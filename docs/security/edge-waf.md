# Edge protection: WAF, CrowdSec and bot management

What stands in front of the API and the storefront in each profile, how it was tuned for an agent-first store, and
how CI proves it. Decisions and trade-offs: [ADR 0014](../adr/0014-platform-at-scale-analytics-edge-siem.md).

## Lite and growth on Compose: Caddy + Coraza (OWASP CRS) + CrowdSec

| Piece | Version | Role |
| --- | --- | --- |
| Caddy, built with xcaddy (`deploy/compose/caddy/Dockerfile`) | 2.11.7 | TLS, security headers, reverse proxy, JSON access log |
| coraza-caddy (Apache-2.0) with the embedded OWASP Core Rule Set (coraza-coreruleset) | 2.6.2, CRS 4.25 | WAF, blocking mode, paranoia level 1, anomaly threshold 5 |
| caddy-crowdsec-bouncer (Apache-2.0) | 0.14.1 | Refuses addresses CrowdSec has banned, refreshed every 10 s |
| CrowdSec agent (MIT), `crowdsec` service | 1.8.1 | Reads Caddy's access log; hub collections `crowdsecurity/caddy`, `base-http-scenarios`, `http-cve`, plus `agentbazaar/sign-in-bf` |

Set `CROWDSEC_BOUNCER_KEY` in `.env` (`openssl rand -hex 32`); Caddy refuses to start without it. The WAF settings
and exclusions live in `deploy/compose/caddy/waf/` and are mounted read-only, so a change needs only
`docker compose restart caddy`.

**Exclusions, and why** (`before-crs.conf`, `after-crs.conf`):

1. PUT, PATCH and DELETE are allowed methods: the API uses PUT for consents and MCP clients send DELETE to end a
   session.
2. `/api/v1/payments/webhooks/*` is scored and logged but never blocked: the API checks the gateway's HMAC over the
   raw body before reading anything, and a false positive on a gateway's notes must not cost a payment notification.
3. The SQL-injection rules (tag `attack-sqli`) skip only the free-text JSON fields shoppers and agents write: chat
   `text`, MCP `make_offer` `message`, personalisation `text.*` and `customization_text.*`, and A2A message parts.
   Ordinary sentences ("I'd like to select the red one -- or drop the price?") trip those rules; the API never puts
   such text into SQL. XSS and every other rule still inspect these fields, and SQL-injection rules still inspect
   everything else, including search queries and other MCP tool arguments.

Response bodies are not buffered (`SecResponseBodyAccess Off`), so streamed replies (SSE on `/mcp` and chat) keep
streaming.

**CrowdSec's sign-in scenario** (`agentbazaar/sign-in-bf`): more than 5 failed `POST`s to `/api/v1/auth/login` or
`/oauth/token` (401 or 429) from one address within about 10 s bans it (default 4 h). It complements the API's
per-account lockout (5 failures, 15 minutes), which cannot see one address walking through many accounts. CrowdSec
whitelists private addresses, and Caddy trusts `X-Forwarded-For` only from private ranges.

**Proof in CI** (`.github/workflows/edge.yml`, on every change to these files and nightly): builds the image, boots
it in front of the demo API with the CrowdSec agent (`compose.edge-test.yml`) and runs `test-edge.sh`. First green
run, 2026-11-06 ([run 42211285774](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42211285774), commit
`5d88f3f`; the image build and boot took 4 minutes, the checks 6 seconds): **26 of 26 checks passed**.

| Kind | Checks |
| --- | --- |
| Passes the WAF | storefront home, product page with tracking parameters, search, Next.js chunk, image optimizer, `llms.txt`; API search, search with apostrophes, agent card; MCP `tools/list`, `search_products`, `request_quote`, `make_offer` with a message full of quotes and dashes, session `DELETE`; chat text with quotes and SQL words; A2A `message/send`; a payment webhook reaches the API, which answers 401 for the bad signature |
| 403 from the WAF | SQL injection in a query string and in an MCP tool argument; XSS in the storefront search and in chat text; path traversal in the path and in a parameter |
| CrowdSec | 12 failed sign-ins from 203.0.113.77 got that address refused at the edge (403) while 198.51.100.23 was still served, and the decision came from `agentbazaar/sign-in-bf` |

The storefront upstream in this test is an nginx stand-in (the WAF inspects requests, so the upstream does not
matter); the real storefront runs in the Stack workflow.

## Scale on AWS: AWS WAF with Bot Control

`deploy/terraform/modules/waf`, attached to the ALB in growth and scale:

- AWS managed rule groups: Core rule set, Known bad inputs, IP reputation.
- Rate rules answering 429: per IP (2,000 per 5 minutes), sign-in endpoints per IP (100), per bearer token (60,000,
  above the largest per-agent quota the API allows), and on scale per unverified bot name and IP (600).
- Bot Control (scale default `COMMON`) on the **storefront host only**. The API serves agents by design, so their
  HTTP clients and AI crawlers are counted and throttled rather than blocked (`waf_bot_control_count_rules`); the
  API's per-agent quotas (`quota_per_minute` per client) stay the precise limit.
- `waf_verified_agent_cidrs`: partner agents' IPv4 ranges, labelled and exempt from the per-IP limit only.

Planned against mocked AWS in `deploy/terraform/profiles/scale/tests/waf-bots.tftest.hcl` (OpenTofu 1.10).

## Related

- SIEM: refusals at the API, prompt-injection flags and audit events go to Wazuh, see
  [deploy/siem](../../deploy/siem/README.md).
- Dependency review, SBOM diff and the licence gate: [supply-chain.md](supply-chain.md).
