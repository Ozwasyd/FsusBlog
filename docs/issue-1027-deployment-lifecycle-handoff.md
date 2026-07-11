# Issue #1027 deployment lifecycle handoff

This file records the completed static integration readback. It is not test output and does not claim the issue is verified or closable.

## Landed behavior

- Production slots start as `Starting/Candidate`; a positive immutable runtime generation and complete startup/dependency/release gates are required before `Ready`.
- `POST /api/ops/deployment/activate` and `POST /api/ops/deployment/drain` use exact release ID, slot and generation CAS. Repeats on the same state are idempotent; mismatches and activation after drain fail closed.
- Deployment control requires the existing independent admin principal `system.config` permission, fixed-IP limiting and a loopback Kestrel remote address. The host helper reads exactly one Bearer or Cookie header from a mode-0400/0600 file and never writes it to evidence.
- Ordinary HTTP uses atomic in-flight leases and excludes health/ops probes and notification stream. Notification connections and global background claims have separate counters/admission gates.
- Draining immediately overrides cached readiness, rejects new ordinary requests and notification handshakes with retryable 503 semantics, and prevents new global worker claims while already-entered work remains counted.
- The drain coordinator invokes `ReleaseDrainParticipantRegistry` and reports bounded counts for HTTP, notification, background claims, article views, hot stats, audit, admin audit, visit log, RUM, security/challenge audit, public-hot updates, article-detail AEDS, Public AOT backfill and upload-cleanup signals. Timeout remains `drained=false,timedOut=true` with exact blockers.
- Active drain, `ApplicationStopping` and hosted `StopAsync` share one state/task. Preflight rejects a Docker stop grace period that is not greater than the configured application drain deadline.
- Gateway switch proves source `Active` and target `Ready Candidate`, activates target before OpenResty reload, commits durable traffic state, then drains source. Pre-commit recovery restores source and neutralizes target; target-commit recovery repeats activation CAS and requires complete source drain evidence.
- Gateway transition/recovery evidence contains sanitized lifecycle snapshots and cannot become release-closeout `ok` without the applicable activation, neutralization and drain checks.

## Executable owners added or extended

- `tests/backend/Unit/DeploymentRuntimeStateTests.cs`: state gates, CAS/idempotency, ordinary request completion/rejection, exception/cancellation accounting, background and notification separation, blockers/timeout, host stopping and public health privacy.
- `tests/backend/Unit/NotificationStreamBoundaryTests.cs`: a draining runtime rejects a new handshake before admission with `deployment_draining` and 503.
- `tests/tools/gateway-switch.test.mjs`: source/target lifecycle doubles, activation-before-cutover, source drain, rollback candidate restart, interrupted transition recovery and lifecycle evidence.
- `tests/tools/deployment-slots.test.mjs`: candidate generation labels plus semantic drain-deadline/stop-grace preflight.

No existing test ID was deleted. The exact no-deletion record and governance readback are in `tests/backend/issue-1027-retention-replacements.json`.

## Central governance readback

Coverage ID `deployment-runtime-lifecycle` is already present in `tests/coverage-registry.json`. The backend requirements include `DeploymentRuntimeStateTests.cs`, `NotificationStreamBoundaryTests.cs`, `gateway-switch.test.mjs` and `deployment-slots.test.mjs`; `tests/matrix.yml` maps the lifecycle owners into static-governance, backend API integration/runtime, resilience and production coverage; static governance retains both Node deployment suites. No central registration remains pending in this handoff.

## Risk and no-restart rollback

- Before durable commit: keep source `Active`, restore/reload its controlled include and CAS-drain any target that was activated. Durable state may return to stable only when both are proven.
- After durable commit: keep target `Active`; failure to drain source blocks closeout and remains explicit evidence. Do not automatically reverse public traffic after commit.
- A retired Draining process cannot be reactivated. Restart the retained immutable previous manifest as a fresh Ready Candidate before rollback.
- A hard stop or missing source runtime cannot be rewritten as complete drain evidence. Traffic recovery may succeed while release closeout remains failed/incomplete.

## Scenario coverage contract

- Anonymous and logged-in ordinary requests use the same low-cost lease and retain existing auth/RiskControl behavior.
- Admin deployment writes require `system.config`, loopback source and high-value audit; remote or mismatched CAS requests are rejected.
- Notification stream uses independent connection accounting and returns explicit retry semantics during Candidate/Draining.
- Binary endpoints remain AEDS and pass through the ordinary HTTP lease; no JSON business fallback or frame change was added.
- Public health remains `status/checkedAt` plus the optional stable
  `schema_incompatible` readiness code; detailed release topology, migration ids
  and blockers remain protected.

All validation is intentionally deferred until every issue in the requested landing batch has completed its code/test/document phase.
