# Backend atomic producer candidate contract

Status: proposed integration contract for [#2249](https://github.com/Ozwasyd/FsusBlog/issues/2249)
and [#2279](https://github.com/Ozwasyd/FsusBlog/issues/2279). This is module documentation,
not a second topology catalog, matrix schema, runtime receipt or qualification authority.
The canonical topology remains `tests/matrix.yml` and its existing physical projection.

## Owned APIs

`backend-atomic-producers.mjs` accepts caller-supplied declarations for a single domain
slice. `createBackendAtomicPlan(input)` validates the closed domain boundaries and
returns a deterministic `fsusblog.backend-atomic-plan-candidate.v1` with
`authority: DATA_ONLY`. It does not supply executable commands or discover dependencies.
`validateBackendAtomicPlan(plan, expectedDigest)` requires an independently selected
exact digest. `assertBackendAtomicPlanParity(local, ci, expectedDigest)` rejects source,
profile, run, readiness-mode, command or authority drift. `verifyBackendAtomicSourceRefs`
rereads all pinned command, input-closure, state and resource source bytes, rejecting
leaf and parent aliases. Reference byte validation does not admit their policy semantics.

Inputs contain `lane`, `identity` (source commit, worktree fingerprint, scheduler run,
profile), explicit `readinessMode`, `buildConfiguration` (`Release` for perf),
`releasePrerequisite`, and `declarations`.
Declarations bind the existing command source path/symbol, command digest, input-closure,
state/resource references, fixture profile, zero-retry policy and the three existing
execution-envelope/replay/temporal authority digests. No caller-selected command argv is
executed. The summary has a separate closed field set with no command or attempt.

`backend-atomic-outcomes.mjs` provides `projectBackendGovernanceOutcomes(input)` and
`projectBackendPerfOutcomes(input)`. Both require the domain plan, independently selected
plan digest, physical evidence root, source root and the existing external authority
verifier. Attempt references are exact relative paths and file-byte digests, distinct
from receipt content digests. The projection rereads immutable first-attempt receipts,
checks source/command/authority identity through the existing `validateAttemptReceipt`,
and verifies every log/artifact byte. Missing, repeated, second-attempt, aliased or
changed evidence refuses. Failure returns an honest complete vector and `exitCode: 1`;
it never runs a child or grants qualification. `verifyBackendAtomicSummary` recomputes
that full vector and requires an independently selected summary digest.

Performance projection receives the original governance plan and three original attempt
references. It recomputes their complete vector; a consumer attempt must retain
`governance-input.json` matching `backendGovernanceInput(summary, observations)`.
`readiness-input.json` must equal `backendReadinessInput(plan)`, binding the explicit
mode, plan and Release configuration. These retained input contracts cannot substitute
for the external verifier or real physical command admission.

## Dependency and failure boundaries

The governance slice contains the three existing source-file-size, test-governance and
PostgreSQL collection owners and a complete settled summary. No sibling hard edges are
admitted. Performance governance consumes that summary through a settled edge, without
calling the checkers again. Native P99 waits for its separately supplied Release test
assembly producer, and for governance/readiness to settle before its CPU measurement.
A readiness or governance failure therefore does not become an unrelated hard P99 edge.
The perf summary settles all three outcomes, classifying governance, product performance,
runtime infrastructure, build readiness, cancellation and actual build blocking.

The separate Release prerequisite is necessary: `EnsureBackendFilteredBuild` explicitly
excludes the benchmark project, while `ensure-benchmark-release-build.sh` builds that
project. Benchmark readiness does not establish the native test assembly. Its failed
verified attempt can justify a DATA_ONLY blocked native observation with spawn/attempt=0;
a blocked observation with physical native evidence refuses. This is a derived candidate
observation, not a replacement compiler terminal receipt. Native attempt timestamps must
follow the actual Release build and both sibling terminals. This detects domain overlap;
full host CPU isolation still belongs to the existing resource/measurement authorities.

## Canonical compiler and attempt bridge

`backend-atomic-bridge.mjs` supplies `compileBackendAtomicBridge(input)`,
`executeBackendAtomicBridge(binding, input, options)` and
`verifyBackendAtomicExecution(result, expectedDigest, binding, input, options)`.
Input supplies the same domain plans and selected digests, source root, canonical matrix
and canonical authorities. The bridge calls the existing `compileAtomicProducerDag`;
it neither synthesizes matrix declarations nor discovers commands. Compilation binds
physical ownership, original source/input/resource references, replay file bytes,
fixture identity, zero-retry policy and exact hard/settled edges to the owned plans.
Canonical command-source, input-closure and resource materials carry the original
`sourceRef`; fixture material carries `profileId`. Native state material carries its
original `sourceRef`. These sealed fields preserve domain provenance within the existing
canonical authority material. An unrelated executable producer refuses before execution.

Execution requires independently selected `expectedBindingDigest`, exact source/run/
worktree context and profile, original per-producer envelope/replay/temporal references,
external authority verifiers and the canonical scheduler capacity/state policy. Perf
producer environments must bind Release and the selected readiness mode. The bridge
calls `executeCompiledAtomicProducerDag` exactly once. It retains the executor's complete
terminal vector, including failures, cancellation and genuine build blocking; it then
projects original attempt receipts through the existing domain outcome APIs. Missing
attempts remain explicit projection failures. `BackendAtomicExecutionError.result`
retains the complete available vector. Executor preflight failure without a vector
propagates without manufacturing evidence. Original exit-zero commands missing structured
result sidecars retain `invalid-success-result-sidecar` refusal.

The result includes the actual immutable terminal-vector path and file-byte digest,
compiled DAG identity and complete domain projections. Readback revalidates vector,
receipt, artifact and log bytes without rerunning commands or repairing evidence.
The binding and result retain `qualificationEligible: false`: successful fixture command
execution is not native host admission or qualification.

## Exact capability composition and remaining integration

Bridge verification composes only the owned modules/tests with canonical capability
`2eda290cc6098971b685b3fb1465d7193bd3dde2`. Its atomic framework contains the published
cancellation correction `653ef38e2ce6dbcf8e2671bd8e091eb9c04538a0` and import correction
`ebf0d6e0e555ba8bf64ceb4dbc9de6427cc1699c`. Canonical source files are unchanged in the
composed test checkout. This branch requires that capability to be integrated before its
bridge test can run directly. Fixture commands, external verifier and state-conflict
policy are explicit test doubles; the compiler, executor, scheduler, first-attempt runner
and immutable receipt producers are the original implementations.

The remaining shared work belongs to its assigned owners:

- #2247/#2248 and #1686 must supply/register the real canonical matrix declarations,
  physical ownership, source closures, replay/temporal/envelope references and domain
  tests. The bridge consumes those capabilities; it does not alter their authority.
- The existing `_suite-support.sh` owner must replace `RunBackendGovernanceChecks`,
  `RunBackendTestGovernanceOnly` and `RunBackendPerfGovernanceOnly` execution with verified
  receipt-only consumption. Real original commands must produce admitted structured
  result sidecars; this increment does not wrap plain exit-zero as success evidence.
- The scheduler owner must consume the selected compiler binding and resulting terminal
  vector under its existing run/resource ownership. `readCanonicalSchedulerCheckpoint`,
  `readCanonicalSchedulerResourceGrant` and `commitSchedulerCheckpointCAS` remain its
  APIs; this module does not add checkpoint fields or write shared registry/checkpoints.
- The performance entry must invoke the same canonical compiler plan, dispatch explicit
  `build` versus `verify-fresh`, preserve Release commands, separately verify the native
  test assembly and remove duplicate readiness execution. Native filter, 32 samples,
  50ms budget, MCL evidence, CPU isolation and measurement admission remain unverified
  by synthetic commands. Local/CI/production parity and full matrix acceptance remain
  open until those real consumers and independent runtime evidence are available.

This increment does not change canonical topology, scheduler, shared inventory/history,
retention authority or frozen build/projection/finalizer adapters from
`d90349112269ad4bdd0925705126912265758dc1` (PR #3889). Independent review and integration
remain required.

Rollback: revert only the owned module/test increment if the canonical handoff disagrees;
retain original checker, build, budget, matrix, policy and failure evidence.
