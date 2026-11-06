# ADR 0005: The LLM only writes the words: a number guard and an escalate-only router

- Status: Accepted
- Date: 2026-11-05
- Deciders: Mukul Kathuria

## Context

Every door to the store accepts free text from untrusted parties: shoppers, their agents, and other sellers' agents pretending to be buyers. LLMs can be talked into discounts, can invent prices, can leak their instructions or other customers' data, and cost money per token. Yet good wording, in English and Hindi, matters to conversion.

## Decision

1. **Services decide; templates speak.** The pricing engine and other services produce a decision and template wording containing every number ([`messages.ts`](../../apps/api/src/modules/pricing/application/messages.ts)). The template alone is a complete, correct reply, which is what the default `template` LLM adapter sends.
2. **The model may only rephrase.** `LlmPort.compose` receives the intent, language, buyer-visible facts, the list of `allowedNumbers` and the template `fallback`. Floors, costs, margins and other customers' data are never in the request. Adapters never throw: on a timeout, an error or an exhausted budget they return the template.
3. **Output guard, failing closed** ([`guard.ts`](../../apps/api/src/modules/agent/domain/guard.ts)). A model reply is rejected and replaced by the template if it contains any number not in `allowedNumbers` (digits with Indian or western grouping, decimals, "k", "lakh" and "crore" multipliers, non-ASCII digits, numbers spelled out in English, Hinglish or Hindi), a link, contact details, personal data, talk of floors, costs, margins or other secret terms (in English and Hindi), or a promise of something free.
4. **Escalate-only router** ([`router.ts`](../../apps/api/src/modules/agent/domain/router.ts)). Each turn is routed to tier 0 (rules and cache), 1 (classifier and template), 2 (small model), 3 (large model) or 4 (a person). Routes form a join-semilattice: every stage proposes a route and the pipeline keeps the maximum tier and the logical OR of "deny", so no stage, in any order, can lower the tier or undo a denial. A route has no field for a price, a discount or a permission.
5. **Budgets.** Output tokens are capped per intent, and each conversation has a token budget and a spend cap; when either is exhausted, replies are canned.
6. **Traces are redacted.** Prompts and replies are stored in `llm_traces` only after PII redaction, for audits and evaluation.

## Consequences

- Safety does not depend on the model behaving. Swapping or upgrading a model cannot change a price, and the store works with no model at all (demo, outage, cost cap).
- Replies can be stiffer than a free-running model's, and the guard has false positives (for example a harmless "2 options" when 2 is not an allowed number). A false positive falls back to the template, which is safe; the guard's tests and the evaluation suite track the rate.
- The guard's multilingual patterns need maintenance as new phrasings appear. Every bypass found becomes a regression test.
- Tone, brand voice and helpfulness still need evaluation (golden conversations and adversarial suites), and abusive or disputed conversations go to a person.

## Alternatives considered

- **Let the model call pricing tools and quote the results itself:** the model could still misquote or be steered, and prices would appear in free text without a check.
- **Prompt rules only ("never go below X"):** provably bypassable by prompt injection, and the floor would have to be in the prompt.
- **An output classifier without a number whitelist:** probabilistic where an exact check is possible.
