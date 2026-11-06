# Product Hunt draft

Status: DRAFT. Launch by hand after `launch-checklist.md` is green and the public MCP demo is live. Every
gallery image must be a real screenshot or recording of the released build.

## Name

AgentBazaar

## Tagline options (60 characters or fewer)

1. `Open-source store where AI agents shop and haggle safely` (56)
2. `The full store for the agent era` (32)
3. `Self-hosted commerce for MCP and A2A shopping agents` (52)

## Description (under 260 characters)

Open-source store where people and AI agents shop and negotiate over MCP and A2A. Prices, floors and stock
are enforced in code; the LLM only writes the words. Self-host on one VPS. GST, UPI and COD built in. MIT.

## Topics

Open Source, Developer Tools, E-Commerce, Artificial Intelligence

## Links

- Repository: https://github.com/mukulkathuria/AgentBazaar
- Public MCP demo: the real URL from `server.json` (the placeholder `https://demo.agentbazaar.dev/mcp` must be
  replaced before launch)

## First maker comment

Hi Product Hunt, I'm Mukul.

AI agents are starting to shop for people. Most stores either block them or hand them a raw API, and a store
whose chatbot sets prices can be talked into a discount or a data leak. AgentBazaar takes a different route:
one backend with four doors (a server-rendered storefront, an MCP server, an A2A endpoint and a chat
widget), and every door goes through the same pricing engine written in code.

The seller agent negotiates, but it cannot invent a number. Each reply is checked, and any price the engine
did not produce is replaced with the template wording. It trades instead of only cutting price ("Take 3 and
I can do ₹5,364 each"), quotes are signed, single-use and expire, and a person always confirms the address
and payment.

You can try it in about a minute with no API keys: clone, `pnpm install`, `pnpm demo`. A scripted buyer
agent negotiates with the seller over MCP and pays through a mock gateway.

It is India-first (GST per line, UPI, cash on delivery, DPDP data-protection features) and MIT-licensed.
Honest status: this is the v0.9 release candidate for a single VPS; the bigger deployment tiers are still in
progress, and it should not take real money before an independent security review.

I would love your feedback, especially attempts to talk the seller below its floor.

## Gallery shot list

1. The demo GIF: the negotiation transcript from a real `pnpm demo` run (`docs/assets/demo.gif`).
2. Product page on the storefront, showing the variant selector and price.
3. An MCP client (Claude, Cursor or VS Code) calling `search_products` and `request_quote` against the store.
4. The chat widget with a structured offer card and its expiry time.
5. The checkout page where a person confirms the address and pays with the mock gateway.
6. The admin approval queue holding a large discount for a human decision.
7. The architecture diagram from the README (one backend, four doors).
8. The social preview image (`docs/assets/social-preview.png`) as the thumbnail.
