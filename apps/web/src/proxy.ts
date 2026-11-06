import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { classifyVisit } from './lib/geo/detect';
import { trackVisit } from './lib/geo/track';
import { buildCsp } from './lib/security/csp';

/**
 * Runs before every page: sets a per-request nonce CSP (Next applies the nonce to its scripts) and
 * records AI crawler hits / AI-assistant referrals in the background without delaying the response.
 */
export function proxy(request: NextRequest, event: NextFetchEvent): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);

  const visit = classifyVisit(request.headers.get('user-agent'), request.headers.get('referer'));
  // Path only: query strings can carry checkout and order tokens.
  if (visit) event.waitUntil(trackVisit(visit, request.nextUrl.pathname));
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api/|_next/static|_next/image|favicon.ico|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
