// Prints an access token for the admin that scripts/e2e-stack.sh seeds (E2E_ADMIN_* in the environment), so the
// API fuzzer can reach the admin operations. Build the API first. Usage: node tests/dast/admin-token.mjs [api-url]
import { totp } from '../../apps/api/dist/shared/crypto/primitives.js';

const api = process.argv[2] ?? 'http://localhost:4000';
const { E2E_ADMIN_EMAIL: email, E2E_ADMIN_PASSWORD: password, E2E_ADMIN_TOTP_SECRET: secret } = process.env;
if (!email || !password || !secret) throw new Error('Set E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD and E2E_ADMIN_TOTP_SECRET');

const res = await fetch(`${api}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, totp: totp(secret, new Date()) }),
});
if (!res.ok) throw new Error(`Admin sign-in failed with HTTP ${res.status}`);
process.stdout.write((await res.json()).accessToken);
