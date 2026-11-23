# AGENTS.md: FsusBlog (v2)

FsusBlog v2 is a clean-slate deployment-oriented content system built on .NET 10 (C# 14, ASP.NET Core Minimal APIs), PostgreSQL/Npgsql, Vue 3/TypeScript consuming sibling `../FsusUI`, AEDS v2 binary wire frames, and an offline operations CLI (`FsusBlog.V2.Cli`). Prefer Chinese in conversation with the user; keep code identifiers, paths, and commands in English.

## Scope, development stage, and Git workflow

- Check `git status` before editing. Respect existing working-tree changes; never overwrite, revert, reformat, or commit unrelated files. Review or planning requests do not automatically authorize implementation.
- Close the loop within the requested scope: implement, verify, fix regressions introduced here, and update matching active documents. Do not invent process for small edits.
- **Pre-release development posture**: V2 is in pre-release development with no production migration obligation. Edit the final schema directly in `src/Cli/Schema/01..04*.sql` and `src/Storage/`, and rebuild development databases via `FsusBlog.V2.Cli plan` and `apply`. Do not add dev-era single-table incremental schema-patch CLI commands, legacy environment-variable fallbacks, or V1 data-migration code. Treat sibling `../FsusBlogV1` strictly as read-only static reference.
- **Phase commit and push cadence**: After completing and verifying each distinct phase, stage only the task's changes, create a clean atomic commit (every commit must build and pass its verification tier), and push to the current tracking branch. Never force-push or rewrite published history.

## Load context on demand

Read only the entry points, source files, and tests relevant to the current task. Do not reread unchanged context or scan historical issue archives unless explicitly asked.

| Task involves | Entry point |
| --- | --- |
| Build, SDK lock, release bundle, readiness | [`README.md`](README.md), [`docs/index.md`](docs/index.md), [`docs/releases/readiness.md`](docs/releases/readiness.md) |
| Architecture, lease, runtime configuration | [`docs/architecture/overview.md`](docs/architecture/overview.md), [`docs/reference/configuration.md`](docs/reference/configuration.md) |
| AEDS v2 wire protocol, POD, code generation | [`docs/protocol.md`](docs/protocol.md), [`src/Contracts/wire.schema.json`](src/Contracts/wire.schema.json) |
| PostgreSQL schema, `FsusBlog.V2.Cli`, backup/restore | [`docs/migration.md`](docs/migration.md), [`src/Cli/Schema/`](src/Cli/Schema/), [`src/Storage/CurrentSchema.cs`](src/Storage/CurrentSchema.cs) |
| FsusUI local source alias & Wasm runtime | [`docs/fsusui.md`](docs/fsusui.md), [`src/Web/vite.config.ts`](src/Web/vite.config.ts) |
| Observable UI, interaction, visual acceptance | [`.agents/skills/fsusblog-design-conformance/SKILL.md`](.agents/skills/fsusblog-design-conformance/SKILL.md), [`docs/web-validation.md`](docs/web-validation.md) |
| Deployment, TLS, origins, product contracts | [`deploy/README.md`](deploy/README.md), [`docs/product/`](docs/product/) |
| Documentation structure, links, config parity | [`docs/development/documentation-policy.md`](docs/development/documentation-policy.md), [`tools/check-docs.py`](tools/check-docs.py) |

## Technical boundaries that must not be bypassed

- **AEDS v2 binary protocol only**: Runtime business endpoints use AEDS v2 frames (`application/octet-stream`) with no JSON business fallbacks. All wire edits go through `src/Contracts/wire.schema.json` and `node tools/protocol-generate.mjs` (`--check`) to keep C#, TypeScript, and C++ parity; never hand-edit generated wire outputs (`Wire.Generated.cs`, `wire.generated.ts`, `wire.generated.hpp`).
- **Online Server vs. Offline CLI isolation**: `FsusBlog.V2.Server` assumes a DML-only database role and validates the database read-only fail-closed via `CurrentSchema.VerifyAsync` at startup; it must never mutate schema on startup or expose break-glass operations over HTTP. DDL initialization (`plan`/`apply`/`verify`), secret generation, admin break-glass (`admin-identity`), backup measurement, media recovery, and offline integrity checkpoints live exclusively in `src/Cli/` (`FsusBlog.V2.Cli`), configured via `FSUSBLOG_CLI_DLL` / `FSUSBLOG_TEST_CLI_DLL`.
- **Fail-closed security invariants**: Preserve canonical origin enforcement (`FSUSBLOG_PUBLIC_ORIGIN`, with `FSUSBLOG_ADMIN_ORIGIN` auto-derived for unified single-origin deployment or explicitly overridden/disabled), strict CSP and XSS sanitization, reader vs. admin cookie/Passkey/endpoint separation (`/api/v2/identity/session.aeds` vs. `/api/v2/admin/identity/session.aeds` & `/api/v2/authoring/session.aeds`), session/credential/generation checks, `X-Fsus-*` and `X-Fsus-Admin-Permission-Session` bindings, scoped PoW, Passkey Step-Up, and dual-control moderation/appeal enforcement. Never weaken or bypass security checks for test or compatibility convenience.
- **Layer & sibling repository ownership**: `src/Contracts/` owns cross-stack wire contracts; `src/Core/` stays HTTP-, storage-, and OS-implementation-agnostic; `src/Platform/` owns POSIX/PInvoke, file-descriptor/disk I/O (signing keys, media directories, extension disk/installation/staging, appearance directory loader), and Linux worker/cgroup execution boundaries with strict one-way `Platform -> Core` dependency (guarded by `tests/Core/CorePlatformBoundaryGuardTests.cs`); `src/Storage/` owns schema shape verification shared by `Server` and `Cli`. `src/Web/` consumes sibling `../FsusUI` strictly via local source aliases (`@ozwasyd/element-plus*`); never switch silently to npm packages, never edit `../FsusUI` or `../FsusBlogV1` during a V2 task, and never mask FsusUI defects with private selectors or forged tokens.
- **Active docs vs. local evidence surfaces**: Synchronize active docs (`README.md`, `docs/index.md`, `docs/architecture/`, `docs/reference/`, `docs/releases/`, `docs/*.md`, `docs/product/*.md`, `deploy/README.md`) when public contracts, configuration keys, schema behavior, or CLI usage changes, and verify with `python3 tools/check-docs.py`. Follow [`docs/development/documentation-policy.md`](docs/development/documentation-policy.md). Never link gitignored `artifacts/*` from tracked docs or dump routine scratch files into `artifacts/`.

## Risk-tiered verification and delivery

Run checks proportional to the blast radius before each phase commit and push:

- **C# changes**: `dotnet restore FsusBlog.V2.slnx --configfile NuGet.Config --locked-mode` (when project/dependencies change), `dotnet build FsusBlog.V2.slnx -c Release --no-restore` (0 warnings, 0 errors), `dotnet test tests/Core/FsusBlog.V2.Core.Tests.csproj -c Release --no-build`, and `dotnet test tests/Platform/FsusBlog.V2.Platform.Tests.csproj -c Release --no-build`.
- **Wire / `src/Contracts/` changes**: `node tools/protocol-generate.mjs --check` and `./tools/protocol-test.sh`.
- **Frontend / `src/Web/` changes**: `cd src/Web && pnpm run typecheck && pnpm run build`, plus real rendered browser inspection (Chromium/Playwright across desktop + mobile and light + dark) for observable UI changes per [`.agents/skills/fsusblog-design-conformance/SKILL.md`](.agents/skills/fsusblog-design-conformance/SKILL.md).
- **`src/Server/`, `src/Storage/`, or `src/Cli/` changes**: Run affected real PostgreSQL 18 integration tests (`tests/Integration/`) and CLI shell suites (`tests/Integration/Migration/`). Widen to the full PG 18 integration suite when changing schema, authentication, or core storage.
- **Docs / configuration / governance changes**: `python3 tools/check-docs.py`.

Always execute PostgreSQL and browser checks against isolated, disposable databases and directories with guaranteed cleanup (`trap ... EXIT`); never target V1 or production data. Never weaken tests, fixtures, or thresholds to force a pass, and never present compilation, static checks, mocks, or historical screenshots as current end-to-end or visual acceptance.

On delivery, concisely state what changed, exact verification commands and results, any un-run environment-gated checks (e.g., Caddy TLS, PDF renderer, Nightly scale), and the pushed commit SHA.

## Maintaining this file

Add only durable technical or workflow decision boundaries that code and tooling cannot express directly, paired with a link to the authoritative document. Do not duplicate product strategy, symbol tables, design numeric values, command catalogs, or temporary task state into this file.
