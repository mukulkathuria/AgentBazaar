import type { NextRequest } from 'next/server';
import { API_URL } from '@/lib/env';
import { errorJson, isSameOrigin } from '@/lib/http';
import { proxyTarget } from '@/lib/proxy-path';
import { COOKIE } from '@/lib/session';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ path: string[] }> };

const MAX_BODY = 256 * 1024; // the API's own body limit
const REQUEST_HEADERS = ['accept', 'content-type', 'idempotency-key', 'accept-language'];
const RESPONSE_HEADERS = ['content-type', 'content-disposition', 'cache-control', 'retry-after', 'x-request-id'];

function upstreamHeaders(req: NextRequest): Headers {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const token = req.cookies.get(COOKIE.access)?.value;
  if (token) headers.set('authorization', `Bearer ${token}`);
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);
  return headers;
}

function downstreamHeaders(upstream: Response): Headers {
  const out = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  // no-transform keeps response compression from buffering server-sent events.
  if (out.get('content-type')?.includes('text/event-stream')) out.set('cache-control', 'no-cache, no-transform');
  return out;
}

/**
 * Same-origin BFF proxy for browser code: forwards allow-listed /api/v1/ paths to the API with the
 * bearer token from the httpOnly cookie. Cookies are never forwarded; tokens never reach the browser.
 */
async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const target = proxyTarget((await ctx.params).path, req.nextUrl.search, API_URL);
  if (!target) return errorJson(404, 'not_found', 'Unknown API path');
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  if (hasBody && !isSameOrigin(req.headers)) return errorJson(403, 'forbidden', 'Cross-site request blocked');
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return errorJson(413, 'validation_failed', 'Request too large');

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: upstreamHeaders(req),
      body: hasBody ? await req.arrayBuffer() : undefined,
      cache: 'no-store',
      redirect: 'manual',
      signal: req.signal,
    });
  } catch {
    return errorJson(503, 'unavailable', 'The store is temporarily unavailable. Please try again shortly.');
  }

  return new Response(upstream.body, { status: upstream.status, headers: downstreamHeaders(upstream) });
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
