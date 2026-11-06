import { NextResponse, type NextRequest } from 'next/server';
import { isSameOrigin } from '@/lib/http';
import { clearAuthCookies } from '@/lib/session';

/** Works as a plain form POST: clears the session cookies and redirects home. */
export async function POST(req: NextRequest): Promise<Response> {
  const res = new NextResponse(null, { status: 303, headers: { location: '/' } });
  if (isSameOrigin(req.headers)) clearAuthCookies(res);
  return res;
}
