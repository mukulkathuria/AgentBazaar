import { PUBLIC_API_URL } from '../env';

/** Per-request CSP for HTML pages. Next.js applies the nonce to its own scripts (see src/proxy.ts). */
export function buildCsp(nonce: string, dev = process.env.NODE_ENV === 'development'): string {
  const api = new URL(PUBLIC_API_URL).origin;
  // Optional extra image CDNs, comma separated (product images are otherwise served by the API).
  const imageHosts = (process.env.IMAGE_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [
    "default-src 'self'",
    // 'unsafe-eval' only in dev: React uses eval there to rebuild server error stacks.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    ['img-src', "'self'", 'data:', 'blob:', api, ...imageHosts].join(' '),
    "font-src 'self'",
    `connect-src 'self' ${api}${dev ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
