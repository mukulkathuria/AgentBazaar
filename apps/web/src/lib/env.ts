const trim = (url: string) => url.replace(/\/+$/, '');

/** Server-side base URL of the API. Never used by browser code. */
export const API_URL = trim(process.env.API_URL ?? 'http://localhost:4000');

/**
 * Public API origin (MCP, Agent Card, CSP, asset URLs). Server code reads PUBLIC_API_URL at runtime (the name
 * Helm/compose pass, shared with the API); browser bundles only see NEXT_PUBLIC_API_URL, inlined at build time.
 */
export const PUBLIC_API_URL = trim(process.env.PUBLIC_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000');

/** Canonical origin of this web app, used in sitemaps, JSON-LD and llms.txt. */
export const SITE_URL = trim(process.env.PUBLIC_WEB_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000');
