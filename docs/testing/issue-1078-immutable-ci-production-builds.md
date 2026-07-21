# #1078 Immutable CI production build fan-out

## Boundary

`production-build-artifacts` is the only producer of the shared Release build set inside one workflow run. In the ordinary Quality Gate it fans out to browserless runtime/performance correctness consumers and, when selected, the single Release Browser Contract. The scheduled/manual Browser Diagnostics workflow has its own current-run producer with the same receipt contract; it never downloads a Quality Gate artifact from another workflow run. It does not cache test success and it never crosses a workflow run or commit boundary. Lockfile-keyed npm, NuGet and Playwright caches remain dependency caches; they are not authoritative build artifacts.

The producer uploads `.tmp/ci-production-build`, not the repository, `node_modules`, NuGet packages or mutable test output. The payload has five explicit domains:

- `backend-runtime`: Release server runtime;
- `test-runtime`: Release test runtime, marked `copy-before-write` for coverage/instrumentation;
- `frontend-dist`: Vite production output;
- `wasm`: the generated Wasm runtime set;
- `generated-contracts`: OpenAPI, frontend binary route and cross-stack matrix contracts.

Coverlet, mutation and benchmark lanes must not instrument these downloaded files in place. They either copy the `test-runtime` domain into a job-local directory or use a separately declared producer for a distinct build variant.

## Receipt and verification

`tools/ci/production-build-artifacts.mjs` emits `fsusblog.ci-production-build-receipt.v1`. The receipt binds:

- full commit SHA and worktree SHA-256 fingerprint;
- workflow name, run ID, run attempt and producer job;
- Node, npm, .NET, Vite, Vitest, Playwright and emsdk identities;
- lockfile, project, solution and build-config input digests;
- build profile, command and producer duration;
- every payload file path, byte size and SHA-256;
- domain ownership, consumer mode, total file count and total bytes;
- a canonical digest of the receipt itself.

Creation and verification reject absolute paths, `..` traversal, symlinks, missing domains, duplicate domain ownership and empty domains. A consumer rejects a wrong commit/fingerprint, wrong workflow run or attempt, wrong producer job, toolchain mismatch, receipt swap, missing/damaged file and any unreceipted file inside a declared domain. Every consumer also recomputes each receipted lockfile, project and build-config digest from its current checkout, so a self-consistent receipt built from different inputs cannot pass admission.

`.github/actions/consume-production-build/action.yml` downloads only the artifact from the current workflow run, checks the receipt against `GITHUB_SHA`, run ID, attempt, producer job, exported worktree fingerprint, exported receipt digest, the current runner toolchain and the current checkout's input digests, then writes a job-isolated verification record under `.tmp/release-evidence/jobs/`. Download plus verification time and downloaded bytes are recorded. GitHub artifact download failure is fail-closed; there is no empty-directory fallback.

## Smart-gate and consumer topology

After the #1144 execution deduplication and #1150 browserless handoff, Quality Gate consumers are split into three explicit classes:

- browserless correctness/runtime consumers: `integration-runtime`, `endpoint-depth-runtime`, `release-public`, `security-runtime`, `resilience-runtime`, `load-smoke`, `backend-qps-collectors`, `perf-regression`, and the `production-summary` closeout binding;
- exactly one browser correctness consumer: `browser-contract`, selected only for browser-boundary PRs, branch pushes, dispatch, or release-final;
- browser diagnostics: the separate scheduled/manual `browser-diagnostics.yml` producer/consumer pair. Acceptance, visual, UX, cross-browser, renderer performance, resilience, permission/search/PoW and zero-auth probes live here and are not ordinary Quality Gate consumers.

For a pull request, the smart gate selects the producer whenever it selects one of the first two classes. It exports only the union of domains those selected jobs require: a backend-QPS-only plan produces `backend-runtime`; browserless integration adds test runtime and generated contracts; release/security/performance or the Browser Contract add frontend dist and Wasm. `production-summary` still forces a producer so a passing correctness closeout always seals a #1078-bound receipt, but it does not invent frontend domains when no selected consumer needs them. Push, `workflow_dispatch` and release-final full mode select the complete required set. Browser Diagnostics always creates and verifies a fresh current-workflow receipt before its serial catalog starts.

Consumers declare a direct `needs: production-build-artifacts` edge and verify before their first test command. A skipped or failed producer therefore blocks downstream jobs. Rerunning a consumer in the same workflow run reuses and re-verifies the same immutable artifact; a different run, attempt, commit or receipt identity is rejected. Browserless jobs continue to own their namespace, services, `.tmp`, coverage and TRX output. The Browser Contract owns one sealed fixture namespace and one Chromium process; diagnostics own a separate run/category/probe namespace. No Acceptance shard, visual shard or cross-browser job can re-enter the correctness dependency closure.

The runtime no-build adapter lives in `tools/bootstrap-acceptance-env.sh`. After the workflow action makes downloaded files read-only, bootstrap verifies the receipt again and materializes only its declared domains into the current consumer scheduler's run-bound output roots. Backend and test DLLs, frontend dist, backend web root, Wasm and generated contracts stay isolated from other jobs. It then forces Release plus `FSUSBLOG_RUNTIME_NO_BUILD=1`; backend launch uses `dotnet run --no-build --no-restore`, and frontend-bearing browserless runtime jobs use the verified Vite production dist through `vite preview` instead of rebuilding or starting a source-transform dev server. A backend-only receipt skips frontend processes. The Browser Contract uses the same immutable payload but owns its separate sealed lifecycle; diagnostics use their workflow-local payload and isolated diagnostics lifecycle.

## Evidence and acceptance measurement

The producer receipt records build duration and payload bytes. Each consumer verification records download-plus-verify time, verification time, bytes and producer identity. Workflow comparison must use at least three equivalent runs of the same SHA and runner class and report:

- critical path and time-to-first-test;
- producer build count and each avoided consumer build/bootstrap phase;
- compression/upload/download/extract time and artifact bytes;
- runner CPU-minutes and total billable minutes;
- setup failure count.

No improvement may be claimed from build-count reduction alone. Closing evidence requires lower total cost or wall-clock time without reducing Fresh browserless correctness, the single Browser Contract, or the separately governed diagnostics catalog, sharing mutable fixtures, or uploading dependency directories.

## Rollback

The topology can be disabled without changing application runtime semantics: remove consumer `needs`/verification edges and restore per-job builds, while retaining receipt tests and evidence for diagnosis. A rollback must not make verification permissive, silently rebuild after receipt failure, or reuse an artifact from another commit/run.
