#!/usr/bin/env node
/**
 * Smoke test for the upgrade suite (.github/workflows/upgrade.yml): run `before` against the previous release
 * and `after` against the upgraded one, on the same database. `before` buys and pays for an order as a new
 * customer and saves who they are; `after` checks that order survived the upgrade with its timeline, then buys
 * again. Each phase also checks health, the catalog and search.
 *
 * Usage: node scripts/upgrade-smoke.mjs before|after <state.json> [base URL, default http://127.0.0.1:4000]
 * (127.0.0.1, not localhost: the API listens on IPv4, and localhost may resolve to ::1 first.)
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [phase, stateFile, base = 'http://127.0.0.1:4000'] = process.argv.slice(2);
if (!['before', 'after'].includes(phase) || !stateFile) {
  console.error('Usage: node scripts/upgrade-smoke.mjs before|after <state.json> [base URL]');
  process.exit(64);
}

async function call(method, path, { body, token, key } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function check(ok, message) {
  if (!ok) throw new Error(message);
  console.log(`ok - ${message}`);
}

async function storefront() {
  check((await call('GET', '/healthz')) !== undefined, 'health');
  await call('GET', '/readyz');
  const categories = await call('GET', '/api/v1/categories');
  check(Array.isArray(categories) && categories.length > 0, `catalog: ${categories.length} top-level categories`);
  const found = await call('GET', '/api/v1/products?q=keyboard');
  const product = found.items.find((p) => p.inStock);
  check(product !== undefined, `search: ${found.total} results for "keyboard"`);
  const detail = await call('GET', `/api/v1/products/${product.slug}`);
  check(detail.slug === product.slug, `product page: ${detail.name}`);
  return product.defaultSku;
}

async function waitForStatus(order, status) {
  for (let i = 0; i < 60; i++) {
    const now = await call('GET', `/api/v1/orders/${order.orderId}?t=${encodeURIComponent(order.accessToken)}`);
    if (now.status === status) return now;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`order ${order.number} never became ${status}`);
}

/** Cart, checkout with the mock gateway, payment; returns the paid order. */
async function buy(sku, email, token) {
  const { cartId } = await call('POST', '/api/v1/carts', { token });
  await call('POST', `/api/v1/carts/${cartId}/lines`, { token, body: { sku, quantity: 1 } });
  const session = await call('POST', '/api/v1/checkout/sessions', { token, key: randomUUID(), body: { cartId } });
  const order = await call('POST', `/api/v1/checkout/sessions/${session.sessionId}/complete?t=${encodeURIComponent(session.token)}`, {
    token,
    key: randomUUID(),
    body: {
      email,
      address: { name: 'Upgrade Smoke', phone: '9876543210', line1: '1 Test Street', city: 'New Delhi', stateCode: 'DL', pincode: '110001' },
      paymentMethod: 'online',
      acceptTerms: true,
    },
  });
  const paymentId = /\/pay\/mock\/([0-9a-f-]{36})/.exec(order.paymentUrl ?? '')?.[1];
  check(paymentId !== undefined, `checkout: order ${order.number} waits for the mock payment`);
  await call('POST', `/api/v1/mock-gateway/payments/${paymentId}/complete`, { body: { outcome: 'success' } });
  const paid = await waitForStatus(order, 'paid');
  check(paid.status === 'paid', `payment: order ${paid.number} is paid`);
  return { ...paid, accessToken: order.accessToken };
}

async function before() {
  const sku = await storefront();
  const email = `upgrade-${Date.now()}@example.com`;
  const password = `Upgrade-pass-${randomUUID().slice(0, 8)}`;
  const { accessToken } = await call('POST', '/api/v1/auth/register', {
    body: { email, password, name: 'Upgrade Smoke', consents: { terms: true } },
  });
  const order = await buy(sku, email, accessToken);
  const mine = await call('GET', '/api/v1/me/orders', { token: accessToken });
  check(mine.some((o) => o.orderId === order.orderId), 'order history lists the order');
  writeFileSync(stateFile, JSON.stringify({ email, password, orderId: order.orderId, number: order.number, accessToken: order.accessToken }));
}

async function after() {
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  const sku = await storefront();
  const { accessToken } = await call('POST', '/api/v1/auth/login', { body: { email: saved.email, password: saved.password } });
  check(Boolean(accessToken), 'the customer created before the upgrade signs in');
  const old = (await call('GET', '/api/v1/me/orders', { token: accessToken })).find((o) => o.orderId === saved.orderId);
  check(old?.status === 'paid', `order history keeps order ${saved.number}, still paid`);
  const steps = old.timeline.map((t) => t.status);
  check(steps.includes('pending_payment') && steps.includes('paid'), `its timeline survived: ${steps.join(' -> ')}`);
  const byLink = await call('GET', `/api/v1/orders/${saved.orderId}?t=${encodeURIComponent(saved.accessToken)}`);
  check(byLink.number === saved.number, 'its order link still works');
  const fresh = await buy(sku, saved.email, accessToken);
  const mine = await call('GET', '/api/v1/me/orders', { token: accessToken });
  check([saved.orderId, fresh.orderId].every((id) => mine.some((o) => o.orderId === id)), 'order history lists both orders');
}

(phase === 'before' ? before() : after()).catch((err) => {
  console.error(`not ok - ${err.message}`);
  process.exit(1);
});
