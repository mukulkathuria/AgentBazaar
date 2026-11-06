import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ComposeRequest, JudgeRequest } from '../domain/ports.js';
import { AnthropicLlm, type AnthropicMessagesApi } from './anthropic-llm.js';
import { AiServiceClassifier, RulesClassifier } from './classifiers.js';
import { FallbackLlm } from './fallback-llm.js';
import { OpenAiCompatibleLlm } from './openai-compatible-llm.js';
import { RemoteGuard } from './resilient.js';
import { TemplateLlm } from './template-llm.js';

const req: ComposeRequest = {
  tier: 2,
  intent: 'search',
  language: 'en',
  facts: { results: [{ name: 'Thock TK-87', price_inr: 5499 }] },
  allowedNumbers: [5499],
  fallback: 'Here are some options: 1. Thock TK-87 (THOCK-TK87-RED) ₹5,499.',
  maxTokens: 300,
  userText: 'show me keyboards',
};
const models = { small: 'claude-haiku-5-5', large: 'claude-sonnet-5-5' };
const fallback = { text: req.fallback, model: 'template-fallback', tokensIn: 0, tokensOut: 0 };

function claudeMessage(over: Record<string, unknown> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'compose_reply', input: { text: 'Sure! The Thock TK-87 is ₹5,499.' } }],
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 400 },
    ...over,
  } as unknown as Anthropic.Message;
}

const fakeClaude = (impl: AnthropicMessagesApi['create']) => {
  const create = vi.fn(impl);
  return { api: { create } satisfies AnthropicMessagesApi, create };
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('TemplateLlm', () => {
  it('returns the policy template verbatim at no cost', async () => {
    expect(await new TemplateLlm().compose(req)).toEqual({ text: req.fallback, model: 'template', tokensIn: 0, tokensOut: 0 });
  });
});

describe('AnthropicLlm', () => {
  it('sends a cached system prompt and tool, small model for tier 2, and reads the tool reply', async () => {
    const { api, create } = fakeClaude(async () => claudeMessage());
    const llm = new AnthropicLlm(api, models, 'Demo Store', new RemoteGuard('t', { timeoutMs: 1000 }));
    const out = await llm.compose(req);
    expect(out).toEqual({ text: 'Sure! The Thock TK-87 is ₹5,499.', model: 'claude-haiku-5-5', tokensIn: 500, tokensOut: 20 });
    const [body, options] = create.mock.calls[0]!;
    expect(body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 300,
      tool_choice: { type: 'auto' },
      output_config: { effort: 'low' },
      tools: [{ name: 'compose_reply', strict: true }],
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
    });
    expect(JSON.parse(body.messages[0]!.content as string)).toMatchObject({ template: req.fallback, buyer_message: 'show me keyboards' });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the large model for tier 3 and accepts a plain-text answer', async () => {
    const { api, create } = fakeClaude(async () => claudeMessage({ stop_reason: 'end_turn', content: [{ type: 'text', text: ' Deal at ₹5,499. ' }] }));
    const out = await new AnthropicLlm(api, models, 'S', new RemoteGuard('t', { timeoutMs: 1000 })).compose({ ...req, tier: 3 });
    expect(out.text).toBe('Deal at ₹5,499.');
    expect(create.mock.calls[0]![0].model).toBe('claude-sonnet-5-5');
  });

  it.each(['refusal', 'max_tokens'])('falls back to the template when the model stops with %s', async (stop) => {
    const { api } = fakeClaude(async () => claudeMessage({ stop_reason: stop }));
    expect(await new AnthropicLlm(api, models, 'S', new RemoteGuard('t', { timeoutMs: 1000 })).compose(req)).toEqual(fallback);
  });

  it('opens the breaker after repeated failures and keeps answering with the template', async () => {
    const { api, create } = fakeClaude(async () => {
      throw new Error('overloaded');
    });
    const guard = new RemoteGuard('anthropic', { timeoutMs: 1000, failureThreshold: 3, resetMs: 60_000 });
    const errors: unknown[] = [];
    const llm = new AnthropicLlm(api, models, 'S', guard, (e) => errors.push(e));
    for (let i = 0; i < 5; i++) expect(await llm.compose(req)).toEqual(fallback);
    expect(create).toHaveBeenCalledTimes(3);
    expect(guard.state).toBe('open');
    expect(errors).toHaveLength(5);
  });

  it('aborts a slow call at the timeout and falls back', async () => {
    let signal: AbortSignal | undefined;
    const { api } = fakeClaude((_body, options) => {
      signal = options?.signal;
      return new Promise<never>(() => undefined);
    });
    const out = await new AnthropicLlm(api, models, 'S', new RemoteGuard('t', { timeoutMs: 20 })).compose(req);
    expect(out).toEqual(fallback);
    expect(signal?.aborted).toBe(true);
  });
});

