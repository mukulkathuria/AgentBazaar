# OWASP ASVS mapping

A subset of the **OWASP Application Security Verification Standard 4.0.3, Level 2**, mapped to AgentBazaar's controls and the tests that check them. The matrix is reviewed at every release; a requirement only counts as met when a test or a reproducible check backs it. Requirement IDs refer to ASVS 4.0.3; the short titles are paraphrased, so check the standard for exact wording.

Status: **Met**, **Partial** (works with a known gap), **Gap** (not yet done), **Operator** (depends on how a store is deployed), **N/A**.

Test paths are relative to the repository root. `api/` means `apps/api/`.

## V1 Architecture and threat modelling

| ID | Requirement | Control | Evidence | Status |
| --- | --- | --- | --- | --- |
| 1.1.2 | Threat modelling for design changes | STRIDE model per module, reviewed per milestone | [threat-model.md](threat-model.md) | Met |
| 1.4.1 | Access control enforced at trusted points, never the client | Global auth guard and per-route requirements in the API; the web app holds no authority | `api/test/e2e/identity.e2e.spec.ts` | Met |
| 1.5.3 | Input validation on a trusted service layer | Zod schemas from `packages/contracts` on every route, tool and A2A part | `packages/contracts/src/contracts.spec.ts` | Met |
| 1.6.1 | Explicit key management policy | Four named keys with generation, storage and rotation procedures | [key rotation runbook](../runbooks/key-rotation.md) | Partial: rotation is manual |
| 1.11.2 | Business logic flows are safe under concurrency | Atomic reservations, row locks, single-use quotes, idempotency keys | `api/test/e2e/checkout.e2e.spec.ts` | Met |

## V2 Authentication

| ID | Requirement | Control | Evidence | Status |
| --- | --- | --- | --- | --- |
| 2.1.1 | Passwords at least 12 characters | Minimum is 10 characters with letters and numbers (`Password` in `packages/contracts/src/identity.ts`) | | **Gap**: raise to 12 |
| 2.1.7 | Check passwords against breached-password lists | Not implemented | | **Gap** |
| 2.2.1 | Anti-automation against brute force and stuffing | Lockout after 5 failures for 15 minutes, one generic error, per-IP rate limit | `identity.e2e.spec.ts` | Met |
| 2.4.1, 2.4.2 | Passwords stored with a salted, approved, slow hash | scrypt (N = 2^15, r = 8, p = 1) with a 16-byte random salt, NFKC-normalised input | `api/src/shared/crypto/primitives.ts` | Met |
| 2.8.1 | Time-based OTPs have a defined lifetime | TOTP for admins; enrolment must be verified before use | `identity.e2e.spec.ts` | Met |
| 4.3.1 (cross-ref) | MFA for administrative interfaces | Admin routes require an MFA-verified session | `identity.e2e.spec.ts` | Met |

## V3 Session management

| ID | Requirement | Control | Evidence | Status |
| --- | --- | --- | --- | --- |
| 3.2.1 | New session token on authentication | Fresh access and refresh tokens at login | `identity.e2e.spec.ts` | Met |
| 3.3.1 | Logout and expiry invalidate sessions | 15-minute access tokens; refresh tokens revocable | `identity.e2e.spec.ts` | Partial: access tokens stay valid until expiry |
| 3.4.1 to 3.4.3 | Cookies use `Secure`, `HttpOnly`, `SameSite` | Web session cookies are `HttpOnly`, `SameSite=Lax`, `Secure` in production | `apps/web/src/lib/session.ts` | Met |
| 3.5.2 | Session tokens rather than static API keys | Agents exchange client credentials for 15-minute bearer tokens | `identity.e2e.spec.ts` | Met |
| 3.5.3 | Stateless tokens protected against tampering and replay | EdDSA signatures with the algorithm pinned, issuer, audience, expiry and `jti`; quote tokens HMAC-signed per purpose with expiry and single use | `identity.e2e.spec.ts`, `checkout.e2e.spec.ts` | Met |
| 3.2.3 (cross-ref) | Refresh token reuse detection | Reusing a rotated refresh token revokes every session of the user | `identity.e2e.spec.ts` | Met |

## V4 Access control

