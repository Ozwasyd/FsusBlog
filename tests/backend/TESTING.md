# `FsusBlog.Server.Tests` Testing Rules

`FsusBlog.Server.Tests` is one xUnit project with a layered, enforced source tree.

## Layout

- `Unit/`: pure tests only; no Docker, external services, random ports, or long-lived background resources; files must use `*Tests.cs`.
- `Integration/`: real PostgreSQL / Docker / external-dependency tests; files must use `*IntegrationTests.cs`; every class must carry `[Trait("Category", "Integration")]`, and Docker-backed tests must also carry `[Trait("Dependency", "Docker")]`.
- `Fixtures/`
    - Shared `*Fixture.cs`, `*Collection.cs`, and stable test sample files (`.sql`, `.json`, `.txt`).
- `Helpers/`: shared fakes, builders, assertions, and test-only utilities. `PublicAotCrashWorkerProgram` is the sole non-xUnit child command; the test assembly is executable only for this argument-closed worker, while ordinary correctness remains owned by the parent five-state Theory.

## Root Directory Contract

The project root may contain only:

- `FsusBlog.Server.Tests.csproj`
- `GlobalUsings.cs`
- `TESTING.md`

All test classes live under `Unit/` or `Integration/`.

## Execution Contract

Backend test wrappers export `FSUSBLOG_REPO_ROOT` to the repository root before invoking .NET tests. It is an override for scripted/CI/IDE hosts, not a mandatory local step: direct `dotnet test tests/backend` still resolves the root through the shared `BackendTestPaths` fallback. On Windows, a manual override can use `$env:FSUSBLOG_REPO_ROOT = (Get-Location).Path` before the equivalent `dotnet test` command.

- `./tools/test.sh fast`: runs only non-integration tests via `Category!=Integration` and must not require Docker or any running service.
- `./tools/test.sh integration`: runs server-side integration tests via `Category=Integration`, then debug runtime checks requiring `3000/7568` (auth session, API contract matrix, Binary parity, notification stream static/live, search, and binary smoke).
- `./tools/test.sh ci`: runs `fast + integration`.
- `./tools/test.sh coverage-gate`: one-shot hard coverage gate running `coverage-backend + coverage-frontend + coverage-merge + coverage-threshold` and enforcing both merged and backend-only thresholds.
- `./tools/test.sh backend-api-integration`: runs backend endpoint/API contract tests via `Category=ApiIntegration` and guards endpoint-family traceability and binary `AedsFrameType` coverage.
- `./tools/test.sh backend-auth-state-machine`: runs backend auth/MFA/PoW/session state-machine tests via `Category=SecurityStateMachine` and must cover legal transitions plus illegal partial-auth/revoked/expired transitions.
- `./tools/test.sh backend-concurrency`: runs deterministic race/idempotency model tests via `Category=Concurrency`; use barriers/latches, not `Thread.Sleep`, for ordering.
- `./tools/test.sh backend-property`: runs seeded backend property tests via `Category=Property`, covering protocol, cache-key, and upload-range invariants with reproducible samples.
- `./tools/test.sh backend-golden`: runs backend golden catalog tests via `Category=GoldenContract`; `tests/backend/Fixtures/aeds-golden-catalog.json` must match `AedsFrameType`.
- `./tools/test.sh backend-test-governance`: runs `tools/check-backend-test-governance.mjs` and validates issue #40 profile, requirement, endpoint, FrameType, mutation, and matrix traceability.
- `./tools/test.sh backend-perf`
    - `backend-perf`: prepares the shared Release test/benchmark producers and governance in parallel, then runs the native verifier P99 alone in a machine-quiet `benchmark-window`. The reader uses `--no-build --no-restore`; compiler work and peer measurements must finish before the P99 window opens.
    - `backend-benchmark-regression`: runs the server `*HotPath*` BenchmarkDotNet cases and evaluates real mean/allocation results against `tests/performance/backend-hotpath-budgets.json`. Missing measurements and synthetic success manifests are failures. PostgreSQL command-count tests separately bind stats and related-reading query budgets to executed SQL. On unprivileged hosts, unavailable process-priority elevation is emitted once as scheduler information while the machine-derived CPU affinity remains enforced.
- `./tools/test.sh backend-mutation`
    - Runs the repository-pinned Stryker.NET full nightly scope from solution context with the explicit `config/testing/mutation/default.json` config path; project-relative globs are required and reports are written through `--output` to `.tmp/mutation/backend`.
    - `backend-mutation-critical` runs from the Core source-project context with the explicit repository-absolute `config/testing/mutation/critical.json` path and the backend test project for the reviewed AEDS v2 wire-frame release slice; it selects the direct `AedsEncoderTests` unit-test slice, writes the raw report plus `.tmp/mutation/backend-critical/authority.json`, and fails when no mutant was executed. The authority sidecar binds raw/config digests, scope, filter, score, scheduler run and source state so optimization evidence cannot reuse an old or unrelated mutation result. Keeping unrelated governance tests out of this filter prevents fresh cleanup of external release evidence from blocking mutation discovery.
    - The runner exports `FSUSBLOG_MUTATION_BUILD=1` so only that Debug build disables the incompatible .NET 10 OpenAPI XML source generator; ordinary Debug/Release builds retain it.
    - `MemberData` / theory case values must be deterministic across discovery and execution so Stryker can bind coverage to stable test IDs.
    - This tier is intended for nightly/manual evidence, not the default fast gate.
