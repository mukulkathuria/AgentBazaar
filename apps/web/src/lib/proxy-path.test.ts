import { describe, expect, it } from 'vitest';
import { proxyTarget } from './proxy-path';

const API = 'http://api.internal:4000';

describe('proxyTarget (BFF proxy allow-list)', () => {
  it('maps /api/v1/ paths onto the API origin and keeps the query string', () => {
    const url = proxyTarget(['api', 'v1', 'products'], '?q=gpu&limit=5', API);
    expect(url?.href).toBe('http://api.internal:4000/api/v1/products?q=gpu&limit=5');
    expect(proxyTarget(['api', 'v1', 'customization', 'MUG-1', 'validate'], '', API)?.pathname).toBe(
      '/api/v1/customization/MUG-1/validate',
    );
  });

  it.each([
    ['dot-dot traversal', ['api', 'v1', '..', '..', 'admin']],
    ['leading traversal', ['..', 'api', 'v1', 'products']],
    ['single dot', ['api', 'v1', '.', 'products']],
    ['encoded traversal', ['api', 'v1', '%2e%2e', 'admin']],
    ['decoded slash inside a segment', ['api', 'v1', '../../admin']],
    ['backslash', ['api', 'v1', '..\\admin']],
    ['absolute URL', ['http:', '', 'evil.example', 'api', 'v1', 'x']],
    ['scheme-relative URL', ['', 'evil.example', 'api', 'v1']],
    ['userinfo trick', ['api', 'v1', '@evil.example']],
    ['other API version', ['api', 'v2', 'products']],
    ['non-API path', ['admin', 'dashboard']],
    ['bare prefix', ['api', 'v1']],
    ['token-issuing auth endpoints', ['api', 'v1', 'auth', 'login']],
  ])('rejects %s', (_name, segments) => {
    expect(proxyTarget(segments, '', API)).toBeNull();
  });

  it('cannot be steered off the API origin through the query string', () => {
    const url = proxyTarget(['api', 'v1', 'products'], '?next=http://evil.example/', API);
    expect(url?.origin).toBe(API);
  });
});
