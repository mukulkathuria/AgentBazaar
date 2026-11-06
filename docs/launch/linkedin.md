# LinkedIn draft

Status: DRAFT. Post by hand from Mukul Kathuria's account after `launch-checklist.md` is green. Attach the
demo GIF or the social preview image (from a real run).

## Post (about 180 words)

AI agents are starting to shop on our behalf. I wanted to see what a store looks like when that is a
first-class use case, so I built one and open-sourced it.

AgentBazaar is an MIT-licensed commerce platform where people and AI agents shop from the same backend:
a server-rendered storefront, an MCP server, an A2A endpoint and a chat widget.

The design choice I care about most: the seller agent can negotiate, but it cannot give away the store.
Prices, floors, discounts and stock are enforced in code. The LLM only writes the words, and a guard
rejects any reply containing a number the pricing engine did not produce. Quotes are signed and single-use,
and a person always confirms the payment.

It is built for India first: GST per line, UPI, cash on delivery, money in paise, and DPDP data-protection
features.

You can try it in about a minute with no API keys: clone the repo and run `pnpm demo`.

This is the v0.9 release candidate for a single VPS. Feedback, issues and adversarial prompts are welcome.

https://github.com/mukulkathuria/AgentBazaar

#OpenSource #AIAgents #MCP #Ecommerce #India
