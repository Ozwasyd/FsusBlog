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

## Required canonical integration

The following work remains with the assigned shared owners; it is not implemented here:

- #2247/#2248 must supply canonical matrix-derived declarations, current command/input
  closure and physical ownership, exact-one attempt compilation, zero-retry terminal
  receipts, scheduler resource admission and independently verified replay references.
- #1686 must register the two domain slices and owning tests through that canonical
  matrix/registry projection. The module's DATA_ONLY schema is not an upstream schema.
- The existing `_suite-support.sh` owner (PR #3733 at reservation) must replace
  `RunBackendGovernanceChecks`, `RunBackendTestGovernanceOnly` and
  `RunBackendPerfGovernanceOnly` execution with verified receipt-only consumption.
  The canonical compiler must keep the three original checker commands/input closures.
  Existing sequential paths remain visible on the source base; this increment does not
  assert that they were removed or admitted.
- The performance entry must use the same compiled plan as local/CI/production consumers,
  dispatch explicit `build` versus `verify-fresh` from policy, preserve existing Release
  commands, separately supply/verify the test assembly, and remove duplicate readiness
  execution. Missing/unknown mode must fail closed before physical execution.
- The native producer must preserve the existing filter, 32 samples, 50ms budget, MCL
  evidence, Release identity and measurement admission. Domain tests do not qualify an
  actual native P99 run, benchmark build, local/CI execution or full matrix acceptance.

The implementation reuses `attempt-provenance.mjs` digest/receipt validation and existing
`executeWeightedStepDag`/`runProducerAttempts` in isolated fixture tests. It neither changes
those owners nor duplicates the frozen build/projection/finalizer semantic adapters from
`d90349112269ad4bdd0925705126912265758dc1` (PR #3889). Fixture external verification is an
explicit test double. Actual upstream admission and independent review remain required.

Rollback: revert only the owned module/test increment if the canonical handoff disagrees;
retain original checker, build, budget, matrix, policy and failure evidence.
