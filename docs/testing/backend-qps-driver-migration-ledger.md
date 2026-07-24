# Backend QPS Scenario Driver Migration Ledger & Specification

## 概览

根据 Issue #1388 架构规范，Backend QPS 测试线已从原 13 个独立 shell/Node 冷启动进程模式，升级为由单一常驻 Node 驱动器 (`tools/test/run-backend-qps-scenarios.mjs`) 管理的顺序 Scenario Driver。

机器可读权威清单已归一化并存放在：
`config/testing/backend-qps-scenario-catalog.json`

CLI 兼容入口：
`tools/test/lanes/backend-qps.sh`

---

## 13 个 Backend QPS Scenario 映射 Ledger (1:1 Exact Mapping)

| # | 旧 Tier / Mode 名称 | 新 Scenario ID | 路由 / Workload | 流量模式 (Traffic Mode) | 静态/运行时断言 Checks |
|---|---|---|---|---|---|
| 1 | `view-count-flush` | `view-count-flush` | `visit-log:view-count-flush` | `static-qps-guard` | `batch-core-gateway`, `batch-adapter-no-single-loop`, `batch-db-values-update` |
| 2 | `visitlog-invalidation` | `visitlog-invalidation` | `visit-log:hot-stats-invalidation` | `cache-invalidation-pressure` | `dirty-coalescer`, `versioned-hot-cache`, `no-empty-hot-prefix-delete`, `diagnostics-snapshot` |
| 3 | `cache-hit` | `cache-hit` | `/api/binary/article/list/home/1/10.aeds` | `static-qps-guard` | `full-frame-cache`, `article-list-frame`, `article-hot-frame`, `comment-frame`, `taxonomy-frame`, `stats-frame` |
| 4 | `comment-cursor` | `comment-cursor` | `/api/binary/comment/{articleId}` | `static-qps-guard` | `comment-thread-frame-cache`, `comment-reply-frame-cache`, `user-comment-frame-cache`, `versioned-invalidation` |
| 5 | `hotread` | `hotread` | `/api/binary/category` | `early-hot-read` | `single-classification-feature`, `dedicated-rate-risk-pow-gate`, `generic-pipeline-bypass`, `taxonomy-suffixless-fastpath`, `preencoded-bodywriter` |
| 6 | `cache-miss-singleflight` | `cache-miss-singleflight` | `/api/binary/article/list/home/1/10.aeds` | `db-miss` | `detail-singleflight`, `search-singleflight`, `hot-singleflight`, `featured-singleflight` |
| 7 | `risk-filter` | `risk-filter` | `public_read:risk-filter` | `static-qps-guard` | `zero-risk-microcache`, `no-public-read-lowercase`, `stable-partition-key` |
| 8 | `related-reading` | `related-reading` | `/api/binary/article/{articleId}/related.aeds` | `static-qps-guard` | `versioned-related-cache`, `output-cache-tag` |
| 9 | `list-pagination` | `list-pagination` | `/api/binary/article/list/home/{page}/{size}.aeds` | `db-miss` | `keyset-small-pages`, `offset-deep-pages` |
| 10 | `article-detail-miss` | `article-detail-miss` | `/api/binary/article/{id}.aeds` | `db-miss` | `public-detail-artifact`, `prepared-primary-key-projection`, `sequential-binary-read`, `classified-db-gate`, `async-backfill`, `preencoded-frame` |
| 11 | `cache-registry` | `cache-registry` | `cache:registry` | `static-qps-guard` | `policy-register-flag`, `exact-cache-no-registry`, `prefix-cache-registry` |
| 12 | `cache-invalidation-batch` | `cache-invalidation-batch` | `cache:invalidation-batch` | `cache-mutation` | `remove-many`, `remove-prefix-many`, `registry-setremove-batch`, `prefix-policy-group`, `dispatcher-batch` |
| 13 | `index-plan` | `index-plan` | `db:index-plan` | `db-miss` | `article-public-index`, `comment-index`, `tag-index`, `public-article-projection-plan` |

---

## 性能与架构设计

1. **共享无状态初始化 (Shared Stateless Initialization)**：
   - 驱动器启动时一次性加载 `config/testing/backend-qps-scenario-catalog.json` 权威 catalog；
   - 一次性解析与缓存全量 C# / SQL / TS 源文件索引；
   - 避免每个 scenario 重复启动 Node runtime 和重复写盘。

2. **独立隔离与 reset 策略 (Per-Scenario Isolation)**：
   - 每个 scenario 包含独立的静态代码断言 (`requiredTokens`, `forbiddenTokens`)、独立采样与独立阈值；
   - 物理上顺序执行以防止不同 QPS 场景互相污染 CPU / 数据库 / Redis / 缓存；
   - 若某 scenario 产生断言失败，聚合该失败信息并继续安全地执行后续非污染 scenario。

3. **信号捕获与 Partial Evidence 保障**：
   - 驱动器注册 SIGINT / SIGTERM 监听，发生中断时自动落盘已执行的 partial evidence json 并以非零 exit code 安全退出，防止诊断信息丢失。
