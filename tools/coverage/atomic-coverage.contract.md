# Atomic coverage migration input contract

This module is an implementation input for issues [#2278](https://github.com/Ozwasyd/FsusBlog/issues/2278)
and [#2254](https://github.com/Ozwasyd/FsusBlog/issues/2254). It is not a second matrix,
scheduler, attempt runner, coverage implementation or release authority. The maintained
execution topology remains `tests/matrix.yml`. These source contracts now consume the published upstream
[#2248](https://github.com/Ozwasyd/FsusBlog/issues/2248) compiler; their output always declares `qualificationEligible: false`.

## APIs

`createCoveragePlan({root, identity, coverageRoot, environment})` binds the explicit
run ID, exact source commit, source fingerprint, coverage root, threshold environment,
collector/checker source bytes and unchanged leaf argv. `validateCoveragePlan(plan, root)`
recomputes the complete binding. Local and CI inputs with equal values yield equal
content digests. This domain input digest is **not** the canonical compiled DAG digest.
The compiler must register these inputs through the sole matrix and seal its own plan.

The declaration inputs contain the following physical actions:

| Producer | Hard coverage prerequisite | Output layout |
| --- | --- | --- |
| `coverage-backend` | None within this subchain | `backend-merged/Summary.json`, Coverlet JSON, Cobertura, backend universe |
| `coverage-frontend` | None within this subchain | `frontend/Summary.json`, original Vitest raw summary |
| `coverage-merge` | Both collections | `merged/Summary.json` |
| `coverage-scope-snapshot` | Merge | `scope-snapshot.json` |
| `coverage-threshold-merged` | Merge | Canonical attempt logs |
| `coverage-threshold-backend` | Backend collection | Canonical attempt logs |
| `coverage-threshold-frontend` | Frontend collection | Canonical attempt logs |

This table describes coverage edges only. Build, dedicated backend lanes, fixture,
resource and physical ownership prerequisites remain with the canonical matrix/compiler.
In particular, removing the old broad `coverage-root` lock must follow verified physical
write ownership; this module does not assert that every pair can safely run together.
Backend raw coverage/shard completeness remains checked by the existing collector.

`prepareCoverageProducer({root, plan, producerId, inputs, verifyAuthority})` accepts an
exact map of that producer's hard predecessor materials. It revalidates attempt, replay,
all retained attempt artifacts, and public output bytes before returning one leaf argv.
Missing, failed, duplicate, cross-run, wrong-domain or tampered inputs throw; the compiler
must record blocked with zero spawn. Collection actions have no coverage inputs. It must
revalidate at its spawn boundary and prevent input writes until the consuming action
settles; the preparation function cannot confer resource isolation across a later spawn.

`readCoverageMaterial({root, plan, producerId, material, verifyAuthority})` consumes:

```js
{
    attemptRef: { path: '.tmp/attempts/run/producer/attempt-1/receipt.json', digest: 'sha256:...' },
    artifacts: [
        { role: 'summary', path: '.tmp/coverage/backend-merged/Summary.json',
            digest: 'sha256:...', attemptPath: 'outputs/summary.json' }
    ]
}
```

The example is only a shape: exact required roles/paths come from the plan. References
are repository relative and must be regular files, without symlink ancestors or traversal.
The canonical attempt receipt is read using the existing `validateAttemptReceipt` and
`correctness-first-attempt` policy; each producer must have attempt 1 of 1. Its argv must
match the plan. The supplied `verifyAuthority` is the existing external owner's independent
verifier for execution-envelope, replay-plan and temporal-context references. Omission or
failed verification rejects the material. The replay plan is also reread and validated
through existing `validateReplayPlan`, including actual source/run/producer and argv.
`artifactDigest` seals replay file bytes; its internal `planDigest` separately seals the
unsigned replay plan. These two digests are not interchangeable.

The attempt runner captures files under its attempt root. The canonical execution owner
must capture immutable output snapshots there, include their digests in the existing attempt
receipt, and supply the role/public-path-to-attempt-path mapping. A caller-supplied public
digest without the retained attempt snapshot is refused. Backend material requires summary,
raw JSON, exchange Cobertura and universe; frontend requires summary and raw Vitest summary.
Collection summary source identity and backend raw/exchange paths are checked. A merged
summary must explicitly include both domains and the existing weighted merge method.
Missing coverage metrics are refused before a zero-default threshold checker can see them.
This reader does not independently validate Coverlet/Vitest membership or instrument tests;
those authorities remain with the actual collectors and replay/execution verifiers.

`projectCoverageSettled({root, plan, projectionId, outcomes, verifyAuthority, verifyBlocked})`
performs no commands. `coverage-gate-summary` projects the three collection/merge members;
`coverage-threshold-summary` projects all four scope/threshold members. Missing entries
remain visible as `missing` and fail the aggregate. Failed/cancelled attempts remain failed.
Successful summary refs remain separately named backend/frontend/merged; a partial merge
can never supply a merged ref. Unknown members are rejected. The aggregate is DATA_ONLY,
including on all-success inputs: its byte digest is not a scheduler qualification receipt.

A blocked outcome supplies only `{blockedRef: {path, digest}}`. Its bytes are rehashed, then
the canonical compiler's independent `verifyBlocked` must return producer/identity/plan digest,
`terminalState: 'blocked'`, nonempty direct `blockedBy` edges and primary failure refs.
Omitting this verifier is an error. The compiler owns verification of causal failure refs,
blocked-versus-spawned consistency, complete terminal membership, no second execution and
receipt authority; this module cannot manufacture that absent upstream capability.

## Policy and source preservation

Threshold argv preserves the **active lane** defaults: merged 35/20/30, backend 75/55/95,
frontend 0/0/0. Existing environment variables, empty-string shell fallback and inherited
global function-threshold behavior are bound explicitly. Frontend collection also preserves
its four existing threshold variables, including statement coverage. Skip-tests is fixed to
0 for new canonical collection attempts. A diagnostic collector reuse cannot be promoted.
No collector, checker, instrumentation, filters, test membership, report format or weighted
merge algorithm is changed by this increment.

The unused support `RunCoverageThresholdOnly` has different legacy frontend defaults
35/20/30; its removal must not alter the active lane's 0/0/0 policy. The shared owner must
remove `RunCoverageGateOnly` and `RunCoverageThresholdOnly` when canonical migration is ready.
The old merger's standalone partial-input behavior remains outside this owned increment;
canonical migration must make the verified two-input preparation unavoidable.

## Canonical compiler and action bridge

The continuation consumes exact framework `ebf0d6e0e555ba8bf64ceb4dbc9de6427cc1699c`
(including cancellation/finalizer correction `653ef38e2ce6dbcf8e2671bd8e091eb9c04538a0`)
and scheduler terminal source `2eda290cc6098971b685b3fb1465d7193bd3dde2` as unchanged
ancestry. `compileCoverageProducerDag` calls the original `compileAtomicProducerDag`
and `verifyCompiledAtomicProducerDag`; `executeCoverageProducerDag` calls the original
`executeCompiledAtomicProducerDag`. There is no additional scheduler or attempt runner.
The canonical terminal vector is reread and compared with the actual returned/failed
vector through `verifyAtomicTerminalVector` before domain projection.

`createCoverageExecutionRequests` prepares explicit run-owned request bytes. The request
binds the domain plan, replay path, bridge source bytes and an independently supplied
external authority verifier module/export/source digest. `writeCoverageExecutionRequests`
publishes only those exact immutable run-local requests. Stable relative argv is
`node tools/coverage/atomic-coverage-command.mjs <explicit request path>`; host checkout
paths are not placed in that argv. Its real transitive closure and toolchain authority
still require canonical owner admission.

`createCoverageAtomicAttachment(plan, producerBindings, projectionOwner)` returns a narrow
matrix attachment request with seven physical children and two command-free logical
projections. Every physical ownership, command/input closure, fixture, resource, state,
service and replay reference is supplied by its owner. It does not seal those authorities
or write the shared matrix. Artifact/evidence declarations use the canonical schema's
stable IDs; public paths remain in the request and attempt snapshot roster.
`compileCoverageProducerDag` verifies the attachment's local hard edges, all projection
members, artifact IDs, actual command, replay path and the input closure's exact
`coverageBinding` (plan digest, request path/byte digest, bridge source digests and authority
verifier identity) before calling the canonical compiler. Additional build/state edges
are supplied by the matrix owner. Actual blocked records retain that compiled direct
prerequisite set, including external prerequisites, through the independent vector bridge.

The one-action adapter verifies hard predecessor attempts and their retained output bytes,
starts exactly one unchanged original shell command and records the actual child spawn
PID/command/input refs. It does not retry. Its result sidecar records the observed process
exit and captured artifact roster. It retains immutable request/replay/output snapshots
inside the original attempt root. For merge/scope/threshold actions, executed test IDs are
empty because those commands are checkers, not test framework executions.

Native backend/frontend collection must additionally provide the original canonical
execution receipt and framework actuals paths. The adapter uses existing
`verifyExecutionReplay` against the sealed plan and captures the exact native receipt/
actual bytes in the attempt. It never copies planned test IDs into a result when native
receipts are absent. The only receipt-less collection mode allowed by the source controls
is an explicitly diagnostic, empty-test fixture action; this is not native qualification.
The real unmodified collectors do not yet export the required coverage-specific native
replay material, so successful native collection admission remains an owner handoff.

Execution output separately records `attemptSpawnCount` and `physicalSpawnCount`. A
canonical blocked node with no attempt yields zero for both. A wrapper input refusal can
have one outer attempt and zero physical coverage child launches. Timeout/internal-error
observations missing verified launch evidence retain unknown counts rather than inventing
zero. These source observations and projections always remain DATA_ONLY.

## Acceptance still required

- Framework owner: pre-attempt admission hook for independently verified hard input
  material under the input/resource grant. A failed collection already hard-blocks merge
  before any attempt; a late missing/invalid input currently refuses inside its wrapper,
  so only the physical child has zero spawn. This is not the stricter whole-producer
  zero-spawn acceptance for all invalid inputs. Keep original terminal causes and scopes.
- Collection/replay owners: actual current-candidate backend/frontend sealed coverage
  selection, shard/worker/seed and native receipt/actuals material matching unchanged
  instrumentation and membership. The new bridge does not infer this from an exit code,
  planned IDs, raw summary or standalone TRX filename.
- Sole matrix/integration owner: adopt seven physical IDs, two settled memberships,
  artifact ID/path bindings, source test membership, real physical input closure/ownership,
  build/dedicated-lane/state/resource prerequisites and local/CI canonical compiled identity.
  No shared source is edited by this partition.
- Wrapper/workflow owners: consume the same compiled plan and retire old support functions
  and the active sequential threshold lane only after actual replacement acceptance.
- Correctness terminal owner: use existing checkpoint/CAS, journal, finalizer and
  `readCurrentSchedulerCorrectness` APIs for eventual authoritative publication. The
  source vector is not a finalized checkpoint or a correctness final receipt; the coverage
  bridge does not mint a terminal seal or perform a CAS without the actual run owner.

Five additional ordinary controls execute real child processes through the canonical
compiler/weighted DAG/attempt runner, using explicit diagnostic synthetic collectors.
They invoke the unchanged merger, scope and threshold scripts, preserve both domain
failure directions, prove failed-collection merge attempt/physical spawn=0, and retain
all threshold terminals. These controls complement the original 41 tests. They are
not real native coverage collection, Production Fresh, resume, CI or release acceptance.
No denied semantic/cohort audits are replayed.
