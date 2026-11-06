# ADR 0004: Negotiate with a guarded floor, a Boulware concession ladder and trades instead of gifts

- Status: Accepted
- Date: 2026-11-05
- Deciders: Mukul Kathuria

## Context

The seller agent negotiates with people and with other agents. It must never sell below cost plus minimum margin, never reveal that floor (not even by stopping exactly on it), behave the same on every door (web chat, MCP, A2A, REST), and be explainable to the shop owner. An LLM cannot be trusted with any of this: it can be argued with, injected or simply make arithmetic mistakes.

## Decision

All numbers come from pure functions in [`apps/api/src/modules/pricing/domain/policy.ts`](../../apps/api/src/modules/pricing/domain/policy.ts), driven by a per-band policy (`fixed` under ₹500, `standard` from ₹500 to ₹20,000, `premium` above) that admins can edit.

1. **Floor.** `floor = landed cost × (1 + minimum margin)`, rounded up to the paisa, where landed cost is purchase price + freight + payment fee + expected return cost + non-recoverable tax (`floorPaise` in the catalog module). The floor never leaves the server.
2. **Guarded floor.** `guard = round_up_to_rupee(floor + max(₹1, 0.5% of floor))`. Every price below list is strictly above the floor, so no quote equals or reveals it.
3. **Ladder.** `opening` is the list price less any published volume tier the quantity reaches (never below the guard). `min = max(guard, round_up_to_rupee(opening × (1 − negotiable share)))`. Customized items get `min = opening`: quantity discounts only.
4. **Boulware concession.** `ask(r) = round_up_to_rupee(min + (opening − min) × (1 − (r / R)^e))` for round `r` of `R`. With `e > 1` the seller concedes little early and more near the deadline, the "Boulware" family of time-dependent tactics described by Faratin, Sierra and Jennings (1998), *Negotiation decision functions for autonomous agents*.
5. **Decision.** An offer at or above the current ask is accepted at the ask; one that clears the next ask is accepted at the offer; otherwise the seller counters at the next ask, marked final in the last round. Fixed-price items and exhausted rounds are rejected, and the last quote stays valid. If the total discount exceeds the band's approval threshold, the negotiation waits for a person, who can approve a discount but never a price under the guard.
6. **Trade, don't give.** Counters include volume alternatives priced off the same ladder ("take 3 and I can do ₹5,364 each"). The only inputs are the offer and the quantity; claims such as "another store sells it for less" are ignored.
7. **Quotes.** Each outcome issues a signed, expiring, single-use quote that supersedes the previous one.

**Worked example** (the demo keyboard; asserted in [`policy.spec.ts`](../../apps/api/src/modules/pricing/domain/policy.spec.ts)): list ₹5,499; floor ₹4,869.92 (landed cost ₹4,509.18 plus 8% minimum margin); guard ₹4,895; standard band with 8% negotiable, 4 rounds and exponent 2, so `min` is ₹5,060. The asks are ₹5,499, ₹5,472, ₹5,390, ₹5,253 and ₹5,060. Scripted offers of ₹4,400, ₹4,800 and ₹4,900 get counters at ₹5,472, ₹5,390 and ₹5,253, and ₹5,100 is accepted because it clears the final ask. At round 1 the volume alternative is 3 units at ₹5,364 each.

## Consequences

- No sequence of offers can reach the floor, by construction. fast-check property tests check it on every run: 3,000 random offer sequences over random policies and prices, 2,000 random ladders kept within [guard, list] with asks that never rise, and 1,000 cases proving a larger quantity never costs more per unit at opening.
- The behaviour is deterministic and explainable; the admin dashboard can show every offer and counter.
- Rounding up to the rupee costs the seller at most ₹1 per unit, by design.
- A buyer who learns the algorithm can predict the path down to `min`. That is acceptable: `min` is a deliberate policy choice above the guard, and the band's rounds and exponent are tunable. Rate limits and per-agent quotas limit fishing across many sessions.
- The LLM receives only buyer-visible facts and the decision's numbers ([ADR 0005](0005-llm-writes-words-only.md)).

## Alternatives considered

- **Let the LLM decide within instructions:** rejected; prompt injection and arithmetic errors make it unsafe.
- **Linear concessions:** give away too much in early rounds.
- **Fixed discount codes only:** safe, but no negotiation and no volume trades for agents.
