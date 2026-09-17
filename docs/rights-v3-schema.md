# Rights V3 Schema

Rights V3 stores per-article rights policy, per-revision rights snapshots, and proof pipeline state in PostgreSQL. The schema is durable write-model state; public article reads still come from the artifact-backed AEDS/PublicAOT read model.

## Tables

`article_rights_policy` has one row per `article.id`. It stores the current editable policy defaults:

- `license_type`: default `all-rights-reserved`.
- `copy_policy`: default `append-attribution`.
- `max_excerpt_chars`: default `300`.
- `allow_code_copy`, `show_public_badge`, `proof_binding_enabled`: default `true`.
- `ux_article_rights_policy_article` enforces one active policy row per article.

`article_rights_snapshot` freezes the policy values used for a specific article revision. The unique key `ux_article_rights_snapshot_article_revision` enforces one snapshot per `(article_id, article_revision_id)`. `policy_hash` and `content_canonical_hash` start as sentinel values during migration and are recomputed by the later canonicalizer/proof pipeline:

- `rights-v3:policy-hash:recompute`
- `rights-v3:content-hash:recompute`

`article_rights_proof` stores Rights V3 proof creation state. `ux_article_rights_proof_idempotency` makes proof retries safe by idempotency key, and the revision/snapshot/status indexes support retry and operations views.

## Write Path

New article creates and updates normalize the request `rights` payload before writing. When the client omits rights, the write path uses the same defaults as the migration: `enabled=true`, `license_type=all-rights-reserved`, `copy_policy=append-attribution`, `max_excerpt_chars=300`, and `allow_code_copy` / `show_public_badge` / `proof_binding_enabled=true`. The service writes the article row/body/tags, the new `article_revision`, the current `article_rights_policy`, the immutable `article_rights_snapshot`, and the article mutation outbox event in one database transaction. The outbox payload includes `rightsSnapshotId` so projectors can rebuild public artifacts from the frozen snapshot instead of querying mutable policy state.

## Migration

`20260704-post-article-rights-v3-schema` creates the three tables and indexes after CodeFirst has synchronized the article and revision tables. It then backfills existing content in set-based SQL:

1. Every existing row in `article` receives a default `article_rights_policy` row if one does not already exist.
2. Each article with at least one `article_revision` receives one `article_rights_snapshot` for the latest revision, chosen by highest `revision_no`, then newest `created_at`, then highest `id`.
3. Articles without a revision receive only the policy row; the first future revision/publish path is responsible for creating the first snapshot.

The migration is idempotent. A second startup must not duplicate policy rows, snapshot rows, or proof rows. Existing articles inherit the default policy because no historical editor-side rights intent existed before Rights V3; the first post-migration edit can replace that editable policy and creates a fresh snapshot bound to the new revision.

## Artifact Boundary

The migration does not create a legacy `rights.aeds` endpoint and does not mutate PublicAOT, PublicHotRead, feed, sitemap, or search artifacts in place. ArticleDetail AEDS legacy files are cleared by the one-time `20260709-post-clear-legacy-public-artifacts` SchemaMigrationRunner step. After enabling Rights V3 payloads, run the public artifact cutover from `docs/operations.md`: migrate DB, `recompute-article-rights`, `rebuild-article-detail-aeds-v3`, then rebuild PublicAOT.

At the original Rights V3 cutover, ArticleDetail artifacts used `ARD3`/version 3. Current writers subsequently moved to `ARD4`/version 4 to carry `updatedAt`, while readers retain ARD3 read compatibility; both versions still require the same `ArticleRightsV3RecordPod`. Missing rights snapshots are not encoded as empty/default rights; the projector records the missing-rights state, removes any stale detail artifact for that article, and waits for the rights recompute/rebuild path to repair the derived read model.

If Rights V3 proof generation needs to be paused without restarting the site, keep public reads on existing artifacts and stop scheduling/retrying the rights proof edge. Do not remove the schema or recreate a separate rights endpoint as a rollback path. Database rollback remains backup based.
