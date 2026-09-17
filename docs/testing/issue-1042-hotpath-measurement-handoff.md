# Issue #1042：HotPath 可执行测量交接

本 issue 将性能证明从生产源码中的集合类型、私有 helper、`Task.WhenAll`、字符串构造和
SQL 片段迁移到可执行行为、数据库 command counter 与 BenchmarkDotNet 预算。代码落地
阶段不生成或预填性能结果；before/after 数值必须由后续统一验证绑定最终 source state。

## 直接行为 owner

- `StatsPerformanceContractTests` 在 PostgreSQL 上分别执行 recent-comment 与 region
  projection，断言每个入口只有一条窄查询，同时验证 public、anonymous、zk anonymous
  三种作者快照不回填账户 ID。
- `RelatedReadingServiceTests` 断言 cold miss 的数据库命令数有界、memory hit 为零命令，
  并保留 category/tag/time scoring 语义。
- `ParallelOperationsHotPathContractTests` 使用受控 task gate 证明同时启动、timeout fallback、
  cancellation 与 capacity release，不再搜索 `Task.WhenAll`。
- `BinaryTransportHotPathContractTests` 使用真实 `PipeReader`，覆盖分段 frame round-trip、
  CRC 失败和 blocked read cancellation。
- `HttpHotPathPerformanceContractTests` 与 `SecurityModerationHotPathContractTests` 只保留
  request-audit、normalization、crawler lookup 与 concurrent scan 的可观察行为。
- `ArticleStatusProjectionTests` 保留参数化 `Normalize/IsDefined` 行为；read-model allocation
  由 benchmark 负责。

## 测量预算

`benchmarks/core/ServerHotPathBenchmarks.cs`、`ContentFilterBenchmarks.cs` 与
`tests/performance/backend-hotpath-budgets.json` 覆盖 request audit、binary bind/encode、
notification fanout/pump、read-model projection、content filter、related reading、stats 与
crawler normalization。预算同时约束 mean 与 allocation/op；无 honest legacy 对照的项目
使用绝对上限。

39 个旧 xUnit test ID 均在 `tests/test-retention-replacements.json` 中逐 ID 指向当前行为
owner 或 `backend-benchmark-regression`。因此等价实现可改变私有 API、集合和 SQL 写法，
但不得改变结果、查询边界、并行/取消语义或测量预算。

## 后续统一验证

后续阶段必须执行 backend unit/integration、PostgreSQL query-counter、benchmark regression、
performance evidence summary、retention audit 与完全 fresh production tier。当前阶段没有运行
测试、构建、lint、语法检查或治理 checker，也没有声称任何未测量的性能改善。
