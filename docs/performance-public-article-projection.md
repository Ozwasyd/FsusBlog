# Public article projection

## 目标与边界

公共 article detail 的 DB miss 从 article/category/body/tags/latest rights/latest proof 的 lateral/aggregate 查询，收敛为 `public_article_projection.article_id` 的单主键读取。SqlSugar 仍负责 write model、admin/private read 和 projector source query；直接 Npgsql 只服务已测量的公开 binary detail miss，不替换全站 ORM。

请求顺序固定为：PublicHotRead/L0 snapshot → article detail file artifact → prepared DB projection → legacy source fallback。前三层返回同一个 AEDS v2 `ArticleDetail` frame；projection miss/corrupt 会排队 repair，只有 legacy fallback 会构造 read model。`Database:PublicArticleProjection:Enabled=false` 可通过 reload-capable configuration 在不重启的情况下跳过 DB projection；outbox projector 继续运行，因而重新启用时不需要重新切流。

## 一致性

`article-detail-aeds` 是 `ArticleMutationReplayEdges.Required` edge。projector 的顺序为 DB projection upsert、old-source/new-frame shadow comparison、file artifact replace。DB row 使用 content hash 保持 replay 幂等；不可公开或不存在的文章保留 `visible=false` negative row。create/update/status/revision/tag assignment/rights snapshot 已由 ArticleService 同事务 outbox 覆盖；scheduled publish 在 claim transaction 写批量 outbox；category/tag rename 为所有受影响 article 在同事务写 outbox；rights proof upsert 与 `rights-proof-updated` outbox 同事务。critical edge 失败时 dispatcher 保存 failed edge并按既有 backoff 重试，不能标记 event processed。

shadow comparison 从 legacy projector source 生成 expected frame，再回读新 projection 并逐 byte 比较；mismatch 写入 `public_article_projection_shadow_mismatch` 的 expected/actual hash、version、reason 和 observed time，并让 required edge 失败。生产证据密封前保留 legacy source query；不要把复杂计算移入读取时数据库函数。

## Pool 与 gate

公共 reader 使用独立 `NpgsqlDataSource`。`MaxPoolSize` 默认从主连接串 `Maximum Pool Size` 派生为四分之一，并可用 `Database:PublicArticleProjection:MaxPoolSize` 覆盖；值会 clamp 到主 pool capacity，不能靠无限连接掩盖 DB 饱和。`MinPoolSize`、command timeout 和四类 gate 的 limit/queue/wait timeout 同样可配置。`runtime.dbGateClasses` 与 `runtime.publicArticleProjection` 提供 active/waiting/timeout/broken connection/pool wait p99/query p99。

四类 gate 是 `public-short-read`、`admin-heavy-read`、`foreground-write`、`background-projection-rebuild`。backfill 初始 `rate_per_second` 从 PostgreSQL `max_connections` 派生，运行时 parallelism 取 background gate limit、durable rate 与当前 batch size 的最小值，batch size 也由 background gate capacity 推导，不读取 `Environment.ProcessorCount`。这让 DB/pool evidence 决定吞吐，而不是把应用线程数当作数据库容量。

## Online migration、backfill 与回退

Expand migration `20260714-post-public-article-projection` 创建 projection/version sequence、partial PK plan index、durable backfill state 和 mismatch evidence。reader 不做 DDL。author cache action：

- `public-article-projection-backfill-status`：读取 durable watermark、rate、成功/失败计数；
- `public-article-projection-backfill-pause`：在当前 batch 后暂停；
- `public-article-projection-backfill-resume`：从 last article id 恢复并按当前 rate 继续；
- `rebuild-article-detail-aeds-v3`：单文章 repair 或显式全量重建。

回退时把 reload 配置 `Database:PublicArticleProjection:Enabled` 设为 `false`，观察 projection read 归零、legacy fallback/错误率和四类 gate；无需重启、删表或清空 outbox。恢复前检查 mismatch=0、backfill completed、projection invalid=0，再重新启用。旧 hot query 只有在 production/release-final 证据密封且回退窗口结束后才能删除。

## 证据

数据库 plan 模板：

```bash
docker exec -i fsusblog-dev-postgres psql -U fsusblog -d fsusblog \
  -v article_id=1 -f - < tools/perf/public-article-projection-plan.sql
```

输出必须同时保存 legacy 与 projection 的 `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)`，记录 actual rows、shared hit/read blocks、WAL、planning/execution time。after plan 必须是 `public_article_projection` 的 PK/partial-index 单行读取，不得出现 join/aggregate/sort。配套运行 `./tools/test.sh ci-tier backend-qps-article-detail-miss`、`backend-qps-index-plan` 和 data-scale tier，保存 DB miss p99、allocations、rows/blocks、pool wait；本机数字是 release evidence，不是跨机器常量。

验收还包括：匿名 public binary hit/miss、登录用户读取同一 public frame、admin/private legacy read、notification stream 不受影响、所有 mutation kind replay、outbox crash/retry、negative/visibility boundary、四类 gate saturation/isolation、pause/resume/rollback，以及最终 production/release-final。
