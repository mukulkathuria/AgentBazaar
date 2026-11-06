/**
 * End-to-end check of a fresh cluster install (.github/workflows/cluster.yml): the scripted buyer agent
 * gets a client-credentials token, shops and haggles over MCP through the gateway, a "human" completes
 * checkout and pays with the mock gateway, and the order must reach `paid`.
 * Env: API_URL (the public API origin), AGENT_CLIENT_ID and AGENT_CLIENT_SECRET (from `cli seed`).
 */
import { ScriptedBuyer } from '@agentbazaar/testkit';
import { call, fetchOrder, payAsHuman } from './checkout.js';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const api = env('API_URL');
  const { access_token: token } = await call<{ access_token: string }>(api, '/oauth/token', {
    grant_type: 'client_credentials',
    client_id: env('AGENT_CLIENT_ID'),
    client_secret: env('AGENT_CLIENT_SECRET'),
    scope: 'catalog:read quote:create order:create',
  });
  const buyer = new ScriptedBuyer({
    url: `${api}/mcp`,
    token,
    strategy: { query: 'thock tk-87 hot-swap mechanical keyboard' },
    // The checkout link's token stays out of CI logs.
    onEvent: (e) => console.log(JSON.stringify(e, (key, value: unknown) => (key === 'url' && typeof value === 'string' ? value.split('?')[0] : value))),
  });
  const result = await buyer.run();
  if (result.outcome !== 'checkout' || !result.checkoutUrl) throw new Error('The buyer agent did not reach checkout');

  const order = await payAsHuman(api, result.checkoutUrl);
  // The payment reaches the order through the outbox relay and NATS, so wait for it.
  for (let attempt = 0; attempt < 60; attempt++) {
    const now = await fetchOrder(api, order);
    if (now.status === 'paid') {
      console.log(`Order ${now.number} paid: ${now.totalPaise} paise, agreed unit price ₹${result.unitPriceInr} (list ₹${result.listPriceInr})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Order ${order.orderId} did not reach paid within 60 s`);
}

main().catch((err: unknown) => {
  console.error('Cluster end-to-end failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