| ID | Requirement | Control | Evidence | Status |
| --- | --- | --- | --- | --- |
| 4.1.1 | Access control enforced server-side | `@Auth()` requirement on every route; scopes per MCP tool (`MCP_TOOL_SCOPES`) | `identity.e2e.spec.ts`, `api/src/modules/agent/application/a2a-messages.spec.ts` | Met |
| 4.1.3 | Least privilege | Anonymous agents read-only; agent clients limited to granted scopes and quotas | `packages/config/src/index.spec.ts`, `identity.e2e.spec.ts` | Met |
| 4.1.5 | Access control fails securely | Missing scope returns 401 or 403 with a `WWW-Authenticate` challenge; no partial execution | `identity.e2e.spec.ts` | Met |
| 4.2.1 | Protection against IDOR | Negotiations, quotes and orders checked against the caller's subject or a hashed per-order token; foreign records look missing | `api/test/e2e/orders.e2e.spec.ts` | Met |
| 4.2.2 | Anti-CSRF for authenticated functionality | API uses bearer tokens (not sent automatically by browsers); web cookies are `SameSite=Lax` | `apps/web/src/lib/session.ts` | Partial: add an Origin check on state-changing web proxy routes |
| 4.3.1 | MFA on administrative interfaces | Role `admin` plus TOTP-verified session | `identity.e2e.spec.ts` | Met |

## V5 Validation, sanitisation and encoding

| ID | Requirement | Control | Evidence | Status |
| --- | --- | --- | --- | --- |
| 5.1.3 | Positive validation of all input | Strict Zod objects (unknown keys rejected), regexes for SKUs, GSTIN, PIN codes, phones | `packages/contracts/src/contracts.spec.ts` | Met |
| 5.1.4 | Structured data strongly typed | Integer paise for money, enums for states and scopes | `packages/contracts/src/money.spec.ts` | Met |
| 5.2.6 | SSRF protection | No user-supplied URL is ever fetched; outbound calls go only to configured gateway, LLM, OpenBao and AI-service URLs | Code review | Met |
| 5.3.4 | Parameterised database queries | Drizzle `sql` tagged templates everywhere; LLMs never write SQL | `api/test/integration/search.int.spec.ts` | Met |
| 5.3.1, 5.3.3 | Output encoding for the context | React escapes output; API returns JSON only; strict CSP | `apps/web/src/lib/seo/jsonld.test.ts` | Met |
| 5.1.x (domain) | Customization text treated as data | Rejects control, bidi and zero-width characters, look-alike scripts, emoji, markup and injection phrasing | `api/src/modules/customization/domain/validator.spec.ts` | Met |

## V6 Stored cryptography

| ID | Requirement | Control | Evidence | Status |
| --- | --- | --- | --- | --- |
| 6.1.1 | Regulated personal data encrypted at rest | Field-level AES-256-GCM per customer in the `pii` schema | `identity.e2e.spec.ts` | Met |
| 6.2.2, 6.2.5 | Proven algorithms and modes | AES-256-GCM, HMAC-SHA256, Ed25519, scrypt from Node's `crypto` and `jose` | `api/src/shared/crypto/` | Met |
| 6.2.6 | Unique nonces and IVs | Fresh 96-bit random IV per encryption; associated data binds customer and field | `api/src/shared/crypto/primitives.ts` | Met |
| 6.3.1 | Cryptographically secure randomness | `crypto.randomBytes` for keys, tokens and salts | Code review | Met |
| 6.4.1, 6.4.2 | Key management and isolation from the application | Lite: keys from the environment. Growth and scale: data keys wrapped by OpenBao Transit, so the master key never enters the app | `api/src/modules/pii/infrastructure/openbao-wrapper.ts` | Partial in lite, Met in growth |

## V7 Error handling and logging

| ID | Requirement | Control | Evidence | Status |
| --- | --- | --- | --- | --- |
| 7.1.1, 7.1.2 | No credentials, payment details or sensitive personal data in logs | Redaction before logging, tracing and analytics; metrics labelled by route pattern, never the raw URL | `api/src/shared/observability/redact.spec.ts`, `api/src/modules/analytics/domain/sanitize.spec.ts` | Met |
| 7.1.3 | Security events logged | Admin decisions and agent-client creation in `audit_log`; request logs for failures | Code review | Partial: add explicit auth-failure and access-denied events |
| 7.3.1 | Protection against log injection | Structured JSON logs; caller request ids validated | Code review | Met |
| 7.4.1 | Generic error messages with a reference id | `{ error: { code, message, requestId } }`; internals never returned | Code review | Met |

## V8 Data protection

