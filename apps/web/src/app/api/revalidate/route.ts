import { createHash, timingSafeEqual } from 'node:crypto';
import { Slug } from '@agentbazaar/contracts';
import { revalidatePath, revalidateTag } from 'next/cache';
import type { NextRequest } from 'next/server';
import { productTag } from '@/lib/catalog';
import { errorJson, readJson } from '@/lib/http';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** On-demand revalidation of one product page: POST { slug } with `x-revalidate-secret` or a Bearer secret. */
export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.WEB_REVALIDATE_SECRET;
  if (!secret) return errorJson(503, 'unavailable', 'Revalidation is not configured');
  const given = req.headers.get('x-revalidate-secret') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!timingSafeEqual(digest(given), digest(secret))) return errorJson(401, 'unauthorized', 'Invalid secret');
  const body = (await readJson(req)) as { slug?: unknown } | null;
  const slug = Slug.safeParse(body?.slug);
  if (!slug.success) return errorJson(400, 'validation_failed', 'Body must be { "slug": "<product-slug>" }');
  const path = `/p/${slug.data}`;
  revalidatePath(path);
  revalidateTag(productTag(slug.data), { expire: 0 });
  return Response.json({ revalidated: true, path });
}
