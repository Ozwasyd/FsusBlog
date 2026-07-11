# Issue #1045：匿名身份与评论协议行为交接

本 issue 删除六个职责混杂的 backend `*ContractTests` 和五个 frontend source-lock 文件，
将 101 个旧 test ID 拆分到 actor、policy/persistence、serialization/codec、ZK verifier、
mounted component、binary adapter、API、store/router 与 privacy runtime/worker owner。旧文件
不再通过全文读取 entity、migration、endpoint、frontend、benchmark 或文档来证明契约。

## 权威行为套件

- `ActorResolverBehaviorTests`：anonymous mode 丢弃请求 account ID；public mode 仅接受持久化
  public handle；缺 handle fail-closed；本地化匿名显示名稳定且不泄漏身份 token。
- `AnonymousCommentPolicyTests`：默认 anonymous、显式 public opt-in、anonymous/zk disable、
  limits、invalid mode 与异步 query 行为。
- `AnonymousCommentPolicyPersistenceTests`：真实 PostgreSQL load/update/invalidation/reload，
  跨 service instance 验证持久化 runtime snapshot。
- `AnonymousIdentitySerializationTests`：DTO/Pod reflection、JSON author/reply snapshot 与
  account snapshot mapper，不含 legacy `UserId/UserName/Role` 身份字段。
- `ZkProofVerifierTests`：disabled/unconfigured fail-closed、ticket required、direct-proof
  downgrade 拒绝、DI、metadata/root/issuer mismatch、input bounds、timeout、日志脱敏与有效
  backend 调用。
- `SchemaMigrationIntegrationTests` 与 `PodBinaryCodecTests`：真实 schema 迁移、enum/golden/
  codec round-trip，取代 SQL/Markdown/其他测试源码字符串。
- `ArticleCommentComposer.test.ts`、`commentAdapter.test.ts`、`notificationAdapter.test.ts` 与
  `comment.test.ts`：mounted identity selector、author snapshot decode/fail-closed、CommentAdded
  decode、anonymous/public binary mutations。
- `authAdapter.test.ts`、`auth.test.ts`、`user.test.ts`、`router/index.test.ts` 与
  `accountNavModules.test.ts`：anonymous account/session decode、`getMe` frame、role-free account
  state/route guards、account/admin navigation separation。
- `anonymousGovernance.test.ts`、`useCommentModerationActions.anonymousGovernance.test.ts` 与
  `admin.test.ts`：step-up AEDS governance query/mutation、queue refresh/fail-closed action、policy
  derived state。
- `commentPrivacyRuntime.test.ts`、`commentPrivacyWorkerClient.test.ts`、
  `commentPrivacyAdapter.test.ts` 与 `commentPrivacyWasmProver.test.ts`：TTL/consume-once/Abort、
  lazy transferable worker、credential-free adapter、console-free Wasm prover boundary。

## Retention 与边界

`tests/test-retention-replacements.json` 对十一个旧文件逐 test ID 登记 replacement。并发
nullifier transaction 仍由 #1040 的 PostgreSQL 套件拥有；endpoint permission/rate limit 由
#1038 拥有；protocol 只由 enum/reflection/golden/generator/round-trip owner 维护。

后续统一验证必须覆盖 privacy ZK、backend unit/integration、golden、auth state machine、
concurrency、coverage/mutation、retention 与 production fresh。当前代码阶段未运行任何测试、
构建、lint、语法检查或治理 checker。