describe('OpenAiCompatibleLlm', () => {
  const opts = { baseUrl: 'http://vllm:8000/v1/', apiKey: 'sk-local', models: { small: 'llama-small', large: 'llama-large' }, seller: 'S' };

  it('posts an OpenAI-style chat completion and reads the reply and usage', async () => {
    const fetchImpl = vi.fn(async () => json({ choices: [{ message: { content: 'Hi! ₹5,499.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 9 } }));
    const out = await new OpenAiCompatibleLlm(opts, new RemoteGuard('t', { timeoutMs: 1000 }), fetchImpl).compose({ ...req, tier: 3 });
    expect(out).toEqual({ text: 'Hi! ₹5,499.', model: 'llama-large', tokensIn: 80, tokensOut: 9 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://vllm:8000/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-local');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'llama-large', max_tokens: 300 });
  });

  it.each([
    ['an HTTP error', json({ error: 'boom' }, 500)],
    ['a truncated reply', json({ choices: [{ message: { content: 'Hi' }, finish_reason: 'length' }] })],
    ['an unexpected body', json({ nope: true })],
  ])('falls back to the template on %s', async (_why, response) => {
    const out = await new OpenAiCompatibleLlm(opts, new RemoteGuard('t', { timeoutMs: 1000 }), async () => response).compose(req);
    expect(out).toEqual(fallback);
  });
});

const verdictReq: JudgeRequest = { intent: 'make_offer', language: 'en', template: 'I can do: ₹5,199 each.', reply: 'Sure! I can do ₹5,199 each.' };
const completion = (content: string) => json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 2 } });
const failed = { ok: false, model: 'template-fallback', tokensIn: 0, tokensOut: 0 };

describe('observer judge', () => {
  it('asks the large Claude model with a cached judge prompt and passes on PASS', async () => {
    const usage = { input_tokens: 90, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 300 };
    const { api, create } = fakeClaude(async () => claudeMessage({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'PASS' }], usage }));
    const out = await new AnthropicLlm(api, models, 'S', new RemoteGuard('t', { timeoutMs: 1000 })).judge(verdictReq);
    expect(out).toEqual({ ok: true, model: 'claude-sonnet-5-5', tokensIn: 390, tokensOut: 1 });
    const [body] = create.mock.calls[0]!;
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 8, system: [{ type: 'text', cache_control: { type: 'ephemeral' } }] });
    expect(JSON.parse(body.messages[0]!.content as string)).toEqual({ ...verdictReq });
  });

  it.each(['FAIL', 'I think it is a pass', ''])('fails closed on the answer %j', async (text) => {
    const { api } = fakeClaude(async () => claudeMessage({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }));
    expect((await new AnthropicLlm(api, models, 'S', new RemoteGuard('t', { timeoutMs: 1000 })).judge(verdictReq)).ok).toBe(false);
  });

  it('fails closed when the model cannot be reached', async () => {
    const { api } = fakeClaude(async () => {
      throw new Error('overloaded');
    });
    expect(await new AnthropicLlm(api, models, 'S', new RemoteGuard('t', { timeoutMs: 1000 })).judge(verdictReq)).toEqual(failed);
  });

  it('judges with the large self-hosted model and fails closed on errors', async () => {
    const opts = { baseUrl: 'http://vllm:8000/v1', models: { small: 'llama-small', large: 'llama-large' }, seller: 'S' };
    const pass = vi.fn(async () => completion('PASS.'));
    expect(await new OpenAiCompatibleLlm(opts, new RemoteGuard('t', { timeoutMs: 1000 }), pass).judge(verdictReq)).toEqual({
      ok: true,
      model: 'llama-large',
      tokensIn: 40,
      tokensOut: 2,
    });
    const body = JSON.parse((pass.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { model: string; max_tokens: number };
    expect(body).toMatchObject({ model: 'llama-large', max_tokens: 8 });
    const down = new OpenAiCompatibleLlm(opts, new RemoteGuard('t', { timeoutMs: 1000 }), async () => json({}, 500));
    expect(await down.judge(verdictReq)).toEqual(failed);
  });

  it('has nothing to judge for template wording', async () => {
    expect((await new TemplateLlm().judge()).ok).toBe(true);
  });
});

describe('FallbackLlm', () => {
  const opts = (prefix: string) => ({ baseUrl: `http://${prefix}:8000/v1`, models: { small: `${prefix}-small`, large: `${prefix}-large` }, seller: 'S' });

  it('answers from the second provider while the first is down and stops calling the first once its breaker opens', async () => {
    const down = vi.fn(async () => json({ error: 'down' }, 503));
    const guard = new RemoteGuard('primary', { timeoutMs: 1000, failureThreshold: 2, resetMs: 60_000 });
    const primary = new OpenAiCompatibleLlm(opts('primary'), guard, down);
    const backup = new OpenAiCompatibleLlm(opts('backup'), new RemoteGuard('backup', { timeoutMs: 1000 }), async () => completion('PASS'));
    const llm = new FallbackLlm([primary, backup]);
    for (let i = 0; i < 4; i++) expect(await llm.compose(req)).toMatchObject({ model: 'backup-small', tokensIn: 40 });
    expect(down).toHaveBeenCalledTimes(2);
    expect(guard.state).toBe('open');
    expect(await llm.judge(verdictReq)).toMatchObject({ ok: true, model: 'backup-large' });
  });

  it('uses the first provider while it works and sends the template when every provider fails', async () => {
    const up = vi.fn(async () => completion('Hi! ₹5,499.'));
    const backupFetch = vi.fn(async () => completion('unused'));
    const working = new FallbackLlm([
      new OpenAiCompatibleLlm(opts('primary'), new RemoteGuard('p', { timeoutMs: 1000 }), up),
      new OpenAiCompatibleLlm(opts('backup'), new RemoteGuard('b', { timeoutMs: 1000 }), backupFetch),
    ]);
    expect((await working.compose({ ...req, tier: 3 })).model).toBe('primary-large');
    expect(backupFetch).not.toHaveBeenCalled();
    const broken = async () => json({}, 500);
    const dead = new FallbackLlm([
      new OpenAiCompatibleLlm(opts('primary'), new RemoteGuard('p', { timeoutMs: 1000 }), broken),
      new OpenAiCompatibleLlm(opts('backup'), new RemoteGuard('b', { timeoutMs: 1000 }), broken),
    ]);
    expect(await dead.compose(req)).toEqual(fallback);
    expect(await dead.judge(verdictReq)).toEqual(failed);
  });
});

describe('classifiers', () => {
  it('rules classifier answers in process', async () => {
    const r = await new RulesClassifier().classify('can you do 1800', 'en');
    expect(r).toMatchObject({ intent: 'make_offer', entities: { amount_inr: 1800 }, model: 'rules-v1' });
  });

  it('uses the AI service when it answers with a valid response', async () => {
    const body = { intent: 'search', complexity: 'low', risk: 'low', language: 'en', confidence: 0.9, entities: { amount_inr: null, quantity: null }, model: 'hf-intent' };
    const fetchImpl = vi.fn(async () => json(body));
    const c = new AiServiceClassifier('http://ai:8000/', new RemoteGuard('ai', { timeoutMs: 1000 }), new RulesClassifier(), fetchImpl);
    expect(await c.classify('show me mugs', 'hi')).toEqual(body);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://ai:8000/v1/classify');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'show me mugs', language_hint: 'hi' });
  });

  it('falls back to the rules on failure and stops calling a failing service', async () => {
    const fetchImpl = vi.fn(async () => json({ detail: 'down' }, 503));
    const guard = new RemoteGuard('ai', { timeoutMs: 1000, failureThreshold: 2 });
    const c = new AiServiceClassifier('http://ai:8000', guard, new RulesClassifier(), fetchImpl);
    for (let i = 0; i < 4; i++) expect((await c.classify('how much is this?')).model).toBe('rules-v1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(guard.state).toBe('open');
  });
});
