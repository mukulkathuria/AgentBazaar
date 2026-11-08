import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: vi.fn() }));

async function secureFor(nodeEnv: string, siteUrl: string): Promise<boolean> {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('PUBLIC_WEB_URL', siteUrl);
  return (await import('./session')).SECURE_COOKIES;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Secure cookie flag (regression: WebKit dropped the cart and session cookies of the http://localhost demo)', () => {
  it('is set in production on an https store', async () => {
    expect(await secureFor('production', 'https://shop.example.com')).toBe(true);
  });

  it('is left off only for a plain-http store on this machine', async () => {
    expect(await secureFor('production', 'http://localhost:3000')).toBe(false);
    expect(await secureFor('production', 'http://127.0.0.1:3101')).toBe(false);
    expect(await secureFor('production', 'http://shop.example.com')).toBe(true);
    expect(await secureFor('production', 'http://localhost.example.com')).toBe(true);
  });

  it('is off outside production', async () => {
    expect(await secureFor('development', 'https://shop.example.com')).toBe(false);
  });
});
