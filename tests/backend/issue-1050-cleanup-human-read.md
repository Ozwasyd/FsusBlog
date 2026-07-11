# Issue #1050 cleanup worker and HumanRead behavior map

Issue #1050 removes source-reading assertions from three mixed backend test
files and keeps their observable contracts in responsibility-specific suites.
No replacement test opens production, frontend, entity, stats, or sibling test
source as evidence.

## Test ownership

| Responsibility | Behavior owner | Evidence |
| --- | --- | --- |
| Visit cleanup paging and cutoff | `LogCleanupDatabaseBehaviorTests` | PostgreSQL rows before/at cutoff, chunk size two, complete deletion count |
| RUM, ordinary audit, and anonymous credential audit cleanup | `LogCleanupDatabaseBehaviorTests` | PostgreSQL deletion and retained cutoff/high-value/critical rows |
| Cancellation, max chunks, single-batch failure, clock, and lease | `LogCleanupWorkerBehaviorTests` | substituted ADO, injected `TimeProvider`, and lease fake |
| Queue capacity, overflow, one-shot consumption, and coalescing | `UploadSessionCleanupQueueBehaviorTests` | bounded queue operations with a manual clock |
| Overflow retry and cleanup-time signals | `UploadSessionCleanupWorkerBehaviorTests` | actual worker flush loop with cleanup callback and lease fake |
| Valid, replayed, tampered, short, expired, and duplicate-viewer proofs | `HumanReadProofSubmissionBehaviorTests` | service submission, recording cache, channel output, and controllable time |
| Browser headers, origin/referer, device, scope, and article binding | `HumanReadProofRequestBindingTests` | challenge/submission results against real service validation |
| Account irreversibility and stats dimensions | `HumanReadProofPersistencePrivacyTests` | reflection, JSON serialization, projection, PostgreSQL insert, and query |

The exact fifteen baseline-ID replacements are recorded in
`issue-1050-retention-replacements.json`. Entries that represented performance
implementation details point to the #1042 backend benchmark lane rather than a
new source-token test. The five deleted source-reading IDs also name the single
historical-residue checker and its executable positive/negative fixture, so the
old suites cannot silently return under the same or a replacement owner.

## Production seams

- `LogCleanupService` receives the already registered `TimeProvider` for both
  the daily timer and cutoff calculation, exposes one internal lease-cycle
  entry, and provides internal target overloads for controlled chunk tests.
  Runtime retention values and SQL semantics are unchanged.
- `UploadSessionCleanupWorker` keeps its public DI constructor. An internal
  cleanup callback constructor allows deterministic worker tests, while the
  runtime path still creates a scope and calls
  `FileService.CleanupExpiredSessionsAsync`.
- The worker checks both the one-shot overflow marker and signals queued during
  the active cleanup before ending a flush cycle, so neither form of pressure
  is lost.
- `HumanReadProofService` already exposes the required clock/cache/channel/logger
  boundaries; only the test harness is new.

## Static residue ownership

- `tools/check-historical-residue.sh` rejects the three retired mixed-suite
  class names and repository source-reader APIs in all seven replacement files
  plus the HumanRead harness.
- The existing HumanRead runtime guards reject visit-log `UserId`, registered
  versus anonymous visit dimensions, and raw visit-IP persistence. Schema
  migration maintenance remains the only explicit user-binding allowlist.
- `check-historical-residue-fixture.mjs` includes separate failing fixtures for
  an old mixed suite, a source reader inside a replacement behavior file,
  visit user binding, and raw IP, while a source-free replacement suite remains
  in the allowed fixture.

## Shared registry status

This issue-specific pass does not edit the shared registries. The current
worktree already contains the three `backend-*-behavior` coverage entries and
the split test owners in `tests/coverage-registry.json`, `tests/matrix.yml`, and
`tests/backend/Fixtures/backend-test-requirements.json`; static governance
already owns the historical-residue checker. Path and registration presence is
not execution evidence. The issue-local manifest records the observed shared
owners with `verificationStatus=not-run` so later convergence can compare them
without pretending the tiers passed.

## Acceptance handoff

| Acceptance item | Code state | Evidence state |
| --- | --- | --- |
| Log paging, cutoff, targets, cancellation, limits, failure, lease | Split database and worker owners present | Not run |
| Upload capacity, overflow, one-shot consumption, coalescing, in-flight signal, retry | Split queue and worker owners present | Not run |
| HumanRead replay, tamper, dwell, browser headers, TTL, origin, device/scope/article binding, single write, identity irreversibility | Submission, request-binding, persistence/privacy owners present | Not run |
| Old source-reading suites removed and prevented from returning | Historical residue rule plus negative/safe fixtures present | Not run |
| Retention replacement | Fifteen exact baseline IDs mapped | Not run by convergence audit |
| Coverage, mutation, timing, backend/integration/background/privacy/stats/production-fresh | Owners are registered or handed off | Required runtime artifacts pending |

No tests, build, lint, syntax check, coverage, mutation, timing, or production
fresh run was executed during this implementation phase. Those evidence
artifacts must be generated by the later unified validation phase; this file
does not claim they passed.
