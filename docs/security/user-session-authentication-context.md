# 普通账号 Session 认证上下文

本文档定义普通账号 `UserSession` 的登录来源、认证时效、step-up proof、Cookie 持续时间与会话列表隐私边界。独立的 admin principal/session 平面不复用这里的字段或 proof。

## 安全不变量

- Session 记录的是“该会话最初如何完成认证”，不是“此后所有敏感操作均已授权”。
- `MfaVerified` 和 JWT `mfa` 只允许作为迁移兼容、粗粒度策略与审计信号；它们不是敏感操作的充分证明。
- 敏感操作必须使用绑定账号、当前 Session 和 action 的短期一次性 proof。Refresh 不复制、不续期也不重新签发该 proof。
- Passkey 来源只保存内部 `passkey_credential` 行 ID；原始 credential ID 不进入 JWT、URL、日志、telemetry 或普通会话列表。
- 所有认证与 step-up 时间均按 UTC 写入和比较。无效枚举、缺失认证时间、缺失当前 Session 或数据库/JWT Session 不一致时 fail closed。

## 持久化字段

| 字段 | 值域或格式 | 语义 | 禁止用途 |
| --- | --- | --- | --- |
| `AuthenticationMethod` | `passkey`、`recovery_key`、`enrollment`、`other` | 初始登录或注册完成路径 | 不作为当前 step-up 证明 |
| `AuthenticationStrength` | `webauthn_uv`、`mfa`、`recovery`、`legacy_verified`、`legacy_unverified` | 初始认证强度的稳定分类 | `legacy_verified` 不得解释为永久 MFA |
| `AuthenticatedAtUtc` | UTC timestamp | 初始认证发生时间；refresh 后保持不变 | 不得改写为 refresh 时间 |
| `AuthenticatedCredentialRowId` | nullable internal integer | 创建 Session 的 Passkey 内部行 ID | 不得作为公开 credential ID |
| `LastStepUpAtUtc` | nullable UTC timestamp | 最近成功签发 step-up proof 的审计时间 | 不得代替 proof cache 的一次性状态 |
| `LastStepUpMethod` | nullable stable method | 最近 step-up 方法的低基数审计分类 | 不得用于绕过 action/session 绑定 |
| `DurationPolicy` | `browser_session`、`persistent_30d` | Cookie 与服务端 idle/absolute TTL 的选择 | 不得由客户端任意字符串扩展 |

`RememberMe` 与 `MfaVerified` 可在兼容窗口保留为数据库投影，但所有新签发、refresh 和授权必须以认证上下文及一次性 proof 为准。

## 登录来源映射

| 流程 | Method | Strength | Credential row |
| --- | --- | --- | --- |
| Passkey 登录 | `passkey` | `webauthn_uv` | 成功 assertion 对应的内部行 ID |
| 匿名账号首枚 Passkey enrollment 完成 | `enrollment` | `webauthn_uv` | 新插入凭据的内部行 ID |
| TOTP/MFA 登录完成 | `other` | `mfa` | `null` |
| Recovery Key 登录完成 | `recovery_key` | `recovery` | `null` |
| 迁移期旧会话 | `other` | `legacy_verified` 或 `legacy_unverified` | `null` |

不同 Passkey 可以为同一账号创建不同 Session。凭据内部行 ID 允许服务端在凭据删除、暂停或 counter risk 处置时精确定位相关 Session，但不能把 Passkey 等同账号，也不要求每个 Session 都绑定 Passkey。

## JWT 与 Refresh

普通账号 access JWT 可以携带以下粗粒度认证上下文：

- `sid`：当前 Session ID，用于服务端权威 Session 回查；
- `auth_method`：初始认证方法；
- `auth_strength`：初始认证强度；
- `auth_time`：初始认证时间的 Unix seconds；
- `mfa`：从 `webauthn_uv`、`mfa` 或 `recovery` 派生的兼容位。

JWT 不携带 `AuthenticatedCredentialRowId`、`LastStepUpAtUtc`、`LastStepUpMethod`、proof token 或 Refresh Token。请求验证仍以 PostgreSQL/Session cache 的 active Session 为权威；claim 与数据库 Session 不一致时拒绝。

Refresh rotation 必须先验证 Session 的方法、强度、认证时间和持续时间策略，再原样保留 `auth_method`、`auth_strength` 与 `auth_time`。Refresh 只轮换 access/refresh token 并在 absolute deadline 内推进 idle deadline；它不得把 `LastStepUpAtUtc` 写入 JWT，不得因旧 `MfaVerified=true` 生成新 step-up，也不得延长或重建已消费/过期 proof。

## Action-bound step-up proof

普通账号敏感操作继续使用现有 `X-Fsus-Mfa-Proof` 通道。proof 必须同时绑定：

```text
accountId
accountSubjectHash
current sessionId
action
random 32-byte token
expiry
```

服务端只保存上述绑定材料的哈希 identity；校验通过后原子 consume-once。缺少当前 `sid`、跨账号、跨 Session、跨 action、过期、复用或 token 不匹配均拒绝，且不得进入业务 handler。

`Security:StepUp:FreshnessMinutes` 默认 `5`。服务在每次签发时读取配置，允许范围为 `1..15` 分钟；调用方请求的 TTL 更短时取更短值，不能通过更长调用方 TTL 绕过 freshness。`LastStepUpAtUtc` / `LastStepUpMethod` 只记录低基数审计事实，删除该记录不会恢复 proof，保留该记录也不会使 proof 再次有效。

## Duration policy 与 Cookie

`rememberMe` 只作为旧请求字段映射到明确策略：

