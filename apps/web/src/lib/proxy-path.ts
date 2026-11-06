// Unreserved URL characters only: rules out encoded slashes, backslashes, "%2e%2e", "http:" and the like.
const SEGMENT = /^[A-Za-z0-9_~.-]+$/;
const ALLOWED_PREFIX = '/api/v1/';
// Token-issuing endpoints stay behind the BFF routes (app/api/auth/*) so tokens never reach browser JS.
const BLOCKED_PREFIXES = ['/api/v1/auth/'];

/**
 * Maps the catch-all segments of /api/proxy/[...path] to an API URL, or null when the path is not
 * an allowed /api/v1/ path. The result is always on the API origin.
 */
export function proxyTarget(segments: readonly string[], search: string, apiBase: string): URL | null {
  if (!segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) return null;
  const path = `/${segments.join('/')}`;
  if (!path.startsWith(ALLOWED_PREFIX) || BLOCKED_PREFIXES.some((p) => path.startsWith(p))) return null;
  const base = new URL(apiBase);
  const url = new URL(path + search, base);
  return url.origin === base.origin && url.pathname === path ? url : null;
}
