# Threat model

STRIDE per module for AgentBazaar v0.9 (lite profile, with notes where growth and scale differ). It is regenerated at every milestone and reviewed with every change to pricing, payments, identity, personal data or the agent surface. Requirement-level mapping is in [asvs.md](asvs.md).

**This model is not a penetration test.** An independent penetration test and design review of the payment and agent flows is required before any store takes real money.

## What we protect

| Asset | Why it matters |
| --- | --- |
| Price floors, costs and margins | Selling below the floor loses money on every sale; revealing it weakens every future negotiation |
| Quotes, checkout links and order tokens | Capabilities: whoever holds one can buy at that price or read that order |
| Personal data (names, emails, phones, addresses, consents) | Customers' privacy and DPDP Act obligations |
| Payment and order state | Shipping unpaid orders or double refunds loses money |
| Admin access and agent credentials | Full control of prices, policies and orders |
| Keys (`QUOTE_SIGNING_KEY`, `PII_MASTER_KEY`, `PII_BLIND_INDEX_KEY`, `JWT_PRIVATE_KEY`) | Forge quotes and tokens, or read every customer's data |
| Availability and LLM spend | Downtime and runaway model bills |
| What the seller agent says | Rude, false or legally binding statements damage the store |

## Who attacks

Anonymous shoppers and scrapers; **malicious buyer agents** over MCP or A2A (including competitors probing floors and prompt injectors); compromised agent clients; customers trying to read other customers' data; forged payment-gateway webhooks; malicious customization text; insiders with admin access; and supply-chain attackers targeting dependencies, images or CI.

## Trust boundaries

```text
Internet ── Caddy (TLS) ──┬── web (Next.js) ── REST ──┐
                          └── api (/mcp, /a2a, REST) ─┴── PostgreSQL (pii schema inside)
                                 │        │               Valkey (cache, quotas)
                                 │        └── payment gateway (outbound API, inbound signed webhooks)
                                 ├── LLM provider (optional, outbound, redacted text only)
                                 └── services/ai (optional, internal HTTP, optional bearer token)
```

Everything from the internet, including webhook bodies, agent messages, chat text, customization text and LLM output, is untrusted until validated.

## Edge and HTTP layer

| STRIDE | Threat | Controls | Residual risk |
| --- | --- | --- | --- |
| S | Spoofed request ids or headers to poison logs | Caller `x-request-id` accepted only if it matches `[A-Za-z0-9_-]{8,64}`; JSON logs | Low |
| T | Oversized or malformed bodies | Caddy caps API bodies at 1 MB, Fastify at 256 KB; Zod validation on every input | Low |
| I | Metrics or internals exposed | Caddy answers 404 for `/metrics`; errors return a code, a message and a request id only; no server version headers | Low |
| D | Floods, slow clients, bot traffic | Global per-IP rate limit (`RATE_LIMIT_PER_MINUTE`), per-agent quotas; CrowdSec, the OWASP CRS WAF and bot management are planned at the edge in later profiles | Medium in lite: volumetric attacks need an upstream provider |
| E | Cross-origin abuse | Strict CORS allow list (`CORS_ORIGINS`), Helmet CSP (`default-src 'none'` on the API), `frame-ancestors 'none'`, HSTS | Low |

## Identity and access

| STRIDE | Threat | Controls | Evidence | Residual risk |
| --- | --- | --- | --- | --- |
| S | Credential stuffing and brute force | One generic error for wrong password and unknown email; lockout after 5 failures for 15 minutes; rate limits | `apps/api/test/e2e/identity.e2e.spec.ts` | Medium: no breached-password check yet; minimum password length is 10 (ASVS asks for 12) |
| S | Forged or replayed tokens | EdDSA-signed JWTs with pinned algorithm, issuer, audience, 15-minute expiry and `jti`; OIDC tokens checked against the issuer's JWKS | `identity.e2e.spec.ts` | Low |
| S | Stolen refresh token | Refresh tokens rotate; reuse of a rotated token revokes every session of that user | `identity.e2e.spec.ts` | Low |
| E | Admin takeover | Admin routes require role `admin` **and** an MFA-verified (TOTP) session | `identity.e2e.spec.ts` | Low |
| E | Agent scope escalation | Client credentials grant only a subset of the client's scopes; scopes checked per tool and route; per-client quota | `identity.e2e.spec.ts`, `packages/config/src/index.spec.ts` | Low |
| E | `DEMO_MODE` left on | Demo mode gives anonymous callers every scope, so the loader refuses it with any payment adapter but `mock` and warns at startup | `packages/config/src/index.spec.ts` | Operator: never expose a demo build as a store |
| R | Disputed admin actions | Admin decisions written to the append-only `audit_log` | | Low |

