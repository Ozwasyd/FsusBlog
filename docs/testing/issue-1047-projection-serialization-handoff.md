# Issue #1047：统计隐私、Taxonomy、ReadModel 与序列化交接

五个旧混合测试文件共 25 个 test ID 已拆分。`tests/test-retention-replacements.json` 对每个旧
ID 登记直接 replacement；其中 `ReadModelProjectionHotPathContractTests` 的性能 intent 与
#1042 共用 benchmark owner，状态语义由本 issue 的参数化行为 owner 保留。

## 权威 owner

- `StatsRecentCommentPrivacyBehaviorTests` 以 reflection/JSON 证明 DTO、Pod、Core model 不含
  legacy account identity，并覆盖 public/anonymous/credential-level mapper 语义。
- `StatsPerformanceContractTests` 在 PostgreSQL 上执行真实 recent-comment query，返回 public、
  anonymous 与 zk anonymous snapshot，且只产生一条窄查询。
- `TaxonomyProjectionTests` 验证 legacy/current/next frame identity 批量 eviction；
  `TaxonomyProjectionPersistenceTests` 验证 reconcile 后 category/tag count、projection row、
  frame version 与 cache invalidation。
- `ArticleStatusProjectionTests` 参数化覆盖所有 declared/invalid status；`ArticleProjectionTests`
  保留 mapper 输出、null/empty collection 与 page semantics。
- `ArticleCoreQueryCacheBehaviorTests` 覆盖 stable identity、versioned hit、single-flight miss 与
  search-cache 单一 ownership；`PublicAotBinaryPayloadTests` 覆盖 Unicode/string 与 decimal
  fixed-point round-trip。
- `AedsFrameNamingTests` 通过 enum、Pod reflection、结构化 protocol/golden catalog 验证 numeric
  identity 与命名；Markdown 文案不再由 xUnit substring 维护。

后续统一验证必须覆盖 backend unit/integration、golden、benchmark regression、privacy、
coverage/mutation、retention/evidence 与 production fresh。当前代码阶段未运行测试、构建、
lint、语法检查或治理 checker。
