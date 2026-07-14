# #1078 Immutable CI production build fan-out

## Boundary

`production-build-artifacts` is the only ordinary quality-gate job that produces the shared Release build set for runtime and browser consumers. It does not cache test success and it never crosses a workflow run or commit boundary. Lockfile-keyed npm, NuGet and Playwright caches remain dependency caches; they are not authoritative build artifacts.

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

Creation and verification reject absolute paths, `..` traversal, symlinks, missing domains, duplicate domain ownership and empty domains. A consumer rejects a wrong commit/fingerprint, wrong workflow run or attempt, wrong producer job, toolchain mismatch, receipt swap, missing/damaged file and any unreceipted file inside a declared domain.

`.github/actions/consume-production-build/action.yml` downloads only the artifact from the current workflow run, checks the receipt against `GITHUB_SHA`, run ID, attempt, producer job, exported worktree fingerprint and exported receipt digest, then writes a job-isolated verification record under `.tmp/release-evidence/jobs/`. Download plus verification time and downloaded bytes are recorded. GitHub artifact download failure is fail-closed; there is no empty-directory fallback.

## Smart-gate and retry topology

For a pull request, the smart gate selects the producer whenever it selects an integration, acceptance, visual, viewport, render-pressure, cross-browser, resilience, load, backend-QPS or performance consumer. It also exports the union of domains required by those selected jobs: a PR that only retains backend-QPS sentinels produces `backend-runtime`, while browser consumers add test runtime, frontend dist, Wasm and generated contracts. Push, `workflow_dispatch` and release-final full mode select the complete producer set. A PR with no immutable-build consumer does not select the producer.

Consumers declare a direct `needs: production-build-artifacts` edge and verify before their first test command. A skipped or failed producer therefore blocks downstream jobs. Rerunning a consumer in the same workflow run reuses and re-verifies the same immutable artifact; a different run, attempt, commit or receipt identity is rejected. Each shard continues to own its namespace, services, `.tmp`, coverage, TRX and Playwright output.

The runtime no-build adapter lives in `tools/bootstrap-acceptance-env.sh`. After the workflow action makes downloaded files read-only, bootstrap verifies the receipt again and materializes only its declared domains into the current consumer scheduler's run-bound output roots. Backend and test DLLs, frontend dist, backend web root, Wasm and generated contracts stay isolated from other shards. It then forces Release plus `FSUSBLOG_RUNTIME_NO_BUILD=1`; backend launch uses `dotnet run --no-build --no-restore`, and both frontend origins use the verified Vite production dist through `vite preview` instead of rebuilding or starting a source-transform dev server. A backend-only receipt skips both frontend processes.

## Evidence and acceptance measurement

The producer receipt records build duration and payload bytes. Each consumer verification records download-plus-verify time, verification time, bytes and producer identity. Workflow comparison must use at least three equivalent runs of the same SHA and runner class and report:

- critical path and time-to-first-test;
- producer build count and each avoided consumer build/bootstrap phase;
- compression/upload/download/extract time and artifact bytes;
- runner CPU-minutes and total billable minutes;
- setup failure count.

No improvement may be claimed from build-count reduction alone. Closing evidence requires lower total cost or wall-clock time without reducing Fresh builds or runtime/browser tests, sharing mutable fixtures, or uploading dependency directories.

## Rollback

The topology can be disabled without changing application runtime semantics: remove consumer `needs`/verification edges and restore per-job builds, while retaining receipt tests and evidence for diagnosis. A rollback must not make verification permissive, silently rebuild after receipt failure, or reuse an artifact from another commit/run.
