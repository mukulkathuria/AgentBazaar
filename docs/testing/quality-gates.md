# Quality gates: coverage and mutation testing

**Status: measured on 2026-11-06 to 2026-11-08, on a Windows 11 laptop (embedded PGlite,
`VITEST_MAX_WORKERS=2`) and in GitHub Actions (`ubuntu-latest`, 4 vCPUs); each number says which.** This
page covers two of the merge gates in the development plan:

| Gate (plan) | Threshold | Enforced by |
| --- | --- | --- |
| Unit coverage (domain and application) | at least 85% lines, 80% branches | [`Quality`](../../.github/workflows/quality.yml) workflow, job *Coverage gate*, every push and pull request |
| Mutation score | at least 80% on pricing, inventory, quotes and the order state machine | `Quality` workflow, job *Mutation gate (critical scope)*, every push and pull request |
| Mutation score | at least 70% on all domain and application code | [`Mutation (full scope)`](../../.github/workflows/mutation.yml) workflow, job *Mutation gate (all domain and application code)*: nightly, on dispatch, and on pushes that change the mutation setup |

Both gates fail the build below their threshold. Every number below comes from a run; nothing is
estimated.

## Coverage

### What is measured, and why the in-process suites

The gate covers `apps/api/src/modules/**/domain/**`, `apps/api/src/modules/**/application/**` and
`apps/api/src/shared/**` (spec files and `index.ts` barrels excluded), as configured in
[`apps/api/vitest.config.ts`](../../apps/api/vitest.config.ts).

Domain code is mostly pure and has its own unit specs, but the application services (checkout,
negotiation, catalog, identity, inventory) talk to the database through Drizzle and are tested the way
they run: through the in-process suites on embedded PGlite. Counting only `src/**/*.spec.ts` would report
those services as untested when they are not, so **the measurement is one merged Vitest run of the
`unit`, `integration` and `e2e` projects on PGlite**:

```sh
pnpm --filter @agentbazaar/api test:coverage        # unit + integration + e2e (contract, negative, regression) on PGlite
VITEST_MAX_WORKERS=2 pnpm --filter @agentbazaar/api test:coverage   # on a small machine
```

The `services` project (growth and scale adapters against the real services in `tests/infra`) is not part
of the run: those suites need Docker, and the adapters they test live in `infrastructure/`, outside the
gate. Leave `TEST_DATABASE_URL` unset; the job runs on PGlite.

### Results

| | Lines | Branches | Statements | Functions |
| --- | --- | --- | --- | --- |
| Before (main at `5a5f919`, same merged run) | 86.01% (2,189 / 2,545) | **72.41%** (1,234 / 1,704) | 83.32% | 85.28% |
| Behaviour specs, first batch (main at `7251947`, laptop run) | 90.15% (2,657 / 2,947) | 82.63% (1,618 / 1,958) | 88.46% | 89.26% |
| Plus identity, customization and catalog suites (main at `887938e`, Quality workflow) | 91.33% | 85.30% | 89.82% | 90.39% |
| Latest (main at `739deb2`, Quality workflow) | **91.58%** | **85.43%** | 90.10% | 90.56% |

Main grew by about 400 measured lines between the first two runs (replica routing, sagas, tracing, the
semantic cache), so the denominators differ. The unit project alone measures much lower, which is expected
for the reason above. Other workstreams keep adding code under the gate, so the 5-point branch margin is
there on purpose.

What closed the branch gap: behaviour specs, not padding. Every new test asserts an outcome.

