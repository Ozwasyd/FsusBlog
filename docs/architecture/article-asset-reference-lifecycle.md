# Article asset reference lifecycle

Article illustration files are durable content, not disposable side effects of one article row. The deletion boundary is therefore the PostgreSQL reference ledger, not Markdown extraction performed after a transaction commits.

## Authoritative sources

`article_asset_reference` stores one row per canonical asset URL and logical source:

- `article`: the current `article` + `article_body` projection;
- `draft`: one server draft identified by admin principal and draft key;
- `revision`: one immutable `article_revision` row.

Every create, update, rollback and server-draft save replaces its source rows in the same transaction as the source write. The startup cleanup worker performs an advisory-lock protected rebuild from all three source tables so pre-migration content is covered before queued deletion runs.

Historical revisions currently have no automatic retention expiry. Their asset references therefore remain live for exactly as long as the revision rows remain live. A future revision-retention job must delete the revision and its `revision` ledger source in one transaction; deleting either side independently is forbidden.

## Canonical URL identity

`ArticleAssetUrlNormalizer` is the only application normalization rule used by authoring reindex, the deletion ledger and local file deletion. It:

- accepts only `/uploads/illustration/` URLs with the supported image extensions;
- trims query and fragment suffixes, decodes URL escaping, converts backslashes, collapses duplicate separators and lowercases the canonical identity;
- rejects absolute/external URLs, traversal segments, NULs and non-illustration paths.

The resulting canonical URL is the leading component of the ledger and cleanup-queue primary keys. Writers and cleanup consumers acquire the same ordered PostgreSQL advisory locks for that identity.

## Delete and cleanup protocol

Permanent article deletion and trash clearing first reconcile candidate URLs against current articles, drafts and revisions. Inside the article transaction they then remove only the deleted current-article sources. A URL is inserted into `article_asset_cleanup_queue` only when the ledger has no remaining row, with a 24-hour grace period.

`ArticleAssetCleanupWorker` is multi-consumer safe. It claims due rows with `FOR UPDATE SKIP LOCKED`, acquires the ledger and URL advisory locks, rebuilds that URL from all authoritative source tables, and checks the count again. A live reference cancels the queue row. A zero count permits an idempotent local-file delete; missing files count as completed cleanup. Failures retain the row with an incremented attempt count and a delayed retry.

No object store, CDN or remote image API participates in this protocol.

## Operational rollback and degradation

To stop physical cleanup without restarting the application, move queue deadlines forward in PostgreSQL:

```sql
UPDATE article_asset_cleanup_queue
SET not_before_utc = (now() AT TIME ZONE 'utc') + interval '7 days',
    updated_at_utc = now() AT TIME ZONE 'utc';
```

This leaves authoring and deletion available while retaining files. Do not delete ledger rows to pause cleanup. Application rollback must preserve both new tables; old binaries ignore them, while returning to the new binary rebuilds the ledger before consuming queued work.
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
