# Governance

AgentBazaar is a young project with a single lead maintainer. This document says how decisions are made today and how that will change as more people contribute. Changes to it are made by pull request and need the lead maintainer's approval.

## Roles

| Role | Who | Can |
| --- | --- | --- |
| User | Anyone running or evaluating AgentBazaar | Open issues, ask questions, propose features |
| Contributor | Anyone with a merged pull request | Everything a user can, plus review others' pull requests (reviews are welcome from anyone) |
| Maintainer | Listed below | Triage, review and merge pull requests, cut releases, handle security reports and Code of Conduct reports |
| Lead maintainer | Mukul Kathuria ([@mukulkathuria](https://github.com/mukulkathuria)) | Everything a maintainer can, plus final say on disputed decisions, the roadmap, licensing and governance |

Current maintainers: Mukul Kathuria (lead). Code ownership for review routing is in [.github/CODEOWNERS](.github/CODEOWNERS).

## How decisions are made

- **Everyday changes** follow lazy consensus: a pull request that passes CI and has a maintainer's approval is merged unless someone raises a concern.
- **Significant technical decisions** (a new dependency or service, a change to a port, data model, security model or profile) are recorded as an [ADR](docs/adr/README.md). The ADR is discussed in its pull request; if consensus is not reached, the lead maintainer decides and the ADR records the reasoning.
- **Decisions that always need a person, never an automated agent:** switching a payment adapter to live keys, approving a release's evidence report, security disclosure timing, legal and licensing questions, and changes to this document. Code written with AI assistance is welcome and is reviewed exactly like any other code; an agent's own opinion never counts as a review or a passing gate.

## Releases

- Versions follow [Semantic Versioning](https://semver.org). Before 1.0, minor versions may contain breaking changes, which are called out in [CHANGELOG.md](CHANGELOG.md).
- Planned tags: `v0.9` (lite release candidate), `v0.95` (growth), `v1.0` (all three profiles pass), `v1.1` (ops agents). See the roadmap in the [README](README.md#roadmap).
- A release is tagged only when the release gates pass (full end-to-end, regression and upgrade suites for each shipped profile, load and soak criteria, a DAST scan with no high findings, a signed image with an SBOM, zero floor or PII leaks in the adversarial suite, updated docs and benchmark) and a maintainer has approved the evidence report.

## Becoming a maintainer

Contributors who have made sustained, high-quality contributions (code, reviews, docs, triage) over several months may be invited by the lead maintainer, or may ask. New maintainers start with review and triage rights. As soon as there are at least three maintainers, adding or removing a maintainer needs the agreement of a majority of them, and this document will be updated to move from a lead-maintainer model to a maintainer council.

A maintainer who is inactive for six months may be moved to emeritus status, and can return by asking.

## Code of Conduct and security

Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md); maintainers enforce it. Security reports follow [SECURITY.md](SECURITY.md) and are handled privately by maintainers.

## Licensing

The project is licensed under the [MIT License](LICENSE). Contributions are accepted under the same licence, with no contributor licence agreement. Dependencies must pass the licence gate described in [CONTRIBUTING.md](CONTRIBUTING.md#licensing-of-contributions). Changing the project's licence is out of scope for ordinary decision-making and would need the agreement of the copyright holders.
