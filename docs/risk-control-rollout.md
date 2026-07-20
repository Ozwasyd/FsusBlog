# RiskControl production rollout gates

本文档定义当前 RiskControl 的生产上线、故障处置和无需重启回退边界。当前感知 challenge 只有 `perceptionCharacterV3`、`perceptionLocalizationV2` 与 `perceptionMicroInteractionV2`；后两者共享 sealed V2 provider，字符任务只由 V3 承担。

## Runtime controls

有效模式固定为 `disabled | observe | enforce | strict | lockdown`。active `security_policy_snapshot` 提供全局与 action mode、challenge kinds、subsystem modes 和 last-known-good 指针；admin binary policy API 是唯一热写入口。provider 配置与 DI registry 必须和 capability manifest 一致，未知 kind 或未 ready provider 不得签发。

默认风险带只选择当前 provider：低风险 allow，中低风险可要求 `sha256PowV1`，字符感知使用 `perceptionCharacterV3`，更高风险可组合 `perceptionLocalizationV2 + sha256PowV1`，MicroInteractionV2 只在显式启用的 strict 策略中使用，达到 block 阈值后拒绝。PoSpace 保持显式资源门控，客户端能力不足不获得自行降级权。

## Rollout order

| Stage | Scope | Required gate |
| ---: | --- | --- |
| 1 | global `observe` | readiness、metrics、audit、provider registry 与 simulator 一致 |
| 2 | public-read enforce | 匿名公开读及 crawler/preview 路径符合策略 |
| 3 | auth/recovery enforce | 登录请求只接受当前 challenge/proof，恢复流程保持 no-store |
| 4 | comment enforce | 匿名和登录评论在持久化前执行 challenge/queue/block |
| 5 | notification enforce | preflight 一次性消费 proof，WebSocket 只消费短效 grant |
| 6 | admin enforce | admin principal、权限和 MFA proof 均不可被普通 RiskControl proof 替代 |
| 7 | selected strict | 仅在前述阶段错误预算稳定后启用 |

`lockdown` 只用于事故期阻止匿名写入，不是常规 rollout stage。

## Pre-production checklist

- active policy、last-known-good、provider registry 和 capability manifest 使用同一当前 kind 集合。
- Redis 支持 envelope、attempt、used 与 proof 的原子一次性语义；PostgreSQL challenge/attempt 审计可写。
- `/api/ops/health/ready-detail` 的 RiskControl 检查为 ready。
- V3、LocalizationV2、MicroInteractionV2 的 issue/verify/replay/tamper 测试通过；退休数值 kind fail closed。
- 匿名、登录、admin、notification stream 与 binary 五类验收均通过。
- 浏览器不把 proof、sealed truth、原始 IP/device 或管理会话写入持久存储与日志。

## Failure matrix

| Failure | Behavior | Live response |
| --- | --- | --- |
| Redis consume-once unavailable | required challenge fail closed | audited policy 切到 `observe` 或恢复 LKG；不绕过 consume-once |
| PostgreSQL challenge audit unavailable | issue/verify fail closed | 恢复数据库或启用不要求新 challenge 的 LKG |
| active policy missing/corrupt | readiness not ready；仅可使用已验证 LKG | 恢复 LKG，不在 endpoint 拼装默认值 |
| provider/manifest mismatch | 对该 kind fail closed | 从 active policy 移除不可用 kind 或切 `observe` |
| 旧前端 capability manifest | 服务端返回稳定 409；客户端仅执行一次正常整页 reload | reload 前写入当前构建版本的 session guard；同一旧构建再次不匹配时 fail closed，不重载循环、不尝试旧 kind/alias/fallback |
| sealed token/recipe/binding invalid | verify 拒绝且不 mint proof | 修复 key/provider；不接受旧 schema 或弱校验 |
| proof expired/replayed/mismatched | 428，业务 handler 不执行 | 重新 issue，不放宽 action/route/identity binding |
| notification grant 无效 | stream 不升级 | 重新执行 preflight，不复用原 proof |

## No-restart rollback

通过 `/api/binary/admin/security/risk-control/options` 把受影响 action 热切到 `observe`，或通过 rollback endpoint 恢复 `LastKnownGoodSnapshotId`。这保留风险评分、审计和 metrics，同时停止新 challenge enforcement。修复后重新从 `observe` 晋级。不得用重启、恢复退休 kind、兼容 alias、文本/JSON fallback、客户端自选 fallback 或复用 proof 作为回退。

每次切换记录 policy version、操作者、原因、readiness、五类验收样本、issue/verify/replay/revoke 指标、428/429 和 Redis/PostgreSQL 错误率。

前端收到 `security_challenge_client_capability_incompatible` 时，把它视为静态资源切换信号而不是新的 challenge 类型。客户端以自身 capability manifest 版本写入 `sessionStorage` guard 后调用 `window.location.reload()`；存储不可用、guard 已存在或 reload 后仍命中旧构建时保持不可用状态。该路径不得重试 issue 请求、映射到其他 kind、恢复退休 wire name，或使用 JSON/文本 challenge fallback。
