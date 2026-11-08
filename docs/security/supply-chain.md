# Supply-chain checks

| Check | Where | When | Fails the run on |
| --- | --- | --- | --- |
| Licence gate (`scripts/license-check.mjs`, every workspace's production dependencies) | Security workflow | every push, pull request and nightly | a licence outside the allowlist |
| OSV-Scanner, Trivy, Semgrep, gitleaks | Security workflow | every push, pull request and nightly | known vulnerabilities, findings, secrets |
| Dependency review (`actions/dependency-review-action` 5.0.0) | `.github/workflows/supply-chain.yml` | pull requests, and pushes to main that change a manifest or lockfile (against the previous commit) | a new or updated dependency with a high or critical advisory, or a licence outside the same allowlist in SPDX form |
| SBOM diff (syft through `anchore/sbom-action`) | `.github/workflows/supply-chain.yml` | same | never: it writes the packages added and removed between base and head to the job summary and the log |
| Release SBOM, signed images with provenance | `release.yml` | release tags | build or signing errors |

## Owner step: turn on the Dependency graph

Dependency review needs the repository's **Dependency graph**, which is off for this repository today. Only the
owner can turn it on: **Settings > Code security > Dependency graph > Enable** (free for public repositories).
Until then the Dependency review job checks the setting first (`GET /repos/{owner}/{repo}/dependency-graph/sbom`
answers 404 while it is off), skips the review and leaves a warning in the run and its summary, so pushes are not
failed by a missing setting; the licence gate and the SBOM diff keep running. Once the graph is on, the same job
starts enforcing with no change to the workflow.

## pnpm 12 lockfiles and syft

pnpm 12 writes `pnpm-lock.yaml` as two YAML documents: pnpm's own packages, then the project's. syft (1.33) reads only
the first, so an SBOM of the repository would list pnpm and the Python packages but none of the npm dependencies.
Both the SBOM diff and the release SBOM job keep only the last document before running syft: on this repository that
is the difference between 15 npm packages and 561. Image SBOMs from BuildKit (`sbom: true` in `release.yml`) scan the
installed `node_modules` and are not affected.

## Results

- SBOM diff logic, reproduced in WSL with syft 1.33 before it went into the workflow: base `a786c9d` (M0) against
  the 2026-11-06 head gave 434 and 560 npm packages, 126 added and 0 removed; identical inputs gave no difference.
- On main, 2026-11-08 ([run 42438395560](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42438395560),
  commit `fb51e97`): green. Dependency review warned that it is inactive (Dependency graph off); the SBOM diff
  counted 953 packages in base and head, 0 added and 0 removed (that push changed no dependency). The run before it
  ([42437960747](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42437960747)) failed with "Dependency
  review is not supported on this repository", which is what the setting check now handles.
