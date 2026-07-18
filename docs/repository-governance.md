# Repository Governance

FsusBlog v1.1.0 public preview uses GitHub-native repository controls as release safety rails. This page documents the expected default-branch settings; it does not enable branch protection through the API.

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
|-------|--------------------|
| `Quality Gate / Production Summary` | Summarizes the full production-ci-gate DAG and fails when any required upstream job failed, skipped unexpectedly, or produced invalid release evidence. |
| `Quality Gate / Validate Test Matrix` | Prevents drift between `tests/matrix.yml`, generated docs, and the GitHub Actions workflow. |
| `Quality Gate / Fast Backend` | Covers deterministic backend unit, auth state-machine, concurrency, property, and golden tests. |
| `Quality Gate / Fast Frontend Unit` | Covers frontend fast tests before broader browser gates. |
| `Quality Gate / Fast Static Governance` | Covers static policy checks, API/AEDS governance, label governance, and repository workflow governance. |
| `Quality Gate / Coverage Merge Threshold` | Keeps backend/frontend coverage evidence above the public-preview thresholds. |
| `Quality Gate / Security Runtime` | Covers auth, MFA, PoW, CSRF/browser matrix, AEDS fuzz, and security runtime checks. |
| `Quality Gate / Release Evidence` | Ensures release evidence artifacts are collected and schema-valid. |
| `Dependency Review / Dependency Review` | Blocks high-severity dependency changes and denied license families on dependency-changing PRs. |
| `CodeQL / Analyze (csharp)` | Runs CodeQL over the backend, shared contracts, and core C# source. |
| `CodeQL / Analyze (javascript-typescript)` | Runs CodeQL over the frontend TypeScript source. |
| `OpenSSF Scorecard / Scorecard` | Records weekly/default-branch repository security posture results. |

When GitHub branch protection cannot express the full `Quality Gate` dependency graph, requiring `Quality Gate / Production Summary` is the minimum safe branch rule because that job evaluates all required upstream jobs from the workflow's `needs` payload.

## Dependency And Supply-Chain Checks

Dependabot version updates are intentionally not configured: the repository has no
`.github/dependabot.yml`, so routine npm, NuGet, and GitHub Actions upgrades are
batched by maintainers when needed instead of being opened as weekly bot pull
requests. Repository settings must keep Dependabot alerts and Dependabot security
updates enabled; security remediation pull requests are reviewed on their own risk
and must not be treated as routine version-update noise.

Every dependency change, whether submitted manually or by a security update, remains
subject to Dependency Review, the denied-license policy, and the normal CI gates.
Dependency Review runs when pull requests change package locks, project files, or
workflow files, blocks high-severity dependency changes, and denies the configured
AGPL/GPL/LGPL license families.

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
|-------|------------------|---------------|
| `pull-requests: read` | `dependency-review.yml`, `scorecard.yml` | Dependency Review needs PR metadata to inspect dependency changes. Scorecard needs read-only PR metadata in private repositories to evaluate review and branch-protection signals. |
| `pull-requests: write` | `labeler.yml` | The path labeler applies labels to pull requests; it does not check out or execute PR code. |
| `issues: write` | `issue-triage.yml` | Issue triage applies labels and status labels to public issue forms. |
| `issues: read` | `scorecard.yml` | Scorecard needs read-only issue metadata in private repositories for maintainer/security posture checks. |
| `checks: read` | `scorecard.yml` | Scorecard needs read-only check metadata in private repositories to detect SAST and branch-protection signals. |
| `packages: read` | `quality-gate.yml` | Quality Gate may install the private `@ozwasyd` frontend package in trusted CI contexts. |
| `actions: read` | `codeql.yml`, `scorecard.yml` | CodeQL and Scorecard use read-only workflow metadata while running private-repository artifact-mode posture checks. |

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
