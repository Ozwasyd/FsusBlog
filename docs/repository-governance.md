# Repository Governance

FsusBlog Public Preview uses GitHub-native repository controls as release safety rails. This page documents the expected default-branch settings; it does not enable branch protection through the API or derive policy from a product version.

## Source ownership

`src/` is the only canonical product-source root. Handwritten ZK circuit definitions
live in `src/zk/circuits/`; their generated R1CS/key/ceremony artifacts, security
manifests, runtime configuration, and test fixtures remain separated under
`artifacts/zk/`, `security/zk/contracts/`, `security/zk/provenance/`, `config/zk/`, and `tests/fixtures/zk/`.
The complete security ownership catalog is `security/catalog/security-domain.json`; flat files directly under
`security/` are forbidden, and matrices, policies, ZK contracts, provenance, and static evidence contracts must
stay in their declared subdomains.
`node tools/check-repository-source-layout.mjs` enforces the tracked top-level
inventory and requires an explicit architectural exception for any source domain
outside `src/`. The complete boundary is documented in
[`architecture/repository-layout.md`](architecture/repository-layout.md).

## Default Branch Protection

Protect the default branch, currently `master`, and mirror the same rule set if the default branch moves to `main`.

Required settings:

- Require a pull request before merge.
- Require review from CODEOWNERS when protected paths change.
- Dismiss stale approvals or require a fresh approval after new commits are pushed.
- Require branches to be up to date before merging when GitHub can enforce it without creating merge queues that hide failing checks.
- Restrict force pushes and branch deletion on the default branch.
- Restrict direct pushes to maintainers only; normal work should merge through pull requests.
- Use one merge strategy consistently. Public-preview maintainers should prefer squash merge or linear history; if merge commits are used, document the reason in the PR.
- Do not require signed commits until the project is ready to enforce signing across maintainers, bots, and release automation.

## Required Status Checks

The default branch rule should require these repository-security and quality checks:

| Check | Why it is required |
| ------- | -------------------- |
| `Change Contract / Change Contract` | Enforces the trusted-base PR title, linked issue, classification, evidence binding, release-note label, format history, and squash metadata contract. |
| `Quality Gate / Production Summary` | Summarizes the full production-ci-gate DAG and fails when any required upstream job failed, skipped unexpectedly, or produced invalid release evidence. |
| `Quality Gate / Validate Test Matrix` | Prevents drift between `tests/matrix.yml`, generated docs, and the GitHub Actions workflow. |
| `Quality Gate / Fast Backend DAG` | Covers deterministic backend unit, auth state-machine, concurrency, property, and golden tests. |
| `Quality Gate / Fast Frontend Unit DAG` | Covers frontend fast tests before broader browser gates. |
| `Quality Gate / Fast Static Governance` | Covers static policy checks, API/AEDS governance, label governance, and repository workflow governance. |
| `Quality Gate / Coverage Merge Threshold` | Keeps backend/frontend coverage evidence above the public-preview thresholds. |
| `Quality Gate / Security Runtime` | Covers auth, MFA, PoW, CSRF/browser matrix, AEDS fuzz, and security runtime checks. |
| `Quality Gate / Release Evidence` | Ensures release evidence artifacts are collected and schema-valid. |
| `Dependency Review / Dependency Review` | Blocks high-severity dependency changes and denied license families on dependency-changing PRs. |
| `CodeQL / Analyze (csharp)` | Runs CodeQL over the backend, shared contracts, and core C# source. |
| `CodeQL / Analyze (javascript-typescript)` | Runs CodeQL over the frontend TypeScript source. |
| `OpenSSF Scorecard / Scorecard` | Records weekly/default-branch repository security posture results. |

When GitHub branch protection cannot express the full `Quality Gate` dependency graph, requiring `Quality Gate / Production Summary` is the minimum safe branch rule because that job evaluates all required upstream jobs from the workflow's `needs` payload.

The unique machine-readable required-check contract for governed dependency PRs is `config/dependencies/required-checks.json`. It maps each dependency group and update type (`major`, `minor`, `patch`, `digest`, `lockFileMaintenance`) to the exact GitHub check names above; it does not use a blanket “all CI” label and does not copy those names into Renovate configuration. Governance tests local-simulate default-branch protection, require bidirectional alignment with that contract, and treat `skipped`, `neutral`, `cancelled`, `timed_out`, and missing required checks as unsuccessful.

