import { Routes } from '@agentbazaar/contracts';
import type { NextRequest } from 'next/server';
import { issueSession } from '@/lib/auth';
import { errorJson, isSameOrigin } from '@/lib/http';
import { clearAuthCookies, COOKIE } from '@/lib/session';

/** Rotates the refresh token kept in the httpOnly cookie; clears the session when the API refuses. */
export async function POST(req: NextRequest): Promise<Response> {
  if (!isSameOrigin(req.headers)) return errorJson(403, 'forbidden', 'Cross-site request blocked');
  const refreshToken = req.cookies.get(COOKIE.refresh)?.value;
  if (!refreshToken) return errorJson(401, 'unauthorized', 'Not signed in');
  const res = await issueSession(Routes.refresh.path, { refreshToken });
  if (!res.ok) clearAuthCookies(res);
  return res;
}
