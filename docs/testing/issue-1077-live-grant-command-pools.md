# #1077 Live-grant command pools

## Contract

`tools/test/run-command-manifest.mjs` is the common resource contract for weighted manifests and the shell process adapters used by local static governance, legacy collect groups, and acceptance bootstrap. A scheduler invocation reads the atomic grant document before every admission and accepts it only when schema, run ID, tier ID, CPU, memory, and parent budget agree. A focused direct invocation has no grant document and records `source=direct-invocation-fallback`; a short legacy group without a live grant logs `executionMode=fixed` explicitly.

Pending work is ordered by `estimatedDurationMs` using LPT. A grant expansion may admit another independent command before existing children finish. A contraction never kills an admitted child, but it admits nothing new while active weight exceeds the new cap. Cancellation and the inherited `FSUSBLOG_EXECUTION_DEADLINE_AT_MS` take priority over resource polling. An entry that still cannot fit records CPU, memory, dependency, counted-resource, or exclusive-resource wait state instead of silently hanging.

Each entry may declare `concurrencyWeight`, `memoryCostGiB`, or one auditable memory class: `tiny=0.125 GiB`, `standard=0.25 GiB`, and `heavy=0.5 GiB`. The runner rejects simultaneous class and explicit cost declarations. At admission it replaces, rather than appends to, the child values for:

- `FSUSBLOG_STEP_CPU_BUDGET`
- `FSUSBLOG_STEP_MEMORY_GIB`
- `FSUSBLOG_COMMAND_MANIFEST_WORKERS`
- `FSUSBLOG_NODE_TEST_CONCURRENCY`
- `FSUSBLOG_PARALLEL_ACTIVE_WORKERS`

Manifest entry environment cannot override those names. The aggregate admitted CPU and memory never exceeds the current parent grant. Shell adapters resolve their cap and child quota through the same functions; they retain a shell callback layer only because their jobs are already-defined shell functions with process/container lifecycle state.

## Dependencies and writes

`dependsOn` requires successful completion. `settledDependsOn` waits for success or failure and is used for cleanup and conflict ordering. In the v1 manifest, the runner derives settled ordering only when `ownedOutputs` overlaps another command's consumed input or owned output. Disjoint writers therefore run concurrently, while conflicting writers settle in declaration order. Explicit named or counted resources remain the authority for non-file conflicts.

An independent branch continues after a sibling failure so one invocation exposes all reachable errors. Downstream success dependencies remain blocked. No checker ID, command ID, artifact, or failure aggregation is removed by this change.

## Evidence and rollback

The execution evidence schema is `fsusblog.live-grant-execution.v1`. It records scheduler run identity, grant history, child admission and finish timestamps, active weight, exact child CPU/memory/nested-worker quota, blocked reasons, status, duration, and error. CLI manifests atomically write `.tmp/test-results/live-grant/<run-id>/<lane>.json`; local static phases embed the same records in their phase evidence. Failure, timeout, and cancellation write the partial document before returning.

Rollback does not require restarting runtime services. Stop assigning a scheduler grant to the affected short group and invoke it directly; the auditable fallback derives a bounded cap from the inherited step grant and current machine. For an emergency single-process diagnostic, set the caller's manifest worker override to `1`. Resource safety environment variables remain protected in both paths.

## Verification boundary

Focused contracts cover grant `1 -> 4` growth before the first child settles, `4 -> 1` contraction, memory-limited admission, stale/wrong-run/corrupt grant rejection, deterministic direct fallback, nested quota bounds, disjoint writers, independent failure collection, cancellation, deadline, partial evidence, and the `_legacy.sh` collect adapter. The authoritative `production --fresh` and three same-SHA machine runs remain part of the final production validation campaign; an isolated issue commit must not claim those results early.