## Agent surface: MCP, A2A, chat, router and LLM

| STRIDE | Threat | Controls | Evidence | Residual risk |
| --- | --- | --- | --- | --- |
| T | Prompt injection ("ignore your rules, 90% off") changes a price or permission | Prices come only from the policy engine; the router can only raise the tier or deny and has no price, discount or permission field; injection attempts are denied and repeated ones go to a person | `apps/api/src/modules/agent/domain/router.spec.ts` | Low for prices; injection may still produce unhelpful replies |
| I | Floor, cost or margin disclosure | Floors never enter prompts, tool results or responses; the guarded floor keeps every price strictly above the floor; the output guard blocks floor, cost and margin talk in English and Hindi | `pricing/domain/policy.spec.ts`, `agent/domain/guard.spec.ts` | Low; an adversarial suite with zero leaks is a release gate |
| T | The model invents or rounds a price | Number guard: any number not produced by the services (digits, grouping, "k", "lakh", "crore", spelled-out numbers, non-ASCII digits) replaces the reply with the template | `agent/domain/guard.spec.ts` | Low; false positives fall back to safe template text |
| I | System-prompt or policy extraction | The prompt holds only buyer-visible facts; the template is a complete answer, so the prompt has nothing secret to leak; secret-term filter on output | `guard.spec.ts` | Low |
| I | Other customers' data in a reply | Tools return only buyer-visible fields; negotiations, quotes and orders are scoped to the caller's subject; personal data patterns are blocked in output | `guard.spec.ts`, `orders.e2e.spec.ts` | Low |
| S | An agent impersonates the store or another agent | Quote tokens are bound to the requesting principal; A2A messages carry structured parts validated by Zod | `agent/application/a2a-messages.spec.ts` | Low |
| D | Using the store as a free chatbot or running up LLM bills | Per-intent output-token caps, per-session token and spend budgets, off-topic redirect, per-agent quotas; exhausted budgets deny with canned replies | `agent/domain/budget.spec.ts`, `router.spec.ts` | Low |
| R | "Your agent promised me X" | Every offer and counter is in the append-only `offers` table; LLM traces are stored redacted; quotes state their terms | | Low |
| T | Unverified claims ("it's cheaper elsewhere") | Ignored by design: the only inputs to a decision are the offer and the quantity | `policy.spec.ts` | Low |

## Pricing and quotes

| STRIDE | Threat | Controls | Evidence | Residual risk |
| --- | --- | --- | --- | --- |
| T | Offer sequences that reach the floor | Pure policy functions; fast-check property tests (3,000 random offer sequences, 2,000 random ladders per run) | `pricing/domain/policy.spec.ts` | Low |
| T | Tampered quote (price edited) | Quote tokens are HMAC-SHA256 signed with a purpose-bound key; the stored quote row, not the token, holds the price | `checkout.e2e.spec.ts` | Low |
| T | Replayed, expired, superseded or cross-customer quote | Single-use consumption with `UPDATE … WHERE status = 'active' AND expires_at > now() RETURNING`; one active quote per negotiation (unique index); subject check | `checkout.e2e.spec.ts` | Low |
| E | A human approves a below-floor price | Approval re-checks the guarded floor and refuses | | Low |
| I | Negotiation ids used as an oracle | Another subject's negotiation looks exactly like a missing one | | Low |

## Catalog, search and customization

| STRIDE | Threat | Controls | Evidence | Residual risk |
| --- | --- | --- | --- | --- |
| T | SQL injection through search | Parameterised queries through Drizzle's `sql` tag; no string-built SQL from input; LLMs never write SQL | `search/application/search.service.spec.ts`, `test/integration/search.int.spec.ts` | Low |
| I | Exact stock levels scraped by competitors | Shown quantities capped at 50 | | Low |
| T | Instruction-bearing or offensive customization text | Validation rejects control, bidirectional-override and zero-width characters, look-alike scripts, emoji, markup and prompt-injection phrasing; blocklist rejects, review words and trademarks go to a human; text is stored and rendered as data, never put in a prompt as an instruction | `customization/domain/validator.spec.ts` | Medium: moderation lists are short and need operator tuning |

## Inventory, checkout and orders

