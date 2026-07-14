# Frontend perf readiness

The isolated frontend perf project is a functional regression smoke with contention-adjusted upper budgets. It is not
the authoritative quiet-machine benchmark: stable comparative measurements remain in the `performance-evidence`
bundle behind `benchmark-window`. The smoke can therefore start as soon as its precise functional prerequisites are
ready instead of inheriting accidental isolation from the complete `build-static` bundle.

## Exact inputs and barriers

The perf Vitest process imports source modules, the production Vitest config, the run-bound immutable transform cache,
the ordinary merged report, and the ordinary coverage tree. It does not read frontend `dist` or privacy Wasm directly.
Production still requires the current release build identity before admitting this smoke, so
`frontend-build-ready.json` binds and revalidates these canonical build outputs:

- the run-bound frontend `dist/index.html`;
- `comment-privacy-prover.js`, `.zkey`, and `.manifest.json` under the run-bound Wasm root;
- the generated prover bundle;
- the generated frontend build contract.

Every entry carries its canonical repository path, SHA-256 declaration digest, and artifact-table reference. The marker
also binds scheduler run ID, source commit/worktree fingerprint through the production build-layout digest,
`physicalBundleId: build-static`, and `producerStepId: sync-static-assets`. It is published by atomic rename only after
the copy step succeeds. A build/copy failure or cancellation publishes a terminal marker immediately unless a valid
success marker already exists; consumers fail closed rather than waiting for the whole bundle or a fixed timeout.

`vitest-settled` depends on the complete rolling runner, not an individual host file. The runner resolves only after all
immutable partitions have exited, merges exact-once reports, and seals the transform-cache lifecycle as
`ordinary-ready`. The isolated process then opens that immutable cache in a new process; mock state, globals, module
singletons, coverage payload, and test results are not reused.

## Admission and evidence

`vitest-production-perf-isolated` is a frontend weighted-DAG node with exactly two readiness dependencies:
`frontend-build-ready` and `vitest-settled`. Its `frontend-test-results` resource prevents report/coverage writers from
colliding, while unrelated build-static fuzz, red-team, risk-control, viewport planning, and Wasm fuzz work do not enter
its critical path. CPU and memory admission remain live-grant capacity decisions. Marker polling derives from the live
bundle CPU grant and the timeout uses the machine-resolved dependency wait ceiling; SIGINT/SIGTERM terminates the
bundle wait before a perf child is spawned.

The frontend bundle summary records `frontendPerfAdmission` with marker publication and artifact bindings, marker wait
duration, all-host settlement time, perf admission time, source state, isolation classification, and an explicit
`waitsForBuildStaticSummary: false`. The ordinary and perf reports, transform-cache timing evidence, coverage exclusion,
test IDs, and logical member projection remain unchanged.

Rollback moves the perf command back after the frontend DAG and restores the old summary wait. No application API,
runtime service, release artifact, test inventory, or cache identity changes, and no service restart is required.
