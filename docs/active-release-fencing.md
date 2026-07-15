# Active Release Fencing 与通知流排空

本文定义 production blue/green 并存期间的全局后台任务单活、单调 generation、统一排空和 notification stream 重连契约。实现入口为 `IActiveReleaseFence`，宿主注册入口为 `AddActiveReleaseFencing()`。

## 不变量

1. production 实例总是以 Candidate 启动。Candidate、Draining、Stopped 和 Failed 都不能取得新的全局后台任务 claim。
2. PostgreSQL `sys_deployment_fence` 是 durable witness，Redis hash 是可重建的低延迟镜像。两者只保存一个 active release fence；身份由 `releaseId + slot + generation + imageDigest` 组成，generation 只能严格递增。
3. target acquire 必须携带当前 owner 的 `expectedReleaseId + expectedSlot + expectedGeneration`。SQL 事务以 `SELECT ... FOR UPDATE` 完成 compare、generation 检查和 owner 替换，提交后再用单调 Redis Lua 镜像。
4. source revoke 只撤销完全匹配的 owner；若 target 已经取得 fence，则 source revoke 返回 `already-superseded`，不能误伤 target。
5. 每个 active-singleton worker 同时持有 active release ticket 和原有 worker lease。lease owner 包含 release、slot、generation 和 process instance，renew 前强制读取 fence；失去 fence 或 lease 会取消本轮工作。
6. 有持久副作用的最后提交边界必须调用 `IActiveReleaseCommitGuard.EnsureCurrentAsync()`。该调用强制对账 durable witness；旧 generation 即使尚未等到 renew tick，也不能提交。
7. durable witness 不可用或同 generation 身份分歧时 production fail closed；不会根据进程年龄、流量、容器状态或本地缓存猜测 active owner。Redis 整库丢失时从 SQL 恢复；Redis 暂时不可用时读取 SQL 进入 degraded 状态。synthetic local fence 只允许 `Development` 且显式设置 `ActiveReleaseFence:AllowSyntheticLocalFence=true`，production 启动校验硬拒绝该设置。
8. 指标标签只允许 operation、result、reason 等低基数字段；releaseId、digest、process instance 不进入 metric label。

## Worker 执行链

`ActiveReleaseFencedBackgroundWorkerLease` 替代原 `IBackgroundWorkerLease` 实现：

1. 从 `DeploymentRuntimeState` 取得 background claim；
2. 从 `IActiveReleaseFence` 取得当前 generation ticket；
3. 用包含 generation 的 owner 取得 worker lease；
4. 把 ticket 放入 `IActiveReleaseExecutionContextAccessor`；
5. renew 时先验证 fence，再 CAS renew worker lease；
6. action 在数据库事务提交、对象存储 finalize、不可逆外部发送前调用 commit guard；
7. action 返回后再强制验证一次 fence。

所有 `BackgroundService` 的权威分类位于 `tests/backend/Fixtures/background-service-classification.json`。合法分类只有：

- `active-singleton`：全局任务，必须使用 active fence、worker lease 和 pre-commit guard；
- `multi-consumer-safe`：不同实例可消费互不重叠的本地输入，必须声明幂等身份和 replay 来源；
- `instance-local`：只维护本 release/process 的派生状态，不得产生全局 owner 语义。

`tools/check-background-service-classification.mjs` 一次扫描全部 backend C# 文件，输出所有缺失、重复、无注册、无 lease 和非法 drain 字段，不设置最大错误数。

## 宿主控制契约

三个 fence endpoint 都要求 loopback 来源、`system.config` admin 权限和 `fixed_ip` rate limit：

### Target acquire / CAS

`POST /api/ops/deployment/fence/acquire`

```json
{
  "releaseId": "20260711010101-0123456789ab",
  "slot": "green",
  "generation": 42,
  "imageDigest": "sha256:...",
  "expectedReleaseId": "20260710183000-fedcba987654",
  "expectedSlot": "blue",
  "expectedGeneration": 41,
  "dryRun": false
}
```

首次 acquire 可把三个 expected 字段同时设为 `null`。已存在 fence 时缺少 expected owner 会返回 `expected_current_required`。相同 owner/generation/digest 重试返回 `already-active`；同 generation 换 owner 会返回 `active_release_generation_not_monotonic`。

### Source revoke

`POST /api/ops/deployment/fence/revoke`

```json
{
  "releaseId": "20260710183000-fedcba987654",
  "slot": "blue",
  "generation": 41,
  "dryRun": false
}
```

### Status / verify

`GET /api/ops/deployment/fence/status?releaseId=...&slot=green&generation=42&requireActive=true`

三个 endpoint 返回统一的 `accepted / idempotent / status / errorCode / dryRun / snapshot` JSON。

宿主命令：

```bash
node tools/deployment/active-release-fence.mjs acquire \
  --port 18082 --release "$TARGET_RELEASE" --slot green --generation 42 \
  --digest "$TARGET_DIGEST" \
  --expected-release "$SOURCE_RELEASE" --expected-slot blue --expected-generation 41 \
  --admin-header-file "$FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE" \
  --origin "$FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN"
```