`renovate.json5` enables GitHub platform auto-merge (`automergeType: "pr"`, `platformAutomerge: true`) for those five update types with no approval gate and no merge window. Local simulation is the merge gate: a PR may merge only when every catalog required check is `success`, the branch is up to date and conflict-free, and the PR is not draft. Draft, merge conflict, blocking labels, failed/skipped/neutral/missing checks, a stale default-branch base, a security bypass/direct push, or an outdated target version fail closed. After required checks have failed for 24 hours the simulator only adds `dependency-blocked` and does not close the PR, downgrade the target, or restore a previous version. No Renovate or bot branch-protection bypass is permitted.

The current private-repository plan returns HTTP 403 for both classic branch protection and repository rulesets. Until that external capability changes, `Change Contract` on a `master` push is a post-push audit rather than a preventive required check. Readiness and issue-closeout evidence must report that limitation explicitly and must not claim that the documented required-check set is enabled. Local simulation of the required-checks contract is the merge gate for this inventory.

## Dependency And Supply-Chain Checks

Repository-side routine dependency update authority is reserved exclusively for
the official Mend Renovate GitHub App. The root `renovate.json5` is its candidate
configuration; the exact managed surface and intentional path exclusions are registered in
`config/dependencies/update-surface.json`. No self-hosted Renovate workflow, PAT,
second update bot, or `.github/dependabot.yml` is permitted. Repository settings
must keep Dependabot alerts and Dependabot security updates enabled.

The candidate config requests six-hour checks, stable exact/pinned major, minor,
patch and digest updates, daily lock-file refreshes, and unscheduled vulnerability
updates. It does not extend `config:recommended`, `:ignoreModulesAndTests`, or
Renovate's default grouping presets, so real version fields under `tests/` stay
visible; fixture and generated-evidence paths are ignored only when
`update-surface.json` registers the exact path and reason. `fsusui-release-train`
is a delegated manager for `config/testing/fsusui-baseline.json` and is still
enumerated by `npm run deps:freshness`; it is not an ignore rule. Freshness is
fail-closed and assigns each catalog item exactly one of `current`,
`latest-target-pr`, or a dated exception in `config/dependencies/exceptions.json`.
The freshness workflow does not merge or close upgrade PRs. The App
installation, permissions, live Dependency Dashboard, and real update pull requests
are `external-unverified`; local acceptance uses the official config validator,
full dry-run, and `local-controlled-simulation` fixtures and does not claim those
external effects occurred. Every dependency change remains subject to Dependency
Review, the denied-license policy, and the normal CI gates.
Dependency Review runs when pull requests change package locks, project files, or
workflow files, blocks high-severity dependency changes, and denies the configured
AGPL/GPL/LGPL license families.

### Freshness execution and identities

From `src/frontend`, `npm run deps:freshness` invokes the unique producer
`tools/governance/check-dependency-freshness.mjs`. Its default evidence class is
`live-registry`; explicit `--fixtures` selects `local-controlled-simulation`.
Use `--output` with an existing parent directory to retain the structured result.
Registry, permission, source-extraction and pagination failures fail closed; a
missing registry snapshot is not evidence that every dependency is outdated.

Current npm versions come from the owned lockfile resolutions, not the lower
bound of a manifest range. Action identities use actual `uses` references, not
version comments. Pinned Docker identities retain `tag@sha256:...`; multiple
Dockerfile flavors use a sorted JSON array encoded in the version string, with
each flavor independently queried. Node targets include stable Current releases,
not only LTS. Action targets come from stable Action tags and their release
metadata, excluding unrelated bundle releases. Publication times come from the
upstream record, never the time the checker happened to observe it. npm registry
routing respects the root and manifest-adjacent `.npmrc` scope ownership.

PR targets are extracted from registered data files at the exact PR head using
the same extractor. Git commit/tree identity, regular-file mode and blob hash
bind those reads; candidate code is never executed. The original Renovate target
declaration remains available as `declaredTargetVersion`. Check collection
revalidates declarations and source targets before and after reading current-head
workflow attempts. Missing checks remain unsuccessful under the existing
required-checks catalog. Explicit supersession uses reciprocal PR-body lines
`Supersedes: #123` and `Superseded by: #456`; a shared package name alone does not
establish a successor.

`.github/workflows/dependency-freshness.yml` runs every six hours or by manual
dispatch on `master`, serializing the fixed `dependency-freshness-blockers`
concurrency group without cancelling an earlier run. It consumes the structured
producer result and maintains one `Dependency freshness blockers` issue. Recovery
closes that issue; a later blocker reopens it. Required-check failures persisting
for 24 hours add `dependency-blocked` to the affected PR; recovery removes only
that label. Read or permission failures cannot produce an issue-closing plan.
The scheduled entry point rejects fixture evidence and non-default-branch runs.

