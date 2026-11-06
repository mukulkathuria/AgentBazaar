import { LoginInput, Routes } from '@agentbazaar/contracts';
import type { NextRequest } from 'next/server';
import { issueSession } from '@/lib/auth';
import { errorJson, isSameOrigin, readJson } from '@/lib/http';

export async function POST(req: NextRequest): Promise<Response> {
  if (!isSameOrigin(req.headers)) return errorJson(403, 'forbidden', 'Cross-site request blocked');
  const input = LoginInput.safeParse(await readJson(req));
  if (!input.success) return errorJson(400, 'validation_failed', 'Check your email, password and code.');
  return issueSession(Routes.login.path, input.data);
}
