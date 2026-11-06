import type { OrderView } from '@agentbazaar/contracts';

export async function call<T>(base: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${json.error?.message ?? 'request failed'}`);
  return json;
}

/**
 * The human half of a sale: opens the checkout link the buyer agent handed over, confirms the delivery
 * address and pays with the mock gateway. Returns the order as it stood before the payment settled.
 */
export async function payAsHuman(base: string, checkoutUrl: string): Promise<OrderView> {
  const link = new URL(checkoutUrl);
  const sessionId = link.pathname.split('/').pop()!;
  const token = link.searchParams.get('t')!;
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
  return order;
}

export const fetchOrder = (base: string, order: OrderView): Promise<OrderView> =>
  call<OrderView>(base, `/api/v1/orders/${order.orderId}?t=${encodeURIComponent(order.accessToken!)}`);
