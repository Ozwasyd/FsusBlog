# `FsusBlog.Server.Tests` Testing Rules

`FsusBlog.Server.Tests` stays as a single xUnit project, but its source tree is layered and enforced.

## Layout

- `Unit/`
  - Pure tests only.
  - No Docker, no external services, no random ports, no long-lived background resources.
  - Files must use `*Tests.cs`.
- `Integration/`
  - Real PostgreSQL / Docker / external dependency tests.
  - Files must use `*IntegrationTests.cs`.
  - Every integration test class must carry `[Trait("Category", "Integration")]`.
  - Docker-backed tests must also carry `[Trait("Dependency", "Docker")]`.
- `Fixtures/`
  - Shared `*Fixture.cs`, `*Collection.cs`, and stable test sample files (`.sql`, `.json`, `.txt`).
- `Helpers/`
  - Shared fakes, builders, assertions, and test-only utilities.

## Root Directory Contract

The project root may only contain:

- `FsusBlog.Server.Tests.csproj`
- `GlobalUsings.cs`
- `TESTING.md`

All test classes must live under `Unit/` or `Integration/`.

## Execution Contract

Backend test wrappers export `FSUSBLOG_REPO_ROOT` to the repository root before invoking .NET tests.
Treat it as an override for scripted/CI/IDE hosts, not a mandatory local step: direct `dotnet test tests/backend` still resolves the root through the shared `BackendTestPaths` fallback.
On Windows, a manual override can use `$env:FSUSBLOG_REPO_ROOT = (Get-Location).Path` before running the equivalent `dotnet test` command.

- `./tools/test.sh fast`
  - Runs only non-integration tests via `Category!=Integration`.
  - Must not require Docker or any running service.
- `./tools/test.sh integration`
  - Runs server-side integration tests via `Category=Integration`.
  - Then runs debug runtime checks that require `3000/7568`: auth session, API contract matrix, Binary parity, notification stream static/live, search, and binary smoke.
- `./tools/test.sh ci`
  - Runs `fast + integration`.
- `./tools/test.sh coverage-gate`
  - One-shot hard coverage gate.
  - Runs `coverage-backend + coverage-frontend + coverage-merge + coverage-threshold`.
  - Enforces both merged and backend-only thresholds.
- `./tools/test.sh backend-api-integration`
  - Runs backend endpoint/API contract tests via `Category=ApiIntegration`.
  - Guards endpoint family traceability and binary `AedsFrameType` coverage.
- `./tools/test.sh backend-auth-state-machine`
  - Runs backend auth/MFA/PoW/session state-machine tests via `Category=SecurityStateMachine`.
  - Must cover legal transitions and illegal partial-auth/revoked/expired transitions.
- `./tools/test.sh backend-concurrency`
  - Runs deterministic race/idempotency model tests via `Category=Concurrency`.
  - Use barriers/latches; do not use `Thread.Sleep` as the ordering mechanism.
- `./tools/test.sh backend-property`
  - Runs seeded backend property tests via `Category=Property`.
  - Covers protocol, cache-key and upload-range invariants with reproducible samples.
- `./tools/test.sh backend-golden`
  - Runs backend golden catalog tests via `Category=GoldenContract`.
  - `tests/backend/Fixtures/aeds-golden-catalog.json` must match `AedsFrameType`.
- `./tools/test.sh backend-test-governance`
  - Runs `tools/check-backend-test-governance.mjs`.
  - Validates issue #40 profile, requirement, endpoint, FrameType, mutation and matrix traceability.
- `./tools/test.sh backend-perf`
  - `backend-perf`: prepares the shared Release test/benchmark producers and governance in parallel, then runs the native verifier P99 alone in a machine-quiet `benchmark-window`. The reader uses `--no-build --no-restore`; compiler work and peer measurements must finish before the P99 window opens.
  - `backend-benchmark-regression`: runs the server `*HotPath*` BenchmarkDotNet cases and evaluates real mean/allocation results against `tests/performance/backend-hotpath-budgets.json`. Missing measurements and synthetic success manifests are failures. PostgreSQL command-count tests separately bind stats and related-reading query budgets to executed SQL. On unprivileged hosts, unavailable process-priority elevation is emitted once as scheduler information while the machine-derived CPU affinity remains enforced.
