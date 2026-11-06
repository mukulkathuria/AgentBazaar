import { PageQuery, Routes, type PublicProduct } from '@agentbazaar/contracts';
import { connection, type NextRequest } from 'next/server';
import { errorJson } from '@/lib/http';
import { callApi } from '@/lib/server-api';

/** Public product feed for search engines and LLM providers, proxied from the API with a short cache. */
export async function GET(req: NextRequest): Promise<Response> {
  await connection();
  const query = PageQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) return errorJson(400, 'validation_failed', 'Use limit=1..100 and offset=0..10000');
  const res = await callApi<PublicProduct[]>(Routes.productFeed.path, { query: query.data, cache: { revalidate: 300, tags: ['feed'] } });
  if (!res.ok) return errorJson(res.status >= 500 ? 503 : res.status, res.code, res.message);
  return Response.json(res.data, { headers: { 'cache-control': 'public, max-age=300' } });
}
