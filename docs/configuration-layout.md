# Configuration Ownership and Canonical Paths

FsusBlog has one generic configuration root: `config/`. Framework-discovered files remain in their framework-defined locations, and application or project configuration remains beside its owning project. A file is not moved merely because it uses JSON.

## Canonical layout

| Configuration | Canonical path | Owner / discovery rule |
| --- | --- | --- |
| .NET local tools | `.config/dotnet-tools.json` | Standard `dotnet tool restore` discovery from the repository tree |
| Development governance manifests | `config/development/**` | Repository governance; authoritative docs and language-style policies |
| Production SLO | `config/observability/slo.yml` | Operations and observability |
| Zero-downtime resource policy | `config/deployment/zero-downtime-resource-policy.json` | Operations and deployment qualification |
| Moderation dictionaries and policies | `config/moderation/**` | Backend moderation runtime and server publish output |
| Default mutation policy | `config/testing/mutation/default.json` | Full backend Stryker lane |
| Critical mutation policy | `config/testing/mutation/critical.json` | Release-critical Stryker lane |
| ZK verification-key manifests | `config/zk/**` | Backend ZK security |
| ASP.NET runtime configuration | `src/backend/appsettings.json`, `src/backend/appsettings.Production.json` | `src/backend/FsusBlog.Server.csproj` content root |
| Development example overlay | `src/backend/appsettings.Development.example.json` | `src/backend/FsusBlog.Server.csproj` content root |
| Backend launch profile | `src/backend/Properties/launchSettings.json` | `src/backend/FsusBlog.Server.csproj` |
| Docker Compose launch profile | `ops/docker/Properties/launchSettings.json` | `ops/docker/docker-compose.dcproj` |

`config/configuration-ownership.json` is the machine-readable ownership registry. Directory ownership is recursive only where the registry says so; every file under `config/` and `.config/` must resolve to exactly one registry entry. Operational templates and executable workflows use the separate boundaries documented in [operations layout](operations-layout.md).

Full backend appsettings examples are retired rather than permanent authorities. The shared base, real production overlay, minimal development example and production operator input are defined in [appsettings authority](configuration/appsettings-authority.md); the cross-source semantic contract is owned by #1172.

## Runtime and tool discovery

`ModerationDictionaryService` and `ModerationRegionCatalogService` resolve the repository path `config/moderation/`. Server build and publish preserve the same `config/moderation/**` relative path. An explicit `Moderation:DictionaryRoot` still takes precedence for operator-managed external policy trees; the migration does not change policy semantics or reload behavior.

The .NET CLI finds `.config/dotnet-tools.json` without a custom flag:

```bash
dotnet tool restore
```

Stryker has no repository-root discovery dependency. Both lanes pass their canonical file explicitly:

```bash
dotnet tool run dotnet-stryker --config-file config/testing/mutation/default.json
repo_root="$PWD"
(cd src/core && dotnet tool run dotnet-stryker --config-file "$repo_root/config/testing/mutation/critical.json")
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
