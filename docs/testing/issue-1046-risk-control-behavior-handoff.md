# Issue #1046：反爬虫与评论风险控制行为交接

`AntiCrawlerSecurityContractTests` 与 `CommentRiskControlContractTests` 已移除。28 个旧 test ID
均在 `tests/test-retention-replacements.json` 中映射到生产对象、TestServer、受控 I/O 或结构化
gateway checker，不再锁定 metric、字段、方法调用顺序、`Task.WhenAll` 或固定配置字符串。

## Crawler、shield 与 limiter

- `CrawlerRangeSyncBehaviorTests` 使用 fake HTTP、受控 clock 和临时 data root，覆盖 provider
  独立失败/并发、remote → snapshot → config fallback、reentry、成功/失败/取消 status、
  unsafe URL/path fail-closed。
- `AntiCrawlerPolicyBehaviorTests` 直接验证 atomic snapshot replace、无残留 tmp、official HTTPS
  allowlist、data-root path boundary 与 policy update 拒绝。
- `AntiCrawlerPipelineTests` 通过 TestServer 发送 verified crawler、fake crawler、social preview、
  ordinary public read 与 authenticated admin 请求，验证最终 partition、observe/enforce/disabled、
  429/403 与 bounded risk writes。
- `check-infra-security-governance.mjs` 解析 OpenResty zone/location 结构，唯一拥有必须保留的
  gateway 配置规则。

## Comment risk

`CommentRiskActionFilterTests` 使用真实 AEDS create/reply frame，验证 dynamic action metadata、
seekable/non-seekable body reset、malformed/oversized/cancellation 边界；queue-for-moderation 会
继续 mutation，并把 manual-review、risk label 与 decision reason 写入最终请求。风险决策的
allow/challenge/queue/block 由 `SecurityRiskPolicySnapshotV2Tests` 直接执行。

后续统一验证必须覆盖 anti-crawler、risk-control、API integration、concurrency、security、
coverage/mutation、retention 与 production fresh。当前代码阶段未运行任何验证。
