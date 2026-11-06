# MCP registry and awesome-list submissions

Status: DRAFT checklist. Nothing here is submitted automatically. Do these by hand, only after the public
MCP demo works (see `launch-checklist.md`, section 3). Commands and list rules change: **verify current CLI
commands in the registry docs at submission time** (https://github.com/modelcontextprotocol/registry/tree/main/docs)
and read each list's contribution rules before opening a pull request.

## 1. Official MCP registry

AgentBazaar is published as a **remote** server (no npm or Docker package entry): the registry lists the URL
and clients connect to it over streamable HTTP.

Before publishing:

- [ ] The public demo is live with `DEMO_MODE=true`, `PAYMENT_ADAPTER=mock`, rate limits and a daily reset.
- [ ] `server.json` at the repository root has the real URL in `remotes[0].url`. The placeholder
      `https://demo.agentbazaar.dev/mcp` must be gone, and the domain must be confirmed as owned by the
      project. The registry checks namespace ownership, **not** control of the remote URL, so this check is
      ours.
- [ ] `name` is `io.github.mukulkathuria/agentbazaar`. GitHub login as `mukulkathuria` proves the
      `io.github.mukulkathuria/` namespace.
- [ ] `$schema` is `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` (or the
      newest schema the registry documents on the day).
- [ ] `description` is 100 characters or fewer (schema limit); `version` equals the release tag without the
      `v` (for example `0.9.0`).
- [ ] `remotes[0].type` is `streamable-http` and the URL is `https://`.
- [ ] `repository` is `{ "url": "https://github.com/mukulkathuria/AgentBazaar", "source": "github" }`.
- [ ] From another machine, an MCP client lists the 12 tools at that URL.

Publish (per the registry quickstart at the time of writing):

```bash
brew install mcp-publisher        # or download the release binary for macOS, Linux or Windows
mcp-publisher login github        # sign in as mukulkathuria
mcp-publisher publish             # run from the repository root, next to server.json
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.mukulkathuria/agentbazaar"
```

The last command should return our entry with `"name":"io.github.mukulkathuria/agentbazaar"`. For every later
release, bump `version` in `server.json` and publish again.

## 2. Awesome lists and directories

Use one description everywhere, adjusted only to each list's format:

> Open-source store where AI agents shop and negotiate over MCP and A2A inside price floors enforced in code.
> Self-hosted; GST, UPI and COD.

| Target | Category we fit | Ready-to-paste entry | Before submitting |
| --- | --- | --- | --- |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | E-Commerce | `- [mukulkathuria/AgentBazaar](https://github.com/mukulkathuria/AgentBazaar) - Self-hosted store for AI agents: search, signed quotes and negotiation inside price floors enforced in code, with checkout handed to a human. GST, UPI, COD.` | Add the list's own legend markers after the link (TypeScript codebase; cloud and local service). Check its contribution rules (pull request or web form) and alphabetical order |
| [appcypher/awesome-mcp-servers](https://github.com/appcypher/awesome-mcp-servers) | Verify: a commerce or shopping section if one exists, otherwise the closest catch-all | Same line, in that list's entry format | Verify the list is still maintained and accepting entries |
| [wong2/awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers) | Verify | Same line, in that list's entry format | Verify whether it takes pull requests or submissions through its website |
| [awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted) via [awesome-selfhosted-data](https://github.com/awesome-selfhosted/awesome-selfhosted-data) | E-commerce (verify the tag name) | YAML file below | Its rules require the software to be **first released more than 4 months ago**, so submit no earlier than 4 months after the `v0.9.0` release date. It also requires working installation instructions and no dependency on a specific cloud provider |
| Official A2A project resources (a2aproject on GitHub) | Verify whether a community agents or implementations list exists | `AgentBazaar - commerce agent with an A2A endpoint and Agent Card at /.well-known/agent-card.json; structured offers and quotes.` | Verify the list exists and how to contribute |
| Community "awesome A2A" lists | Verify exists | Same A2A line | Verify each list exists and is maintained |
| MCP directories such as Glama, PulseMCP, mcp.so and Smithery | Commerce or shopping, where offered | The shared description above | Verify each still exists; some import from the official registry or GitHub automatically, so check before submitting by hand |

awesome-selfhosted entry (`software/agentbazaar.yml`; verify the field names against the repository's
addition template before submitting):

```yaml
name: AgentBazaar
website_url: https://github.com/mukulkathuria/AgentBazaar
source_code_url: https://github.com/mukulkathuria/AgentBazaar
description: Commerce platform where people and AI agents shop and negotiate (MCP, A2A) inside price floors enforced in code.
licenses:
  - MIT
platforms:
  - Nodejs
  - Docker
tags:
  - E-commerce
```

## 3. After submitting

- [ ] Note each submission (link to the pull request or form receipt) in the launch issue.
- [ ] Answer reviewer questions within a few days; close the pull request yourself if the list declines it.
- [ ] Re-check entries when the public demo URL or the project description changes.