The delegated FsusUI baseline record is separate from local frontend source
consumption. Freshness enumeration neither updates that baseline nor modifies
the local FsusUI repository, and a newer upstream commit is not UI qualification.
Local tests simulate issue/label transitions and unavailable external execution;
they do not establish that GitHub scheduling, App installation or remote checks
actually ran.

CodeQL runs on pull requests and default-branch pushes that touch the monorepo source roots:

- `src/backend/`
- `src/frontend/`
- `src/shared/`
- `src/core/`

It also runs on a weekly schedule from the default branch. C# uses a manual backend build with `/p:PublishClientAssets=false` so CodeQL traces backend, shared, and core source without requiring the private frontend package install. JavaScript/TypeScript uses no-build analysis for `src/frontend/`. The current private repository keeps CodeQL in SARIF artifact mode because code scanning is disabled; when code scanning is enabled, maintainers may switch `upload: true` and add `security-events: write`.

OpenSSF Scorecard runs on default-branch pushes that touch repository governance files and on a weekly schedule. It stores SARIF as a workflow artifact and does not upload to Code Scanning while this private repository has code scanning disabled. No checks are ignored. Known interpretation notes:

- The Branch-Protection score should be evaluated against this document and the actual default-branch rule; classic branch protection visibility can differ from repository rules.
- Signed-Commits may score below perfect while this project intentionally keeps signing unenforced during public preview.
- Security-Policy, Code-Review, Dependency-Update-Tool, SAST, Token-Permissions, and Dangerous-Workflow should be treated as blocking review areas if the score regresses after these workflows are active.

## Workflow Permissions Policy

Default policy: each workflow starts from `permissions: contents: read`, then adds only the scopes it needs.

Allowed exceptions:

| Scope | Allowed workflow | Justification |
| ------- | ------------------ | --------------- |
| `pull-requests: read` | `dependency-review.yml`, `scorecard.yml`, `dependency-freshness.yml` | Dependency Review and Scorecard inspect PR metadata; freshness binds dependency targets and current-head checks. |
| `pull-requests: write` | `labeler.yml` | The path labeler applies labels to pull requests; it does not check out or execute PR code. |
| `issues: write` | `issue-triage.yml`, `dependency-freshness.yml` | Issue triage applies form labels; freshness maintains its fixed-title blocker issue and the `dependency-blocked` PR label through the Issues API. |
| `issues: read` | `scorecard.yml` | Scorecard needs read-only issue metadata in private repositories for maintainer/security posture checks. |
| `checks: read` | `scorecard.yml` | Scorecard needs read-only check metadata in private repositories to detect SAST and branch-protection signals. |
| `packages: read` | `quality-gate.yml`, `dependency-freshness.yml` | Quality Gate may install private packages; freshness reads scoped npm and GHCR publication metadata in a trusted default-branch run. |
| `actions: read` | `codeql.yml`, `scorecard.yml`, `dependency-freshness.yml` | Posture checks and freshness read workflow metadata; freshness binds required checks to exact PR heads and run attempts. |

Rules for untrusted code:

- Do not use repository write tokens in workflows that execute code from fork pull requests.
- Do not expose secrets to untrusted PR contexts. GitHub does not pass repository secrets to fork `pull_request` runs; maintainers must treat missing package tokens as expected for fork validation and rerun trusted jobs only after review.
- Keep secret-dependent release, package, deployment, and evidence publishing jobs on `push` to protected branches, scheduled runs, `workflow_dispatch`, or maintainer-controlled environments.
- Do not move secret-dependent jobs to `pull_request_target` unless the job does not check out or execute untrusted PR code.
- Set `persist-credentials: false` on checkout for posture workflows that do not need to push.

## Maintainer Checklist

Before marking a public-preview release branch as ready:

- Confirm the default branch rule requires PRs, stale review refresh, force-push restriction, and the required status checks above.
- Confirm CodeQL results exist for C# and JavaScript/TypeScript.
- Confirm OpenSSF Scorecard ran on the default branch during the current readiness window.
- Confirm Dependency Review still blocks high-severity dependency changes and denied license families.
- Confirm workflow permissions match this policy and no PR workflow gained unnecessary write permissions or secrets.