| ID | Requirement | Control | Evidence | Status |
| --- | --- | --- | --- | --- |
| 8.3.1 | Sensitive data not sent in query strings | Checkout, order and payment capability tokens use the `t` query parameter (hashed at rest, stripped from analytics paths and metrics) | | **Partial**: move tokens to a header or POST body, or keep them single-use and short-lived |
| 8.3.2 | Users can export and delete their data | `GET /api/v1/me/export`, `POST /api/v1/me/erase` (crypto-shredding) | `identity.e2e.spec.ts` | Met |
| 8.3.4 | Sensitive data identified with a handling policy | Data map and retention schedule | [data map](../compliance/data-map.md), [retention](../compliance/retention-schedule.md) | Met |
| 8.3.8 | Retention with automatic deletion | Scheduled retention sweep for inactive guest customers | Code review | Partial: other tables follow the retention schedule's manual steps |

## V9 Communications

| ID | Requirement | Control | Evidence | Status |
| --- | --- | --- | --- | --- |
| 9.1.1 | TLS for all client connections | Caddy obtains certificates automatically; HSTS | `deploy/compose/Caddyfile` | Operator |
| 9.2.2 | Encrypted connections to back-end services | Lite runs Postgres and Valkey on a private Docker network on one host; growth and scale use TLS to managed services | | Operator |

## V10 to V14 Malicious code, business logic, files, APIs and configuration

| ID | Requirement | Control | Evidence | Status |
| --- | --- | --- | --- | --- |
| 10.3.2 | Integrity protection for releases | Cosign-signed images, SBOM and build provenance | `.github/workflows/release.yml` | Met |
| 11.1.3 | Per-user limits on business actions | Negotiation rounds per band, per-agent quotas, token and spend budgets per conversation | `api/src/modules/agent/domain/budget.spec.ts`, `api/src/modules/pricing/domain/policy.spec.ts` | Met |
| 11.1.4 | Anti-automation against excessive calls | Rate limits, agent quotas, stock display capped at 50 | `packages/config/src/index.spec.ts` | Partial: no bot management in lite |
| 11.1.5 | Business-logic limits against likely threats | Guarded floor, single-use quotes, human approval for large discounts | `policy.spec.ts`, `checkout.e2e.spec.ts` | Met |
| 11.1.6 | No time-of-check to time-of-use races | Conditional reservation updates, `FOR UPDATE` row locks, `UPDATE … RETURNING` quote consumption | `checkout.e2e.spec.ts`, `orders.e2e.spec.ts` | Met |
| 11.1.8 | Alerting on automated attacks or unusual activity | Prometheus metrics; alert rules and SIEM arrive with growth and scale | | Partial |
| 12.x | File upload and resource handling | No file uploads anywhere; designs come from the catalog | | N/A |
| 13.1.3 | API URLs carry no secrets | See 8.3.1 | | Partial |
| 13.1.5 | Unexpected content types rejected | Fastify content-type parsing with Zod validation | Code review | Met |
| 13.2.6 | Webhooks verified | HMAC over the raw body, event-id deduplication, forward-only status, amount and currency checks | `orders.e2e.spec.ts` | Met for mock and YouPI-PG; Razorpay against fixtures only |
| 14.2.1 | Components kept up to date | Renovate, OSV-Scanner and Trivy in CI | `.github/workflows/security.yml`, `renovate.json` | Met |
| 14.2.5 | Inventory of third-party components | SBOM per release, licence gate | `release.yml`, `scripts/license-check.mjs` | Met |
| 14.3.3 | No version information in responses | Caddy removes `Server`; Next.js `poweredByHeader: false` | `deploy/compose/Caddyfile`, `apps/web/next.config.ts` | Met |
| 14.4.3 to 14.4.7 | Security headers | CSP (`default-src 'none'` on the API, nonce-based on pages), `nosniff`, HSTS, `Referrer-Policy`, `frame-ancestors 'none'` / `X-Frame-Options: DENY` | `apps/web/src/lib/security/csp.ts` | Met |
| 14.5.3 | Strict CORS allow list | `CORS_ORIGINS`, defaulting to the storefront origin only | `packages/config/src/index.spec.ts` | Met |

## LLM-specific controls (OWASP Top 10 for LLM Applications)

| Risk | Control | Evidence |
| --- | --- | --- |
| Prompt injection | Escalate-only router; prices only from the policy engine; buyer text passed as data | `agent/domain/router.spec.ts` |
| Sensitive information disclosure | No secrets in prompts; output guard for numbers, PII, links and secret terms | `agent/domain/guard.spec.ts` |
| Excessive agency | Agents cannot pay; a person confirms on the checkout page; tool scopes | `checkout.e2e.spec.ts` |
| Unbounded consumption | Per-intent token caps, per-session token and spend budgets, quotas | `agent/domain/budget.spec.ts` |
| Misinformation | Template wording for every outcome; numbers checked; evaluation suite before release | `agent/domain/guard.spec.ts` |
