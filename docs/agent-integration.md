# Agents: MCP, A2A and chat

AgentBazaar has one backend and four doors. People use the web storefront and the chat widget; software agents use **MCP** or **A2A**. Every door goes through the same services, the same pricing policy engine and the same router, so an agent can never get a price, a discount or a permission that the website would not give.

| Door | Endpoint | Protocol |
| --- | --- | --- |
| MCP server | `POST /mcp` | Model Context Protocol over streamable HTTP, stateless, JSON responses |
| A2A endpoint | `POST /a2a`, Agent Card at `GET /.well-known/agent-card.json` | A2A JSON-RPC, protocol 1.0 and 0.3 |
| Chat widget | `POST /api/v1/chat/sessions`, `POST /api/v1/chat/sessions/{id}/messages` | REST, or server-sent events with `Accept: text/event-stream` |
| REST | `/api/v1/*`, documented in `packages/contracts/generated/openapi.json` | HTTP + JSON |

## MCP tools

Tool input schemas are generated from the Zod definitions in [`packages/contracts/src/agent.ts`](../packages/contracts/src/agent.ts) (`McpToolInputs`), and the scope each tool needs comes from `MCP_TOOL_SCOPES` in the same file. Inputs use `snake_case` and amounts in **rupees** (up to two decimals), because LLM callers handle those more reliably than camelCase paise; the server converts to integer paise.

| Tool | What it does | Required scope |
| --- | --- | --- |
| `search_products` | Hybrid keyword and semantic search with category, price and stock filters | `catalog:read` |
| `get_product` | Public details of a product by slug or SKU: attributes, FAQs, return policy, variants with price and stock | `catalog:read` |
| `check_availability` | Whether a SKU can supply a quantity (shown quantities are capped at 50) | `catalog:read` |
| `get_customization_options` | Allowed text fields with limits, catalog designs and the surcharge | `catalog:read` |
| `validate_customization` | Checks personalisation text and a design choice before quoting | `catalog:read` |
| `get_recommendations` | Bought-together items and alternatives | `catalog:read` |
| `get_compatible_items` | Items that fit, from the product graph (for example a PSU for a GPU) | `catalog:read` |
| `request_quote` | Opens a negotiation and returns a signed, expiring quote plus volume alternatives | `quote:create` |
| `make_offer` | Counter-offers a unit price (and optionally a new quantity) within the band's rounds | `quote:create` |
| `accept_quote` | Locks the quoted price and reserves stock in a checkout session | `order:create` |
| `create_checkout_link` | Returns a signed, expiring URL that a **person** opens to confirm the address and pay | `order:create` |
| `get_order_status` | Status, totals and timeline of an order placed through this agent | `order:create` |

The server's instructions to the calling model describe the intended flow: `search_products`, `get_product`, `request_quote`, optionally `make_offer`, then `accept_quote` and `create_checkout_link`, and finally hand the link to the user. Tool results carry `structuredContent` plus a short text summary; errors come back as tool errors with a stable code such as `quote_expired`, `quote_used`, `negotiation_closed` or `out_of_stock`.

`GET /mcp` and `DELETE /mcp` return 405: the server is stateless, so there are no sessions to resume or close.

## A2A

The Agent Card at `/.well-known/agent-card.json` advertises the `/a2a` JSON-RPC endpoint for protocol versions 1.0 and 0.3 (requests without an `A2A-Version` header, or with `0.3`, use the 0.3 handler so agents that still speak `message/send` work), a bearer security scheme, and three skills:

| Skill | How to use it |
| --- | --- |
| `catalog_search` | Ask in plain text, for example "Is the THOCK-TK87-RED keyboard in stock?" |
| `negotiate` | Send a `quote_request` DataPart, then `offer` DataParts; replies carry a `quote` DataPart |
| `checkout_handoff` | Send an `accept` DataPart; the reply carries a `checkout` DataPart with a signed URL for a person |

Structured messages travel as A2A `DataPart`s whose schemas are in [`packages/contracts/src/agent.ts`](../packages/contracts/src/agent.ts). Money is a decimal string plus currency, to avoid floating-point ambiguity between languages.

| Direction | `type` | Fields |
| --- | --- | --- |
| In | `quote_request` | `sku`, `quantity` |
| In | `offer` | `negotiation_id`, `unit_price` `{ amount: "5100.00", currency: "INR" }`, optional `quantity`, optional `valid_until` |
| In | `accept` | `quote_token` |
| Out | `quote` | `negotiation_id`, `state`, `decision`, `sku`, `quantity`, `unit_price`, `total`, `quote_token`, `valid_until`, `rounds_remaining`, `alternatives` (`quantity`, `unit_price`) |
| Out | `checkout` | `checkout_session_id`, `checkout_url`, `valid_until`, `amount` |

