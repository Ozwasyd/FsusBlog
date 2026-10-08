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

The sole canonical proposal and checkpoint stores are registered through
`AddFsusArticleVaultPostgresRecoveryStores()`. They require the host's actual
`NpgsqlDataSource`, original execution store and time provider; this composition
creates no second pool, schema or migration. Each interface shares its canonical
scoped instance. Ordinary domain startup leaves these stores disabled unless the
host explicitly supplies `ArticleVault:TrustedSiteIdentity` and the required data
source. Missing dependencies fail real composition validation.

The recovery owner commit `0ba8e8eca81798f07540aaec232e1abaffb7e2b2` supplies the
original proposal codec, immutable proposal storage, exact stored reader and
transactional encrypted recovery storage. The shared HTTP integration now exposes
only authenticated exact historical reads through AEDS frames 253/254 and the
existing private authoring browser runtime. The host binds its opaque Vault site
independently from the permission-site URL. The route verifies the actual principal,
article permission before/after reading and original sealed plan; it cannot execute,
resume, materialize or commit base.

Native owner commit `8b2634d06d543246bc3208076be6c3db2f84e651` was inspected and does
contain the Linux peer/grant dispatcher and canonical operation adapter. Consumption
still requires the coordinated handoff and applicable native runtime qualification.
Current-resolution fact acquisition and decision/candidate admission remain open.
The recovery owner `b8277a23a6a721c5b0ea3f8c918fa32251d325cd` now supplies the actual
AES-256-GCM backup verifier. Explicit protection composition reuses the existing
`IAuditRetentionEpochKeyStore.TryReadAsync` with the fixed recovery domain; it creates,
derives, rotates and destroys no keys. Encrypted storage automatically composes this
provider when the host's existing key facility is registered. Missing key-owner
registration or an unavailable exact key remains a refusal. Key custody/lifecycle
and native encrypted snapshot origin are separate unqualified boundaries. The checkpoint owner commit
`39459f8162c775b79747a35228cd38b3c5b5faf6` now invokes canonical `StageAsync`
before checkpoint insertion and again before the same transaction commits; the
root registers `IArticleVaultRecoveryOperationCheckpointWriter` to that same scoped
checkpoint store. Explicit encrypted storage composition requires an already
registered trusted protection authority or the existing application key facility
and shares the sole recovery storage instance.
These authority gaps are distinct from ordinary branch conflicts.
Historical browser reads do not qualify current execution or product acceptance.

The actual server observer already produces a metadata projection digest over title,
summary, cover, category and tags. That digest is not the canonical V1 metadata
manifest's serialized identity. The revision reader supplies those finite fields and
snapshots but not slug/portable taxonomy/property definitions or the complete V1
manifest bytes bound to the observation. The original sync planner continues to
classify BothModified as Blocked; the new-operation adapter preserves all observed
coordinates and candidate refusal. Root decision/executable-candidate integration
remains incomplete until a legitimate current candidate can be bound without clearing
SOURCE HOLD or inventing those missing facts.

`ArticleVaultCurrentSourceReader` now binds the existing exact-current revision
reader to the original sealed plan and complete current group through shared
trusted-site DI. It reuses the original executor observation guard and existing
live permission guard, preserving their refusal semantics. It rechecks current
facts and permission after reading, validates the literal revision ID and raw
source-byte identity, and supplies only the verified server bytes to the existing
three-way source admission owner. A Blocked original plan stays Blocked; no
writer, package codec, source winner or native admission is introduced.

This fills the current-server source-read integration, not complete metadata or
decision admission. Existing revision fields and definition-store APIs must be
distinguished from the absent persisted article-value/current-manifest bridge.
The package owner supplies portable slug/taxonomy/property mappings under its
original unresolved-definition policy; the value owner supplies actual persisted
revision/property coordinates and current definition/permission binding. Source
acquisition for base/local, typed dependencies, real assets, native writes/readback
and base completion retain their separate canonical owners and qualification gates.

`AddFsusArticleVaultAgentCanonicalOperations` composes the existing scoped execution
store, checkpoint store and sync executor with the canonical agent operation adapter.
It requires an explicit native binding, root-manifest digest and trusted administrator,
and rejects duplicate registration or unavailable canonical owners. It does not create
a dispatcher, lease, endpoint or grant. The native session owns its dispatcher.
The adapter reads sealed operation/checkpoint references, replays only an existing
immutable execution result, and persists cancellation through the sole checkpoint
store before returning the new pointer. A first execution still refuses with
`agent_current_operation_execution_admission_missing`.

The shared dispatcher and lifecycle inventory retain successful canonical pointers
and drain/revoke session work before cancellation. These ordinary contract controls
do not qualify native lock ownership, IPC host registration or session cleanup on an
admitted filesystem. The Linux control-session implementation uses the same
canonical lease owner's codec and transition-verification APIs. These source APIs
validate receipt shape and chain transitions; they do not establish native lock
ownership or qualify host IPC/session cleanup. Shared DI remains explicit and
does not start a native session or supply first-execution admission.