- `./tools/test.sh backend-mutation`
  - Runs the repository-pinned Stryker.NET full nightly scope from solution context with the explicit `config/testing/mutation/default.json` config path; project-relative globs are required and reports are written through `--output` to `.tmp/mutation/backend`.
  - `backend-mutation-critical` runs from the Core source-project context with the explicit repository-absolute `config/testing/mutation/critical.json` path and the backend test project for the reviewed AEDS v2 wire-frame release slice; it selects the direct `AedsEncoderTests` unit-test slice, writes the raw report plus `.tmp/mutation/backend-critical/authority.json`, and fails when no mutant was executed. The authority sidecar binds raw/config digests, scope, filter, score, scheduler run and source state so optimization evidence cannot reuse an old or unrelated mutation result. Keeping unrelated governance tests out of this filter prevents fresh cleanup of external release evidence from blocking mutation discovery.
  - The runner exports `FSUSBLOG_MUTATION_BUILD=1` so only that Debug build disables the incompatible .NET 10 OpenAPI XML source generator; ordinary Debug/Release builds retain it.
  - `MemberData` / theory case values must be deterministic across discovery and execution so Stryker can bind coverage to stable test IDs.
  - This tier is intended for nightly/manual evidence, not the default fast gate.
- `./tools/test.sh backend-chaos`
  - Runs backend governance plus deterministic concurrency/fault-readiness tests.
- `./tools/test.sh backend-nightly`
  - Runs backend governance, property, golden, concurrency, auth/API contract and perf readiness.
  - Set `FSUSBLOG_RUN_BACKEND_MUTATION_FULL=1` to include the full mutation run.
- `./tools/test.sh release`
  - Requires release preview at `8080`.
  - Covers public hydration / SEO / AOT preview checks.
- `./tools/test.sh acceptance`
  - Legacy nightly diagnostics-only tier; it is not part of production correctness.
  - Its Playwright acceptance surface may run only under the governed `browser-diagnostics` job.
- `./tools/test.sh visual`
  - Nightly diagnostics-only visual aggregate; it is not a correctness credential.
  - Runs dark-mode, mobile-layout, and screenshot-baseline probes through the browser diagnostics boundary.
- `./tools/test.sh security`
  - Requires the shared runtime bootstrap, but launches no browser.
  - Runs browserless auth/session/MFA/PoW/permission contract and state checks; rendered a11y probes belong to browser diagnostics.
- `./tools/test.sh resilience`
  - Requires the shared runtime bootstrap, but launches no browser.
  - Runs server/runtime, upload, search, and notification stream resilience gates.
- `./tools/test.sh load`
  - Requires the shared runtime bootstrap, but launches no browser.
  - Runs lightweight public/API concurrency checks.
- `./tools/test.sh production-correctness`
  - Authoritative browserless production CI gate.
  - Covers fast/static/unit/property/model, SSR/AOT/HTTP, API/DB/cache integration, browserless security/resilience/load/backend-QPS, frontend render structure, and release evidence schema validation.
  - Its dependency closure contains no Acceptance, visual, UX viewport, cross-browser, browser render-pressure, Playwright, or Chromium tier.
- `./tools/test.sh production`
  - Historical compatibility alias that depends only on `production-correctness`.
  - It does not add any browser suite to the browserless production gate.
  - The backend production union is deterministically sharded by test method. Each shard instruments an isolated copy of the same fresh build, and the runner rejects any gap, overlap, non-passing TRX result, or incomplete coverage output.
  - Allows schema-valid `collected-blocked` release evidence for external production handoff; this is not a final publish credential.
- `./tools/test.sh browser-contract`
  - The only real-browser correctness tier and the only browser tier in the `release-final` closure.
  - Consumes the immutable production build receipt and runs one managed Chromium with one controller/session, zero shard, and zero retry.
- `./tools/test.sh browser-diagnostics`
  - Explicit scheduled/manual diagnostics boundary for legacy Acceptance, visual, UX viewport, cross-browser, renderer pressure/performance, and browser-runtime resilience probes.
  - Diagnostic failure is retained independently and never converted into production correctness evidence.
- `./tools/test.sh release-final`
  - Final publish credential for manual release candidates.
  - Adds strict coverage, changed-code coverage, release runtime lanes, AOT generation/consumption, peak/burst/scale/soak/mutation/resource budgets, strict shard completeness, live exposure evidence, real backup restore, deployed post-smoke coverage, authenticated DAST/Wasm fuzz/fault-injection/short-soak semantic evidence, flaky release-final governance, artifact digest binding, and exactly one `browser-contract`.
  - The aggregate itself is browserless; scheduled/manual visual and browser diagnostics are not folded into its correctness result.
  - This is the only gate that may be treated as the "zero known release-blocker bugs inside the declared release matrix" proof.

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
