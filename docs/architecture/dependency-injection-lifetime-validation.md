# DI lifetime validation

## Scope

The FsusBlog backend composition root spans `ServiceCollectionExtensions`, four `Runtime*ServiceCollectionExtensions` files, and a few initializers. Successful registration proves only that the container can construct services, not that singleton, hosted-service, and scoped `DbContext` lifetimes are safe; the final graph therefore requires static and runtime validation before host build.

## Validation layers

1. `FsusServiceProviderValidation` enables the Microsoft default provider's `ValidateOnBuild=true` and `ValidateScopes=true` in every environment, covering missing dependencies and captive dependencies without leaving production unvalidated.
2. `DependencyGraphValidator` analyzes the standard runtime graph at the end of `ConfigureFsusApplication`, then analyzes the final graph again after `Program.cs` adds schema command/control-plane registrations. It recursively follows singleton/hosted-service paths through transient or singleton services to scoped services, checks every `IEnumerable<T>` registration, and fails closed before `builder.Build()`; mixed singleton/scoped implementations cannot hide a violation.
3. The backend references the `FsusBlog.DiLifetimeAnalyzer` Roslyn analyzer. `FSUSDI001` checks complete constructor paths for generic `AddSingleton` / `TryAddSingleton` / `AddHostedService`, every `IEnumerable<T>` registration, and scoped services explicitly resolved by singleton factories. Non-collection resolution follows the default container's last-registration-wins semantics, avoiding false captive-dependency reports for an unused older registration.

The issue's suggested `NetEscapades.DependencyInjection.Validation` is not a resolvable NuGet package identifier. The repository uses the .NET 10-supported default provider validation and local Roslyn analyzer instead of an ambiguous dependency with unverifiable provenance; do not add a nonexistent or unsourced package to satisfy a checklist.

## Feature slices

The composition root is not a single 277+-registration method. `ServiceCollectionExtensions.AddFsusRuntimeServices` provides stable orchestration, while registrations live in four feature slices—`RuntimeSecurityAndLifecycle`, `RuntimeInfrastructure`, `RuntimePublicAot`, and `RuntimeDomain`; DataProtection, OpenAPI, and framework registrations remain at the outer root. New services belong in their slice, not back in `ServiceCollectionExtensions`; the validator still analyzes the same assembled graph.

## Hosted-service scope ownership

Hosted services may inject only singleton/thread-safe dependencies, `IServiceScopeFactory`, or explicit runtime state. For a scoped `DbContext`/SqlSugar dependency, use:

```csharp
await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
    scopeFactory,
    "scheduled_publish");
ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
```

`ObservedAsyncServiceScope.DisposeAsync()` waits for the real scope to dispose before ending the `di.scope` Activity; `finally` closes the Activity even when scoped disposal throws. The Activity uses only a fixed operation name and never includes SQL, account, path, token, or other high-cardinality input.

## Observability and dashboard

`DependencyGraphRuntimeState` adds a `dependency-graph` service status to admin-only `/api/binary/author/ops/health`, showing counts for registrations, singleton, scoped, transient, hosted service, opaque factory, and captive dependencies. OTLP also exports:

- `fsus.di.graph.registration_count`
- `fsus.di.graph.captive_dependency_count`
- `fsus.di.graph.opaque_factory_count`
- `di.scope` Activity (`fsus.operation` contains only a fixed worker name)

Anonymous, login, admin, notification-stream, and binary endpoint contracts remain unchanged; graph details appear only in the existing admin-ops response and internal metrics.

## Risk and rollback

The main risk is a registration that previously started only because production skipped scope validation. Fix it by giving the singleton/hosted service explicit scope ownership; do not disable the gate or hide the problem by making a scoped service singleton.

If a new analyzer rule produces a false positive, roll back the pending commit without restarting live instances and continue using the released version. Lifetime validation cannot be hot-disabled because it runs before a new process builds its composition root. A candidate that fails closed does not affect the active slot; to restore traffic, retain the old active slot, fix the registration, and restart the candidate.

## Focused verification

```bash
dotnet build tests/backend/FsusBlog.Server.Tests.csproj --no-restore -p:TreatWarningsAsErrors=true
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-build --no-restore \
  --filter 'FullyQualifiedName~DependencyGraphValidationTests|FullyQualifiedName~DiLifetimeAnalyzerTests|FullyQualifiedName~ServiceCollectionExtensionsTests|FullyQualifiedName~ScheduledPublishWorkerTests'
```

Tests cover transitive transient/singleton capture, mixed-lifetime `IEnumerable<T>`, the Roslyn diagnostic, last-registration-wins, explicit scope boundaries, the complete runtime graph, provider validation in every environment, hosted-service scoped disposal, and Activity closure. Because routes, authentication, and AEDS are unchanged, anonymous and login requests, admin permissions, notification stream, and binary payloads retain their contracts; admin ops only adds the new service item.
