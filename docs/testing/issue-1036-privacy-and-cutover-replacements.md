# Issue #1036：隐私与身份切换伪 gate 的行为替代

本 issue 删除三个读取 matrix、workflow、文档、Vue/C# 源码和其他测试源码的伪 gate：

- `commentPrivacyReleaseGate.test.ts`
- `anonymousIdentityColdStartQuality.test.ts`
- `AnonymousIdentityColdStartQualityContractTests.cs`

## 实际行为 owner

- `commentPrivacyRuntime.test.ts` 执行 fake-time TTL、single-use、Abort 和
  adapter/worker 交互；adapter、worker client、Wasm prover 与 comment API 测试分别执行
  credential/proof 传递、fail-closed、transferable buffer 和无 Cookie/Authorization transport。
- `ArticleCommentComposer.test.ts` 直接 mount 组件，证明匿名为默认状态、公开署名必须由用户
  显式切换，UI 不暴露内部证明术语，并且仅在可见后触发 privacy prewarm。
- privacy matrix 与 production gate 由结构化 verifier 和 production smoke/release 测试所有，
  不再由 Vitest 搜索脚本或 workflow 字符串。
- #1014 已把一次性破坏性路径替换为保留数据的 account-subject expand/backfill。相应旧 gate
  不再保留一个已退役操作；PostgreSQL integration 直接证明幂等 backfill、durable resume、
  零缺失 projection readiness 与 startup fail-closed。
- AEDS frame/DTO 由 backend POD round-trip 与 frontend request encoder 执行。

13 个 baseline test ID 的逐项替换位于
`tests/issue-1036-retention-replacements.json`。中央合并必须把它们并入
`tests/test-retention-replacements.json`，使普通 retention/optimization after audit 也能读取；
suite convergence 会额外发现 issue-local manifest，但它不是中央合并的替代品。

## 风险与回退

隐私 runtime 失败保持 fail closed；公开署名仍需显式 opt-in。组件行为回归可在不改协议的
情况下回退 UI 调用点。数据库切换不得恢复破坏性清空；projection 不满足时 candidate 必须保持
not-ready，修复 backfill 后可恢复而无需删除账号或评论。

## 验证状态

当前仅完成实现、直接测试源码、retention mapping 与文档；按统一指令没有运行任何测试、构建、
lint、syntax check、治理 checker、数据库、浏览器或 production fresh。
