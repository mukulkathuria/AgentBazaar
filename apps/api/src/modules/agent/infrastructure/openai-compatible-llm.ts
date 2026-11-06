import { z } from 'zod';
import { type ComposeRequest, type ComposeResult, type LlmPort, templateResult } from '../domain/ports.js';
import { systemPrompt, userPrompt } from '../domain/prompt.js';
import type { ModelPair } from './anthropic-llm.js';
import type { RemoteGuard } from './resilient.js';

const ChatCompletion = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }), finish_reason: z.string().nullable().optional() }))
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
});

export interface OpenAiCompatibleOptions {
  /** e.g. http://localhost:11434/v1 (Ollama) or http://vllm:8000/v1 */
  baseUrl: string;
  apiKey?: string | undefined;
  models: ModelPair;
  seller: string;
}

/** Self-hosted models (vLLM, Ollama) over the OpenAI-style /chat/completions API. Falls back to the template. */
export class OpenAiCompatibleLlm implements LlmPort {
  private readonly url: string;
  private readonly system: string;

  constructor(
    private readonly opts: OpenAiCompatibleOptions,
    private readonly guard: RemoteGuard,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {
    this.url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.system = systemPrompt(opts.seller, false);
  }

  async compose(req: ComposeRequest): Promise<ComposeResult> {
    const model = req.tier === 3 ? this.opts.models.large : this.opts.models.small;
    try {
      return await this.guard.run(async (signal) => {
        const res = await this.fetchImpl(this.url, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
          body: JSON.stringify({
            model,
            max_tokens: req.maxTokens,
            temperature: 0.3,
            messages: [
              { role: 'system', content: this.system },
              { role: 'user', content: userPrompt(req) },
            ],
          }),
        });
        if (!res.ok) throw new Error(`Model server answered HTTP ${res.status}`);
        const body = ChatCompletion.parse(await res.json());
        const choice = body.choices[0]!;
        const text = choice.message.content?.trim();
        if (choice.finish_reason === 'length' || !text) throw new Error('Model reply was empty or truncated');
        return { text, model, tokensIn: body.usage?.prompt_tokens ?? 0, tokensOut: body.usage?.completion_tokens ?? 0 };
      });
    } catch (err) {
      this.onError(err);
      return templateResult(req, 'template-fallback');
    }
  }
}
