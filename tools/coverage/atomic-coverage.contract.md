# Atomic coverage migration input contract

This module is an implementation input for issues [#2278](https://github.com/Ozwasyd/FsusBlog/issues/2278)
and [#2254](https://github.com/Ozwasyd/FsusBlog/issues/2254). It is not a second matrix,
scheduler, attempt runner, coverage implementation or release authority. The maintained
execution topology remains `tests/matrix.yml`. These source contracts are consumable
before the upstream [#2248](https://github.com/Ozwasyd/FsusBlog/issues/2248) compiler
is available; their output always declares `qualificationEligible: false`.

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

## Acceptance still required

- #2248: actual canonical compiler/settled execution API, exact-one attempt invocation,
  independent blocked verifier, terminal receipt with input/evidence refs, replay handoff,
  resource safety and spawn-boundary input isolation.
- #1686/matrix owner: seven producers, two settled projection memberships, existing build,
  dedicated-lane and physical ownership edges, test membership registration and canonical
  local/CI compiled digest.
- Shared wrapper/workflow owners: retire both support functions and the active sequential
  threshold lane; consume the same compiled set in `quality-gate.yml` and local entry.
- #2278: actual backend/frontend collections with independent complete raw/test/shard evidence,
  failure isolation and merge spawn=0 controls under the canonical scheduler.
- #2254: all four actions running through that scheduler with actual terminal/blocked refs;
  real scope/checker failures fully retained in the authoritative aggregate.

Focused tests use synthetic receipts and external-verifier fixtures. They additionally invoke
the unchanged weighted merger and threshold checker on isolated fixture summaries. They are
not real coverage collection, scheduler qualification, runtime acceptance or remote CI.
