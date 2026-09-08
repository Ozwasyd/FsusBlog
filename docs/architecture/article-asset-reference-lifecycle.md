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

`ArticleAssetCleanupWorker` claims due AssetIds with `FOR UPDATE SKIP LOCKED` and delegates deletion to `IAssetStore.DeleteAsync(AssetId)`. The asset store rechecks `content_asset_reference`; a live reference returns `Referenced` and cancels the queue row. Missing physical files are an idempotent success. Failures retain the row with an incremented attempt count and a delayed retry.

No object store, CDN or remote image API participates in this protocol.

## Operational rollback and degradation

To stop physical cleanup without restarting the application, move queue deadlines forward in PostgreSQL using the [canonical cleanup-pause runbook](article-deletion-lifecycle.md#file-cleanup-and-operational-degradation). This leaves authoring and deletion available while retaining files. Do not delete ledger rows to pause cleanup. An application rollback must preserve `content_asset`, `content_asset_reference`, and `content_asset_cleanup_queue` because they remain the metadata, reference, and cleanup authorities.

```sql
UPDATE article_asset_cleanup_queue
SET not_before_utc = (now() AT TIME ZONE 'utc') + interval '7 days',
    updated_at_utc = now() AT TIME ZONE 'utc';
```
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
