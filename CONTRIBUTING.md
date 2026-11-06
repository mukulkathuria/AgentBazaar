# Contributing to AgentBazaar

Thanks for helping. Bug reports, docs fixes, tests and new adapters are all welcome. This guide covers setup, how we work, and the rules the build enforces, so your pull request goes through on the first try.

- Be kind: everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Found a vulnerability? Do **not** open an issue. Follow [SECURITY.md](SECURITY.md).
- Planning something large (a new module, a new profile service, a change to pricing or payments)? Open an issue first so we can agree on the approach, and expect to write an [ADR](#architecture-decision-records).

## Setup

| Tool | Version |
| --- | --- |
| Node.js | 22.12 or newer (`.nvmrc` pins 24) |
| pnpm | 12 (`npm install -g pnpm@12`) |
| Python + [uv](https://docs.astral.sh/uv/) | 3.12+, only for `services/ai` |
| Docker with Compose v2 | only for the full stack and profile services |

```bash
git clone https://github.com/mukulkathuria/AgentBazaar && cd AgentBazaar
pnpm install
pnpm build          # workspace packages export ./dist, so build once before testing
pnpm test           # unit and property tests
pnpm demo           # the end-to-end demo: store on PGlite, buyer agent over MCP, mock payment
```

Run the API against embedded Postgres while you work. No database server is needed:

```bash
DATABASE_DRIVER=pglite PGLITE_DATA_DIR=./data/dev.pglite pnpm --filter @agentbazaar/api dev
```

The API reads settings from the process environment only; it does not load `.env` files. For the Python service:

```bash
cd services/ai && uv sync && uv run pytest && uv run ruff check && uv run mypy
```

Tests use PGlite by default. Set `TEST_DATABASE_URL` to a Postgres URL (for example the `pgvector/pgvector:pg18` image) to run integration and end-to-end suites against a real server, as CI does. If your machine is short on memory, lower `VITEST_MAX_WORKERS`: each PGlite instance takes roughly 100 MB.

## How we work

Every change follows the same loop, whoever (or whatever) writes it:

1. Read the milestone or issue, its definition of done, and the relevant ADRs.
2. **Write failing tests first**, including the negative cases: invalid input, wrong scope, replay, race.
3. Make the smallest change that passes.
4. Refactor for clarity, complexity limits and module boundaries.
5. Run the suites for what you touched (`pnpm test`, `pnpm test:int`, `pnpm test:e2e`, `pnpm lint`, `pnpm typecheck`).
6. Open a pull request with evidence: what you ran, the results, and any benchmark change.

A bug fix starts with a regression test that reproduces the bug. A feature is finished when its tests, security checks and performance budgets pass in CI, not before.

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org). The scope is usually the module or package.

```text
feat(pricing): offer a delivery-speed trade alongside volume tiers
fix(payments): ignore a webhook whose currency differs from the order
test(inventory): 1,000 concurrent reservations for 10 units
docs(readme): explain the guarded floor with the demo keyboard
refactor(search)!: rename SearchPort.count to SearchPort.size
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `revert`. Mark breaking changes with `!` and a `BREAKING CHANGE:` footer. Add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) for anything a user or operator would notice.

### Pull requests

- One logical change per pull request. Fill in the [template](.github/PULL_REQUEST_TEMPLATE.md): it mirrors the merge gates.
- CI must be green: build, lint, types, module boundaries, unit, integration, end-to-end, generated contracts, licences, secrets and dependency scans, and the README quickstart.
- At least one maintainer review. Changes to pricing, quotes, payments, PII, identity or the agent surface need a second look and negative tests.
- We squash-merge, so the pull request title becomes the commit message: make it a conventional commit.

## Code rules the build enforces

- **TypeScript `strict`**, with `noUncheckedIndexedAccess`. No `any`. No floating promises.
- **Size and complexity limits:** cyclomatic complexity 15, nesting depth 4, 8 parameters, 500 lines per file (tests excepted).
- **Money is integer paise** plus a currency. Never use floats for amounts; convert agent-facing rupees with `rupeesToPaise()` from `@agentbazaar/contracts`.
- **Every public interface has a Zod schema** in `packages/contracts`. REST validation, MCP tool schemas, A2A parts and the OpenAPI document all come from it. Generated files are never edited by hand: run `pnpm contracts:generate` and commit the output.
- **Migrations are append-only.** Add a new numbered file in `apps/api/migrations`; the migrator refuses to run if an applied file changed.
- **Policy lives in code.** Prices, floors, discounts, stock and expiry are decided by services. Floors, costs, margins and other customers' data never go into a prompt, a tool result or a log line. Text from buyers, buyer agents and customization fields is data, never instructions.

### Module boundaries

`apps/api` is a modular monolith. Each module under `apps/api/src/modules/<name>` has four layers: `domain` (rules, no framework), `application` (use cases), `infrastructure` (adapters) and `interfaces` (REST, MCP, A2A handlers). [dependency-cruiser](.dependency-cruiser.cjs) fails `pnpm lint` when:

| Rule | Meaning |
| --- | --- |
| `no-circular` | No import cycles anywhere in `apps/api/src` |
| `module-internals-are-private` | Another module is used only through its public `index.ts` |
| `domain-is-framework-free` | `domain` imports no NestJS, Drizzle, Fastify, pg, PGlite, MCP, A2A, BullMQ, NATS or Kafka |
| `domain-does-not-reach-out` | `domain` never imports its own `application`, `infrastructure` or `interfaces` |
| `shared-does-not-depend-on-modules` | `apps/api/src/shared` never imports a module |

Modules never read each other's tables. They call a public service or react to a domain event from the outbox. Run `pnpm depcruise` to check locally.

### Tests

| Kind | Location | Runs with |
| --- | --- | --- |
| Unit and property (fast-check) | next to the code, `src/**/*.spec.ts` | `pnpm test` |
| Integration | `apps/api/test/integration` | `pnpm test:int` |
| End-to-end, contract, negative, regression | `apps/api/test/{e2e,contract,negative,regression}` | `pnpm test:e2e` |
| Web journeys and accessibility | `apps/web/e2e` | `pnpm --filter @agentbazaar/web test:e2e` |
| Python | `services/ai/tests` | `uv run pytest` |
| Load | `tests/load` | `k6 run tests/load/lite.js` |

Tag each suite with the profiles it covers in its `describe` name: `@lite`, `@growth` or `@scale`. Prefer property tests for anything with arithmetic or a state machine. Coverage of domain and application code must stay at or above 85% of lines and 80% of branches.

## Architecture decision records

A significant choice (a new dependency or service, a change to a port, a security or data-model decision) gets an ADR in [docs/adr](docs/adr):

1. Copy the template in [docs/adr/README.md](docs/adr/README.md) to `docs/adr/NNNN-short-title.md` with the next free number.
2. Fill in context, decision, alternatives and consequences. Status starts as `Proposed`.
3. Open the pull request with the ADR and, ideally, the code. The status becomes `Accepted` when it merges.
4. Never rewrite an accepted ADR. Supersede it with a new one and link both ways.

## Adding an adapter

Every external dependency sits behind a port, so most extensions are one class plus configuration, tests and docs.

### Payment gateway

1. Implement `PaymentPort` from [`apps/api/src/modules/payments/domain/payment-port.ts`](apps/api/src/modules/payments/domain/payment-port.ts): `name`, `capabilities` (`autoConfirm`, `refunds`, `maxConcurrency`), `createPayment`, `parseWebhook` and `refund`.
2. `parseWebhook` must verify the signature over the **raw body** with a constant-time comparison, throw `InvalidSignatureError` on any doubt, reject stale deliveries, and return the provider's event ID so the service can deduplicate.
3. Add the name to `PAYMENT_ADAPTER` and its required variables to `checkPayments` in [`packages/config`](packages/config/src/index.ts), to `PaymentProvider` in `packages/contracts`, and to the factory in `payments.module.ts`. A new provider value also needs a migration for the `payments.provider` check constraint.
4. Run the shared payment contract tests against recorded fixtures: tampered, replayed, stale and out-of-order webhooks, amount mismatch (409), duplicate deliveries.
5. Document setup in the README, and say plainly whether it was verified against the provider's sandbox.

### Tax rules

GST is the first tax implementation, in [`apps/api/src/modules/tax`](apps/api/src/modules/tax). Its contract: given a tax-inclusive line total and a rate, return the taxable value and tax lines whose parts add up to the exact total in paise, plus gap-free invoice numbering per financial year. Another country's rules should keep that shape, live in the tax module's `domain`, be selected by configuration, and come with property tests for the exact-sum invariant. A formal `TaxPort` is extracted when the second implementation lands; open an issue to coordinate.

### LLM provider

1. Implement `LlmPort.compose()` from [`apps/api/src/modules/agent/domain/ports.ts`](apps/api/src/modules/agent/domain/ports.ts). The adapter only rephrases `fallback` using `facts`, respects `maxTokens`, and **never throws**: on any failure it returns the template result.
2. Do not bypass the output guard. Any reply containing a number outside `allowedNumbers`, a link, contact details, personal data or floor and margin talk is replaced with the template.
3. Add the adapter to `LLM_ADAPTER` and its required variables to `checkServices` in `packages/config`.
4. Record the model and its licence in [MODELS.md](MODELS.md).

### Search engine

1. Implement `SearchPort` (`upsert`, `remove`, `search`, `count`) from [`apps/api/src/modules/search/application/ports.ts`](apps/api/src/modules/search/application/ports.ts). The index is fed from the outbox by `SearchIndexer` and rebuilt by `cli reindex`.
2. Add it to `SEARCH_ADAPTER` (and to `PROFILE_DEFAULTS` if a profile should use it by default) with its required variables.
3. It must pass the golden queries in `apps/api/test/regression/search-golden.e2e.spec.ts` with recall at least equal to the Postgres adapter.

## Docs and diagrams

Update the README or `docs/` in the same pull request as a behaviour change. Mermaid diagrams live in `docs/diagrams/*.mmd`; run `pnpm docs:sync` after editing one, and CI runs `pnpm docs:check`. Never put a measured number in the docs without the run that produced it; use a `<!-- METRIC:name -->TBD<!-- /METRIC -->` marker until then.

## Licensing of contributions

AgentBazaar is MIT-licensed, and contributions are accepted under the same licence ("inbound = outbound"); there is no CLA. New dependencies must pass `pnpm license:check`: MIT, Apache-2.0, BSD, ISC, PostgreSQL and MPL-2.0 are allowed. AGPL and GPL tools may only run as separate services, never linked into the code, and source-available licences (BSL, SSPL, FSL, Elastic) are not allowed. Never commit secrets or real personal data; use the synthetic generator in `@agentbazaar/testkit`.

## Getting help

Open a GitHub issue with the `question` label, or start from the issue templates. Maintainers and roles are described in [GOVERNANCE.md](GOVERNANCE.md).
