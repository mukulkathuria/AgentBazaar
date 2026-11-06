# Launch when it works

Every box below must be ticked, by a person, with the evidence noted next to it (a CI run link, a command
output, a screenshot). An agent's opinion does not tick a box. If a box cannot be ticked, the launch waits.

Release: `v0.9.0` (lite release candidate). Release commit: `________`. Checked by: `________` on `________`.

## 1. The product works from a clean checkout

- [ ] The `Quickstart` workflow (`.github/workflows/quickstart.yml`) is green on the release commit. It runs
      `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm demo` (asserting the output contains `Order` and
      `paid`) and `pnpm docs:check`.
- [ ] The `CI`, `Security` and `Stack` workflows are green on the release commit.
- [ ] `pnpm demo` timed on a clean laptop (fresh clone, Node.js 22.12 or later, pnpm 12, after
      `pnpm install`): <!-- METRIC:demo_runtime_s -->not yet timed on a fresh clone. On a working copy (Intel
      Core i5-1345U laptop, 2026-11-05) it took 16.4 s with warm caches and 61.9 s on the first run after a
      code change, mostly TypeScript builds<!-- /METRIC -->. It must be under 60 seconds,
      because the README promises "Try it in 60 seconds". Record the machine.
- [ ] The README one-liner works exactly as written:
      `git clone https://github.com/mukulkathuria/AgentBazaar && cd AgentBazaar && pnpm install && pnpm demo`.
      If `pnpm demo` needs a `pnpm build` first, either fix the demo script or change the README.
- [ ] The Docker path works: `docker compose -f deploy/compose/docker-compose.yml --profile demo up --build`
      serves the storefront at http://localhost:3000, `tools/list` on http://localhost:4000/mcp returns all
      12 tools, and http://localhost:4000/.well-known/agent-card.json returns the Agent Card.
- [ ] Every Dockerfile the Compose file and the release matrix build exists and builds:
      `apps/api/Dockerfile`, `apps/web/Dockerfile`, `services/ai/Dockerfile`.
- [ ] At least one real MCP client (Claude, Cursor or VS Code) connected to a running store, searched,
      negotiated and received a checkout link. Note the client and version.
- [ ] A person completed the checkout link in a browser with the mock gateway and saw the order as paid.
- [ ] `pnpm docs:check` passes (README diagrams match `docs/diagrams/*.mmd`).

## 2. Launch assets come from real runs

- [ ] `docs/assets/demo-transcript.json` is the transcript of a real `pnpm demo` run on the release commit
      (not the `.sample.json` file).
- [ ] `docs/assets/demo.gif` regenerated from it:
      `uv run --with pillow python scripts/make-demo-gif.py --input docs/assets/demo-transcript.json`.
      The file is 6 MB or less and renders at the top of the README on GitHub.
- [ ] Social preview generated with `uv run --with pillow python scripts/make-social-preview.py` and
      uploaded in GitHub: Settings, General, Social preview.
- [ ] No `TBD` metric is left in the public pages. This prints nothing:
      `grep -rn -- "-->TBD<!--" README.md docs/benchmarks`. Each marker is either filled from a recorded run
      (with commit SHA and hardware in `docs/benchmarks/lite.md`) or its row or sentence is removed. The
      drafts in `docs/launch/` keep their markers; fill them in the copy you post.
- [ ] Every number in every post traces to a recorded run, a test, or the code. Remove anything that does not.
- [ ] Adversarial suite on the release commit: floor leaks
      <!-- METRIC:adversarial_floor_leaks -->0 (pre-release working copy, 2026-11-05)<!-- /METRIC -->, PII leaks
      <!-- METRIC:adversarial_pii_leaks -->0 (same run)<!-- /METRIC -->. Both must be zero (plan release gate).

## 3. Public MCP demo

- [ ] Deployed and reachable over HTTPS. The placeholder `https://demo.agentbazaar.dev/mcp` in `server.json`
      and the README is replaced by the real URL, and the domain is confirmed as owned by the project.
- [ ] Runs with `DEMO_MODE=true` and `PAYMENT_ADAPTER=mock` (the config refuses `DEMO_MODE` with any other
      payment adapter). No real payment keys exist on that host.
- [ ] Uses the template LLM (`LLM_ADAPTER=template`), or a hosted model only with a spend cap set at the
      provider and `SESSION_TOKEN_BUDGET` configured.
- [ ] Rate limits set (`RATE_LIMIT_PER_MINUTE`, Caddy in front). A burst from one IP is throttled; check it.
- [ ] Daily reset in place: the demo store is wiped and reseeded on a schedule (for example a scheduled
      restart of the demo container, which runs PGlite in memory when `PGLITE_DATA_DIR` is unset).
- [ ] The storefront says plainly that it is a demo: no real products, payments or deliveries, and no real
      personal data should be entered.
- [ ] An uptime check on `/readyz` alerts a maintainer.

## 4. Security

- [ ] GitHub private vulnerability reporting is enabled (Settings, Code security) and `SECURITY.md` points
      to it. Test by opening the "Report a vulnerability" form (do not submit).
- [ ] gitleaks, Semgrep, OSV-Scanner, Trivy and the licence gate are green on the release commit.
- [ ] No production secrets exist in the repository or its history (gitleaks runs over full history).
- [ ] `README.md` states that an independent penetration test and a design review of the payment and agent
      flows are required before any real-money use. That test is **not** required for a demo launch with
      mock payments, and the README must not imply it has been done.

## 5. Legal and docs

- [ ] The README "Legal, compliance and security" section is present: MIT without warranty, operators
      responsible for compliance in their jurisdiction, DPDP features listed, GST seed rates illustrative,
      penetration test before real money, not legal advice, reporting via `SECURITY.md`.
- [ ] Every file in `docs/compliance/drafts/` starts with a prominent DRAFT notice.
- [ ] Payment statements are accurate: Razorpay is "not yet verified against the live sandbox" unless a
      person has run it against Razorpay test mode; YouPI-PG is marked experimental with its own README's
      cautions.
- [ ] `NOTICE` and `MODELS.md` match the shipped dependencies and models; `pnpm license:check` passes.
- [ ] `CHANGELOG.md`: the `0.9.0` section is dated and no longer under "Unreleased".
- [ ] `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `GOVERNANCE.md`, issue and PR templates and `CODEOWNERS` exist.

## 6. Release

- [ ] Tag `v0.9.0` on the green release commit.
- [ ] The `Release` workflow published the `api`, `web` and `ai` images to GHCR, signed them with Cosign
      (keyless) and attached the SBOM to the GitHub release. Verify one signature with `cosign verify`.
- [ ] GitHub release notes match `CHANGELOG.md`.
- [ ] Repository settings: description ("The full store for the agent era."), website, and topics such as
      `mcp`, `a2a`, `ecommerce`, `ai-agents`, `self-hosted`, `nestjs`, `gst`, `upi`.
- [ ] `server.json` version equals the release version.

## 7. Distribution and support

- [ ] MCP registry entry published and visible (see `registry-and-awesome-lists.md`).
- [ ] Awesome-list pull requests opened only after the public demo URL works, following each list's rules.
- [ ] Each post re-read against the community's current rules on the day of posting.
- [ ] Labels `good first issue` and `help wanted` exist, with a few real issues tagged.
- [ ] A maintainer is available for 48 hours after each post to answer questions and triage issues.