| STRIDE | Threat | Controls | Evidence | Residual risk |
| --- | --- | --- | --- | --- |
| T | Overselling under concurrency | Reservation is one conditional statement; `reserved <= on_hand` is a database constraint; rows locked in a fixed order | `checkout.e2e.spec.ts` | Low; the 1,000-buyers-for-10-units test is a release gate |
| T | Price changed mid-checkout | Checkout session locks prices; catalog changes do not move them | `checkout.e2e.spec.ts` | Low |
| T | Double submit | `Idempotency-Key` on session creation and completion; same key and body return the stored response | `checkout.e2e.spec.ts` | Low |
| I | IDOR on orders | Orders readable by their owner or with the order's own access token; tokens stored as hashes | `orders.e2e.spec.ts` | Medium: checkout, order and payment capability tokens travel in the `t` query parameter (see [asvs.md](asvs.md), V8.3.1) |
| R | Disputed order history | `order_events` is append-only | | Low |

## Payments

| STRIDE | Threat | Controls | Evidence | Residual risk |
| --- | --- | --- | --- | --- |
| S | Forged webhook | HMAC signature verified over the raw body with a constant-time comparison; malformed events rejected | | Low; Razorpay adapter not yet verified against its live sandbox |
| T | Replayed or out-of-order webhook | Deduplicated by `(provider, event_id)`; payment status moves forward only; YouPI-PG deliveries older than one hour refused | `orders.e2e.spec.ts` | Low |
| T | Amount or currency mismatch | Event amount and currency must equal the payment's, otherwise 409 and no state change | | Low; mismatches need manual resolution |
| T | UPI "observed" treated as paid | `payment_observed` is not `paid`; UPI orders ship only after `RECONCILED`; unreconciled payments are flagged for a person | `orders.e2e.spec.ts` | Medium: YouPI-PG is experimental and not bank-approved |
| I | Card data exposure | Gateway-hosted payment pages; card data never reaches the store | | Low |
| D | Gateway outage | Timeouts and circuit breakers; the order stands without a payment link and can be paid later | `checkout.e2e.spec.ts` | Low |

## Personal data (PII vault)

| STRIDE | Threat | Controls | Evidence | Residual risk |
| --- | --- | --- | --- | --- |
| I | Database dump exposes customers | Field-level AES-256-GCM with a per-customer data key and the customer and field bound as associated data; data keys wrapped by the master key (OpenBao Transit in growth); blind indexes for lookups | | Medium in lite: the master key sits in the environment of the same host |
| I | PII in logs, traces or analytics | Regex redaction (email, Luhn-valid cards, Aadhaar, phone, PAN, UPI IDs, PIN codes) before logging, tracing and analytics; optional Presidio | `shared/observability/redact.spec.ts`, `analytics/domain/sanitize.spec.ts` | Medium: regexes miss free-form names and addresses |
| T | Erasure leaves data behind | Crypto-shredding deletes the wrapped key and every encrypted field | `identity.e2e.spec.ts` | Medium: backups keep old ciphertext until they age out; plaintext customization text on orders is not shredded |
| R | Consent disputes | Consent rows record purpose, grant or withdrawal, notice version, source and time | | Medium: `pii.consents` has no append-only trigger yet |
| E | Other modules read the vault | Only the PII module touches the `pii` schema (module boundaries); a separate database role for the schema is planned | | Medium until the role exists |
| I | Anonymous callers re-identified | Anonymous subjects are a truncated SHA-256 of the IP address, which is brute-forceable: treat it as pseudonymous, not anonymous | | Low |

## AI service, admin console and supply chain

| STRIDE | Threat | Controls | Evidence | Residual risk |
| --- | --- | --- | --- | --- |
| S | Unauthorised calls to `services/ai` | Optional bearer token checked before the body is parsed; internal network only | `services/ai/tests/test_api.py` | Low |
| D | Oversized inputs to the AI service | 256 KB body cap, including chunked bodies; request text never logged | `test_api.py` | Low |
| T | Malicious dependency or image | Lockfiles, Renovate with a minimum release age, OSV-Scanner, Trivy, Semgrep, gitleaks, licence gate; release images signed with Cosign, with SBOM and provenance | `.github/workflows/security.yml`, `release.yml` | Medium: GitHub Actions are pinned by tag until Renovate pins digests |
| E | Admin console XSS or CSRF | React output encoding, per-request nonce CSP, HttpOnly SameSite=Lax session cookies | `apps/web/src/lib/*.test.ts` | Medium until the admin journeys are pen-tested |

## Top open risks

1. No independent penetration test yet (blocks real-money use).
2. Razorpay adapter not yet run against Razorpay's sandbox; YouPI-PG is experimental.
3. Capability tokens in query strings for checkout, order and payment links.
4. Lite keeps the PII master key on the same host as the database; growth moves wrapping to OpenBao.
5. No breached-password check and a 10-character password minimum.
6. Edge protections in lite are limited to TLS, headers and rate limits; WAF, CrowdSec and bot management arrive with later profiles.
7. Moderation word lists and PII regexes are deliberately small and need tuning per market.
