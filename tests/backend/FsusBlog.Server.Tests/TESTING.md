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
  - Then runs debug runtime checks that require `3000/5000`: auth session, API contract matrix, Binary parity, SSE static/live, search, and binary smoke.
- `./tools/test.sh ci`
  - Runs `fast + integration`.
- `./tools/test.sh coverage-gate`
  - One-shot hard coverage gate.
  - Runs `coverage-backend + coverage-frontend + coverage-merge + coverage-threshold`.
  - Enforces both merged and backend-only thresholds.
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
  - Runs runtime, upload, search and SSE resilience gates.
- `./tools/test.sh load`
  - Requires the acceptance environment.
  - Runs lightweight public/API concurrency checks.
- `./tools/test.sh production`
  - Industrial release gate.
  - Runs `fast`, bootstraps `3000/5000/8080` once, then runs `integration + release + acceptance + visual + security + resilience + load` against the shared environment.
  - This is the "0 errors / 0 warnings / 0 release-blocker bugs" gate.

## CI Contract

- `.github/workflows/quality-gate.yml` runs `./tools/test.sh production` on `pull_request`, `main` / `master` push, and manual dispatch.
- The same workflow also runs `./tools/test.sh coverage-gate` as the coverage blocker.
- CI must provide `GITHUB_PACKAGES_TOKEN` so `src/frontend/.npmrc` can install the private `@ozwasyd` package.
- On failure, inspect `.tmp/acceptance/*.log` and `src/frontend/test-results/playwright/`; CI uploads both as `quality-gate-artifacts`.

## Cleanliness Rules

- Test source directories must not contain committed runtime artifacts.
- Do not commit `TestResults`, `.trx`, coverage outputs, database files, logs, or snapshot residue.
- Shared fixtures belong in `Fixtures/`; do not inline them at the bottom of unrelated test files.
- Shared helpers belong in `Helpers/`; do not hide them inside random test files.
- Any new external-dependency test must be explicitly marked as `Integration`; do not let it silently join the fast gate.
