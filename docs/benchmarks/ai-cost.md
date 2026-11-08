# AI cost per conversation (milestone G5)

**Status: measured on 2026-11-08 on a Windows 11 laptop (embedded PGlite, deterministic fake model).**
G5's definition of done is: "Cost per conversation falls against the all-large-model shadow baseline
with no drop in conversion proxies." This page reports the run that checks it. Every number below
comes from that run; nothing is estimated.

| Arm | Cost per conversation | Tokens per conversation | Model calls per conversation | Judge calls | Cache hits | Deals | Checkout links | Floor violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shadow baseline: every turn on the large model, observer on every turn | ₹0.6592 | 2,956 | 9.15 | 183 | 0 | 22/40 | 22/40 | 0 |
| Routed tiers and gated observer, cache off | ₹0.1689 | 1,618 | 4.58 | 71 | 0 | 22/40 | 22/40 | 0 |
| **Routed tiers, semantic cache and gated observer** | **₹0.0716** | **528** | **2.17** | **71** | **96** | **22/40** | **22/40** | **0** |

Cost per conversation fell **89.1%** against the shadow baseline. Routing and the observer gate save
74.4%, and the semantic cache saves more than half of what remains. The conversion proxies did not
move: the same 22 of 40 conversations reached a deal and got a checkout link in every arm, and no
seller quote was at or below a floor.

The first run, on 2026-11-06, measured ₹0.7127, ₹0.2090 and ₹0.0995 (an 86.0% saving). The difference
is the classifier fix of 2026-11-08: the adversarial conversations' extraction and personal-data
requests are now refused without any model call in every arm, where they used to be answered as
product searches.

## What runs

The harness is [`apps/api/test/e2e/ai-cost.e2e.spec.ts`](../../apps/api/test/e2e/ai-cost.e2e.spec.ts).
It runs in CI with the rest of the e2e project and fails if the optimised arm is not cheaper, has fewer
deals or checkout links, or shows any floor violation.

- **Conversations:** 40 per arm, run with `runChatConversation` from `@agentbazaar/testkit` through the
  chat REST API. 24 haggle and buy (open at about 80% of the list price, meet the seller halfway once,
  accept), 8 browse (warranty question, stock check) and 8 are adversarial: an injection, an
  extraction attempt, a quote, a 5% lowball offer, a personal-data request and abuse, drawn from the
  testkit corpora. One conversation in three is in Hindi (13 of 40). The products are five hero SKUs
  (keyboards, power supplies, a case).
- **The model** is the testkit's fake OpenAI-compatible server (`startFakeLlm`). It returns the policy
  template with a friendly opener, answers PASS to judge requests, and reports usage of one token per
  four characters of prompt and reply. Runs are deterministic: a fixed test clock keeps quote expiry
  times equal, and two runs differed by less than 0.1% in total cost.
- **Cost** is the API's own accounting: `chat_sessions.cost_micro_inr`, filled by the phraser and the
  observer from each call's token usage and the price table below.
- **Arms:** the baseline sets `ROUTER_SHADOW_MODE=true` and `SEMANTIC_CACHE=off`. Every reply goes to
  the large model and the observer judges every model-written reply. The other arms use normal
  routing (tier 2 small model, tier 3 large model, tiers 0 and 1 templates) and the gated observer,
  with the cache off or `memory`.

## Price table

The API prices calls with `DEFAULT_PRICES` in
[`apps/api/src/modules/agent/domain/budget.ts`](../../apps/api/src/modules/agent/domain/budget.ts),
which operators can override through the `LLM_PRICES` provider. Rupee amounts assume ₹88 to the dollar.

| Model (env) | Input per million tokens | Output per million tokens |
| --- | --- | --- |
| `claude-haiku-5-5` (`LLM_SMALL_MODEL`, tier 2) | ₹8.80 ($0.10) | ₹44 ($0.50) |
| `claude-sonnet-5-5` (`LLM_LARGE_MODEL`, tier 3 and the observer's judge) | ₹176 ($2) | ₹880 ($10) |

Self-hosted models (any name not in the table) cost nothing per token.

## Where the money goes

Calls and spend for all 40 conversations, from `llm_traces` (`kind` is new in migration 0060):

| Arm | Phrasing, small model | Phrasing, large model | Judge, large model | Cache hits |
| --- | --- | --- | --- | --- |
| Shadow baseline | none | 183 calls, ₹18.90 | 183 calls, ₹7.47 | none |
| Routed, cache off | 63 calls, ₹0.43 | 49 calls, ₹3.87 | 71 calls, ₹2.46 | none |
| Routed, cache on | 12 calls, ₹0.08 | 4 calls, ₹0.33 | 71 calls, ₹2.46 | 96 |

- **Routing** moves search, product questions and price quotes to the small model, and greetings,
  order status, refusals and rule answers to templates.
- **Gating** runs the judge on 71 turns instead of 183. Every judged turn was a commitment or risky;
  calm browsing turns were skipped.
- **The cache** answered 96 of the 112 phrasing requests in the cached arm (86%). Every hit was filled
  with that request's own numbers and passed the guard again. See
  [ADR 0012](../adr/0012-semantic-cache-and-observer-gating.md) for why this cannot leak another
  customer's prices or name.
- **The judge is now 86% of the remaining spend**, because every commitment is judged, including
  cached ones. That is deliberate.

## Caveats

- **Scripted traffic repeats itself.** Forty conversations over five products and fixed phrasings
  give a far higher cache hit rate than real shoppers will. Watch `agentbazaar_semantic_cache_total`
  in production. The 74.4% saved by routing and gating does not depend on repetition.
- **Token counts come from the fake model** (one token per four characters). Real tokenizers and real
  replies differ, which changes the absolute rupee figures, not the comparison: all three arms
  send the same prompts.
- **The baseline is the shadow mode the plan launches with.** Every reply is phrased by the large
  model and the observer judges every turn.
- **Conversion proxies come from the policy, not the wording.** Deals, checkout links and floors are
  decided by the pricing engine (ADR 0005), so equal proxies are expected. The check guards against a
  cache or gate bug that would change a decision or drop a reply.

## Rerun it

```bash
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@agentbazaar/api^...
cd apps/api
VITEST_MAX_WORKERS=1 pnpm exec vitest run --project e2e test/e2e/ai-cost.e2e.spec.ts --silent=false
```

The test prints the table above and the calls and spend by kind and model.
