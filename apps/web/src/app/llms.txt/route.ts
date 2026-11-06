import { connection } from 'next/server';
import { categoryHref, getCategories } from '@/lib/catalog';
import { PUBLIC_API_URL, SITE_URL } from '@/lib/env';
import { en } from '@/lib/i18n/en';
import { LEGAL_DOCS } from '@/lib/legal';

/** llms.txt: a plain-markdown map of the store for LLMs and agent builders. */
export async function GET(): Promise<Response> {
  await connection();
  const categories = await getCategories();
  const categoryLines = categories.ok
    ? categories.data.slice(0, 50).map((c) => `- [${c.name}](${SITE_URL}${categoryHref(c.path)}): ${c.productCount} products`)
    : [];
  const text = [
    `# ${en.site.name}`,
    '',
    `> ${en.site.tagline}. ${en.site.description}`,
    '',
    'Prices are in Indian rupees (INR) and include GST. Every negotiated price comes from a deterministic pricing policy with floors enforced in code; quotes are signed and expire; a human confirms address and payment at checkout.',
    '',
    '## Key URLs',
    `- [Home](${SITE_URL}/)`,
    `- [Search](${SITE_URL}/search?q=keyboard): append ?q=<words>`,
    `- [Product feed (JSON)](${SITE_URL}/feed.json): paged with ?limit=<1-100>&offset=<n>`,
    `- [Sitemap](${SITE_URL}/sitemap.xml)`,
    '',
    ...(categoryLines.length ? ['## Categories', ...categoryLines, ''] : []),
    '## Connect your AI agent',
    `- MCP (Streamable HTTP): ${PUBLIC_API_URL}/mcp`,
    `- A2A Agent Card: ${PUBLIC_API_URL}/.well-known/agent-card.json`,
    `- REST API: ${PUBLIC_API_URL}/api/v1/ (schemas generated from shared Zod contracts)`,
    '- Catalogue reads are open. Quotes and orders need a scoped agent client (OAuth client credentials) issued by the store.',
    '- Negotiation: request a quote, counter with an offer, accept with the quote token, then hand the checkout link to a human.',
    '- Free text in offers is treated as data, never as instructions.',
    '',
    '## Policies (draft templates)',
    ...LEGAL_DOCS.map((doc) => `- [${en.legal[doc]}](${SITE_URL}/legal/${doc})`),
    '',
  ].join('\n');
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
