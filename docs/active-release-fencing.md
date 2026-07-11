# Active Release Fencing 与通知流排空

本文定义 production blue/green 并存期间的全局后台任务单活、单调 generation、统一排空和 notification stream 重连契约。实现入口为 `IActiveReleaseFence`，宿主注册入口为 `AddActiveReleaseFencing()`。

## 不变量

1. production 实例总是以 Candidate 启动。Candidate、Draining、Stopped 和 Failed 都不能取得新的全局后台任务 claim。
2. Redis 只保存一个 active release fence。身份由 `releaseId + slot + generation + imageDigest` 组成；generation 只能严格递增。
3. target acquire 必须携带当前 owner 的 `expectedReleaseId + expectedSlot + expectedGeneration`。Redis Lua 在一个原子操作内完成 compare、generation 检查和 owner 替换。
4. source revoke 只撤销完全匹配的 owner；若 target 已经取得 fence，则 source revoke 返回 `already-superseded`，不能误伤 target。
5. 每个 active-singleton worker 同时持有 active release ticket 和原有 worker lease。lease owner 包含 release、slot、generation 和 process instance，renew 前强制读取 fence；失去 fence 或 lease 会取消本轮工作。
6. 有持久副作用的最后提交边界必须调用 `IActiveReleaseCommitGuard.EnsureCurrentAsync()`。该调用强制读取 Redis，因此旧 generation 即使尚未等到 renew tick，也不能提交。
7. Redis fence 不可用时 production fail closed；不会根据进程年龄、流量、容器状态或本地缓存猜测 active owner。未配置 release identity 的非 production `local` 环境使用 synthetic local fence。
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

命令只连接显式 `127.0.0.1` 端口，校验 admin header 文件权限为 0400/0600，并把 machine JSON 写到 `.tmp/deployment/active-release-fence.json`。`--dry-run` 仍执行服务端 CAS 判定，但 Redis 不写入。

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

发布证据必须至少包含 target acquire/CAS、source revoke、target status verify、notification restart status、drain participant terminal snapshot。运行时生成文件不提交；静态实现映射位于 `tests/backend/issue-1030-implementation-evidence.json`。

## 失败与回退

- Redis 不可用、snapshot 过期或身份不匹配：停止新 claim，取消正在 renew 的全局任务，readiness 失败。
- target acquire CAS 失败：不切流，保留 source fence。
- target 已 acquire 但后置验证失败：用更高 generation 把 source release 重新 acquire 为 active；禁止把 generation 回退到旧值。
- notification 1012 后客户端无法重连：cursor 仍保留，可继续指数退避；backlog 超窗则 4009 触发 full resync。
- drain deadline 到期：发布 blockers，不停止 source，不把未排空状态伪装成成功。

## 验证边界

本次代码落地按任务约束未运行 build、test、lint 或静态检查。新增测试覆盖 CAS 源码契约、commit guard、1012/4009 policy、worker catalog 和宿主 JSON 契约；实际执行结果只能在后续统一验证阶段记录。
