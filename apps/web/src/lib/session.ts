import type { Role, TokenResponse } from '@agentbazaar/contracts';
import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';

export const COOKIE = { access: 'ab_at', refresh: 'ab_rt', role: 'ab_role', cart: 'ab_cart', lang: 'lang' } as const;

// shortcut: assumed refresh-token lifetime; align with the API once it reports one.
const REFRESH_MAX_AGE = 30 * 24 * 3600;
export const CART_MAX_AGE = 30 * 24 * 3600;

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

export function setAuthCookies(res: NextResponse, tokens: TokenResponse): void {
  // Expire the cookie a little before the token so the API never sees a stale bearer.
  res.cookies.set(COOKIE.access, tokens.accessToken, cookieOptions(Math.max(60, tokens.expiresIn - 30)));
  if (tokens.refreshToken) res.cookies.set(COOKIE.refresh, tokens.refreshToken, cookieOptions(REFRESH_MAX_AGE));
  res.cookies.set(COOKIE.role, tokens.role ?? 'customer', cookieOptions(tokens.refreshToken ? REFRESH_MAX_AGE : tokens.expiresIn));
}

export function clearAuthCookies(res: NextResponse): void {
  for (const name of [COOKIE.access, COOKIE.refresh, COOKIE.role]) res.cookies.delete(name);
}

export interface Session {
  accessToken: string | null;
  role: Role | null;
  /** Access token expired but a refresh token is present: the page should refresh the session. */
  canRefresh: boolean;
}

export async function getSession(): Promise<Session> {
  const jar = await cookies();
  const accessToken = jar.get(COOKIE.access)?.value ?? null;
  const role = jar.get(COOKIE.role)?.value;
  return {
    accessToken,
    role: role === 'admin' || role === 'customer' ? role : null,
    canRefresh: !accessToken && jar.has(COOKIE.refresh),
  };
}
