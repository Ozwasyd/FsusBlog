# Article Vault dependency coordinates

The shared [portable dependency manifest](../../src/shared/Contracts/ArticleVault/Dependencies/PortableDependencyManifest.cs)
provides one closed format for Vault and future canonical package adapters. The
[JSON schema](../../src/shared/Contracts/ArticleVault/Dependencies/portable-dependency-manifest.schema.json)
references the existing Vault coordinate, embed target and frozen dependency
schemas. It does not define another anchor grammar or embed budget table.

This is a source capability for [#2124](https://github.com/Ozwasyd/FsusBlog/issues/2124)
and the independent validation portion of
[#2125](https://github.com/Ozwasyd/FsusBlog/issues/2125). It does not establish
package interoperability, native filesystem qualification, asset upload,
materialization or dependency-aware writer acceptance. The maintained
[Vault architecture](../architecture.md#article-vault-local-first-boundary)
continues to own the overall authority and failure model.

## Manifest and plan admission

`PortableDependencyManifest` binds site, Vault, portable/server article identity,
base/local/server coordinates, selected raw source byte identity, canonical
relation digest, typed dependency nodes and exact edges. Its graph digest sorts
semantic node keys and edges; list order does not change identity. Content,
target, ownership, rights, permission and frozen revision changes do.

Asset nodes carry the existing registered `AssetId.Value` as a GUID projection;
they cannot obtain identity from storage keys, URLs or names. Link nodes consume
`ArticleEmbedTargetIdentity`; anchors consume `ArticleBlockTarget` and the
canonical anchor contract digest. Embed nodes consume
`ArticleEmbedDependencyCoordinate` with an exact revision and publication receipt
digest. Target bindings retain site and Vault scope. None of these projections
prove that a ledger row, portable mapping, source anchor or frozen publication
exists. Only their corresponding canonical adapters can supply those facts.

`PortableDependencyCodec` rejects unknown/missing/duplicate JSON fields, unknown
node/edge kinds and noncanonical enum tokens. It verifies coordinate and manifest
seals. Structural decoding establishes integrity, not authorization; execution
must also call `PortableDependencyVerifier.VerifyCurrent` with the real current
article manifest, exact source bytes, current canonical nodes and edges, and
current relation digest. A pull binds the fresh canonical server observation,
even when the stored local article manifest still contains an older server
coordinate; the extension cannot freeze the older source or dependency graph.
That gate delegates article/source validation to the
existing manifest authority and rejects missing, ambiguous, denied or drifted
facts. It applies the existing embed owner's bounded budgets and uses iterative
cycle detection and deterministic prerequisite ordering.

`ArticleVaultDependencyPlanner.Build` first verifies the existing sync plan
against current root/article/server observations. It requires one dependency
input per operation, preserves all-or-nothing group membership and canonical
operation order, freezes the selected source side and required rights, and seals
an extension bound to the original plan SHA-256. Any failing dependency rejects
the whole extension. `VerifyCurrent` revalidates the current inputs and compares
the frozen extension before a later executor may admit it. These methods perform
no business write, asset operation, link rewrite or embed resolution.

## Asset validation boundary

The backend [asset byte validator](../../src/backend/Services/ArticleVault/Assets/ArticleVaultAssetValidator.cs)
uses `AssetId`, `AssetRecord`, `ContentAssetSchemaValidator` and
`ContentAssetMediaInspector`. Supplied bytes must match the registered size,
digest, MIME, extension and dimensions. The existing inspector recognizes media
headers and dimensions; it is not a full media decoder. The caller remains
responsible for acquiring the bytes through the canonical stable snapshot or
authorized asset read API.

[Three-way diagnostics](../../src/backend/Services/ArticleVault/Assets/ArticleVaultAssetConflictDiagnostics.cs)
classify base/local/server content digests and report independent ownership,
storage-class and metadata drift. Matching content never combines authorization
facts. Missing local observations never create a server deletion instruction.
Diagnostics do not choose a winner or produce an upload/materialization receipt.

## Outstanding integration

The canonical package owner must provide its actual portable mapping and manifest
extension API. The current `IAssetStore` exposes deletion only; `FileService`
upload completion exposes a relative display URL, without the required intended
AssetId, operation/plan, rights, revision and explicit reuse receipt. Those APIs,
and the canonical stable snapshot/path capability, are required before pull,
upload, local materialization, recovery obligations and ledger receipts can be
implemented. No replacement port, direct database/storage writer or production
mock is introduced here.

The original integration owner registers the schema resource, documentation,
test matrix, coverage and lifecycle entry. The adapter
[static boundary check](../../tools/governance/check-article-vault-dependency-boundary.mjs)
rejects direct network/filesystem/database, rendered scanning, persistent second
indexes and string target identity tokens in these modules. Static checks and
focused algorithm tests do not establish package or native end-to-end acceptance.

Rollback consists of removing the unused dependency extension and validation
modules before wiring any consumer. Once integrated, coordinate/schema drift must
block admission and require an explicit new plan rather than a fallback writer.

## Shared host composition increment

The runtime domain composition registers the existing `PostgresArticleVaultOperationCheckpointStore` once per scope and exposes the same scoped instance through `IArticleVaultOperationCheckpointStore`. Registration executes no SQL and does not migrate a database. The explicit `AddFsusArticleVaultRecoveryReaders(trustedVaultSiteIdentity)` composition also registers the sole `ArticleVaultConflictReviewReader` from `6019f3834df477627cd59e55e297cf086ff0bae3`, using the existing permission projection, execution and checkpoint readers. A missing canonical proposal store remains an actual DI failure; no replacement persistence is supplied.

The full supplied branches have unresolved add/add conflicts in resolution-plan and frontend files. The proposal store requires the conflicted owner's `TryDeserialize` capability and is not installed here. No HTTP route is registered: the current AEDS catalog has no Vault frame pair, and the canonical current-resolution-input producer and permission-site/Vault-site binding are not supplied. The current shared IPC request/lease contracts also do not provide a native peer/token dispatcher. Request assertions cannot fill these authority gaps. Native, current execution, browser transport and product qualification remain open.
