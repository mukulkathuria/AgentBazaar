'use server';

import {
  CartLineInput,
  Quantity,
  Routes,
  Uuid,
  type CartView,
  type CheckoutSessionView,
} from '@agentbazaar/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiPath } from '@/lib/http';
import { callApi } from '@/lib/server-api';
import { CART_MAX_AGE, COOKIE, cookieOptions } from '@/lib/session';

export type ActionResult = { ok: true } | { ok: false; message: string | null };

async function currentCartId(): Promise<string | null> {
  const id = (await cookies()).get(COOKIE.cart)?.value;
  return id && Uuid.safeParse(id).success ? id : null;
}

async function createCart(): Promise<string | null> {
  const res = await callApi<CartView>(Routes.createCart.path, { method: 'POST' });
  if (!res.ok) return null;
  (await cookies()).set(COOKIE.cart, res.data.cartId, cookieOptions(CART_MAX_AGE));
  return res.data.cartId;
}

function addLine(cartId: string, line: CartLineInput) {
  return callApi<CartView>(apiPath(Routes.addCartLine.path, { id: cartId }), { method: 'POST', body: line });
}

/** Adds a line to the anonymous cart (created on first use, id kept in an httpOnly cookie). */
export async function addToCart(input: unknown): Promise<ActionResult> {
  const line = CartLineInput.safeParse(input);
  if (!line.success) return { ok: false, message: null };
  const cartId = (await currentCartId()) ?? (await createCart());
  if (!cartId) return { ok: false, message: null };
  let res = await addLine(cartId, line.data);
  if (!res.ok && res.status === 404) {
    // The cart expired on the server: start a new one.
    const fresh = await createCart();
    if (fresh) res = await addLine(fresh, line.data);
  }
  if (res.ok) return { ok: true };
  return { ok: false, message: res.status < 500 ? res.message : null };
}

export async function updateCartLine(formData: FormData): Promise<void> {
  const cartId = await currentCartId();
  const lineId = Uuid.safeParse(formData.get('lineId'));
  const quantity = Quantity.safeParse(Number(formData.get('quantity')));
  if (!cartId || !lineId.success || !quantity.success) redirect('/cart?error=validation_failed');
  const res = await callApi<CartView>(apiPath(Routes.updateCartLine.path, { id: cartId, lineId: lineId.data }), {
    method: 'PATCH',
    body: { quantity: quantity.data },
  });
  redirect(res.ok ? '/cart' : `/cart?error=${encodeURIComponent(res.code)}`);
}

export async function removeCartLine(formData: FormData): Promise<void> {
  const cartId = await currentCartId();
  const lineId = Uuid.safeParse(formData.get('lineId'));
  if (!cartId || !lineId.success) redirect('/cart?error=validation_failed');
  const res = await callApi<CartView>(apiPath(Routes.removeCartLine.path, { id: cartId, lineId: lineId.data }), {
    method: 'DELETE',
  });
  redirect(res.ok ? '/cart' : `/cart?error=${encodeURIComponent(res.code)}`);
}

/** Locks prices and reserves stock, then sends the shopper to the capability-token checkout URL. */
export async function startCheckout(formData: FormData): Promise<void> {
  const cartId = await currentCartId();
  const raw = formData.get('idempotencyKey');
  const key = typeof raw === 'string' ? raw : '';
  if (!cartId || !/^[A-Za-z0-9-]{8,128}$/.test(key)) redirect('/cart?error=validation_failed');
  const res = await callApi<CheckoutSessionView>(Routes.startCheckout.path, {
    method: 'POST',
    body: { cartId },
    idempotencyKey: key,
  });
  if (!res.ok) redirect(`/cart?error=${encodeURIComponent(res.code)}`);
  if (!res.data.token) redirect('/cart?error=checkout');
  redirect(`/checkout/${res.data.sessionId}?t=${encodeURIComponent(res.data.token)}`);
}
