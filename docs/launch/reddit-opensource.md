# r/opensource draft

Status: DRAFT. Before posting: check the subreddit's current rules on project announcements, and make sure
`CONTRIBUTING.md`, `GOVERNANCE.md` and the issue labels mentioned below exist on `main`.

## Title

`AgentBazaar: an MIT-licensed commerce platform for the agent era, with a strict dependency licence gate`

## Body

AgentBazaar is an open-source store where people and AI agents shop and negotiate (over MCP and A2A)
inside price floors that are enforced in code, not in a prompt. It is MIT-licensed (copyright 2026 Mukul
Kathuria) and meant to be self-hosted by anyone.

A few choices that may interest this community:

**Licences are checked, not assumed.** A CI gate (`scripts/license-check.mjs`) fails the build if a
production dependency is not on the allow-list: MIT, Apache-2.0, BSD, ISC, PostgreSQL, MPL-2.0 and a few
similar. AGPL or GPL tools may only run as separate services, never linked into the code, and
source-available licences (BSL, SSPL, Elastic and similar) are refused. That is why the stack uses Valkey,
OpenBao, Apache Kafka and SeaweedFS rather than their better-known alternatives. Third-party notices are in
`NOTICE`, and model licences are recorded in `MODELS.md`.

**Every tier is real code.** Instead of "enable this later" comments, a `PROFILE` setting (lite, growth,
scale) chooses adapters behind ports, and each profile has its own tests.

**Docs are part of the product.** Architecture decision records, a threat model, an OWASP ASVS mapping,
runbooks, a compliance pack for India's DPDP Act (with legal drafts clearly marked as drafts) and a
benchmark method anyone can rerun.

Ways to contribute, with documented interfaces:

- Payment adapters behind `PaymentPort` (Cashfree, PayU, Stripe, ...)
- Tax adapters for countries other than India (GST is the first)
- LLM, search and storage adapters
- Translations beyond English and Hindi
- Adversarial prompts for the seller-agent evaluation suite
- Docs, examples and bug reports with a failing test

How decisions are made and how to get started are in `GOVERNANCE.md` and `CONTRIBUTING.md`. Issues labelled
`good first issue` are a good starting point.

Status: v0.9 lite release candidate; the growth and scale tiers are still being finished.

Try it without keys: `git clone https://github.com/mukulkathuria/AgentBazaar && cd AgentBazaar && pnpm install && pnpm demo`

Repository: https://github.com/mukulkathuria/AgentBazaar
