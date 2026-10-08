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

The [plan input verifier](../../src/backend/Services/ArticleVault/Assets/ArticleVaultAssetInputVerifier.cs)
now binds supplied raw asset bytes and an original `AssetRecord` to an exact
current plan. `VerifyCurrent` accepts the original operation and sealed bundle,
dependency extension, current request/dependency inputs, authenticated principal,
trusted site, item identity, AssetId, record, raw bytes, clock and cancellation.
It uses the original bundle/operation/current dependency verifiers, binds the
authenticated admin to the bundle principal, admits only a planned pull/push
content item and its unique AssetId, and compares owner/content/media metadata
before hashing bytes with the existing inspector. Asset owner need not equal
executing admin: it must equal the selected node's owner, with rights still
supplied by the actual authority. Current graph, deadline and cancellation are
checked again after byte validation. The method returns only the existing
`ArticleVaultValidationResult`; it performs no read or write and creates no
asset grant, upload/reuse receipt or materialization admission. Its record/bytes
are required original-supplier inputs, not proof of their acquisition provenance.

[Three-way diagnostics](../../src/backend/Services/ArticleVault/Assets/ArticleVaultAssetConflictDiagnostics.cs)
classify base/local/server content digests and report independent ownership,
storage-class and metadata drift. Matching content never combines authorization
facts. Missing local observations never create a server deletion instruction.
Diagnostics do not choose a winner or produce an upload/materialization receipt.

The [committed upload observer](../../src/backend/Services/ArticleVault/Assets/ArticleVaultCommittedUploadObserver.cs)
consumes the canonical `IFileService.ObserveCommittedUploadAsync` capability from
`982430c1c696e51715e1fb9587acbc2f61ec8902`. The original service verifies the upload
grant, native file bytes and unique asset/reference ledger. The adapter checks
the resulting AssetId, content digest, MIME, extension, size, dimensions and owner
against the supplied asset dependency, preserving original failures and returned
version/reference digests. Public URLs never participate in matching.

This method returns the original observation, not a Vault receipt or permission
decision. It does not establish the dependency's rights or server revision, bind
plan/operation identities, start an upload, decide reuse, materialize bytes or
advance a synced base. Version/reference digests come from the original authority;
the adapter neither recomputes them nor creates another ledger. Canonical Vault
authorization and current observation revalidation remain mandatory before any
business write. Unit adapter controls use synthetic responses and do not qualify
real native IO or a live ledger.

The [asset staging adapter](../../src/backend/Services/ArticleVault/Assets/ArticleVaultAssetStagingAdapter.cs)
adds exact plan scope to that observation. It loads the named immutable execution
bundle through `IArticleVaultExecutionStore.LoadSealedAsync`, uses the original
`ArticleVaultOperationVerifier` from `9cd6ae50b233eee35f291c9690d316bbfee37941`,
and verifies the dependency extension against supplied current canonical inputs.
The whole-plan operation identity and article item identity remain distinct.
Only a named push item and its unique planned AssetId can produce a handoff;
the upload principal must match the sealed bundle principal. Current input,
deadline and cancellation checks surround the original upload observation.

The [upload handoff](../../src/backend/Services/ArticleVault/Assets/ArticleVaultAssetUploadHandoff.cs)
binds site/vault/device/agent, exact plan, operation, group/item, article source,
dependency extension, asset and original observation. Its preparation identity is
deterministic for that scope. Identical retries reread the same original upload
session; they do not initialize or complete another upload. Observation drift
changes the content seal and makes `RevalidateAsync` refuse a previous handoff.
Returned reference collections are immutable copies. No grant/token is retained.

This is content-addressed staging preparation before execution, not durable asset
staging or an accepted materialization receipt. After an article operation is
accepted, its server revision and original reference ledger can legitimately
change. `RevalidateAsync` checks the pre-execution plan and observation; it cannot
be used to admit those changes after acceptance. The actual accepted-source
reader supplies exact article bytes and permission checks, but no asset receipt
binding the accepted operation to its resulting ledger references. That missing
owner capability must define the expected accepted asset facts before a
materialization handoff can be implemented. An old snapshot cannot stand in for
fresh observations, and arbitrary ledger deltas cannot be allowed as recovery.

The existing resolution proposal
store accepts only resolution proposals; it is not repurposed. The existing
operation checkpoint store persists operation history, with no asset-stage API.
The adapter never writes either store, rolls back a committed upload, deletes an
asset or changes a synced base. Its `CanStartUpload`, `CanMaterialize` and
`CanCommitBase` remain false. Calling composition must acquire fresh canonical
source/permission inputs; this adapter does not implement their acquisition or
grant Vault rights.

## Outstanding integration

The canonical package owner must provide its actual portable mapping and manifest
extension API. The current `IAssetStore` exposes deletion only; the committed
upload observation now supplies verified upload bytes and asset/reference facts,
but no intended AssetId operation/plan binding, Vault rights, revision or explicit
reuse receipt. It also lacks a method to persist an asset stage under the exact
plan/item/AssetId and replay it without initializing a new upload. Those APIs,
and the canonical stable snapshot/path capability, are required before pull,
upload, local materialization, recovery obligations and ledger receipts can be
implemented. No replacement port, direct database/storage writer or production
mock is introduced here.

