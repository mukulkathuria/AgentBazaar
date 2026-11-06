import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

/** Seeded demo products (see the API seed). */
export const PRODUCTS = {
  keyboard: 'thock-tk87-mechanical-keyboard',
  gpu: 'zentrix-zx7070-12gb',
  mug: 'mitti-personalised-ceramic-mug',
  chocolate: 'kokoa-mini-milk-chocolate-13g',
} as const;

export const uniqueEmail = (tag: string) => `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

/** Adds a product's default variant to the cart from its page and lands on /cart. */
export async function addToCart(page: Page, slug: string): Promise<void> {
  await page.goto(`/p/${slug}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page).toHaveURL(/\/cart$/);
}

/** From a non-empty cart, starts checkout and lands on the capability-token checkout page. */
export async function startCheckout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Proceed to checkout' }).click();
  await expect(page).toHaveURL(/\/checkout\/[0-9a-f-]{36}\?t=/);
}

export async function fillCheckout(page: Page, payment: 'Pay online (UPI, card, net banking)' | 'Cash on delivery'): Promise<void> {
  await page.getByLabel('Email').fill(uniqueEmail('buyer'));
  await page.getByLabel('Full name').fill('Asha Verma');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByLabel('PIN code').fill('560001');
  await page.getByLabel('House, building and street').fill('12 MG Road');
  await page.getByLabel('City').fill('Bengaluru');
  await page.getByLabel('State').selectOption('KA');
  await page.getByLabel(payment).check();
  await page.getByLabel('I have read and accept the terms of sale').check();
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/[\s=]/g, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for the admin login journey. */
export function totp(secret: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
