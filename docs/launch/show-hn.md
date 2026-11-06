# Show HN draft

Status: DRAFT. Post by hand, only after `launch-checklist.md` is green. Link the repository, not a landing
page. Fill or delete every metric marker.

## Title options (under 80 characters)

1. `Show HN: AgentBazaar – open-source store where AI agents haggle above a floor` (77)
2. `Show HN: AgentBazaar – self-hosted store for MCP and A2A shopping agents` (72)
3. `Show HN: An open-source store whose AI seller can't sell below its floor` (72)

URL: https://github.com/mukulkathuria/AgentBazaar

## Post body (about 250 words)

AgentBazaar is an open-source (MIT) commerce platform where people and AI agents shop from the same store.
One backend has four doors: a server-rendered storefront, an MCP server, an A2A endpoint and a chat widget.

The part I cared most about: a seller agent that negotiates without being talked into a loss. Prices,
floors, discounts, stock and quote expiry are enforced in TypeScript. The LLM only writes the words, and a
guard rejects any reply that contains a number the pricing engine did not produce. The router that picks a
model per turn can only escalate or deny. Quotes are signed, single-use and expire, and a person confirms
the address and pays at checkout.

Try it with no API keys (Node.js 22.12 or later, pnpm 12):

    git clone https://github.com/mukulkathuria/AgentBazaar && cd AgentBazaar && pnpm install && pnpm demo

That starts the store on embedded Postgres (PGlite), has a scripted buyer agent negotiate over MCP with the
seller, pays through a mock gateway and prints the transcript. The Docker demo keeps a store running for
your own MCP client.

It is built for India first: GST per line, UPI, cash on delivery, money as integer paise, and DPDP Act
features (consent records, export, erasure by crypto-shredding).

Honest status: this is the v0.9 lite release candidate for a single VPS. The growth and scale tiers are not
finished. The Razorpay adapter is written from public docs and not yet verified against the live sandbox.
The YouPI-PG UPI adapter is experimental. Please do not take real money with it before an independent
penetration test.

I would love adversarial prompts against the seller agent, and reports from MCP clients I have not tried.

## First comment (maker)

Some details for the curious.

The negotiation is plain arithmetic. The demo keyboard lists at ₹5,499. Its secret floor is ₹4,869.92:
landed cost (₹4,509.18) plus an 8% minimum margin. The engine never quotes within ₹1 or 0.5% of the floor,
so the lowest price it could ever show is ₹4,895, rounded up to a whole rupee. The keyboard's price band
allows 8% off, so this negotiation bottoms out at ₹5,060. The asks follow a Boulware curve (concede little
early, more near the end): ₹5,499, ₹5,472, ₹5,390, ₹5,253, ₹5,060 over four rounds. Instead of only
cutting price, it trades: "Take 3 and I can do ₹5,364 each." Those numbers come from
`apps/api/src/modules/pricing/domain/policy.ts` and are asserted in `policy.spec.ts`, alongside fast-check
property tests that run 3,000 random offer sequences per CI run and check that none prices at or below the
floor.

Every tier is built behind ports and chosen by a `PROFILE` setting (lite, growth, scale) instead of
commented-out code: Postgres full-text plus pgvector search in lite, Meilisearch or OpenSearch later; an
in-process outbox bus in lite, NATS or Kafka later.

Test count: <!-- METRIC:unit_test_count -->473 unit and property tests<!-- /METRIC -->, plus 128 integration and
end-to-end tests and 320 Python tests. Search p95 at 10,000 products:
<!-- METRIC:search_p95_ms_10k -->23.0<!-- /METRIC --> ms on a laptop with local Postgres (method in `docs/benchmarks/lite.md`).

What I would most like feedback on: prompt-injection attempts against the seller, the MCP tool design (12
tools, scoped `catalog:read`, `quote:create`, `order:create`), and whether the GST handling matches what you
have seen in production.