| 请求 | DurationPolicy | Cookie | 服务端 idle / absolute |
| --- | --- | --- | --- |
| `rememberMe=false` | `browser_session` | access、refresh、session Cookie 均不设置持久 `Expires`/`Max-Age` | 7 天 / 30 天上限；浏览器关闭后因 session Cookie 消失而不可继续使用 |
| `rememberMe=true` | `persistent_30d` | access Cookie 到 access-token expiry；refresh/session Cookie 到当前 idle deadline | 30 天 / 90 天上限 |

两种策略都保留 HttpOnly、SameSite、Secure/`__Host-` 与 path 边界。`browser_session` 的数据库行可以在清理窗口内继续存在，但浏览器关闭后不能靠服务端行重新构造缺失的 Cookie。Refresh 必须沿用 Session 已持久化的 `DurationPolicy`；无效或未知策略清 Cookie 并要求重新登录。

## 会话列表隐私

`GET /api/binary/auth/sessions` 只返回账号自己的 active Session，并限制为安全展示所需的最小信息：

- Session 的公开撤销标识和是否为当前 Session；
- 设备粗粒度标签；
- 创建时间、最近活动时间；
- 登录方法、持续时间策略；
- 若存在，仅返回 Passkey 友好名称。

不得返回内部 `AuthenticatedCredentialRowId`、原始 WebAuthn credential ID、Refresh Token、JWT、proof、原始 IP、完整 User-Agent、精确认证器/设备指纹或可跨站关联的高熵标识。底层缺少凭据行或友好名称时显示稳定的低信息量 fallback，不得回退输出内部 ID。列表中的认证强度/MFA 展示不能成为授权决定；敏感操作仍重新验证当前 Session 并消费 action-bound proof。

## Legacy migration

`20260720-pre-user-session-authentication-context` 是 additive、事务性 pre-code-first migration：

1. 为 `sys_user_session` 增加认证方法、强度、认证时间、凭据来源、最近 step-up 与持续时间字段；
2. 旧 `MfaVerified=true` 映射为 `other / legacy_verified`，false 映射为 `other / legacy_unverified`；
3. 旧 `RememberMe=true` 映射为 `persistent_30d`，false 映射为 `browser_session`；
4. 认证时间优先使用既有值，其次使用 Session 创建时间；
5. 迁移后核心字段设为非空并提供保守默认值。

`legacy_verified` 仅说明旧行曾记录 MFA 布尔值。迁移不会制造 credential 关联、fresh step-up 或新的认证时间，也不允许 refresh 把它提升为 `mfa`。无法形成有效认证上下文的 Session 在 refresh 时 fail closed，用户重新登录后得到原生上下文。

迁移窗口内不删除旧列。回退版本可以忽略新增列，但不得重新把 `MfaVerified` 当作长期敏感操作授权。

## 风险与无需重启回退

主要风险及控制如下：

- **上下文漂移**：JWT 与数据库认证上下文不一致时拒绝并清理普通账号 Cookie，不猜测或降级。
- **旧客户端 Cookie 语义**：旧持久 Cookie 不能在响应外原地变成 session Cookie；撤销受影响 Session 后要求重新登录，用新策略重写 Cookie。
- **proof 窗口过宽**：通过 reload-capable 配置把 `Security:StepUp:FreshnessMinutes` 热更新为 `1`，使后续签发立即缩短；既有 proof 最多按原 5 分钟 TTL 自然过期。需要立即止血时撤销受影响 Session，使绑定该 Session 的请求无法通过认证；不需要重启，也不恢复 password fallback。
- **凭据来源或列表投影异常**：隐藏友好名称/认证来源展示并保留服务端 Session 校验；不得输出内部 credential ID 作为 fallback。
- **候选版本异常**：从流量入口摘除候选 slot、切回 last-known-good serving slot；保留 additive columns。随后撤销受影响 Session，不能通过恢复永久 `MfaVerified`、放宽 sid 校验或延长 proof 来回退。

## 验收场景矩阵

| 场景 | 必须验证 |
| --- | --- |
| 匿名请求 | 未认证请求不能列出/refresh/revoke Session，也不能签发 user step-up proof；匿名 enrollment 完成只创建 `enrollment / webauthn_uv` browser Session |
| 登录请求 | Passkey、TOTP、Recovery Key 分别写入正确来源；不同 Passkey 的内部行关联不同；browser/persistent Cookie 属性与 TTL 一致 |
| Refresh | 保持初始 `auth_method`、`auth_strength`、`auth_time`，不延长 step-up；无效上下文或 sid/refresh 不匹配 fail closed |
| 敏感操作 | proof 跨 account/session/action、过期和重放全部失败；默认 5 分钟和热更新后的 freshness 生效 |
| Session list | 只显示粗粒度设备信息、登录来源、友好名称和 duration；无 credential ID、raw IP/token/JWT/proof/精确指纹 |
| 凭据处置 | 删除或暂停凭据可按内部行 ID 定位相关 Session；不得误撤销同账号其他凭据创建的 Session |
| admin 请求 | 独立 `admin_session`、admin Passkey 和 `admin-sensitive` proof 语义不被普通账号上下文替代 |
| notification stream | Session 撤销继续只按账号发布低信息量事件，不携带 session/credential 标识；客户端回查服务端权威状态 |
| binary | auth/session/MFA/Passkey 只走 AEDS；错误使用稳定低信息量类别，不增加公开 JSON fallback |
| migration | legacy true/false 与 remember-me 行正确回填；迁移重复执行安全；旧行不会获得永久 step-up |

## Current session duration modes

<!-- fsus-doc-claim
claimId: authentication-session-permission.duration-modes
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.session.duration-modes
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.session.duration-modes -->
- `browser_session`
- `persistent_30d`
<!-- FSUSBLOG-GENERATED:END auth.session.duration-modes -->
