import { sha256Hex } from '../../../shared/crypto/primitives.js';

/**
 * Seeded products get an id derived from their slug (an RFC 9562 version 8 UUID), so the demo catalog is the same
 * store on every boot: search and "bought together" break ranking ties by product id, which with random ids put
 * tied products in a different order each time.
 */
export function seedProductId(slug: string): string {
  const h = sha256Hex(`agentbazaar-seed-product:${slug}`);
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
