import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Token usage the fake model reported, in total and per model name. */
export interface FakeLlmUsage {
  calls: number;
  judgeCalls: number;
  tokensIn: number;
  tokensOut: number;
  byModel: Record<string, { calls: number; tokensIn: number; tokensOut: number }>;
}

export interface FakeLlmOptions {
  port?: number;
  host?: string;
  /** Added to every answer, to stand in for model latency. */
  latencyMs?: number;
  /** The judge's verdict for a template and a reply; PASS by default. */
  judge?: (template: string, reply: string) => boolean;
}

export interface FakeLlm {
  /** Base URL for OPENAI_COMPAT_BASE_URL, e.g. http://127.0.0.1:4117/v1 */
  url: string;
  usage(): FakeLlmUsage;
  reset(): void;
  close(): Promise<void>;
}

interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
}

const tokens = (chars: number) => Math.ceil(chars / 4);
const empty = (): FakeLlmUsage => ({ calls: 0, judgeCalls: 0, tokensIn: 0, tokensOut: 0, byModel: {} });
const PREFIX: Record<string, string> = { en: 'Sure!', hi: 'ज़रूर!' };

/** Phrasing requests get the template with a friendly opener; judge requests get PASS or FAIL. */
function answer(req: ChatRequest, judge: NonNullable<FakeLlmOptions['judge']>): { text: string; isJudge: boolean } {
  const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
  const user = JSON.parse(req.messages.find((m) => m.role === 'user')?.content ?? '{}') as Record<string, string>;
  if (system.includes('PASS or FAIL')) return { text: judge(user.template ?? '', user.reply ?? '') ? 'PASS' : 'FAIL', isJudge: true };
  return { text: `${PREFIX[user.language ?? 'en'] ?? PREFIX.en} ${user.template ?? ''}`, isJudge: false };
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const send = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
};

/**
 * A deterministic OpenAI-compatible model server for tests, the cost evaluation and load tests. Usage
 * is about one token per four characters, so costs are reproducible run to run. GET /stats returns
 * the usage, POST /reset clears it.
 */
export async function startFakeLlm(opts: FakeLlmOptions = {}): Promise<FakeLlm> {
  let usage = empty();
  const judge = opts.judge ?? (() => true);
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/stats') return send(res, 200, usage);
      if (req.method === 'POST' && req.url === '/reset') return send(res, 200, (usage = empty()));
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) return send(res, 404, { error: 'not found' });
      const chat = JSON.parse(await body(req)) as ChatRequest;
      const { text, isJudge } = answer(chat, judge);
      const tokensIn = tokens(chat.messages.reduce((n, m) => n + m.content.length, 0));
      const tokensOut = tokens(text.length);
      const m = (usage.byModel[chat.model] ??= { calls: 0, tokensIn: 0, tokensOut: 0 });
      for (const u of [usage, m]) Object.assign(u, { calls: u.calls + 1, tokensIn: u.tokensIn + tokensIn, tokensOut: u.tokensOut + tokensOut });
      if (isJudge) usage.judgeCalls++;
      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
      send(res, 200, {
        choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut },
      });
    })().catch((err: unknown) => send(res, 400, { error: String(err) }));
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${opts.host ?? '127.0.0.1'}:${port}/v1`,
    usage: () => structuredClone(usage),
    reset: () => {
      usage = empty();
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
