## What and why

<!-- One logical change. Link the issue or milestone. The title must be a conventional commit, e.g. "fix(payments): ...". -->

Closes #

## Evidence

<!-- Commands you ran and their results, new tests (including negative cases), and benchmark deltas if performance could change. -->

## Merge gates

- [ ] Types, lint and module boundaries pass with zero errors (`pnpm typecheck && pnpm lint`)
- [ ] Tests were written first, including negative cases; `pnpm test`, `pnpm test:int` and `pnpm test:e2e` pass
- [ ] Coverage of domain and application code stays at or above 85% of lines and 80% of branches
- [ ] A bug fix comes with a regression test that failed before the fix
- [ ] No new critical or high vulnerabilities; no secrets, keys or real personal data in the diff
- [ ] New dependencies are on the licence allowlist (`pnpm license:check`)
- [ ] Contracts changed: `pnpm contracts:generate` was run and committed, and REST, MCP and A2A contract tests pass
- [ ] Migrations: only new numbered files, they apply forward on seeded data, and the rollback plan is below
- [ ] Logs, traces and analytics carry no personal data
- [ ] UI changed: Playwright journeys and axe accessibility checks pass, and performance budgets are met
- [ ] Mutation score holds where Stryker runs (70% overall, 80% on pricing, inventory, quotes and the order state machine)
- [ ] Docs, diagrams (`pnpm docs:sync`) and `CHANGELOG.md` are updated where users or operators will notice the change
- [ ] A significant decision is recorded as an ADR in `docs/adr`

## Policy and security impact

- [ ] This touches pricing, quotes, payments, personal data, identity or the agent surface, so a second reviewer is requested and negative tests are included
- [ ] No floor, cost, margin or other customer's data can reach a prompt, a tool result, an API response or a log
- [ ] The router and any LLM still cannot grant a price, a discount or a permission

## Rollback plan

<!-- How to undo this safely in production (revert, feature flag, data fix). "Revert the commit" is fine when no data changes. -->