- Pricing: exact policy-engine decisions at every boundary (floor guard, ladder, lowball, the final
  counter, the approval threshold, volume trades), the negotiation state machine's full transition table,
  the outcome wording in English and Hindi, and a negotiation service suite on PGlite for the paths no HTTP
  suite reached: manager approvals (grant, decline, stale, under the floor, window expiry), quote
  acceptance failures (forged, superseded, withdrawn, expired, someone else's, already used), quantity
  changes, personalised items, sweeps, the admin listing and policy edits.
- Inventory and orders: stock rules, the inventory service against a migrated schema (all-or-nothing
  reserve, commit, release, transfer, hold checks, expiry sweeps), and the full order and payment
  transition tables.
- Shared: signed tokens and the key ring, AES-GCM framing, scrypt and the RFC 6238 TOTP vectors, timeouts,
  retry with jitter, the circuit breaker's half-open trial, the bulkhead hand-over, the error envelope for
  every error source, request validation and PII scrubbing in log lines.
- Identity, customization, catalog: the built-in token issuer (expiry, foreign keys, audience and issuer)
  and the OIDC verifier's claim mapping against a local key set (an unreachable issuer fails closed);
  customization previews (escaping, designs, refusal of bad preview data) and the review queue; admin
  product upserts (price history only on change, unknown category, price above MRP, another product's SKU).

### Bug found by the new tests

`NegotiationService.makeOffer` marked a lapsed negotiation expired and then threw `quote_expired` in the
same transaction, so the rollback discarded the expiry: the session stayed open, with its quotes active,
until the background sweeper ran. The fix commits the expiry and raises the error after the transaction
(`23a7aa9`); the regression test is *expires a stale negotiation on the next offer and keeps it closed* in
[`test/integration/negotiation.int.spec.ts`](../../apps/api/test/integration/negotiation.int.spec.ts).

### Other packages

| Package | Lines | Branches | Gate (numbers: Quality workflow, except testkit and web: laptop) |
| --- | --- | --- | --- |
| `packages/config` | 100% | 94.31% | Enforced (85 / 80): `pnpm --filter @agentbazaar/config test:coverage` |
| `packages/contracts` | 98.34% | 85.18% | Enforced (85 / 80): `pnpm --filter @agentbazaar/contracts test:coverage` |
| `services/ai` | 100% (467 statements) | 100% (96 branches) | Enforced: `pytest --cov --cov-branch` against the existing `fail_under = 90` (statements and branches combined). No workflow ran the Python tests before; the *Coverage gate (AI service)* job does now |
| `packages/testkit` | 37.0% | 29.8% | Not enforced. It is test and demo tooling (catalog generator, scripted and adversarial buyer agents); its own spec covers the generator, and the agents are exercised by the API's end-to-end and negative suites, which do not count towards the package's own number |
| `apps/web` (`src/lib`, `src/components`) | 26.1% | 27.4% | Not enforced. Pages and most components are covered by the Playwright journeys, not Vitest; reaching 85% would mean a component-test effort of its own |

## Mutation testing

### Setup

[StrykerJS](https://stryker-mutator.io/) 10.1 with the Vitest runner, in `apps/api`:

| Scope | Config | Mutated code | Tests that may kill a mutant | Break |
| --- | --- | --- | --- | --- |
| Critical | [`stryker.critical.config.mjs`](../../apps/api/stryker.critical.config.mjs) | `pricing/domain` (policy engine, negotiation state machine), `shared/crypto/keyring.ts` (quote token signing and verification), `inventory/{domain,application}`, `orders/domain` (order state machine) | the unit specs and the inventory service's PGlite suite ([`vitest.critical.config.mjs`](../../apps/api/vitest.critical.config.mjs)) | 80% |
| Full | [`stryker.config.mjs`](../../apps/api/stryker.config.mjs) | every `src/modules/**/{domain,application}/**` file (62 files) | unit, integration, end-to-end, contract, negative and regression suites on PGlite | 70%, on the merged score |

```sh
pnpm --filter @agentbazaar/api mutation:critical   # incremental; results in apps/api/reports/mutation/
STRYKER_SHARD="orders payments" pnpm --filter @agentbazaar/api mutation   # one shard of the full scope
pnpm --filter @agentbazaar/api mutation            # the whole full scope: hours, leave it to the nightly job
```

Both configs run at concurrency 2 (CI passes `--concurrency 4`) in **incremental mode**: the incremental
file under `reports/mutation/` keeps every result, and later runs retest only mutants whose code or
covering tests changed. CI caches the file per scope, and per shard for the full scope (restored from the
newest run, saved even when the gate fails), so pull requests and later nights pay only for what changed.
Cold runs are much slower on Windows than on the CI runner: the laptop used here tested about 8 mutants a
minute (roughly an hour for the critical scope), against 512 mutants in 3.5 minutes on `ubuntu-latest`.

**Why the full scope runs in shards.** The full scope has about 5,800 mutants, 5,100 of them testable (the
rest are static). The first single-job run reached 4,055 of them in 320 minutes before the step time limit
stopped it, without writing any results: about 7 hours for one run, more than a GitHub-hosted job may take.
[`mutation.yml`](../../.github/workflows/mutation.yml) therefore runs the full scope in parallel shards,
chosen with `STRYKER_SHARD` (a list of modules, or `module/layer` for the agent module, which is split in
two). A shard has no break threshold of its own:
[`scripts/mutation-score.mjs`](../../scripts/mutation-score.mjs) merges the shard reports, prints the score
per module, and fails the job under 70% overall, when a shard's report is missing, or when two reports
contain the same file. That last case is real: in incremental mode StrykerJS carries forward the results of
files outside `mutate`, so after the shard layout changed, a cache from the old layout reported another
shard's files too. Each shard therefore first trims its cached incremental file to its own modules
([`scripts/mutation-prune.mjs`](../../scripts/mutation-prune.mjs)). Each shard runs under
`timeout --signal=INT 270m`, so one that runs long is stopped inside the job limit; StrykerJS's interrupt
handler then writes its partial incremental results, which the cache step keeps for the next night (a
safeguard: no shard has needed it yet).

The first sharded run used five shards. Three took 70 to 74 minutes, but the agent domain (with the small
modules) took 203 and pricing with the catalog and inventory 228, because most end-to-end suites cover
catalog and agent-domain code and every such mutant also reran the AI cost benchmark (120 priced
conversations). There are now seven shards (`agent/application`; `agent/domain`; orders with payments;
pricing with inventory; catalog; identity with customization; PII, search, recommendations, analytics,
notifications and tax), and the two benchmark suites (`test/e2e/ai-cost.e2e.spec.ts` and
`test/integration/search-benchmark.int.spec.ts`) are left out of mutant runs: they assert aggregates rather
than behaviour. The first seven-shard run took one hour; its longest shard (60 minutes) was one with no cache
yet, and the catalog, also cold, took 27 minutes.

Decisions worth knowing:

- **Static mutants.** A mutant in module-level code (the transition tables, word lists) can't be traced to
  individual tests, so Stryker reruns every selected suite for it. The critical scope keeps them: its test
  set is small, and the transition tables are the point of the state machines. The full scope sets
  `ignoreStatic`, because rerunning every end-to-end suite (each boots the app) per static mutant would take
  days; mutants that run both at load time and inside tests are still tested against those tests.
- **Why the critical scope has its own Vitest config** rather than Stryker's `testFiles` option: with
  `testFiles` set, StrykerJS 10.1 activates static mutants only after the module is imported, so they can
  never be killed and every transition-table mutant reports as survived.
- **pnpm:** Stryker's default plugin glob (`@stryker-mutator/*`) looks next to `@stryker-mutator/core`,
  where pnpm's isolated layout holds only core's own dependencies, so the config loads the Vitest runner by
  resolved path. A dependency of StrykerJS (`typed-rest-client`) pins `qs` 6.15.1, which OSV-Scanner flags;
  an override in `pnpm-workspace.yaml` resolves it to the 6.17.1 the runtime already uses.
- `.stryker-tmp/` (sandboxes) and `apps/api/reports/` are git-ignored, and `cleanTempDir: 'always'` removes
  sandboxes even after a failed run, so `eslint .` never sees them.

### Results: critical scope

**96.68%** (512 mutants: 495 killed, 17 survived, none without a test). Quality workflow on main at
`887938e`, a cold run with no incremental file, 3 minutes 27 seconds at concurrency 4. With the cached
incremental file a later push (`739deb2`) reused 508 of the 512 results and finished in 14 seconds.

| File | Score | Killed | Survived |
| --- | --- | --- | --- |
| `pricing/domain/negotiation-state.ts` | 100% | 72 | 0 |
| `orders/domain/order-state.ts` | 100% | 58 | 0 |
| `shared/crypto/keyring.ts` | 100% | 88 | 0 |
| `pricing/domain/policy.ts` | 95.81% | 183 | 8 |
| `inventory/application/inventory.service.ts` | 94.59% | 70 | 4 |
| `inventory/domain/stock.ts` | 82.76% | 24 | 5 |

Before this work the same scope scored **25.78%** with the tests that existed (132 killed, 147 survived,
233 not reached by any test: `keyring.ts`, `stock.ts` and `inventory.service.ts` had no dedicated tests).
That first run used Stryker's `testFiles` option, which cannot kill static mutants, so the true starting
score was between 25.8% and 39.8% (the upper bound counts all 72 static mutants as killed).

The 17 survivors are equivalent mutants, left visible rather than disabled because a
`// Stryker disable next-line` comment would also hide killable mutants on the same lines:

- `policy.ts` (8): the `guard >= list` shortcut, and the `vBps > 0` and `negotiable > 0` guards, return
  what the general formula returns anyway (`min(list, max(guard, ceilRupee(list)))` is `list`), and in
  `askAt` the `minUnit >= openingUnit` early return matches the final clamp.
- `stock.ts` (5): the sort comparator. Lines are merged by variant first, so keys are unique and `<` and
  `<=` agree; and V8's sort only tests `comparator < 0`, so its `a > b ? 1 : 0` arm never changes the order.
- `inventory.service.ts` (4): `setStock`'s upsert (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`) always
  returns a row, so its event guard is always true; `isHeld`'s `count(*)` query always returns a row, so its
  two optional chains never fire; and `availability` with no ids gets no rows from `= ANY('{}')` either.

Quote handling outside the critical scope (issuing, accepting and re-signing quotes in
`pricing/application/negotiation.service.ts`) was measured on its own against its integration suite alone:
**98.46%** (64 of 65 mutants killed; laptop run). The survivor removes the state-machine check before
checkout, which is equivalent because only states that may move to checkout get that far.

### Results: full scope

All three runs were triggered by pushes to the mutation setup, standing in for the nightly schedule, and all
three pass the 70% gate.

| Run | Main at | Layout | Wall time (longest shard) | Score | Detected of testable |
| --- | --- | --- | --- | --- | --- |
| `42438759581` | `739deb2` | five shards, benchmarks included, no caches | 3 h 49 min (228 min) | 71.34% | 3,654 of 5,122 |
| `42449438096` | `e5d25fc` | seven shards, benchmarks left out, two shards without a cache | 1 h 0 min (60 min) | 73.48% | 3,787 of 5,154 |
| `42456122508` | `f688714` | seven shards, caches trimmed to each shard | 11 min (11 min) | **73.91%** | 3,819 of 5,167 |

The second run's own gate job printed 74.09% because it still counted the stale files described above
(790 testable mutants, counted twice); 73.48% is its seven reports trimmed to their own modules. The third
run is the current setup end to end: each shard trimmed its cache (the identity shard dropped 7 stale files
and reused 603 of its 892 results), and the gate job printed 73.91% itself. About 650 static mutants per run
are not tested (see above).

| Module | First run | Latest run | Detected of testable (latest) |
| --- | --- | --- | --- |
| payments | 100.00% | 100.00% | 6 of 6 |
| tax | 87.93% | 100.00% | 58 of 58 |
| analytics | 79.59% | 97.96% | 48 of 49 |
| pii | 48.67% | 97.35% | 110 of 113 |
| identity | 75.77% | 93.24% | 331 of 355 |
| customization | 81.07% | 92.92% | 315 of 339 |
| notifications | 92.86% | 92.86% | 13 of 14 |
| inventory | 92.16% | 92.16% | 94 of 102 |
| search | 89.09% | 90.76% | 108 of 119 |
| pricing | 88.58% | 87.22% | 621 of 712 |
| recommendations | 82.35% | 85.57% | 83 of 97 |
| catalog | 80.86% | 78.95% | 240 of 304 |
| orders | 68.45% | 67.07% | 603 of 899 |
| agent | 60.18% | 59.45% | 1,189 of 2,000 |

PII, identity, customization, analytics and tax rose with the suites added after the first run (key re-wrap
against a stand-in Transit and the vault itself; accounts, agent clients and tokens; every buyer-facing
customization message; analytics events; GST edges). Pricing and the catalog moved by one to two points:
their code changed between the runs (other workstreams kept merging), and the two benchmarks no longer run
against mutants.

Where the gap is:

- **agent** (811 undetected): reply templates (`agent/domain/replies.ts`, 19% detected), the chat
  orchestration (`chat.service.ts`, 232 undetected) and the MCP tool layer (`mcp-tools.ts`, 107). The
  conversation suites check outcomes (a deal, a checkout link, no floor leak) rather than wording and every
  branch of the orchestration.
- **orders** (296): `order-lifecycle.service.ts` has 124, chiefly the hand-over to the payment saga
  and payments that arrive after an order closed, which no in-process suite drives.