命令只连接显式 `127.0.0.1` 端口，校验 admin header 文件权限为 0400/0600，并把 machine JSON 写到 `.tmp/deployment/active-release-fence.json`。`--dry-run` 仍执行服务端 CAS 判定但不变更 owner；进入判定前的 witness read 仍可修复缺失的 SQL/Redis 镜像。

## Durable witness 与启动对账

`DurableActiveReleaseFenceStore` 并行读取 PostgreSQL 与 Redis，并按以下规则收敛：

- SQL 有记录、Redis 缺失：判定为 Redis total loss，从 SQL 单调恢复 Redis；
- SQL 缺失、Redis 有记录：兼容升级窗口，把既有 Redis owner 写入 SQL 后再允许 mutation；
- generation 不同：较高 generation 胜出并修复较旧一侧，generation 永不回退；
- 同 generation、相同 identity、状态不同：`revoked` 胜出，避免已撤销 owner 复活；
- 同 generation、identity 或 digest 不同：返回 `active_release_fence_witness_diverged`，readiness、claim 与 commit guard 全部 fail closed。

Acquire/revoke 总是 SQL 事务先提交、Redis 镜像后更新。若 SQL 已提交而 Redis 更新失败，本次控制请求不会伪报成功；相同请求重试会从 SQL 的幂等状态恢复 Redis。PostgreSQL 在这里就是 Redis 之外的 durable external witness，不要求部署额外的 etcd/Consul 服务。

## 统一 drain 与 notification stream

`ReleaseDrainParticipantRegistry` 并行启动所有 participant，每项有独立 `MaxDrain`，同时受全局 deadline 约束。当前显式 adapter 包含 article-view、hot-stats invalidation 和 notification stream；其余 channel/queue 的接线要求记录在 issue handoff。排空不是无界等待：每个 participant 必须声明 pending count、状态、最大时长和 replay 来源。

notification drain 调用 `NotificationStreamRestartCoordinator`，取消所有 session 的 linked token。现有连接使用 WebSocket 1012 / `fsus_service_restart` 关闭；浏览器保留 cursor，并在 250–1250ms 抖动窗口内快速重连。服务端 replay 检测到保留窗口缺口时，不发送不完整 batch，而以 4009 / `fsus_replay_miss` 关闭；浏览器清除 cursor，重连成功后通过 `onReconnectSuccess(true)` 触发已有 full-resync 调度。

控制入口：

- `POST /api/ops/deployment/notification-stream/restart`
- `GET /api/ops/deployment/notification-stream/restart/status`
- host tool：`tools/deployment/notification-stream-restart.mjs`
- machine evidence：`.tmp/deployment/notification-stream-restart.json`

## Readiness、指标和证据

`ActiveReleaseFenceReadiness.EvaluateAsync()` 只有在 store 可达且本地 identity 精确拥有 active fence 时返回 `ok`。接入 production readiness 后，Candidate 和旧 generation 会保持 not-ready。

指标：

- `fsus.active_release_fence.operations{operation,result,reason}`
- `fsus.active_release_fence.eligibility{result,reason}`
- `fsus.active_release_fence.witness_reconcile{result,reason}`
- `fsus.active_release_fence.witness_generation_gap{result}`

发布证据必须至少包含 target acquire/CAS、source revoke、target status verify、notification restart status、drain participant terminal snapshot。运行时生成文件不提交；静态实现映射位于 `tests/backend/issue-1030-implementation-evidence.json`。

## 失败与回退

- SQL durable witness 不可用或同 generation 身份分歧：停止新 claim，取消正在 renew 的全局任务，readiness 失败。
- Redis 整库丢失：下一次读取用 SQL snapshot 重建；Redis 连接暂不可用时仍以 SQL 阻断旧 generation，并记录 degraded reconcile 指标。
- target acquire CAS 失败：不切流，保留 source fence。
- target 已 acquire 但后置验证失败：用更高 generation 把 source release 重新 acquire 为 active；禁止把 generation 回退到旧值。
- notification 1012 后客户端无法重连：cursor 仍保留，可继续指数退避；backlog 超窗则 4009 触发 full resync。
- drain deadline 到期：发布 blockers，不停止 source，不把未排空状态伪装成成功。
- 需要无重启暂停控制面 mutation 时，把可 reload 配置 `ActiveReleaseFence:MutationEnabled=false`；status/readiness/worker commit guard 保持启用。恢复为 `true` 后先完成 SQL/Redis 对账，再接受 acquire/revoke。不得通过启用 synthetic local fence 回退 production。

## 验证边界

聚焦测试覆盖 SQL-first 写入顺序、Redis total-loss 恢复、legacy Redis 启动引导、同 generation 分歧 fail-closed、revoked 优先、reloadable mutation pause、production synthetic local fence 硬门禁、迁移与指标契约。匿名、登录、notification stream 与 binary API 的请求/响应契约未改变；控制端点仍仅允许 loopback admin，既有 endpoint contract 测试继续覆盖该边界。实际执行结果记录在 issue handoff，不在本文伪造。