Actual native root APIs now include root-issued enumeration and
`OpenMutationBoundary`/`CreateTemporarySource` from
`5e7fd98bdefc8cbd5c0a405accc383da917dfa3a`. Their admission is limited to registered
article source projections; the dependency asset node has no canonical portable
asset path. The native boundary explicitly cannot execute final replacement or
commit a base. It must not be used to write an asset through an article path.
The accepted-source adapter reads an exact accepted article revision and rechecks
permissions, but supplies neither an asset read grant nor an asset projection.

Required owner methods remain: the #1779/#2258 plan/item-bound upload initializer
and exact immutable asset-stage read/replay; #1779 authorized AssetId byte/ledger
read; #1865 portable AssetId projection; and #1910/#2128 asset-specific conditional
materialization/readback/recovery and verified receipt/base commit. These are
capability requests, not alternative production interfaces declared here.

## Original asset supplier binding

The exact root supplier table at
[`42ece11c821dd01e9f372b66e7822f0fd0fc3864`](https://github.com/Ozwasyd/FsusBlog/blob/42ece11c821dd01e9f372b66e7822f0fd0fc3864/artifacts/article-vault/chain-3582-current-source-handoff/supplier-input-requirements.md)
confirms existing private reads, access tickets, media inspection and ledgers.
Their current arguments/returns are:

| Existing method | Actual arguments | Actual return |
| --- | --- | --- |
| `IPrivateAssetAccessService.IssueTicketAsync` | `AssetId`, registered `PrivateAssetAccessPurpose`, `ClaimsPrincipal`, cancellation | Ticket and expiry, or refusal |
| Internal `IPrivateAssetTicketRedemptionService.RedeemAsync` | Original ticket, same principal, cancellation | Reauthorized metadata handle, or refusal |
| `IPrivateAssetStore.OpenReadAsync` | `AssetId`, cancellation | AssetId/storage key/media type/extension/size/digest/content stream, or missing |
| Original `IPrivateAssetMetadataSource.FindAsync` | `AssetId`, cancellation | Original `AssetRecord`, including dimensions, owner and active state |
| `IFileService.ObserveCommittedUploadAsync` | `UploadSessionAccess`, expected content digest, cancellation | Original asset, asset version digest, reference list and ledger digest, or original failure |

The existing Kestrel private response writer pairs authorized metadata with the
opened handle before streaming. Ticket redemption rechecks its subject and sole
registered purpose policy. No policy registration or new purpose is introduced
by the Vault adapter. Raw `OpenReadAsync` is not a Vault grant. A display URL is
not an asset lookup key, source revision or authorization result.

The supplier must supply its actual operation-bound method/source, retaining
those original APIs, with the following exact context and result bindings:

| Required binding | Source/caller | Missing supplier result |
| --- | --- | --- |
| Trusted site/Vault/device/agent, exact plan reference/SHA, global operation identity/deadline, group/item/article identity | Original sealed bundle and operation; selected dependency item | Genuine receipt bound to these values, not a caller-hashed declaration |
| Selected article source side/digest and exact server article/revision | Current original plan item and raw-source/dependency input | Authorized read/upload/reference result bound to the selected source revision; record timestamps cannot substitute |
| AssetId/content digest/MIME/extension/size/dimensions/owner | Selected `VaultAssetDependency`, original record/bytes | Owner-issued current asset observation and authorized bytes; same content must retain independent owners |
| Required/granted rights and permission/rights/authority digests | Fresh original current dependency authority | Genuine current rights/read grant; a ticket's purpose or plain private handle cannot supply missing Vault rights |
| Asset server revision/version, reference list/ledger digest and explicit reuse decision | Original asset/reference ledger and upload owner | Exact original read/reuse/upload receipt; `AssetRecord` and private handles have no server revision or reference ledger fields |
| Intended AssetId and retry identity bound to plan/global operation/item/content | Canonical upload initializer/store owner | Idempotent original initialization/replay result, preserving original committed uploads and reference ownership |
| Accepted article result/item and resulting asset reference facts | Original accepted result plus asset/reference ledger owner | Expected accepted reference result distinguishable from later drift, before recovery/materialization |

Root can call `ArticleVaultAssetInputVerifier.VerifyCurrent` after loading the
exact bundle and after the genuine supplier acquires record/bytes/current inputs.
The already implemented push call site is
`ArticleVaultAssetStagingAdapter.PrepareCommittedUploadAsync`; its original
upload observation is checked against this scope. Candidate/writer admission
remains the original root's call site; a passing input check cannot bypass its
current `RequireExecutionAdmission` refusal. No substitute read/upload interface
or receipt schema is declared to stand in for the original supplier's result.

The original integration owner registers the schema resource, documentation,
test matrix, coverage and lifecycle entry. The adapter
[static boundary check](../../tools/governance/check-article-vault-dependency-boundary.mjs)
rejects direct network/filesystem/database, rendered scanning, persistent second
indexes and string target identity tokens in these modules. Static checks and
focused algorithm tests do not establish package or native end-to-end acceptance.

Rollback consists of removing the unused dependency extension and validation
modules before wiring any consumer. Once integrated, coordinate/schema drift must
block admission and require an explicit new plan rather than a fallback writer.
