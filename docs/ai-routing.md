# Model routing and AI efficiency settings

How a chat or A2A turn reaches a model, what each call may cost, and the settings behind the semantic
cache, the observer gate, provider fallback and Langfuse tracing. The rules come from
[ADR 0005](adr/0005-llm-writes-words-only.md): models only write words, every number comes from the
pricing policy, and the router can only add caution. The cache and the gate are covered in
[ADR 0012](adr/0012-semantic-cache-and-observer-gating.md). Measured effect:
[benchmarks/ai-cost.md](benchmarks/ai-cost.md) (G5) and [benchmarks/agent-spike.md](benchmarks/agent-spike.md) (S6).

## Routing table

| Router tier | Handles | Model | Output-token cap per call | If the provider fails |
| --- | --- | --- | --- | --- |
| 0 | Order status, exact FAQ answers, repeated product questions, off-topic redirects | none | none | not applicable |
| 1 | Greetings, availability, acceptance, refused injections: classifier plus template | none | none | not applicable |
| 2 | Search, product questions, customization, price quotes | `LLM_SMALL_MODEL`, then `LLM_FALLBACK_SMALL_MODEL` | the intent's cap (120 to 350), at most `LLM_TIER2_MAX_TOKENS` | the template |
| 3 | Offers, complaints, competitor claims, returns, low confidence, late rounds, carts over ₹50,000 | `LLM_LARGE_MODEL`, then `LLM_FALLBACK_LARGE_MODEL` | the intent's cap, at most `LLM_TIER3_MAX_TOKENS` | the template |
| Observer judge | Model wording on gated turns | `LLM_LARGE_MODEL`, then `LLM_FALLBACK_LARGE_MODEL` | 8 (PASS or FAIL) | counts as FAIL: the template is sent |
| 4 | Abuse, disputes, repeated injection | a person | not applicable | not applicable |

`ROUTER_SHADOW_MODE=true` sends every turn to tier 3 and observes every turn, while logging the tier
the router would have chosen. Budgets apply on top: each conversation has `SESSION_TOKEN_BUDGET`
tokens (default 20,000) and ₹5 of model spend, priced with `DEFAULT_PRICES` (see
[ai-cost.md](benchmarks/ai-cost.md#price-table)). When either runs out, replies are canned.

## Provider fallback

`LLM_ADAPTER` is the primary provider. `LLM_FALLBACK_ADAPTER` (`none`, `anthropic` or
`openai-compatible`) adds a second one with its own `LLM_FALLBACK_SMALL_MODEL` and
`LLM_FALLBACK_LARGE_MODEL`, for example Claude first and a self-hosted vLLM second. Each provider
runs behind its own guard: at most 16 calls in flight with 64 queued, a 10-second timeout, and a
circuit breaker that opens after 5 consecutive failures and tries again after 30 seconds. While the
primary fails or its breaker is open, its calls fail fast and the fallback answers. If both fail,
the buyer gets the template. `loadConfig` refuses a fallback that is the same adapter as the
primary, a fallback with a `template` primary, and a fallback without its models or credentials.

## Semantic cache

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEMANTIC_CACHE` | `off` | `memory`: a per-process LRU of 2,000 keys. `valkey`: shared by all API instances; needs the Valkey cache adapter (`VALKEY_URL`). |
| `SEMANTIC_CACHE_THRESHOLD` | `0.9` | Cosine similarity (0.5 to 1) the buyer's message needs to reuse a reply stored for the same tier, intent, language and template wording. |

Replies are stored without numbers, re-filled from the current policy template on a hit and checked
by the guard again. Replies that echo the buyer's own words are never stored, and entries expire
after one hour. Embeddings come from `EMBEDDINGS_ADAPTER` (hash in lite, the AI service in growth).
The default is `off` because the default `template` adapter makes no model calls to save.

## Observer gate

The observer runs on a turn that commits to something (a quote, an offer, an acceptance, a return
or warranty claim) and on any risk signal: confidence below 0.6, round 3 or later, a cart over
₹50,000, a failed tool, an upset buyer, classifier risk above low, a refusal or handoff, or a message
that probes for instructions, floors and costs, or personal data. On those turns, model wording is
re-checked by the guard and then by the judge, and the turn is written to the audit log
(`chat.observed`, with its reasons). Calm turns skip it. There is no setting; shadow mode observes
everything.

## Langfuse tracing

Set `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` together (`loadConfig` refuses
a partial set). Every model call, judge verdict and cache hit then becomes a `generation` span sent
to `{LANGFUSE_HOST}/api/public/otel/v1/traces`. This is Langfuse's OpenTelemetry endpoint, used over
HTTP with JSON and basic auth, through plain `fetch`: no Langfuse SDK and no new dependency. Spans
carry the model, input and output tokens, cost (in dollars at ₹88, and in micro-rupees as metadata),
latency, tier, shadow tier, intent, channel and the session as `langfuse.session.id`. Prompts and
replies are redacted with the same rules as the `llm_traces` table before they leave the process.
Spans are sent in batches of 50 or every 2 seconds. A failed export is logged and dropped and never
delays a reply. With the variables unset, nothing is sent. The legacy batch ingestion API is not
used, because Langfuse v4 no longer accepts trace events there.

## GPU for the AI service

`AI_DEVICE=cuda` in `services/ai` puts the optional `hf` classifier and `sentence-transformers`
embeddings on a GPU when PyTorch sees one. Otherwise they run on the CPU, and the fallback is shown
in `/readyz`. The default rules classifier and hash embeddings run no model, so a GPU only matters
after switching to those optional backends. See [services/ai/README.md](../services/ai/README.md#configuration).

## Suggested settings per profile

| Setting | Lite | Growth | Scale |
| --- | --- | --- | --- |
| `LLM_ADAPTER` | `template` | `anthropic` or `openai-compatible` | same as growth |
| `LLM_FALLBACK_ADAPTER` | `none` | the other adapter, if one is available | same as growth |
| `SEMANTIC_CACHE` | `off` | `valkey` | `valkey` |
| `LANGFUSE_*` | unset | optional | optional |
| `AI_DEVICE` (services/ai) | not used | `cpu` | `cuda` on GPU nodes with the `hf` classifier |

## Metrics

| Metric | Labels | What it shows |
| --- | --- | --- |
| `agentbazaar_llm_tokens_total` | `tier` (`2`, `3`, `observer`), `direction` | Tokens per tier; the judge counts under `observer` |
| `agentbazaar_router_tier_total` | `tier`, `intent` | Where turns were routed |
| `agentbazaar_semantic_cache_total` | `outcome` (`hit`, `miss`, `rejected`, `stored`, `skipped`, `error`) | Hit rate is hit / (hit + miss + rejected) |
| `agentbazaar_observer_turns_total` | `decision` (`skipped`, `observed`, `replaced`) | How many turns the gate observed and how many replies it replaced |
