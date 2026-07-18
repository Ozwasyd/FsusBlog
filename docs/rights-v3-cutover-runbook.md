# Rights V3 Cutover Runbook

> Current protocol note: this is a historical Rights V3 cutover runbook. Current ArticleDetail writers emit `ARD4`/version 4 with the same Rights V3 record, and readers retain `ARD3`/version 3 compatibility.

This runbook is the production cutover order for the no-compat Rights V3 public artifact model. ArticleDetail AEDS V3 embeds the frozen rights snapshot and proof pointer, PublicAOT renders from the same payload, and there is no separate public rights endpoint. Legacy public article artifacts must be cleared and rebuilt before traffic is trusted on the new build.

## Preconditions

- The release image contains the Rights V3 schema migration, ArticleWriteRequest V3 write path, ArticleDetail AEDS V3 reader/projector, rights proof worker, and PublicAOT rights hydration.
- Operators have database backup access, runtime artifact volume access, and an admin principal allowed to call `/api/binary/author/cache/actions`.
- The previous production image tag and database restore target are recorded before starting.

## Cutover Order

Run these steps in order. Do not switch public traffic to the candidate until the verification step passes.

1. backup database with the normal production database backup command, for example `pg_dump` or the managed PostgreSQL snapshot workflow. Keep the restore target outside the application container.
2. backup runtime artifacts, including ArticleDetail `.aeds` storage, PublicHotRead snapshots, `wwwroot/aot-cache`, search artifacts, feed/sitemap output, and any release evidence needed to compare old and new public outputs.
3. apply DB migration by deploying the candidate image and letting startup run the Rights V3 migration. SchemaMigrationRunner clears legacy public artifacts that do not contain the V3 `ARD3` payload header; legacy public article artifacts must be cleared by SchemaMigrationRunner before the rebuild step.
4. Run `recompute-article-rights` through the admin cache action endpoint. This replaces migration sentinel hashes, recomputes latest-revision rights hashes, and fills any missing latest public rights snapshot.
5. Run `rebuild-article-detail-aeds-v3` with no `articleId` to rebuild all public ArticleDetail AEDS V3 artifacts. Use the optional `articleId` only for a targeted repair after the global pass has already completed.

    > Historical note: the maintenance action name is retained for rollout compatibility. Current execution writes `ARD4`/version 4 ArticleDetail records while preserving the Rights V3 record; readers continue to accept the historical `ARD3` output.
6. rebuild PublicAOT output after ArticleDetail AEDS V3 is clean. Use the existing `aot-rebuild` cache action or the current PublicAOT rebuild job so HTML, metadata, and hydration rights are generated from the rebuilt V3 detail payloads.
7. run verification tests:

```bash
./tools/test.sh ci-tier rights-v3-test-matrix --no-deps
```

## Operator Checks

Use these checks before traffic switch and during the first production observation window.

- missing rights snapshot: inspect the article revision and `article_rights_snapshot` row. Run `recompute-article-rights`, then rebuild that article with `rebuild-article-detail-aeds-v3` if the snapshot was missing or used a sentinel hash.
- failed rights proof: check the article rights proof status and related publish proof. A rights proof can be ready only after the article is public, the content canonical hash is ready, the rights snapshot exists, and the publish proof is ready or superseded.
- stale ArticleDetail artifact: confirm the `20260709-post-clear-legacy-public-artifacts` migration ran, remove the specific artifact file only for targeted repair, then rerun `rebuild-article-detail-aeds-v3`. Do not serve a legacy ArticleDetail payload as a fallback.
- hydration mismatch: compare PublicAOT rendered rights metadata with the decoded ArticleDetail AEDS V3 rights payload. Rebuild ArticleDetail first, then rebuild PublicAOT output so HTML and hydration converge on the same snapshot.
- no separate public rights endpoint: confirm public readers use the embedded `ArticleDetail.rights` / `detailView.rights` payload and integrity sidecar only. Do not add `/rights`, `/rights.aeds`, or `/article/{id}/rights.aeds` as a runtime fallback.

## Rollback

Rollback is image and backup based. Restore the previous image and the backed-up database/runtime artifact set together. Do not roll back by accepting legacy ArticleDetail frames, by repopulating old `.aeds` files after the V3 frontend is live, or by adding a separate public rights endpoint.
