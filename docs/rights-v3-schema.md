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

## Migration

`20260704-post-article-rights-v3-schema` creates the three tables and indexes after CodeFirst has synchronized the article and revision tables. It then backfills existing content in set-based SQL:

1. Every existing row in `article` receives a default `article_rights_policy` row if one does not already exist.
2. Each article with at least one `article_revision` receives one `article_rights_snapshot` for the latest revision, chosen by highest `revision_no`, then newest `created_at`, then highest `id`.
3. Articles without a revision receive only the policy row; the first future revision/publish path is responsible for creating the first snapshot.

The migration is idempotent. A second startup must not duplicate policy rows, snapshot rows, or proof rows.

## Artifact Boundary

The migration does not create a legacy `rights.aeds` endpoint and does not mutate existing PublicAOT, article detail AEDS, PublicHotRead, feed, sitemap, or search artifacts in place. Those outputs remain derived read models. After enabling Rights V3 payloads, rebuild or invalidate the affected public artifacts through the normal article mutation/public-hot/AOT paths so cached anonymous reads converge to the new frame shape.

If Rights V3 proof generation needs to be paused without restarting the site, keep public reads on existing artifacts and stop scheduling/retrying the rights proof edge. Do not remove the schema or recreate a separate rights endpoint as a rollback path. Database rollback remains backup based.
