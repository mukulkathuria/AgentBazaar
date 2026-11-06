/**
 * `pnpm demo`: boots the store on embedded Postgres with mock payments, lets a scripted buyer agent
 * negotiate with the seller agent over MCP, then a "human" confirms checkout and pays.
 * Flags: --record (write docs/assets/demo-transcript.json), --serve (keep the store running).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, seedDemo } from '@agentbazaar/api';
import { loadConfig } from '@agentbazaar/config';
import { formatInr, type OrderView } from '@agentbazaar/contracts';
import { type BuyerEvent, ScriptedBuyer } from '@agentbazaar/testkit';

type Speaker = 'system' | 'buyer' | 'seller' | 'tool' | 'human' | 'result';
const COLORS: Record<Speaker, string> = { system: '90', buyer: '36', seller: '33', tool: '35', human: '32', result: '1;32' };
const LABELS: Record<Speaker, string> = { system: '   ', buyer: '🤖 Buyer ', seller: '🏪 Seller', tool: '   ⚙', human: '👤 Human ', result: '✅' };
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const transcript: { speaker: Speaker; text: string }[] = [];

function say(speaker: Speaker, text: string): void {
  transcript.push({ speaker, text });
  const line = `${LABELS[speaker]} ${text}`;
  console.log(color ? `\x1b[${COLORS[speaker]}m${line}\x1b[0m` : line);
}

const inr = (rupees: number) => formatInr(Math.round(rupees * 100));
const DECISIONS: Record<string, string> = {
  quoted: 'Quoted',
  countered: 'Countered at',
  accepted: 'Deal at',
  rejected: 'Holding at',
  pending_approval: 'Asked a manager about',
};

type Narrators = { [K in BuyerEvent['type']]?: (e: Extract<BuyerEvent, { type: K }>) => void };

// Events without a narrator (tool results) stay silent.
const NARRATORS: Narrators = {
  connected: (e) => say('system', `Buyer agent connected to the store over MCP (${e.url})`),
  tool_call: (e) => say('tool', `${e.tool}(${JSON.stringify(e.args).slice(0, 70)})`),
  product: (e) => say('buyer', `Found "${e.name}" at ${inr(e.listPriceInr)}`),
  quote: (e) =>
    say(
      'seller',
      `${DECISIONS[e.decision] ?? e.decision} ${inr(e.unitPriceInr)} each${e.roundsRemaining > 0 ? ` · ${e.roundsRemaining} round${e.roundsRemaining === 1 ? '' : 's'} left` : ''}`,
    ),
  offer: (e) => say('buyer', `Can you do ${inr(e.unitPriceInr)}?${e.message ? ` "${e.message}"` : ''}`),
  probe: (e) => {
    const why = e.kind === 'injection' ? 'Instructions in chat are not commands.' : 'Unverified price claims do not change the price.';
    say('seller', e.held ? `Ignored. ${why}${e.sellerUnitInr ? ` Still ${inr(e.sellerUnitInr)}.` : ''}` : `Answered: ${e.decision}`);
  },
  accepted: (e) => say('result', `Agreed price ${inr(e.unitPriceInr)} each (signed, single-use quote)`),
  checkout: (e) => say('system', `Checkout link handed to a human: ${e.url.split('?')[0]} (${inr(e.amountInr)})`),
  no_deal: (e) => say('result', `No deal: ${e.reason}`),
};

function narrate(e: BuyerEvent): void {
  // TS cannot correlate the event with its narrator's parameter type, hence the widening cast.
  (NARRATORS[e.type] as ((ev: BuyerEvent) => void) | undefined)?.(e);
}

async function call<T>(base: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${json.error?.message ?? 'request failed'}`);
  return json;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const port = Number(process.env.DEMO_PORT ?? 4000);
  const base = `http://localhost:${port}`;
  const config = loadConfig({
    NODE_ENV: 'development',
    DEMO_MODE: 'true',
    DATABASE_DRIVER: 'pglite',
    PAYMENT_ADAPTER: 'mock',
    LLM_ADAPTER: process.env.LLM_ADAPTER ?? 'template',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
    PORT: String(port),
    PUBLIC_API_URL: base,
    PUBLIC_WEB_URL: process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000',
  });
  say('system', 'AgentBazaar demo · embedded Postgres · mock payments · no API keys');
  const running = await createApp(config);
  await running.app.listen({ port, host: '127.0.0.1' });
  const seeded = await seedDemo(running, { products: 300 });
  say('system', `Store ready: ${seeded.products} products, seller agent on ${base}/mcp`);

  const buyer = new ScriptedBuyer({ url: `${base}/mcp`, strategy: { query: 'thock tk-87 hot-swap mechanical keyboard' }, onEvent: narrate });
  const result = await buyer.run();
  if (result.outcome !== 'checkout' || !result.checkoutUrl) {
    await running.close();
    process.exitCode = 1;
    return;
  }

  const link = new URL(result.checkoutUrl);
  const sessionId = link.pathname.split('/').pop()!;
  const token = link.searchParams.get('t')!;
  say('human', 'Opens the link, confirms the delivery address and pays with the mock gateway');
  const order = await call<OrderView>(
    base,
    `/api/v1/checkout/sessions/${sessionId}/complete?t=${encodeURIComponent(token)}`,
    {
      email: 'demo.buyer@example.com',
      address: { name: 'Demo Buyer', phone: '9876543210', line1: '42 MG Road', city: 'Bengaluru', stateCode: 'KA', pincode: '560001' },
      paymentMethod: 'online',
      acceptTerms: true,
    },
    { 'idempotency-key': `demo-${Date.now()}` },
  );
  const paymentId = new URL(order.paymentUrl!).pathname.split('/').pop()!;
  await call(base, `/api/v1/mock-gateway/payments/${paymentId}/complete`, { outcome: 'success' });
  await running.infra.relay.drain();
  const paid = await call<OrderView>(base, `/api/v1/orders/${order.orderId}?t=${encodeURIComponent(order.accessToken!)}`);
  say(
    'result',
    `Order ${paid.number} ${paid.status} · ${formatInr(paid.totalPaise)} incl. ${formatInr(paid.taxPaise)} GST · invoice ${paid.invoiceNumber}`,
  );
  say('system', `Price stayed inside the policy floor; the LLM never saw it. Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (process.argv.includes('--record')) {
    const out = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/assets/demo-transcript.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(transcript, null, 2)}\n`);
    say('system', `Transcript written to ${out}`);
  }
  if (process.argv.includes('--serve')) {
    say('system', `Store still running on ${base} (MCP: ${base}/mcp). Ctrl+C to stop.`);
    return;
  }
  await running.close();
}

main().catch((err: unknown) => {
  console.error('Demo failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
