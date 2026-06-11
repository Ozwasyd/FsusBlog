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

- `./tools/test.sh fast`
  - Runs only non-integration tests via `Category!=Integration`.
  - Must not require Docker or any running service.
- `./tools/test.sh integration`
  - Runs server-side integration tests via `Category=Integration`.
  - Then runs debug runtime checks that require `3000/5000`: auth session, API contract matrix, Binary parity, notification stream static/live, search, and binary smoke.
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
  - `backend-perf-readiness`: validates backend performance readiness by building the BenchmarkDotNet project in Release. It does not claim a benchmark result; use `backend-benchmark-regression` for real benchmark evidence.
- `./tools/test.sh backend-mutation`
  - Runs Stryker.NET with `stryker-config.json`.
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
  - Bootstraps `3000 / 5000 / 8080`.
  - Runs `fast + integration + release` and then full Playwright acceptance.
- `./tools/test.sh visual`
  - Requires the acceptance environment.
  - Runs dark-mode, mobile-layout, and screenshot-baseline gates on key public and console routes.
- `./tools/test.sh security`
  - Requires the acceptance environment.
  - Runs auth/session/MFA/PoW/permission/a11y release blockers.
- `./tools/test.sh resilience`
  - Requires the acceptance environment.
  - Runs runtime, upload, search and notification stream resilience gates.
- `./tools/test.sh load`
  - Requires the acceptance environment.
  - Runs lightweight public/API concurrency checks.
- `./tools/test.sh production`
  - Production CI gate.
  - Runs `fast`, bootstraps `3000/5000/8080` once, then runs `integration + release + acceptance + visual + security + resilience + load + backend-qps` against the shared environment.
  - Allows schema-valid `collected-blocked` release evidence for external production handoff; this is not a final publish credential.
- `./tools/test.sh release-final`
  - Final publish credential for manual release candidates.
  - Adds strict coverage, changed-code coverage, release runtime lanes, AOT generation/consumption, peak/burst/scale/soak/mutation/resource budgets, strict shard completeness, no visual skip, live exposure evidence, real backup restore, deployed post-smoke coverage, authenticated DAST/Wasm fuzz/fault-injection/short-soak semantic evidence, flaky release-final governance, and artifact digest binding.
  - This is the only gate that may be treated as the "zero known release-blocker bugs inside the declared release matrix" proof.

## CI Contract

- `.github/workflows/quality-gate.yml` runs `./tools/test.sh production` on `pull_request`, `main` / `master` push, and manual dispatch.
- The same workflow also runs `./tools/test.sh coverage-gate` as the coverage blocker.
- `release-final` is `manualOnly` in `tests/matrix.yml`; it is intentionally not part of ordinary PR CI.
- CI must provide `GITHUB_PACKAGES_TOKEN` so `src/frontend/.npmrc` can install the private `@ozwasyd` package.
- On failure, inspect `.tmp/acceptance/*.log` and `src/frontend/test-results/playwright/`; CI uploads both as `quality-gate-artifacts`.

## Cleanliness Rules

- Test source directories must not contain committed runtime artifacts.
- Do not commit `TestResults`, `.trx`, coverage outputs, database files, logs, or snapshot residue.
- Shared fixtures belong in `Fixtures/`; do not inline them at the bottom of unrelated test files.
- Shared helpers belong in `Helpers/`; do not hide them inside random test files.
- Any new external-dependency test must be explicitly marked as `Integration`; do not let it silently join the fast gate.
