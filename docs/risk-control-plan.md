# RiskControl production tracking plan

RiskControl 收敛所有风险信号、裁决、challenge、proof、enforcement、审计和管理策略。当前感知挑战面只包含 `perceptionCharacterV3`、`perceptionLocalizationV2` 与 `perceptionMicroInteractionV2`；V2 只承担 Localization 和 Micro-interaction，不承担字符或文本任务。所有 provider 共享 `SecurityChallengeEnvelope`、`SecurityChallengeAssignment` 与一次性 proof 契约。

## Production architecture

```text
Risk Signal -> Risk Score -> Risk Decision -> Challenge Orchestration -> Proof Verification -> Enforcement -> Audit / Metrics / Admin Policy
```

- endpoint 通过 `WithRiskAction(...)` 声明 action 与 route key；业务 handler 不自行选择 challenge。
- `SecurityChallengeOrchestrator` 只从已注册 provider 中按服务端策略顺序签发 assignment；缺 provider、非法 kind、持久化失败或 proof mint 失败都 fail closed。
- `SecurityChallengeEnvelope` 是 required member 的权威有序集合。客户端不得重排、删除、替换或自行降级成员。
- provider verify 成功后只 mint 统一 `X-Fsus-Challenge-Proof`；业务 filter 一次性消费并验证 action、route、subject、IP、device、kind、policy version 与 expiry 绑定。
- 浏览器 proof 只存进程内，不进入 URL、Web Storage、BroadcastChannel、日志或重连状态。

## Current challenge policy

V3 是字符感知挑战的唯一当前实现。LocalizationV2 与 MicroInteractionV2 继续使用 `fsu.challenge/perception-sealed@v2`、AEAD sealed token、坐标/步骤响应、render recipe 与 `RecipeHash`。公开 payload 不包含期望答案、期望坐标、期望步骤或语义标签；服务端解封后校验 assignment、recipe、action、route、subject、IP、device 与 policy binding，再通过 Redis attempt gate 和 consume-once。

策略只引用当前 manifest 中存在且 provider-ready 的 kind。客户端上报能力不足时只能回送低基数原因和原 assignment binding；服务端重新读取当前策略，撤销旧 assignment，并改发仍被策略允许的成员或拒绝。客户端不能指定替代 kind。

## Rollout and rollback

生产按 `observe -> enforce -> strict` 渐进，并保留 `disabled` 与事故期 `lockdown`。无需重启的回退通过 admin binary policy API 把受影响 action 切换到 `observe`，或恢复 last-known-good snapshot；不得通过恢复已退休 provider、别名 parser、JSON fallback 或弱绑定 proof 回退。

每个阶段必须覆盖：

- 匿名请求：公开读、匿名评论与 notification preflight 的 challenge/proof binding。
- 登录请求：Passkey、恢复流程及登录态评论不能绕过当前策略。
- admin 请求：策略写入仍要求 admin principal、`system.config` 与 `X-Fsus-Mfa-Proof`。
- notification stream：只使用 path-bound 短效 grant，重连不复用 proof。
- binary：issue、verify、envelope、proof 与业务恢复全程只走 AEDS；未知或退休数值 kind fail closed。

切换后记录 active policy version、readiness、issue/verify/replay/revoke 指标、428/429、Redis/PostgreSQL 错误率和回滚演练结果。具体操作见 [RiskControl production rollout gates](risk-control-rollout.md)。
