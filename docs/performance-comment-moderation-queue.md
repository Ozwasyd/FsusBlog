# 评论审核队列查询计划与基准证据

> 2026-07-20；对应 issue #1202。数据仅写入本机临时 PostgreSQL 18 Alpine 容器，未连接开发或生产数据库。

## 可复现方式

脚本：`tools/performance/comment-moderation-queue-benchmark.sql`。

```bash
psql -v scale=100000 -f tools/performance/comment-moderation-queue-benchmark.sql
psql -v scale=1000000 -f tools/performance/comment-moderation-queue-benchmark.sql
```

每个规模都建立全新的 UNLOGGED 表，写入 1% Pending、0.4% borderline Hidden、0.1% open report、0.01% pending appeal；`jit=off`、`work_mem=64MB`、关闭 parallel gather。延迟样本是同一连接内 100 次完整首屏 keyset 查询，之后单独运行 `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)`。结果是本机热缓存工程门禁，不代表生产 SLA。

## 结果

| 评论行数 | p50 | p95 | p99 | 平均 | EXPLAIN execution | candidate 输入行 | shared hit blocks |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100,000 | 2.300 ms | 3.977 ms | 14.669 ms | 2.785 ms | 3.532 ms | 166 | 364 |
| 1,000,000 | 17.933 ms | 25.366 ms | 28.217 ms | 18.339 ms | 15.846 ms | 1,156 | 4,442 |

`candidate 输入行` 是计划读取的 active report + pending appeal + pending/borderline partial-index window：100k 为 `100 + 10 + 56`，1m 为 `1000 + 100 + 56`。此外只有按 comment PK、report comment index 与 appeal comment index 的点查；计划无 comment 全表扫描、无 OFFSET、无 temp block。最终 top-N 只在三个已各自 `LIMIT 51` 的优先级分支上合并。

第一次候选 SQL 把 report/appeal 左连接到整张 comment 后再执行 OR 过滤，100k 实测 p50/p95/p99 为 `39.612/55.880/76.849 ms`，计划候选行接近 100k。该方案被拒绝；实现改为 appeal/report/ordinary 三个有界分支后，同一数据的 p50 降至 2.300 ms，候选输入降至 166 行。

## 索引收益与成本

100k/1m 数据下，pending/borderline partial index 分别为 56 KiB/384 KiB；pending-appeal partial index 均为 16 KiB。索引只覆盖进入人工队列的 comment 或待决 appeal，不为 Approved 普通评论增加条目。claim 的 lease/owner 索引位于独立小表，续租不会更新大 `comment` 表或其公共读取索引。

上线后观察 `pg_stat_user_indexes.idx_scan`、`pg_relation_size`、`n_dead_tup`、`n_tup_upd`、autovacuum 时间与 claim 表 HOT update 比例。若索引增长或写放大超过收益，可先停止新 claim、等待 lease 到期，再按 rollback SQL `DROP INDEX CONCURRENTLY`；保留 claim 表跨过 N-1 兼容窗口。

## 其他查询形状

公共根节点、任意直接子节点、1,001 层祖先路径与 permalink 同级窗口的 1m 实测计划见 [performance-comment-tree.md](performance-comment-tree.md)。本文件不以树证据替代队列证据；上述 queue p50/p95/p99 与 candidate 输入行来自独立 #1202 脚本。
