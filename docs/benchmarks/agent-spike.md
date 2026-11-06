# Agent traffic spike (milestone S6, application side)

**Status: measured on 2026-11-06 on a Windows 11 laptop with k6 v2.3.0, one API process on embedded
PGlite and a deterministic fake model.** S6's definition of done is: "Agent traffic spike test meets
latency and cost budgets." Autoscaling the agent workers on Kubernetes is a separate track and is
not measured here. This page measures what one API instance does under an agent spike, with model
routing, the semantic cache and the gated observer on. Every number comes from the runs below.

## Result

| Run | Agent conversations per second | Conversations | Requests | Errors | Search p95 | Quote p95 | Offer p95 | Chat turn p95 | Model cost per conversation | Budgets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A, cold cache | 1 → 5 → 1 | 249 | 1,497 | 0% | 24.4 ms | 22.9 ms | 21.2 ms | 137.4 ms | ₹0.0720 | **all met** |
| B, warm cache | 1 → 5 → 1 | 249 | 1,497 | 0% | 18.6 ms | 20.3 ms | 17.2 ms | 91.0 ms | ₹0.0709 | **all met** |
| C, cold cache | 2 → 10 → 2 | 497 | 2,985 | 0% | 444.3 ms | 433.1 ms | 431.1 ms | 1.17 s | ₹0.0716 | search and chat missed |
| D, warm cache | 2 → 10 → 2 | 499 | 2,997 | 0% | 279.4 ms | 258.0 ms | 254.1 ms | 674.0 ms | ₹0.0709 | all met, narrowly |

Budgets: errors under 1%, checks over 99%, p95 under 300 ms for `search_products`, under 800 ms for
`request_quote` and `make_offer`, under 1 second for a chat turn, and model cost under ₹0.50 per agent
conversation. The session cap is ₹5.

- **A 5× spike to 5 agent conversations a second (about 30 requests a second) meets every budget**
  from a cold start, with most p95 latencies under 30 ms and model cost 7 times under budget.
- **At 10 conversations a second (about 60 requests a second) one process on embedded PGlite
  saturates.** From a cold cache, search and chat p95 missed their budgets in both runs. The first
  (not in the table, run before the cost line was captured) measured 636 ms and 1.91 s. With a warm
  cache all budgets were met, search only just. PGlite is single-threaded WebAssembly inside the API
  process, so every query waits its turn. Cold chat turns also wait for the model, so more requests
  are in flight. Growth and scale run Postgres and several API replicas
  ([profiles](../profiles.md)), which this laptop run does not test.
- **Cost holds under load.** It is about ₹0.07 per agent conversation in every run, because the
  semantic cache answers most chat phrasing (92% of lookups in run A, 94% in run C). The judge on
  every commitment is nearly all of the spend.
- **No errors** in 8,976 requests across the four runs, and no observer replacement: the fake model's
  wording always passed the guard and the judge.

Another agent's long k6 soak was running on the same laptop throughout, so these latencies are
conservative. They are not a benchmark of the scale profile.

## What one agent conversation does

Each iteration of [`tests/load/agent-spike.js`](../../tests/load/agent-spike.js) is one buyer agent:

1. MCP `search_products` (one of five hero products' keywords, in stock only).
2. MCP `request_quote` for one unit, then `make_offer` at 85% of the list price. The MCP tools
   run no model; prices come from the pricing engine.
3. A chat session with two turns, "how much is SKU?" and "can you do X?" at 85% of the quote. These
   go through the router (tier 2 for the quote, tier 3 for the offer), the semantic cache, and the
   observer, which judges every commitment with the large model.

The scenario uses a `ramping-arrival-rate` executor: 20 s at the baseline rate, a 10 s ramp to the
peak, 30 s at the peak, a 10 s ramp down and 20 s at the baseline again. Latency comes from k6.
Model cost comes from the API's own `/metrics` counters (`agentbazaar_llm_tokens_total` by tier:
tier 2 at the small model's price, tier 3 and the judge at the large model's), read before and after
the run and priced with `DEFAULT_PRICES` ([price table](ai-cost.md#price-table)). The teardown fails
the run when the cost per conversation is over budget.

| Run | Tier 2 tokens in/out | Tier 3 tokens in/out | Judge tokens in/out | Cache hit / miss / rejected | Observed turns |
| --- | --- | --- | --- | --- | --- |
| A | 14,225 / 1,387 | 364 / 16 | 97,814 / 498 | 460 / 6 / 32 | 498 of 498 |
| C | 23,823 / 2,319 | 359 / 16 | 195,130 / 994 | 931 / 6 / 57 | 994 of 994 |

"Rejected" lookups found a similar cached reply but would not reuse it. Its numbers did not fit
the new template (for example a quote expiry hour that matched a quantity in one template but not
the other), or the refilled reply failed the guard. The model answered those turns instead, as
[ADR 0012](../adr/0012-semantic-cache-and-observer-gating.md) intends.

## Setup

- API: `apps/api` at commit `1ef1ac9`, started with `pnpm exec tsx src/main.ts` and these settings:
  `PORT=4107`, `NODE_ENV=production`, `DEMO_MODE=true`, `DATABASE_DRIVER=pglite`, `SEED_ON_BOOT=true`
  (300-product demo catalog), `RATE_LIMIT_PER_MINUTE=100000`, `LLM_ADAPTER=openai-compatible`,
  `OPENAI_COMPAT_BASE_URL=http://127.0.0.1:4117/v1`, `SEMANTIC_CACHE=memory`. Runs A and C started
  from a freshly booted process; B and D followed on a process that had already served a run.
- Model: `node packages/testkit/dist/bin/fake-llm.js --port 4117 --latency-ms 50` adds 50 ms to every
  call and reports one token per four characters.
- k6 v2.3.0 for Windows, the release zip from GitHub. Its SHA-256,
  `112276d495e5741c968e2bc09ea6196099c1275bd6db9ee0875d173c7148ce43`, matched
  `k6-v2.3.0-checksums.txt`.

## Rerun it

```bash
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@agentbazaar/api^...
node packages/testkit/dist/bin/fake-llm.js --port 4117 --latency-ms 50 &
(cd apps/api && PORT=4107 NODE_ENV=production DEMO_MODE=true DATABASE_DRIVER=pglite SEED_ON_BOOT=true \
  RATE_LIMIT_PER_MINUTE=100000 LLM_ADAPTER=openai-compatible OPENAI_COMPAT_BASE_URL=http://127.0.0.1:4117/v1 \
  SEMANTIC_CACHE=memory pnpm exec tsx src/main.ts) &
k6 run -e BASE_URL=http://127.0.0.1:4107 tests/load/agent-spike.js                                 # runs A and B
k6 run -e BASE_URL=http://127.0.0.1:4107 -e BASELINE_RATE=2 -e PEAK_RATE=10 tests/load/agent-spike.js  # runs C and D
```

`COST_BUDGET_INR` changes the cost budget. Against a real provider, set `LLM_ADAPTER` and its key
instead of the fake model, and expect the chat-turn latency to be dominated by the model.
