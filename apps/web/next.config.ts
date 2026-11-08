import path from 'node:path';
import type { NextConfig } from 'next';

// Monorepo root: standalone output must trace the workspace packages (e.g. @agentbazaar/contracts).
const root = path.join(import.meta.dirname, '../..');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // Other origins may not embed this app's pages, scripts or styles (ZAP 90004).
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), usb=(), payment=()' },
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
    : []),
];

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot: root,
  turbopack: { root },
  images: { unoptimized: true },
  // Metadata blocks rendering for every user agent, not only crawlers: streamed metadata left a re-rendered page
  // (the language switch) briefly without a <title>, which screen readers announce and axe flags.
  htmlLimitedBots: /.*/,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Pages get a per-request nonce CSP from src/proxy.ts; JSON route handlers get this locked-down one.
      { source: '/api/:path*', headers: [{ key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" }] },
    ];
  },
};

export default nextConfig;
