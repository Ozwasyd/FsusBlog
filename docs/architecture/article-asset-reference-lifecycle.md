# Article asset reference lifecycle

Article illustration files are durable content, not disposable side effects of one article row. The deletion boundary is therefore the PostgreSQL reference ledger, not Markdown extraction performed after a transaction commits.

## Authoritative sources

`content_asset_reference` is the only persistent reference authority. Its composite identity is
`asset_id + source_kind + source_key`, where `asset_id` points to `content_asset.id` and the source is:

- `article`: the current `article` + `article_body` projection;
- `draft`: one server draft identified by admin principal and draft key;
- `revision`: one immutable `article_revision` row.

Every article create/update/rollback, revision append, and server-draft save/discard replaces or removes its source rows in the same transaction as the business mutation. A failed transaction therefore commits neither side. Historical revisions remain referenced for exactly as long as their revision source is retained; revision removal must remove that source in the same transaction.

The ledger stores deterministic `reference_count`, normalized `alt_text`, and the owning `article_id`. Replacing a source first takes a source-identity advisory lock, loads existing edges in one query, then takes all affected AssetId locks in stable order and performs batch delete/insert operations. Concurrent replacement of the same source is serialized, and the command count does not grow per referenced asset.

## Public URL boundary

Markdown and public URLs are presentation input, not ledger identity. `ArticleAssetReferenceWriteBoundary` extracts illustration references and uses `PublicAssetUrlCodec` to obtain `AssetStorageKey`; one `content_asset` lookup resolves those keys to AssetIds. Only typed AssetId writes enter `ArticleAssetReferenceStore`.

The store does not accept a URL, path, Markdown body, or storage key. It never scans Markdown, reads or writes a second reference table, or maintains an independent reference-count cache. Public URL rendering happens in `PublicAssetUrlCodec` only when a presentation response needs it.

## Delete and cleanup protocol

Permanent article deletion and trash clearing load affected AssetIds from `content_asset_reference` and remove the applicable current article/draft sources inside the article transaction. An AssetId is inserted into `content_asset_cleanup_queue` only when the ledger has no remaining row, with a 24-hour grace period. Restoring any source reference cancels that queue row and returns the asset to `active`.

`ArticleAssetCleanupWorker` claims due AssetIds with `FOR UPDATE SKIP LOCKED` and delegates deletion to `IAssetStore.DeleteAsync(AssetId)`. The asset store rechecks `content_asset_reference` under the AssetId advisory lock. A live reference returns `Referenced` with a source count and up to 16 locations ordered by source kind and source key; locations contain source identity, article ID and reference count, never a URL or storage path.

Before deleting bytes, the store commits `pending_delete` and the `content_asset_delete_pending` cleanup marker. Reference restoration rejects this marker: the ordinary grace-period cancellation applies only before physical deletion begins. After byte deletion, a second transaction takes the same AssetId lock, checks references and removes metadata and the queue row. Missing physical files are an idempotent success. A failed metadata transaction leaves the deletion marker available for retry rather than restoring an active asset without bytes. Cleanup failure bookkeeping and cancellation of an earlier `Referenced` result must preserve a newer deletion marker.

No object store, CDN or remote image API participates in this protocol.

## Operational rollback and degradation

To stop physical cleanup without restarting the application, move queue deadlines forward in PostgreSQL using the [canonical cleanup-pause runbook](article-deletion-lifecycle.md#file-cleanup-and-operational-degradation). This leaves authoring and deletion available while retaining files. Do not delete ledger rows to pause cleanup. An application rollback must preserve `content_asset`, `content_asset_reference`, and `content_asset_cleanup_queue` because they remain the metadata, reference, and cleanup authorities.

```sql
UPDATE content_asset_cleanup_queue
SET not_before_utc = (now() AT TIME ZONE 'utc') + interval '7 days',
    updated_at_utc = now() AT TIME ZONE 'utc';
```
This postpones future claims; it does not cancel a deletion already in progress. Do not clear deletion markers to pause cleanup. Do not roll back to an implementation that restores references without checking deletion markers while marked rows remain; first finish their cleanup using the marker-aware implementation.

## Current rights fields

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.rights-fields
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.rights-fields
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.article.rights-fields -->
- `copyPolicy`
- `enabled`
- `licenseType`
- `rightsSnapshotId`
<!-- FSUSBLOG-GENERATED:END content.article.rights-fields -->

## Completed-upload observation and bounded preview

The ordinary upload service exposes `ObserveCommittedUploadAsync` and
`ReadCommittedUploadPreviewAsync` through `IFileService`. Both use the original
upload-session access: authenticated admin owner, original upload token, unexpired
completed session and expected SHA-256. Under the existing AssetId advisory lock,
the service reads the current active asset and sole reference ledger, validates
the original native regular-file identity, exact bytes/hash/media/dimensions and
returns the same observation. It never resolves identity from a display URL or
creates an article, Vault, reference-operation or cleanup grant.

The existing ArticleWrite/PoW upload group registers
`POST /api/binary/upload/{uploadId}/preview`. It consumes the original
`UploadCompleteRequest` frame and its 64-byte SHA payload, retains private/no-store
responses and uses the existing `UploadAssetPreview` frame 275 and strict POD
codec. Preview refuses before opening/allocating oversized image bytes: the
760-byte POD plus 16-byte AEDS header and complete bytes must fit the existing
8 MiB frame limit. It returns no truncated or converted preview. The ordinary
`UploadAssetPreviewViewModel` declaration reflects those actual shared fields;
the existing caller's token/hash/bytes validation remains unchanged.

This source restoration does not update canonical OpenAPI, endpoint manifests,
generated route constants, frame rosters or qualification evidence. The generated
preview operation projection remains absent until the original API/protocol owner
uses the existing observed-endpoint workflow. Current facts have only the real
service observation; a facts wire endpoint requires its canonical DTO/POD/codec,
allocated frame and operation projection. Historical facts frame 285 is not a
current allocation and preview frame 275 cannot substitute for it. Runtime,
security/native/backup-restore qualification and business receiver acceptance
remain separate gates.