A2A and MCP share the negotiation state machine, so a quote obtained over one can be accepted over the other by the same principal.

```json
{ "type": "offer", "negotiation_id": "6f1c…", "unit_price": { "amount": "4800.00", "currency": "INR" } }
```

## Authentication and scopes

There are three scopes: `catalog:read`, `quote:create` and `order:create`.

| Caller | Scopes | Notes |
| --- | --- | --- |
| Anonymous (no token) | `catalog:read` | Browse and search only. Identified by a hash of the IP address for rate limiting |
| Anonymous with `DEMO_MODE=true` | all three | Demo only. The config loader refuses `DEMO_MODE` with any payment adapter other than `mock` |
| Agent client (OAuth 2.0 client credentials) | the scopes the admin granted, or a requested subset | Per-client quota in requests per minute |
| Signed-in customer (chat, REST) | all three | Their own orders and negotiations only |

**Getting an agent token** with the built-in issuer:

1. An admin creates a client: `POST /api/v1/admin/agent-clients` with `{ "name": "Acme buyer agent", "scopes": ["catalog:read", "quote:create", "order:create"], "quotaPerMinute": 60 }`. The response contains `clientId` (`agt_…`) and `clientSecret` (`abs_…`). The secret is shown **once** and stored only as a hash.
2. The agent exchanges them for a short-lived EdDSA-signed access token at `POST /oauth/token` (JSON or form-encoded body):

   ```bash
   curl -s https://api.shop.example.com/oauth/token \
     -H 'content-type: application/json' \
     -d '{"grant_type":"client_credentials","client_id":"agt_…","client_secret":"abs_…","scope":"catalog:read quote:create"}'
   ```

3. It sends `Authorization: Bearer <access_token>` to `/mcp`, `/a2a` or REST. Tokens last 15 minutes; request a new one when it expires.

When a tool needs a scope the caller lacks, `/mcp` answers 401 (no token) or 403 (`insufficient_scope`) with a `WWW-Authenticate` header naming the scope and pointing at the OAuth protected-resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`. That document lists the authorization server (the built-in issuer, or your OIDC issuer when `IDENTITY_PROVIDER=oidc`) and the supported scopes, so standards-aware MCP clients can discover how to authenticate.

With `IDENTITY_PROVIDER=oidc` (Keycloak or another issuer), agents use client credentials at your identity provider instead. A token with a `client_id` claim, or with the realm role `agent`, maps to an agent principal with the scopes in its `scope` claim.

**Interactive connectors** (for example Claude's custom connectors) sign a *person* in with an OAuth authorization-code flow rather than client credentials. The built-in issuer implements client credentials only, so against a production store such a connector works anonymously and can browse. To let it negotiate and check out for a signed-in customer, run with `IDENTITY_PROVIDER=oidc` and an identity provider that the connector can use for login; the protected-resource metadata advertises that provider. This path has not yet been tested end to end. A demo-mode store, such as the public demo, lets any connector negotiate without signing in.

## Guardrails that apply to every agent

- **Policy in code.** Every price, discount, quantity and expiry comes from the pricing engine. Floors, costs, margins and other customers' data are never in a prompt, a tool result or an API response.
- **The LLM only writes the words.** A model may rephrase the template reply. The output guard rejects any reply with a number the services did not produce (including numbers spelled out in English or Hindi, Devanagari digits and "5k"-style shorthand), links, contact details, personal data, talk of floors, costs or margins, or promises of something free, and the template is sent instead.
- **The router can only add caution.** Each turn is routed from rules (tier 0) through a classifier, a small model and a large model to a person (tier 4). Every stage can raise the tier or deny the request; none can lower it or unlock anything. Injection attempts, complaints, low classifier confidence, late negotiation rounds and large carts all push upward.
- **Untrusted text stays data.** Buyer messages, offer notes and customization text are stored and passed as data, never as instructions. Unverified claims such as "another shop sells it for less" do not change the price.
- **Budgets.** Each intent has an output-token cap, and each conversation has a token budget (`SESSION_TOKEN_BUDGET`) and a spend cap, so the store cannot be used as a free general chatbot.
- **Quotas.** Each agent client has its own per-minute quota on top of the global rate limit.
- **Quotes are capabilities.** A quote token is HMAC-signed for the purpose `quote`, bound to the principal that requested it, expires, and is consumed exactly once. Requesting a new counter supersedes the previous quote.
- **A human pays.** Agents can create a checkout link but cannot pay. A person opens the link, confirms the address and terms, and pays on a gateway-hosted page or chooses cash on delivery.

## Connecting a client

See [Connect your own LLM app](../README.md#connect-your-own-llm-app) for Claude, Claude Code, Cursor and VS Code. For a quick manual check against a local store:

```bash
curl -s http://localhost:4000/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
curl -s http://localhost:4000/.well-known/agent-card.json
```