- `./tools/test.sh backend-chaos`: runs backend governance plus deterministic concurrency/fault-readiness tests.
- `./tools/test.sh backend-nightly`: runs backend governance, property, golden, concurrency, auth/API contract, and perf readiness; set `FSUSBLOG_RUN_BACKEND_MUTATION_FULL=1` to include the full mutation run.
- `./tools/test.sh release`: requires release preview at `8080` and covers public hydration / SEO / AOT preview checks.
- `./tools/test.sh acceptance`: legacy nightly diagnostics-only tier, not part of production correctness; its Playwright acceptance surface may run only under the governed `browser-diagnostics` job.
- `./tools/test.sh visual`: nightly diagnostics-only visual aggregate, not a correctness credential; it runs dark-mode, mobile-layout, and screenshot-baseline probes through the browser diagnostics boundary.
- `./tools/test.sh security`: requires the shared runtime bootstrap but launches no browser; it runs browserless auth/session/MFA/PoW/permission contract and state checks, while rendered a11y probes belong to browser diagnostics.
- `./tools/test.sh resilience`: requires the shared runtime bootstrap but launches no browser; it runs server/runtime, upload, search, and notification stream resilience gates.
- `./tools/test.sh load`: requires the shared runtime bootstrap but launches no browser; it runs lightweight public/API concurrency checks.
- `./tools/test.sh production-correctness`: authoritative browserless production CI gate covering fast/static/unit/property/model, SSR/AOT/HTTP, API/DB/cache integration, browserless security/resilience/load/backend-QPS, frontend render structure, and release-evidence schema validation. Its dependency closure contains no Acceptance, visual, UX viewport, cross-browser, browser render-pressure, Playwright, or Chromium tier.
- `./tools/test.sh production`: historical compatibility alias depending only on `production-correctness`; it adds no browser suite to the browserless production gate. The backend production union is deterministically sharded by test method, each shard instruments an isolated copy of the same fresh build, and the runner rejects any gap, overlap, non-passing TRX result, or incomplete coverage output. It allows schema-valid `collected-blocked` release evidence for external production handoff, which is not a final publish credential.
- `./tools/test.sh browser-contract`: the only real-browser correctness tier and browser tier in the `release-final` closure; it consumes the immutable production build receipt and runs one managed Chromium with one controller/session, zero shard, and zero retry.
- `./tools/test.sh browser-diagnostics`: the explicit scheduled/manual diagnostics boundary for legacy Acceptance, visual, UX viewport, cross-browser, renderer pressure/performance, and browser-runtime resilience probes; diagnostic failure remains independent and is never converted into production correctness evidence.
- `./tools/test.sh release-final`: the final publish credential for manual release candidates. It adds strict coverage, changed-code coverage, release runtime lanes, AOT generation/consumption, peak/burst/scale/soak/mutation/resource budgets, strict shard completeness, live exposure evidence, real backup restore, deployed post-smoke coverage, authenticated DAST/Wasm fuzz/fault-injection/short-soak semantic evidence, flaky release-final governance, artifact digest binding, and exactly one `browser-contract`. The aggregate is browserless; scheduled/manual visual and browser diagnostics are not folded into its correctness result. This is the only gate that may be treated as the "zero known release-blocker bugs inside the declared release matrix" proof.

## CI Contract

- `.github/workflows/quality-gate.yml` represents `production-correctness` on `pull_request`, `main` / `master` push, and manual dispatch; `production` remains only its compatibility alias.
- The workflow conditionally runs the single `browser-contract` job for `main` / `master` pushes, manual/release boundaries, and browser-boundary PR changes. Ordinary PR jobs install no browser.
- The same workflow also runs `./tools/test.sh coverage-gate` as the coverage blocker.
- `release-final` is `manualOnly` in `tests/matrix.yml`; it is intentionally not part of ordinary PR CI.
- CI must provide `GITHUB_PACKAGES_TOKEN` so `src/frontend/.npmrc` can install the private `@ozwasyd` package.
- On browserless runtime failure, inspect `.tmp/acceptance/*.log`. On Browser Contract failure, inspect `.tmp/browser-contract/receipt.json`; raw fixture/session/trace material remains private and is not a CI upload. Scheduled/manual diagnostics use `.tmp/browser-diagnostics/` and `src/frontend/test-results/playwright/`.

## Cleanliness Rules

- Test source directories must not contain committed runtime artifacts.
- Do not commit `TestResults`, `.trx`, coverage outputs, database files, logs, or snapshot residue.
- Shared fixtures belong in `Fixtures/`; do not inline them at the bottom of unrelated test files.
- Shared helpers belong in `Helpers/`; do not hide them inside random test files.
- Any new external-dependency test must be explicitly marked as `Integration`; do not let it silently join the fast gate.
- Legacy SQL fixtures may preserve historical columns needed by migration tests, but inserted identity, token, and network samples must use anonymized placeholders instead of real usernames, refresh tokens, or IP literals.
