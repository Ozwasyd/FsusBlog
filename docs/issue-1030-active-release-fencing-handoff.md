# Issue #1030 集成 handoff

本文件记录当前源码的最终静态集成 readback。production 实现、DI、路由、session 行为、worker commit guard、drain participant、host tools、证据语义、测试、分类 fixture 与中央文档均已接线；但本文件不是验证通过证明。

## 已完成的 production 接线

- `ServiceCollectionExtensions.AddFsusRuntimeServices()` 在既有 runtime/domain 服务之后调用 `AddActiveReleaseFencing()`，并用 `ActiveReleaseFencedBackgroundWorkerLease` replacement 封闭 global worker claim。
- `WebApplicationCompositionExtensions.MapFsusOperationalRoutes` 已在 deployment control 后映射 `MapActiveReleaseFenceEndpoints()` 与 `MapNotificationStreamRestartEndpoints()`。
- `DeploymentDrainCoordinator.RunDrainAsync` 调用 `ReleaseDrainParticipantRegistry.DrainAsync`，将 participant 的 pending/error 映射为稳定 blocker，而不是只观察队列。
- `ProductionHealth` 输出受保护的 `activeReleaseFence` readiness；Active 实例必须持有正确 release/slot/generation/digest fence 才能 ready，Candidate 不得 claim active-singleton worker。
- `NotificationStreamSessionService` 链接 restart token：1012 保留 cursor，replay miss 4009 强制 full resync。
- rollout/recovery 已生成并语义校验 active-fence acquire/revoke/final verify、notification restart 和 source drain evidence。target acquire 必须绑定精确 identity，source revoke 只能是 `revoked`/`already-superseded`，notification close 必须是 1012，participant 不得残留 blocker 或 timeout。

## Active-singleton commit guards

以下不可逆提交边界均已调用 `IActiveReleaseCommitGuard.EnsureCurrentAsync`，防止最后一次 lease renew 与 commit 之间由旧 generation 写入：

- `ScheduledPublishWorker`：scheduled transition 与 outbox transaction；
- `ArticleMutationOutboxDispatcher`：claim、side-effect/replay edge、processed/retry 状态；
- `PowLoadResetWorker`：process governor window reset；
- `ArticleViewProjectionRepairWorker`：watermark、增量/full projection 与 repair checkpoint；
- `CrawlerUpdateWorker`：range snapshot/final local publish；
- `LogCleanupService`：每个 retention delete chunk；
- `PublicAotBackfillWorker`：artifact publish/finalize；
- `UploadSessionCleanupWorker`：session/object irreversible delete。

## Drain participants

`ActiveReleaseFenceHosting.cs` 已注册 article-view、hot-stats、notification stream、audit-log、admin-audit-log、visit-log、RUM、security-risk、challenge-v2-audit、public-hot-update、article-detail AEDS、Public AOT backfill 与 upload-cleanup adapters。每个 adapter 使用真实 `FlushAsync`/`DrainAsync`、稳定 pending count、fixture deadline 与 replay source；没有以“pending 归零”冒充丢弃队列。

## 中央治理与文档 readback

- `tools/test/lanes/static-governance.sh` 已运行入口 `tools/check-background-service-classification.mjs` 的登记；checker 聚合全部错误，不设最大错误数或提前停止。
- coverage ID `active-release-fence-drain-restart`、backend requirements 与 matrix owners 已存在。
- `docs/architecture.md`、`docs/production.md`、`docs/operations.md`、API design/contracts/quick-reference/schemas-and-errors、`docs/security.md` 与 `docs/testing.md` 已包含 fence、worker ticket、loopback + `system.config`、restart、parallel drain、rollback 与 evidence 语义。

## 风险与无重启回退

- 切流前 fence acquire 或 readiness 失败：保留 source Active，revoke/neutralize candidate，恢复 source gateway include。
- 切流后 source revoke/drain 失败：保持 target Active 并让 closeout 明确失败；不得把硬停止或进程缺失伪造为 drain complete。
- notification 1012 重连保留 cursor；4009 必须从完整状态重建后再恢复 stream。
- 旧 generation 的 commit guard 失败必须取消该次不可逆提交，由 durable replay source 在 target 重放；不得绕过 guard 继续写。

## 尚未执行

按当前统一验证策略，本 issue 未运行任何 shell syntax、Node、frontend、backend、matrix 或 production test。验证状态必须保持 `not-run`，直到后续统一验证真实执行并产生结果。
