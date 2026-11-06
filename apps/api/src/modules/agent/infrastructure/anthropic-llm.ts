import type Anthropic from '@anthropic-ai/sdk';
import {
  type ComposeRequest,
  type ComposeResult,
  FALLBACK_MODEL,
  judgeFailed,
  type JudgeRequest,
  type JudgeResult,
  type LlmPort,
  templateResult,
} from '../domain/ports.js';
import { JUDGE_MAX_TOKENS, JUDGE_SYSTEM_PROMPT, judgePassed, judgePrompt, systemPrompt, userPrompt } from '../domain/prompt.js';
import type { RemoteGuard } from './resilient.js';

/** The slice of the SDK client this adapter uses, so tests can pass a fake. */
export interface AnthropicMessagesApi {
  create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
}

export interface ModelPair {
  small: string;
  large: string;
}

const COMPOSE_TOOL: Anthropic.Tool = {
  name: 'compose_reply',
  description: 'Send the reply text to the buyer.',
  input_schema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The reply to send to the buyer.' } },
    required: ['text'],
    additionalProperties: false,
  },
  strict: true,
};

function replyText(res: Anthropic.Message): string {
  if (res.stop_reason !== 'end_turn' && res.stop_reason !== 'tool_use') throw new Error(`Model stopped with ${res.stop_reason}`);
  const call = res.content.find((b) => b.type === 'tool_use' && b.name === COMPOSE_TOOL.name);
  const raw = call?.type === 'tool_use' ? (call.input as { text?: unknown }).text : res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Model returned no reply text');
  return raw.trim();
}

// Cached prefix tokens are billed differently; counting them all at full rate keeps budgets conservative.
const inputTokens = (u: Anthropic.Usage): number => u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

/**
 * Claude adapter: small tier for search and product questions, large tier for negotiation and
 * complaints. Tools and the system prompt are static and cached; only the request JSON varies.
 * Forced tool_choice is rejected by current models, so the prompt asks for the tool and plain text is
 * accepted too. Any failure (timeout, open breaker, refusal, truncation) returns the template.
 */
export class AnthropicLlm implements LlmPort {
  private readonly system: Anthropic.TextBlockParam[];
  private readonly judgeSystem: Anthropic.TextBlockParam[] = [{ type: 'text', text: JUDGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];

  constructor(
    private readonly messages: AnthropicMessagesApi,
    private readonly models: ModelPair,
    seller: string,
    private readonly guard: RemoteGuard,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {
    // Tools render before the system prompt, so this one breakpoint caches both.
    this.system = [{ type: 'text', text: systemPrompt(seller, true), cache_control: { type: 'ephemeral' } }];
  }

  /** The large model reviews a reply; any failure counts as a FAIL. */
  async judge(req: JudgeRequest): Promise<JudgeResult> {
    const model = this.models.large;
    try {
      return await this.guard.run(async (signal) => {
        const res = await this.messages.create(
          { model, max_tokens: JUDGE_MAX_TOKENS, system: this.judgeSystem, messages: [{ role: 'user', content: judgePrompt(req) }] },
          { signal },
        );
        const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        return { ok: judgePassed(text), model, tokensIn: inputTokens(res.usage), tokensOut: res.usage.output_tokens };
      });
    } catch (err) {
      this.onError(err);
      return judgeFailed();
    }
  }

  async compose(req: ComposeRequest): Promise<ComposeResult> {
    const model = req.tier === 3 ? this.models.large : this.models.small;
    try {
      return await this.guard.run(async (signal) => {
        const res = await this.messages.create(
          {
            model,
            max_tokens: req.maxTokens,
            output_config: { effort: 'low' },
            system: this.system,
            tools: [COMPOSE_TOOL],
            tool_choice: { type: 'auto' },
            messages: [{ role: 'user', content: userPrompt(req) }],
          },
          { signal },
        );
        return { text: replyText(res), model, tokensIn: inputTokens(res.usage), tokensOut: res.usage.output_tokens };
      });
    } catch (err) {
      this.onError(err);
      return templateResult(req, FALLBACK_MODEL);
    }
  }
}
