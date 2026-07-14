# #1081 Performance evidence marker DAG

`./tools/test.sh production` keeps five physical bundles, but
`performance-evidence` no longer waits for the complete backend, frontend, and
runtime bundle summaries. It starts as an independent physical bundle and its
internal DAG waits only for the exact run-bound inputs of each operation.

## Run-bound markers

Markers use `fsusblog.local-production.run-bound-marker.v1` and bind the
scheduler run ID, source commit, worktree fingerprint, producer bundle/step,
artifact paths, sizes, SHA-256 digests, and a canonical marker digest. Writes
are atomic. A stale source, wrong producer, changed artifact, corrupt marker,
producer failure, timeout, or cancellation fails closed.

The producers publish:

- `backend-coverage-ready` after `backend-coverage-summary`;
- `frontend-coverage-ready` after `frontend-coverage-summary`;
- `runtime-state-ready` at `runtime-state-stable`;
- one quiet marker when each of `backend-tests`, `frontend-tests`, and
  `build-static` has no remaining executable work.

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

| Step group | Required receipts | Reads runtime | Mutates runtime/database | Timing-sensitive | `benchmark-window` |
|---|---|---:|---:|---:|---:|
| `coverage-merge`, `coverage-threshold` | backend + frontend coverage | no | no | no | no |
| `aeds-compression` | frontend build | no | no | no | no |
| `privacy-zk-project-functional`, input verification | backend/frontend coverage + frontend build + contract/functional receipts | no | no | no | no |
| `data-scale-xs`, `data-scale-s`, summary, `fault-injection` | runtime stable + resident handoff | yes | yes | no | no |
| `browser-performance` | measurement barrier | yes | no | yes | yes |
| `backend-perf` | measurement barrier + benchmark build | yes | no | yes | yes |
| `privacy-zk-benchmark` | measurement barrier + privacy receipts | yes | no | yes | yes |
| `mixed-performance-window` | measurement barrier + benchmark build | yes | controlled benchmark writes | yes | yes |
| `aeds-frame-cost` | measurement barrier + benchmark build | no | no | yes | yes |
| summaries and release evidence | completed measurement receipts | no | no | no | no |

The scheduler includes resident process and OCI reservations in admission
accounting. If the reservation appears while an elastic consumer is active,
the active grant is contracted before any released capacity is expanded. Grant
history and wait categories remain in checkpoint/resource-utilization
evidence. Cleanup releases capacity only after the bound identities exit.

## Failure and rollback

Marker waits are independent DAG nodes, so a failed producer blocks only real
descendants and unrelated preparation can still report its own failure. The
summary distinguishes dependency/marker waits from benchmark isolation.

Rollback is source-only and requires no service restart: restore the former
physical `dependsOn` edges and move data-scale/fault-injection members back to
`runtime-browser`. Do not reuse marker or handoff files from the rolled-back
run; start a new fresh scheduler run so run/source binding remains valid.

Final acceptance still requires three successful fresh production runs on the
same SHA. Until those measurements exist, #1081 must remain open.
