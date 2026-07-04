# Rights V3 Cutover Runbook

This runbook is the production cutover order for the no-compat Rights V3 public artifact model. ArticleDetail AEDS V3 embeds the frozen rights snapshot and proof pointer, PublicAOT renders from the same payload, and there is no separate public rights endpoint. Legacy public article artifacts must be cleared and rebuilt before traffic is trusted on the new build.

## Preconditions

- The release image contains the Rights V3 schema migration, ArticleWriteRequest V3 write path, ArticleDetail AEDS V3 reader/projector, rights proof worker, and PublicAOT rights hydration.
- Operators have database backup access, runtime artifact volume access, and an admin principal allowed to call `/api/binary/author/cache/actions`.
- The previous production image tag and database restore target are recorded before starting.

## Cutover Order

Run these steps in order. Do not switch public traffic to the candidate until the verification step passes.

1. backup database with the normal production database backup command, for example `pg_dump` or the managed PostgreSQL snapshot workflow. Keep the restore target outside the application container.
2. backup runtime artifacts, including ArticleDetail `.aeds` storage, PublicHotRead snapshots, `wwwroot/aot-cache`, search artifacts, feed/sitemap output, and any release evidence needed to compare old and new public outputs.
3. apply DB migration by deploying the candidate image and letting startup run the Rights V3 migration. The migration creates the rights policy, rights snapshot, and rights proof tables, but it does not rewrite public artifacts in place.
4. Run `recompute-article-rights` through the admin cache action endpoint. This replaces migration sentinel hashes, recomputes latest-revision rights hashes, and fills any missing latest public rights snapshot.
5. Run `clear-legacy-public-artifacts`. This removes legacy ArticleDetail artifacts that do not contain the V3 `ARD3` payload header. Legacy public article artifacts must be cleared and rebuilt; leaving them on disk would let anonymous reads serve payloads that the strict V3 frontend must reject.
6. Run `rebuild-article-detail-aeds-v3` with no `articleId` to rebuild all public ArticleDetail AEDS V3 artifacts. Use the optional `articleId` only for a targeted repair after the global pass has already completed.
7. rebuild PublicAOT output after ArticleDetail AEDS V3 is clean. Use the existing `aot-rebuild` cache action or the current PublicAOT rebuild job so HTML, metadata, and hydration rights are generated from the rebuilt V3 detail payloads.
8. run verification tests:

```bash
./tools/test.sh ci-tier rights-v3-test-matrix --no-deps
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter FullyQualifiedName~RightsV3DocumentationContractTests -v minimal
```

## Operator Checks

Use these checks before traffic switch and during the first production observation window.

- missing rights snapshot: inspect the article revision and `article_rights_snapshot` row. Run `recompute-article-rights`, then rebuild that article with `rebuild-article-detail-aeds-v3` if the snapshot was missing or used a sentinel hash.
- failed rights proof: check the article rights proof status and related publish proof. A rights proof can be ready only after the article is public, the content canonical hash is ready, the rights snapshot exists, and the publish proof is ready or superseded.
- stale ArticleDetail artifact: clear the affected legacy artifact with `clear-legacy-public-artifacts` or remove the specific artifact file, then rerun `rebuild-article-detail-aeds-v3`. Do not serve a legacy ArticleDetail payload as a fallback.
- hydration mismatch: compare PublicAOT rendered rights metadata with the decoded ArticleDetail AEDS V3 rights payload. Rebuild ArticleDetail first, then rebuild PublicAOT output so HTML and hydration converge on the same snapshot.
- no separate public rights endpoint: confirm public readers use the embedded `ArticleDetail.rights` / `detailView.rights` payload and integrity sidecar only. Do not add `/rights`, `/rights.aeds`, or `/article/{id}/rights.aeds` as a runtime fallback.

## Rollback

Rollback is image and backup based. Restore the previous image and the backed-up database/runtime artifact set together. Do not roll back by accepting legacy ArticleDetail frames, by repopulating old `.aeds` files after the V3 frontend is live, or by adding a separate public rights endpoint.
