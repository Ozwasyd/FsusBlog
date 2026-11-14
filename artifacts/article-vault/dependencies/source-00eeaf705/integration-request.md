# Integration handoff for original #3582

Published source candidate: `00eeaf705dcc03a5412b36002df0b166e7442f3a`
Branch: `codex/issues-2124-2125-portable-assets-20261008`
Preceding source commit: `80a2736711edff3a711ec854d55c65433a127a5f`
Base independently read: `53da546cc8ab9fd8603067395d988b7ddb650394`; latest default independently fetched: `0e9dd5751bdd584204fd149bdb1526b97ff682a6`.

New shared API paths under `src/shared/Contracts/ArticleVault/Dependencies/`:
- `PortableDependencyManifest.cs`: schema constants, closed node union, binding/admission/rights, semantic edges, manifest and immutable extension records. Link/frozen nodes require exact `TargetBinding`; `VaultAssetDependency.AssetIdentity` is the existing backend `AssetId.Value` projection.
- `PortableDependencyCodec.cs`: `NodeKey`, `NodeDigest`, `GraphDigest`, `ManifestDigest`, `PlanDigest`, `Seal`, overloaded `Serialize`, `Deserialize`, `DeserializePlan`.
- `PortableDependencyVerifier.cs`: `ValidateStructure(manifest)`, `VerifyCurrent(manifest, realArticleManifest, sourceBytes, currentAuthorityNodes, currentAuthorityEdges, currentRelationSha256, canonicalBudgets, timeProvider?, currentServerCoordinate?)`, `VerifyBudgets`.
- `ArticleVaultDependencyPlanner.cs`: `VaultDependencyPlanInput` includes exact current nodes AND edges; `Build(syncPlan, originalRequest, verificationContext, inputs, budgets, timeProvider?)`, `ValidateStructure(extension)`, `VerifyCurrent(extension, syncPlan, originalRequest, context, inputs, budgets, timeProvider?)`.
- `portable-dependency-manifest.schema.json`: one shared portable schema referencing existing coordinate/embed schemas by their canonical IDs. Canonical JSON emits lowercase GUIDs; input D UUID casing follows actual backend AssetId parsing rather than a second identity grammar. No replicated embed budget table.

New internal backend API paths:
`src/backend/Services/ArticleVault/Assets/ArticleVaultAssetValidator.cs` (`ValidateRecord`, `ValidateBytes` with actual `AssetId`/`AssetRecord`/canonical schema/media inspector) and `ArticleVaultAssetConflictDiagnostics.cs` (`Diagnose`, diagnostics only).

Precise shared edits requested; intentionally not performed concurrently:

1. `src/shared/FsusBlog.Shared.csproj` add to original resource ItemGroup:

```xml
<EmbeddedResource Include="Contracts/ArticleVault/Dependencies/portable-dependency-manifest.schema.json"
                  LogicalName="FsusBlog.Contracts.ArticleVault.Dependencies.portable-dependency-manifest.schema.json" />
```

2. Register the new Node test in `tests/governance/test-lifecycle-registry.json` under the original `repository-governance:static-node-contracts` owner, canonical execution once, classifications `source-text` and `behavior`: `tests/tools/article-vault-dependency-boundary.test.mjs`. Add the actual checker `tools/governance/check-article-vault-dependency-boundary.mjs` to the existing static governance command/closure producer, with its new test, rather than a second matrix authority.
3. Extend original `tests/matrix.yml` backend-unit/static-governance closures and original coverage registry for `PortableDependencyManifestTests`, `ArticleVaultAssetValidationTests`, and this boundary test/checker. Actual focused command after prerequisites/compilation are fixed:

```sh
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter 'FullyQualifiedName~PortableDependencyManifestTests|FullyQualifiedName~ArticleVaultAssetValidationTests'
node tools/governance/check-article-vault-dependency-boundary.mjs
node --test tests/tools/article-vault-dependency-boundary.test.mjs
```

4. `config/development/document-lifecycle.json`: register `docs/architecture/article-vault-dependencies.md` with `status: current`, `owner: backend`, `relatedIssues: [2124, 2125]`, empty supersession and `supersededBy: null`; add its link alongside the existing Vault watcher entry in `docs/index.md`; regenerate products only through the original document producer.
5. Preserve mandatory `PortableDependencyVerifier.VerifyCurrent` / `ArticleVaultDependencyPlanner.VerifyCurrent` gate before #2128 writer admission. The planner supplies the fresh canonical plan item server coordinate, so a pull cannot bind the older stored server snapshot. Structural JSON/hash validation is not authorization. Existing coordinate semantics remain owned by `ArticleVaultManifestValidator`; if structural-only consumers need a standalone coordinate check, expose that owner's existing validator rather than duplicating it in this module.

Outstanding exact canonical capabilities:
- #3560/#1865 portable article/link mapping and package extension bytes/API; no mapper stand-in exists.
- #1779 authorized bytes by AssetId with owner/rights/revision, idempotent intended-AssetId upload bound to plan/operation/digest, explicit physical reuse decision and ledger/reference receipt.
- #1910 real stable snapshot/path-safe read/materialize API; #1909 accepted coordinate/journal/recovery handoff.
No pull/upload/materialization/recovery receipt or final business writer is claimed implemented.
