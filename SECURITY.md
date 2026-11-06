# Security policy

AgentBazaar handles prices, payments and personal data, and lets untrusted AI agents talk to a store. We take reports seriously and will work with you to fix problems before they are disclosed.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub's private vulnerability reporting:

1. Go to <https://github.com/mukulkathuria/AgentBazaar/security/advisories/new> (or the repository's **Security** tab, then **Report a vulnerability**).
2. Describe the issue, the affected version or commit, and the steps to reproduce. A proof of concept against a local `pnpm demo` or the Docker demo profile is ideal.
3. Tell us how you would like to be credited, if at all.

If you cannot use private vulnerability reporting, open a public issue titled "Security contact request" with no details, and a maintainer will open a private advisory with you.

## What to expect

These are our targets as a small, volunteer-run project. We will tell you if we expect to miss one.

| Step | Target |
| --- | --- |
| Acknowledge your report | within 3 business days |
| Initial assessment and severity (CVSS) | within 10 business days |
| Fix released for a critical issue | within 30 days of confirmation |
| Fix released for a high issue | within 60 days of confirmation |
| Medium and low issues | in a following release |
| Public disclosure | after a fix is available, coordinated with you, and no later than 90 days after your report unless we agree otherwise |

We publish a GitHub security advisory for every confirmed issue, request a CVE where appropriate and credit reporters who want credit. There is no paid bug bounty yet; one may be considered after the first stable release.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Latest `0.9.x` release candidate | Yes |
| Anything older | No: please upgrade |

## Scope

In scope: everything in this repository, including `apps/api`, `apps/web`, `apps/demo`, `services/ai`, `packages/*` and the deployment configuration in `deploy/`. We are especially interested in:

- **Pricing integrity:** any way to obtain a quote or an order below the guarded price floor, to forge, tamper with, replay or reuse a quote, or to make the seller agent reveal a floor, cost or margin.
- **The agent surface (MCP, A2A, chat):** prompt injection that changes a price, a permission, a tool's behaviour or what another customer sees; system-prompt or policy extraction; a model-written reply that gets an invented number past the output guard; abuse of scopes or per-agent quotas.
- **Personal data:** access to another customer's orders, addresses, consents or chat transcripts (IDOR), PII in logs, traces or analytics, and erasure that leaves recoverable data.
- **Payments:** forged, replayed or reordered webhooks that change an order, amount or currency mismatches that are accepted, and checkout tokens that can be guessed or reused.
- **Authentication and authorisation:** token forgery, admin actions without an MFA-verified session, privilege escalation, CSRF, SSRF, injection and path traversal.
- **Supply chain:** a malicious dependency path, or a build or release workflow that can be abused.

Out of scope:

- Findings that need `DEMO_MODE=true`. Demo mode deliberately gives anonymous agents every scope, refuses to run with real payment adapters, and must never be used for a real store.
- Vulnerabilities in third-party services we integrate with (Razorpay, YouPI-PG, LLM providers, Keycloak and others). Report those to their maintainers; do tell us if our integration makes them worse.
- Volumetric denial of service, spam and social engineering of maintainers or users.
- A model saying something rude or off-topic with no security impact. Please still open a normal issue so we can improve the guard or the router.
- Missing hardening headers or best practices without a demonstrated impact.

## Safe harbour

We will not pursue legal action against anyone who, in good faith, follows this policy: tests only against their own local or self-hosted instance (never a store run by someone else without its owner's permission), avoids privacy violations and data destruction, does not degrade other people's service, and gives us reasonable time to fix the issue before disclosure.

## Before you run AgentBazaar with real money

The security controls are documented in the [threat model](docs/security/threat-model.md) and the [OWASP ASVS mapping](docs/security/asvs.md). They are not a substitute for an **independent penetration test and design review of the payment and agent flows**, which every operator should commission before taking real payments. Switching payment adapters to live keys is always a human decision.
