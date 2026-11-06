import type { TokenResponse } from '@agentbazaar/contracts';
import { NextResponse } from 'next/server';
import { callApi } from './server-api';
import { setAuthCookies } from './session';

/**
 * BFF token exchange: calls an API endpoint that returns tokens, stores them in httpOnly cookies and
 * returns only `{ ok, role }` to the browser. API errors pass through as the usual error envelope.
 */
export async function issueSession(path: string, body: unknown): Promise<NextResponse> {
  const res = await callApi<TokenResponse>(path, { method: 'POST', body });
  if (!res.ok) {
    return NextResponse.json({ error: { code: res.code, message: res.message } }, { status: res.status });
  }
  const out = NextResponse.json({ ok: true, role: res.data.role ?? 'customer' });
  setAuthCookies(out, res.data);
  return out;
}
