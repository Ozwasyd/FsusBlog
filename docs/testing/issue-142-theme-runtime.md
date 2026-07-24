# Issue #142 theme runtime verification

The focused contract covers:

- per-user preview isolation from public/site-wide activation;
- exact package/asset hash and config-version capture;
- fenced rollback restoring theme, asset, config and mode;
- automatic rollback when event/cache publication fails;
- stale versus current runtime CSS load failure reports;
- default reset as no-restart hot disable;
- durable PostgreSQL history and machine-readable evidence;
- browser fallback when the failure reporter is unavailable.

Run the backend contract:

```bash
dotnet build tests/backend/FsusBlog.Server.Tests.csproj --no-restore -p:TreatWarningsAsErrors=true
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-build --no-restore \
  --filter "FullyQualifiedName~ThemeInfrastructureTests|FullyQualifiedName~ThemeRegistryPostgresTests"
```

Run the browserless frontend contract through the local sibling FsusUI alias:

```bash
cd src/frontend
FSUSBLOG_LOCAL_FSUSUI_ROOT=../../../FsusUI npx vitest run \
  --config vitest.config.ts ../../tests/frontend/unit/services/themeAssetRuntime.test.ts
FSUSBLOG_LOCAL_FSUSUI_ROOT=../../../FsusUI npm run typecheck:local-fsusui
```

This issue does not add an admin endpoint or UI, so it does not claim a
rendered admin workflow. Browser plugin evidence is not required for the
runtime-only boundary; a future admin surface must exercise the same service
and report adapter rather than create a second activation state machine.
