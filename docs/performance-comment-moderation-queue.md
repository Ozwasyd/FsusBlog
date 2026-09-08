# Comment moderation-queue query plan and benchmark evidence

> 2026-07-20; issue #1202. Data was written only to a local temporary PostgreSQL 18 Alpine container, never to a development or production database.

## Reproduction

Script: `tools/performance/comment-moderation-queue-benchmark.sql`.

```bash
psql -v scale=100000 -f tools/performance/comment-moderation-queue-benchmark.sql
psql -v scale=1000000 -f tools/performance/comment-moderation-queue-benchmark.sql
```

Each scale creates a new `UNLOGGED` table with 1% Pending, 0.4% borderline Hidden, 0.1% open report, and 0.01% pending appeal; `jit=off`, `work_mem=64MB`, and parallel gather disabled. Latency samples are 100 complete first-page keyset queries on one connection, followed by a separate `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)`. Results are a hot-cache local engineering gate, not a production SLA.

## Results

| Comment rows | p50 | p95 | p99 | Mean | EXPLAIN execution | Candidate input rows | Shared hit blocks |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100,000 | 2.300 ms | 3.977 ms | 14.669 ms | 2.785 ms | 3.532 ms | 166 | 364 |
| 1,000,000 | 17.933 ms | 25.366 ms | 28.217 ms | 18.339 ms | 15.846 ms | 1,156 | 4,442 |

`Candidate input rows` is the planned active-report + pending-appeal + pending/borderline partial-index window: `100 + 10 + 56` at 100k and `1000 + 100 + 56` at 1m. The plan otherwise performs only point lookups by comment PK, report-comment index, and appeal-comment index: no full comment-table scan, `OFFSET`, or temp block. It merges the final top-N from three priority branches, each using `LIMIT 51`.

The first candidate left-joined report/appeal to the full comment table before applying its OR filter. At 100k it measured p50/p95/p99 of `39.612/55.880/76.849 ms` with nearly 100k candidate rows, so it was rejected. Three bounded appeal/report/ordinary branches reduced p50 to 2.300 ms and candidate input to 166 rows on the same data.

## Index benefit and cost

At 100k/1m rows, pending/borderline partial indexes were 56 KiB/384 KiB; pending-appeal partial indexes were 16 KiB at both scales. They cover only comments or pending appeals entering the human queue and add no entries for Approved ordinary comments. Claim lease/owner indexes live in a separate small table, so renewal does not update the large `comment` table or public-read indexes.

After deployment, observe `pg_stat_user_indexes.idx_scan`, `pg_relation_size`, `n_dead_tup`, `n_tup_upd`, autovacuum time, and the claim-table HOT-update ratio. If index growth or write amplification exceeds the benefit, stop new claims, let leases expire, then use rollback SQL `DROP INDEX CONCURRENTLY`; retain the claim table through the N-1 compatibility window.

## Other query shapes

Plans for public roots, arbitrary direct children, the 1,001-level ancestor path, and the permalink sibling window at 1m rows are in [performance-comment-tree.md](performance-comment-tree.md). Tree evidence does not replace queue evidence; the queue p50/p95/p99 and candidate-input rows above come from the independent #1202 script.
