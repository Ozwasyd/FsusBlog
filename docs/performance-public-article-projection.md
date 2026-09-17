# Public article projection

## Goal and boundary

A public article-detail DB miss collapses the article/category/body/tags/latest-rights/latest-proof lateral/aggregate query into one primary-key read from `public_article_projection.article_id`. SqlSugar remains responsible for the write model, admin/private reads, and projector source query; direct Npgsql serves only the measured public binary-detail miss and does not replace the site-wide ORM.

Request order is fixed: PublicHotRead/L0 snapshot → article-detail file artifact → prepared DB projection → legacy source fallback. The first three layers return the same AEDS v2 `ArticleDetail` frame; a projection miss/corruption queues repair, and only the legacy fallback constructs a read model. Reloadable `Database:PublicArticleProjection:Enabled=false` skips the DB projection without restart; the outbox projector continues, so re-enabling needs no traffic cutover.

## Consistency

`article-detail-aeds` is a required `ArticleMutationReplayEdges.Required` edge. The projector orders DB projection upsert, old-source/new-frame shadow comparison, and file-artifact replacement. Content hashes make DB-row replay idempotent; non-public or missing articles retain a `visible=false` negative row. ArticleService's transactional outbox covers create/update/status/revision/tag assignment/rights snapshot; scheduled publish writes a batch outbox in its claim transaction; category/tag rename writes one transactional outbox entry for every affected article; rights-proof upsert and `rights-proof-updated` outbox are transactional. A critical-edge failure remains a failed edge for dispatcher backoff retry and cannot mark the event processed.

Shadow comparison builds the expected frame from the legacy projector source, rereads the new projection, and compares byte-for-byte. A mismatch writes expected/actual hash, version, reason, and observed time to `public_article_projection_shadow_mismatch` and fails the required edge. Retain the legacy source query until production evidence is sealed; do not move complex computation into a read-time database function.

## Pool and gates

The public reader uses an independent `NpgsqlDataSource`. `MaxPoolSize` defaults to one quarter of the main connection string's `Maximum Pool Size` and may be overridden by `Database:PublicArticleProjection:MaxPoolSize`; it is clamped to main-pool capacity, so unlimited connections cannot hide DB saturation. `MinPoolSize`, command timeout, and the four gate limit/queue/wait timeouts are likewise configurable. `runtime.dbGateClasses` and `runtime.publicArticleProjection` expose active/waiting/timeout/broken-connection/pool-wait p99/query p99.

The four gates are `public-short-read`, `admin-heavy-read`, `foreground-write`, and `background-projection-rebuild`. Backfill's initial `rate_per_second` derives from PostgreSQL `max_connections`; runtime parallelism is the minimum of background-gate limit, durable rate, and current batch size, and batch size derives from background-gate capacity. It does not read `Environment.ProcessorCount`, so DB/pool evidence—not application thread count—sets throughput.

## Online migration, backfill, and rollback

Expand migration `20260714-post-public-article-projection` creates the projection/version sequence, partial-PK plan index, durable backfill state, and mismatch evidence. Readers do no DDL. Author cache actions are:

- `public-article-projection-backfill-status`: read the durable watermark, rate, and success/failure counts;
- `public-article-projection-backfill-pause`: pause after the current batch;
- `public-article-projection-backfill-resume`: resume from the last article ID at the current rate;
- `rebuild-article-detail-aeds-v3`: repair one article or explicitly rebuild all.

For rollback, set reloadable `Database:PublicArticleProjection:Enabled` to `false`, then observe projection reads reach zero, legacy fallback/error rate, and all four gates. No restart, table drop, or outbox purge is required. Before re-enabling, verify `mismatch=0`, backfill completed, and `projection invalid=0`. Delete the old hot query only after production/release-final evidence is sealed and the rollback window ends.

## Evidence

Database-plan template:

```bash
docker exec -i fsusblog-dev-postgres psql -U fsusblog -d fsusblog \
  -v article_id=1 -f - < tools/perf/public-article-projection-plan.sql
```

Save legacy and projection `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)` together, including actual rows, shared hit/read blocks, WAL, and planning/execution time. The after plan must be a one-row PK/partial-index read from `public_article_projection`, with no join/aggregate/sort. Also run `./tools/test.sh ci-tier backend-qps-article-detail-miss`, `backend-qps-index-plan`, and the data-scale tier; retain DB-miss p99, allocations, rows/blocks, and pool wait. Local numbers are release evidence, not cross-machine constants.

Acceptance also covers anonymous public-binary hit/miss, logged-in reads of the same public frame, admin/private legacy reads, unaffected notification stream, replay of every mutation kind, outbox crash/retry, negative/visibility boundaries, four-gate saturation/isolation, pause/resume/rollback, and final production/release-final evidence.
