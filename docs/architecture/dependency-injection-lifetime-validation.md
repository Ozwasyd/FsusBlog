# DI lifetime validation

## Scope

FsusBlog 的 backend 组合根分布在 `ServiceCollectionExtensions`、四个 `Runtime*ServiceCollectionExtensions` 和少量 initializer。注册成功只证明容器可构造服务，不证明 singleton、hosted service 与 scoped DbContext 的 lifetime 边界正确。因此最终 graph 在 host build 前必须完成静态和运行时双重校验。

## Validation layers

1. `FsusServiceProviderValidation` 对所有环境启用 Microsoft 默认容器的 `ValidateOnBuild=true` 与 `ValidateScopes=true`。这覆盖实际 provider 的缺失依赖和 captive dependency，不把 production 变成未验证的特殊路径。
2. `DependencyGraphValidator` 在 `ConfigureFsusApplication` 末尾分析标准 runtime graph，并在 `Program.cs` 加入 schema command/control-plane 注册后再次分析最终 graph。它递归跟踪 singleton/hosted-service 经 transient 或 singleton 到 scoped 的路径；`IEnumerable<T>` 会检查全部注册，不能因同一 service 同时存在 singleton 与 scoped 实现而漏报。发现违规即在 `builder.Build()` 前 fail closed。
3. `FsusBlog.DiLifetimeAnalyzer` 作为 backend 的 Roslyn analyzer project reference 运行。`FSUSDI001` 检查 generic `AddSingleton` / `TryAddSingleton` / `AddHostedService` 的完整 singleton/transient 构造函数路径、`IEnumerable<T>` 的每项注册，并检查 singleton factory 中显式解析的 scoped service。非集合解析遵循默认容器的 last-registration-wins 语义，避免把未被解析的旧注册误报为 captive dependency。

Issue 中建议的 `NetEscapades.DependencyInjection.Validation` 不是可解析的 NuGet 包标识；仓库使用受 .NET 10 支持的默认 provider validation 加本地 Roslyn analyzer，避免引入名称不明确、无法锁定 provenance 的依赖。不得为了勾选清单添加不存在或无来源的 package。

## Feature slices

组合根不是单个 277+ 注册的巨型方法。`ServiceCollectionExtensions.AddFsusRuntimeServices` 只负责稳定编排，实际注册已按 `RuntimeSecurityAndLifecycle`、`RuntimeInfrastructure`、`RuntimePublicAot`、`RuntimeDomain` 四个 feature slice 分文件维护；DataProtection、OpenAPI 与基础框架注册保留在最外层组合根。新增服务必须进入对应 slice，不能把全部注册重新堆回 `ServiceCollectionExtensions`，最终 validator 仍分析拼合后的同一张 graph。

## Hosted-service scope ownership

Hosted service 只能注入 singleton/thread-safe dependency、`IServiceScopeFactory` 或显式 runtime state。需要 DbContext/SqlSugar scoped dependency 时，使用：

```csharp
await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
    scopeFactory,
    "scheduled_publish");
ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
```

`ObservedAsyncServiceScope.DisposeAsync()` 先等待真实 scope 释放，再结束 `di.scope` Activity。即使 scoped disposal 抛错，Activity 也会在 `finally` 中关闭。Activity 只使用固定 operation 名，不包含 SQL、账号、路径、token 或其它高基数输入。

## Observability and dashboard

`DependencyGraphRuntimeState` 向 admin-only `/api/binary/author/ops/health` 增加 `dependency-graph` service status，显示 registrations、singleton、scoped、transient、hosted service、opaque factory 与 captive dependency 数量。OTLP 同时导出：

- `fsus.di.graph.registration_count`
- `fsus.di.graph.captive_dependency_count`
- `fsus.di.graph.opaque_factory_count`
- `di.scope` Activity（`fsus.operation` 只取固定 worker 名）

公开匿名、登录、admin、notification stream 和 binary endpoint 契约不变；graph 详情只进入既有 admin ops 响应和内部 metrics。

## Risk and rollback

主要风险是旧注册以前依赖 production 不启用 scope validation 而侥幸启动。正确处置是把 singleton/hosted service 的 scoped constructor dependency 改为显式 scope ownership，不能关闭门禁或把 scoped service 改成 singleton 掩盖问题。

若新增 analyzer 规则产生误报，可在不重启现网实例的情况下回退待发布 commit，并继续使用当前已发布版本；不得在运行时热关闭 lifetime validation，因为验证发生在新进程组合根 build 前。候选实例 fail closed 不影响当前 active slot。确需恢复流量时保留旧 active slot，修正注册后重新启动 candidate。

## Focused verification

```bash
dotnet build tests/backend/FsusBlog.Server.Tests.csproj --no-restore -p:TreatWarningsAsErrors=true
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-build --no-restore \
  --filter 'FullyQualifiedName~DependencyGraphValidationTests|FullyQualifiedName~DiLifetimeAnalyzerTests|FullyQualifiedName~ServiceCollectionExtensionsTests|FullyQualifiedName~ScheduledPublishWorkerTests'
```

测试覆盖 transient/singleton transitive capture、mixed-lifetime `IEnumerable<T>`、Roslyn diagnostic、last-registration-wins、显式 scope boundary、完整 runtime graph、全环境 provider validation、hosted-service scoped disposal 与 Activity close。由于没有路由/鉴权/AEDS 变更，匿名请求、登录请求、admin 权限、notification stream 和 binary payload 继续使用原契约；admin ops 只追加新的 service item。
