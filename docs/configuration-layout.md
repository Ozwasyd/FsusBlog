# Configuration Ownership and Canonical Paths

FsusBlog has one generic configuration root: `config/`. Framework-discovered files remain in their framework-defined locations, and application or project configuration remains beside its owning project. A file is not moved merely because it uses JSON.

## Canonical layout

| Configuration | Canonical path | Owner / discovery rule |
| --- | --- | --- |
| Native CMake presets | `CMakePresets.json` | Native build tooling; root placement follows CMake discovery |
| .NET local tools | `.config/dotnet-tools.json` | Standard `dotnet tool restore` discovery from the repository tree |
| Backend configuration contract | `config/application/backend-configuration-contract.json` | Backend configuration governance; metadata only, never secret values |
| Development governance manifests | `config/development/**` | Repository governance; authoritative docs and language-style policies |
| Production SLO | `config/observability/slo.yml` | Operations and observability |
| Zero-downtime resource policy | `config/deployment/zero-downtime-resource-policy.json` | Operations and deployment qualification |
| Production Fresh disk demand catalog | `config/testing/production-disk-demand.json` | Test governance; selected pre-admission authority plus physical and projection/checkpoint producer capacity declarations |
| Moderation dictionaries and policies | `config/moderation/**` | Backend moderation runtime and server publish output |
| Default mutation policy | `config/testing/mutation/default.json` | Full backend Stryker lane |
| Critical mutation policy | `config/testing/mutation/critical.json` | Release-critical Stryker lane |
| ZK verification-key manifests | `config/zk/**` | Backend ZK security |
| ASP.NET runtime configuration | `src/backend/appsettings.json`, `src/backend/appsettings.Production.json` | `src/backend/FsusBlog.Server.csproj` content root |
| Development example overlay | `src/backend/appsettings.Development.example.json` | `src/backend/FsusBlog.Server.csproj` content root |
| Backend launch profile | `src/backend/Properties/launchSettings.json` | `src/backend/FsusBlog.Server.csproj` |
| Docker Compose launch profile | `ops/docker/Properties/launchSettings.json` | `ops/docker/docker-compose.dcproj` |

`config/configuration-ownership.json` is the machine-readable ownership registry. Directory ownership is recursive only where the registry says so; every file under `config/` and `.config/` must resolve to exactly one registry entry. Operational templates and executable workflows use the separate boundaries documented in [operations layout](operations-layout.md).

Full backend appsettings examples are retired rather than permanent authorities. The shared base, real production overlay, minimal development example and production operator input are defined in [appsettings authority](configuration/appsettings-authority.md). The [generated backend configuration reference](configuration/backend-configuration-reference.generated.md) is derived from the cross-source semantic contract and is documentation, not an operator input template.

## Backend configuration semantics

`config/application/backend-configuration-contract.json` is the only semantic inventory for custom backend keys, tracked environment inputs and mounted files. It binds each setting to an owner, environment scope, source class, secret policy, requiredness, validator, documentation and runtime consumer. ASP.NET Core configuration precedence remains unchanged; the contract detects drift and does not contain runtime values.

Check the repository, emit a machine-readable report, or regenerate the reference with:

```bash
node tools/configuration/check-backend-configuration-contract.mjs
node tools/configuration/check-backend-configuration-contract.mjs \
  --report-json .tmp/configuration/backend-configuration-drift.json
node tools/configuration/check-backend-configuration-contract.mjs --write-doc
node --test tests/tools/backend-configuration-contract.test.mjs
```

The static-governance lane runs the checker and its tamper fixtures. A rollback must revert the contract, generated reference, owner registry and checker together; disabling startup validation is not a rollback path.

## Runtime and tool discovery

`ModerationDictionaryService` and `ModerationRegionCatalogService` resolve the repository path `config/moderation/`. Server build and publish preserve the same `config/moderation/**` relative path. An explicit `Moderation:DictionaryRoot` still takes precedence for operator-managed external policy trees; the migration does not change policy semantics or reload behavior.

The .NET CLI finds `.config/dotnet-tools.json` without a custom flag:

```bash
dotnet tool restore
```

root manifest 只锁定 official Stryker release；mutation lane 不执行该 manifest 中的
upstream tool，而由 wrapper 校验 custom producer identity、official archive digest、overlay digest，并在
`.tmp/tools/stryker/` 构建和缓存。各 lane 仍显式传递 canonical config：

```bash
node tools/mutation/stryker-tool.mjs run --working-directory . -- --config-file config/testing/mutation/default.json
repo_root="$PWD"
node tools/mutation/stryker-tool.mjs run --working-directory src/core -- --config-file "$repo_root/config/testing/mutation/critical.json"
```

The test runner also supplies each lane's output directory and, for the critical lane, runs from `src/core` while retaining the repository-absolute config path.

## Visual Studio launch ownership

`FsusBlog.slnLaunch` may reference only project paths declared by `FsusBlog.slnx`. Docker Compose project items must resolve relative to `ops/docker/docker-compose.dcproj`; optional local `.env` files are runtime inputs and are not unconditional project items. Each `Properties/launchSettings.json` must be colocated with a real project in its parent directory.

## Governance

Run the focused layout gate with:

```bash
node tools/configuration/check-configuration-layout.mjs
node --test tests/tools/configuration-layout.test.mjs
```

The gate reports all detected violations in one run. It rejects the historical `configs/` root, arbitrary repository-root JSON outside the framework allowlist, stale root appsettings examples, unowned root `Properties/`, overlapping or missing configuration owners, stale `.slnLaunch` paths, and missing `.dcproj` includes.

To roll back a path migration, revert the path, runtime/publish reference, ownership registry, and documentation together. Do not keep both old and new copies: duplicate canonical paths deliberately fail the gate.
