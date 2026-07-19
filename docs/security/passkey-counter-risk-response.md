# Passkey signature counter 风险响应

本文定义普通账号 Passkey 登录与 step-up 共用的 WebAuthn `signCount` 状态机。它只处理已通过签名、challenge、RP ID、UP/UV 验证后的 counter 结果，不改变 FIDO 验证、Cookie、JWT 或独立 admin principal 边界。

## 状态机

| Stored | Actual | Outcome | 行为 |
| ------ | ------ | ------- | ---- |
| `0` | `0` | `Unsupported` | 允许 assertion；保持 counter 为 `0` 并更新 `LastUsedAt` |
| 任意非负值 | `> stored` | `Advanced` | 通过 signCount + rowVersion CAS 推进 counter 与 `LastUsedAt` |
| 至少一端非零 | `<= stored` | `Risk` | 拒绝 assertion，记录 non-monotonic 高价值事件并执行配置的响应 |
| 验证后 CAS 失败 | 任意 | `ConcurrentConflict` | 重新读取 counter/rowVersion；已被并发推进则接受，否则最多重试一次 CAS |

`InvalidSignCount` 只有在 authenticator data 同样给出 `0 -> 0` 时可进入 `Unsupported`。其他 `InvalidSignCount` 与已验证的非单调值进入 `Risk`；普通无效签名仍是普通 assertion failure。任何路径都不得把风险信号表述为已确认 credential clone。

## 风险响应配置

`PasskeyCounterRisk:ResponseAction` 按请求读取，可由支持 reload 的配置源无需重启地调整：

- `reject_credential`：默认值。拒绝本次异常 credential assertion，保留现有 Session，不发送 `SessionRevoked`。
- `revoke_account_sessions`：只在已有账户级 compromise 证据和人工策略批准后启用。撤销该账户全部 active Session，更新 account snapshot generation，并发送去标识的撤销通知。
- 缺失、拼写错误或未知值：安全回退为 `reject_credential`，不能隐式扩大到全账号撤销。

当前 Session schema 尚未持久化登录 credential 来源，因此默认策略不能声称只撤销“该 credential 创建的 Session”。在来源关联落地前，默认 credential-only 拒绝是避免误伤无关设备的安全边界；不得用猜测的设备 fingerprint、User-Agent 或 IP 代替 credential 来源。

## 可观测性与隐私

低基数安全 telemetry 分别记录：

- `counter_unsupported`
- `counter_advanced`
- `counter_non_monotonic`
- `counter_concurrent_conflict`
- 最终动作：`counter_unchanged`、`counter_updated`、`accepted_after_reload`、`counter_retry_updated`、`reject_credential`、`revoke_account_sessions` 或 `assertion_rejected`

日志只允许 account subject hash、flow、异常类型和固定动作类别。不得记录原始 credential ID、challenge、authenticator data、signature、Session ID 或 token。Audit 可使用内部 credential row ID 作为受保护目标引用，但事件文案必须写“non-monotonic counter risk”，不能写“confirmed clone”。

## 失败与回退

- Risk 响应在任何副作用失败时仍拒绝当前 assertion。
- 默认 `reject_credential` 下 audit/telemetry 暂时不可用不得扩大 Session 影响范围。
- 显式 `revoke_account_sessions` 下持久 Session revoke 失败会 fail closed；成功 revoke 后 notification 或 cache invalidation 暂时失败不恢复 Session。
- 发生误报或并发冲突升高时，将配置热更新为 `reject_credential`；这不会关闭 counter 检查，也不会接受非单调 assertion。
- 需要代码回退时切回上一服务槽，同时保持 `reject_credential` 配置。不得通过关闭 WebAuthn counter 校验或恢复 blind update 降级。

## 验证覆盖

`PasskeyServiceTests` 锁定 `0 -> 0`、`0 -> N`、`N -> N+1`、`N -> 0`、`N -> N` 与 `N -> N-1` 分类。`PasskeyCounterRollbackIntegrationTests` 覆盖登录、step-up、backup-eligible credential、默认不撤销 Session、显式账户级撤销和响应失败。`PasskeySignCountConcurrencyTests` 使用 PostgreSQL stale rowVersion 与两个并发 assertion 验证 CAS 冲突重读，不依赖真实硬件。
