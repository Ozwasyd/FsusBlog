# #1081 Performance evidence marker DAG

`./tools/test.sh production` keeps five physical bundles, but
`performance-evidence` no longer waits for the complete backend, frontend, and
runtime bundle summaries. It starts as an independent physical bundle and its
internal DAG waits only for the exact run-bound inputs of each operation.

## Run-bound markers

Markers use `fsusblog.local-production.run-bound-marker.v1` and bind the
scheduler run ID, source commit, worktree fingerprint, producer bundle/step,
an exact consumer-expected artifact path roster, sizes, SHA-256 digests, and a
canonical marker digest. Writes are atomic and publishers must execute inside
the declared physical bundle/step context; a self-consistent marker that names
another current file is still rejected. A stale source, wrong producer,
changed artifact, corrupt marker, producer failure, timeout, or cancellation
fails closed.

The producers publish:

- `backend-coverage-ready` after `backend-coverage-summary`;
- `frontend-coverage-ready` after `frontend-coverage-summary`;
- `runtime-state-ready` at `runtime-state-stable`;
- one quiet marker only after each of `backend-tests`, `frontend-tests`, and
  `build-static` has written member receipts, bound artifact digests, finalized
  resource evidence, and atomically published its physical summary. The marker
  write is the final evidence mutation before that producer returns; only
  diagnostic console output follows it.

Existing run-bound `frontend-build-ready` and `benchmark-build-ready` receipts
remain authoritative. The scheduler publishes the resident runtime inventory
and one-use handoff receipt after `runtime-browser` reaches its stable marker.

## Admission and measurement isolation

Coverage merge starts after the two coverage markers. AEDS compression starts
after frontend build readiness. Privacy-ZK functional preparation uses the two
coverage markers plus the frontend build marker, rather than whole-bundle
summaries. Runtime-preserving data-scale and fault-injection work moves behind
the stable runtime handoff.

Every timed profiler waits at `performance-measurement-ready`. That barrier
requires all non-measurement preparation, runtime mutation, producer quiet
markers, benchmark build readiness, runtime stability, and the consumed
resident handoff. The profilers then serialize on the inner
`benchmark-window`; the physical bundle itself holds no broad exclusive lock
while it is merely waiting or preparing.

Every performance step carries one evidence phase: `coordination`,
`preparation`, `measurement`, or `post-measurement`. Deadline evidence v2
binds the scheduler run and source state, records each phase duration and exact
timestamps, requires the exact five measurement step identities, and rejects
both measurement-to-measurement overlap and preparation/post-processing noise
overlap. The DAG contract allows only measurement steps to request
`benchmark-window`. Privacy finalization waits for all five timed measurements,
so it cannot become noise beside a later profiler.

| Step group | Required receipts | Reads runtime | Mutates runtime/database | Timing-sensitive | `benchmark-window` |
| --- | --- | ---: | ---: | ---: | ---: |
| `coverage-merge`, `coverage-threshold` | backend + frontend coverage | no | no | no | no |
| `aeds-compression` | frontend build | no | no | no | no |
| `privacy-zk-project-functional`, input verification | backend/frontend coverage + frontend build + contract/functional receipts | no | no | no | no |
| `data-scale-xs`, `data-scale-s`, summary, `fault-injection` | runtime stable + resident handoff | yes | yes | no | no |
| `browser-performance` | measurement barrier | yes | no | yes | yes |
| `backend-perf` | measurement barrier + benchmark build | yes | no | yes | yes |
| `privacy-zk-benchmark` | measurement barrier + privacy receipts | yes | no | yes | yes |
| `mixed-performance-window` | measurement barrier + benchmark build | yes | controlled benchmark writes | yes | yes |
| `aeds-frame-cost` | measurement barrier + benchmark build | no | no | yes | yes |
| privacy finalize, summaries and release evidence | all completed measurement receipts | no | no | no | no |

The scheduler includes resident process and OCI reservations in admission
accounting. If the reservation appears while an elastic consumer is active,
the active grant is contracted before any released capacity is expanded. Grant
history and wait categories remain in checkpoint/resource-utilization
evidence. Cleanup releases capacity only after the bound identities exit.

## Failure and rollback

Marker waits are independent DAG nodes, so a failed producer blocks only real
descendants and unrelated preparation can still report its own failure. The
summary distinguishes dependency/marker waits from benchmark isolation.
Cancellation is wired into both the weighted DAG and every generic/specialized
marker poll. Success or failure records the coordination step duration; signal
shutdown writes `resource-utilization.json` with `status=partial`, completed
step metrics, marker/capacity/benchmark wait intervals, and the cancellation
reason before exit.

Rollback is source-only and requires no service restart: restore the former
physical `dependsOn` edges and move data-scale/fault-injection members back to
`runtime-browser`. Do not reuse marker or handoff files from the rolled-back
run; start a new fresh scheduler run so run/source binding remains valid.

Focused contract verification:

```bash
node --test tests/tools/run-bound-marker.test.mjs
node --test tests/tools/privacy-zk-performance-inputs.test.mjs
node --test tests/tools/bundle-step-contract.test.mjs
node --test tests/tools/frontend-bundle-dag.test.mjs
node --test tests/tools/local-production-profile.test.mjs
node --test tests/tools/resident-resource-leases.test.mjs
node --test tests/tools/test-matrix-scheduler.test.mjs
node --check tools/test-matrix/run-bound-marker.mjs
node --check tools/test/bundles/bundle-steps.mjs
node --check tools/test/bundles/run-bundle.mjs
node --check tools/test/verify-privacy-zk-performance-inputs.mjs
```

Final acceptance still requires three successful fresh production runs on the
same SHA. Until those measurements exist, #1081 must remain open.
