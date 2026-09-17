# Comment-tree query plan and benchmark evidence

> 2026-07-19; issue #1201. This evidence uses only a local temporary PostgreSQL 16 container and never connects to production.

## Conclusion

The comment tree continues to use the existing adjacency list (`parent_id`, `root_id`, `depth`) and a PostgreSQL recursive CTE. Path reads walk back by primary key; roots, direct children, and sibling windows use the existing `(article_id, parent_id, id)` index. No closure table, materialized-path column, or write-amplifying index was added for #1201.

`childCount` is computed in batch. The initial per-node correlated subquery caused 101 full-table scans on 1,001,001 rows and took about 12.9 seconds. The implementation now first takes the current cursor window, then aggregates by `parent_id` over the same `visible_chain`, prohibiting N+1 counts.

## Reproducible dataset

Script: `tools/performance/comment-tree-benchmark.sql`.

- PostgreSQL 16 Alpine with a locally cached image; `jit=off`, `work_mem=64MB`.
- Wide tree: 5,000 roots with 199 direct children each, 1,000,000 rows total.
- Deep tree: a separate article with a 1,001-level chain for the worst recursive-path shape.
- Two existing index equivalents: `(article_id, parent_id, id)` and `(article_id, root_id, id)`.
- Each query uses `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)`; the table is dropped at script end.

## Measurements

| Query | Returned rows | Execution Time | Main plan | Temp blocks |
| --- | ---: | ---: | --- | ---: |
| Root-comment keyset cursor | 51 | 2.520 ms | `idx_comment_tree_article_parent_id` Index Scan + top-N | 0 |
| Direct-child cursor + batched child count | 101 | 1.171 ms | parent-index page + batched count join | 0 |
| 1,001-level ancestor path | 1,001 | 3.271 ms | Recursive Union + primary-key Index Scan | 0 |
| Permalink sibling window | 11 | 0.144 ms | parent-index forward/backward scans + Merge Append | 0 |

These are single, hot-cache query-plan measurements on a development machine; they do not replace the #1202 production-equivalent p50/p95/p99 gate. The #1201 gate checks plan shape: no cursor `OFFSET`, no per-node count, a primary-key lookup at every ancestor level, and a parent keyset index for sibling windows.

## Risk and rollback

- Reloadable `CommentThreads:RecursiveReadsEnabled=false` immediately disables recursive root/child/permalink reads and returns a uniform AEDS `ApiError` 503; no restart is required.
- `CommentThreads:MaxDepth` defaults to 32 and ranges from 2–256; `CommentThreads:MaxChildrenPerNode` defaults to 500 and ranges from 1–10,000. Lowering either limits only new writes and does not break existing ancestor chains.
- Each parent's direct-reply quota is checked serially inside a transaction using a PostgreSQL advisory transaction lock; deletion, hiding, or rejection does not return a slot, preventing concurrent bypass.
- The permalink recursive CTE records visited IDs, rejects cycles, and stops at 257 nodes; the server then checks root/parent/depth continuity and degrades a corrupt chain to `unavailable`.
- The former thread-wide flat-reply endpoint remains temporarily for rolling-release compatibility, but the new frontend does not call it; public article bodies remain available when recursive reads are disabled.
