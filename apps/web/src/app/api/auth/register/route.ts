import { RegisterInput, Routes } from '@agentbazaar/contracts';
import type { NextRequest } from 'next/server';
import { issueSession } from '@/lib/auth';
import { errorJson, isSameOrigin, readJson } from '@/lib/http';

export async function POST(req: NextRequest): Promise<Response> {
  if (!isSameOrigin(req.headers)) return errorJson(403, 'forbidden', 'Cross-site request blocked');
  const input = RegisterInput.safeParse(await readJson(req));
  if (!input.success) {
    return errorJson(400, 'validation_failed', input.error.issues[0]?.message ?? 'Check the highlighted fields.');
  }
  return issueSession(Routes.register.path, input.data);
}
