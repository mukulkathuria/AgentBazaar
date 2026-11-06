import { PUBLIC_API_URL } from './env';

const LOCAL_PREFIXES = ['/checkout/', '/pay/mock/', '/orders/'];

/**
 * Checkout, mock-payment and order links come from the API built with its PUBLIC_WEB_URL. Keep them on
 * this app's origin (so a mismatched origin, e.g. in e2e, still works); other links must be https.
 */
export function toLocalHref(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url, 'http://local.invalid');
  } catch {
    return null;
  }
  if (LOCAL_PREFIXES.some((p) => u.pathname.startsWith(p))) return u.pathname + u.search;
  return u.protocol === 'https:' ? u.href : null;
}

/** API-relative asset URLs (product images, customization previews) resolve against the public API origin. */
export function apiAssetUrl(url: string): string {
  try {
    return new URL(url, `${PUBLIC_API_URL}/`).href;
  } catch {
    return url;
  }
}

/** For images rendered in the browser: API paths go through the same-origin proxy, so no API origin is needed. */
export function browserAssetUrl(url: string): string {
  return url.startsWith('/api/v1/') ? `/api/proxy${url}` : apiAssetUrl(url);
}

/** sessionStorage key: the mock pay page needs the order's access token to continue to the order page. */
export const orderTokenKey = (orderId: string) => `order-token:${orderId}`;
