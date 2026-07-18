# Runtime capability slices and source-file budget

Issue #1119 将后端 7 个高耦合服务、端点和组合根按 capability 拆分。目标不是改变运行时语义，而是让 policy、state、I/O、orchestration、codec、metrics 和 persistence 可以分别 review，并把每个受治理文件控制在 1,500 行以内。

## 边界

| Logical component | Stable runtime type | Capability files |
| --- | --- | --- |
| Search index | `SearchIndexService` singleton | orchestration, artifact codec, runtime persistence, models, dictionary/tokenizer |
| Schema migrations | `SchemaMigrationRegistry` singleton | thin registry, validated manifest, release-range catalogs, domain-oriented definitions |
| Authoring workflow | `AuthoringWorkflowService` scoped | drafts/preview, assets, analytics, moderation, import/export/AI |
| Authoring API | `AuthoringEndpoints` static route boundary | route orchestration, workflow routes, moderation routes, operations routes, codec/helpers |
| Articles | `ArticleService` scoped | detail/write orchestration, lifecycle/read models, cache/invalidation |
| Public hot read | `PublicHotReadStore` and `PublicHotReadCounters` singletons | snapshot/store, serving, route classification, metrics/artifact factories |
| Application composition | `WebApplicationCompositionExtensions` static composition root | pipeline/routes and HTML/CSP response materialization |

Partial declarations are an implementation boundary only. The primary constructor remains on exactly one root file, so constructor injection, service identity and lifetime do not change. Extracted pure codec/policy helpers remain private members of the same runtime type; they are not registered as stateful services and cannot accidentally acquire a broader lifetime. Schema migration is the later #1266 exception: its stable singleton is now a non-partial adapter over an explicit versioned manifest, while descriptor implementations are non-service definition types.

## Runtime invariants

- The public types, implemented interfaces and public method signatures stay unchanged.
- `/api/binary/author` keeps the same 58 method/path pairs, `Authoring` tag, admin permission metadata and AEDS request/response frame lookup.
- Schema migration descriptor order, migration IDs, checksums and SQL step fingerprints stay unchanged.
- Public hot-read route classification, variant negotiation, ETag handling, snapshot publication and metric counters use the same state objects and method bodies.
- No route, DTO, AEDS frame, cache key, database schema or notification-stream contract is added, removed or renamed.
- The service lifetimes remain: search/registry/hot-read state singleton; article and authoring workflow scoped.

## Governance and verification

`tools/architecture/check-backend-source-file-size.mjs` discovers every capability file belonging to the seven logical components. It fails when a component has not been split into its required minimum slices or when any governed file has 1,500 lines or more. The checker is part of `backend-build-governance`, so later edits cannot silently rebuild a giant root file.

Focused verification:

```bash
node tools/architecture/check-backend-source-file-size.mjs
dotnet build src/backend/FsusBlog.Server.csproj -c Release
dotnet test tests/backend/FsusBlog.Server.Tests.csproj -c Release \
  --filter 'FullyQualifiedName~ArchitectureMaintainabilityBehaviorTests|FullyQualifiedName~DependencyGraphValidationTests|FullyQualifiedName~AuthoringNativeAedsEndpointTests|FullyQualifiedName~AuthoringWorkflowServiceTests|FullyQualifiedName~ArticleServiceTests|FullyQualifiedName~SearchIndexServiceTests|FullyQualifiedName~SchemaMigrationRegistryTests|FullyQualifiedName~PublicHotReadFastPathTests'
```

The runtime topology test inspects the final endpoint data source and DI descriptors; it does not inspect source text. Existing service tests continue to exercise mutation, cache, migration, search and hot-read behavior.

## Risk and rollback

This is a compile-time source-layout change with no data migration or runtime switch. A partial file omitted from the project would fail build, and a missing authoring route or lifetime drift fails the focused behavior tests. Rollback is the previous application commit/image; database and cache rollback are unnecessary because wire, storage and key contracts do not change. Existing runtime degradation switches such as `PublicHotRead:Enabled=false` remain available and are unaffected by this refactor.
