# 普通账号 Session 认证上下文

本文档定义普通账号 `UserSession` 的登录来源、认证时效、step-up proof、Cookie 持续时间与会话列表隐私边界。独立的 admin principal/session 平面不复用这里的字段或 proof。

## 安全不变量

- Session 记录的是“该会话最初如何完成认证”，不是“此后所有敏感操作均已授权”。
- `MfaVerified` 和 JWT `mfa` 只允许作为迁移兼容、粗粒度策略与审计信号；它们不是敏感操作的充分证明。
- 敏感操作必须使用绑定账号、当前 Session 和 action 的短期一次性 proof。Refresh 不复制、不续期也不重新签发该 proof。
- Passkey 来源只保存内部 `passkey_credential` 行 ID；原始 credential ID 不进入 JWT、URL、日志、telemetry 或普通会话列表。
- 所有认证与 step-up 时间均按 UTC 写入和比较。无效枚举、缺失认证时间、缺失当前 Session 或数据库/JWT Session 不一致时 fail closed。

## 字段与登录来源

字段列表、认证方法、认证强度及它们的 current 关系由下方 generated sections 与 controlled prose claims 承载。本节只保留设计理由：Session 记录初始认证来源，敏感操作仍需要单独的 action-bound proof。

## JWT 与 Refresh

请求验证以服务端 active Session 为权威；JWT 不是一次性 proof 或 credential 秘密的保存处。精确保留字段与不保留字段见下方 generated refresh context。

Refresh 的保留与禁止关系不在此手写，由下方 refresh generated section 与 directional claims 唯一承载。

## Action-bound step-up proof

敏感操作使用 action-bound proof。精确 binding 集合与 consume-once 关系只由下方 generated section 和 directional claims 承载。

Step-up freshness 的精确配置键、默认值与范围由下方 generated section 唯一承载。审计投影不代替 proof cache 的一次性状态。

## Duration policy 与 Cookie

Duration mode、Cookie 投影及 idle/absolute policy 的精确枚举和时长均由下方 generated sections 唯一承载；本节不保留手写兼容表。

## 会话列表隐私

`GET /api/binary/auth/sessions` 只返回账号自己的 active Session，并限制为安全展示所需的最小信息：

- Session 的公开撤销标识和是否为当前 Session；
- 设备粗粒度标签；
- 创建时间、最近活动时间；
- 登录方法、持续时间策略；
- 若存在，仅返回 Passkey 友好名称。

不得返回内部 `AuthenticatedCredentialRowId`、原始 WebAuthn credential ID、Refresh Token、JWT、proof、原始 IP、完整 User-Agent、精确认证器/设备指纹或可跨站关联的高熵标识。底层缺少凭据行或友好名称时显示稳定的低信息量 fallback，不得回退输出内部 ID。列表中的认证强度/MFA 展示不能成为授权决定；敏感操作仍重新验证当前 Session 并消费 action-bound proof。

## Migration 与验收边界

迁移期状态不是 current auth 枚举的兼容副本。详细迁移机制与运行验收由 database migration 文档和 executable tests 承载；本 current authority 不再手写迁移映射、精确时长或验收矩阵。

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

### Generated session, credential, MFA and step-up facts

<!-- fsus-doc-claim
claimId: authentication-session-permission.idle-expiry-policy
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.session.idle-expiry-policy
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.session.idle-expiry-policy -->
| Key | Value |
| --- | --- |
| admin | 8 hours |
| browser_session | 7 days |
| persistent_30d | 30 days |
<!-- FSUSBLOG-GENERATED:END auth.session.idle-expiry-policy -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.absolute-expiry-policy
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.session.absolute-expiry-policy
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.session.absolute-expiry-policy -->
| Key | Value |
| --- | --- |
| admin | 12 hours |
| browser_session | 30 days |
| persistent_30d | 90 days |
<!-- FSUSBLOG-GENERATED:END auth.session.absolute-expiry-policy -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.refresh-context-table
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.session.refresh-context
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.session.refresh-context -->
| Key | Value |
| --- | --- |
| doesNotPreserve | ["access_token","last_step_up_at","last_step_up_method","refresh_token","step_up_proof"] |
| mayUpdate | ["idle_expires_at","last_seen_at","refresh_generation","refresh_token_hash","session_mode"] |
| preserves | ["auth_method","auth_strength","auth_time","authenticated_credential_row_id","duration_policy"] |
<!-- FSUSBLOG-GENERATED:END auth.session.refresh-context -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.step-up-freshness
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.step-up.freshness
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.step-up.freshness -->
| Key | Value |
| --- | --- |
| configurationKey | Security:StepUp:FreshnessMinutes |
| default | 5 minutes |
| maximum | 15 minutes |
| minimum | 1 minutes |
<!-- FSUSBLOG-GENERATED:END auth.step-up.freshness -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.step-up-binding-table
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.step-up.binding
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.step-up.binding -->
- `account`
- `account_subject`
- `action`
- `expiry`
- `session`
- `token`
<!-- FSUSBLOG-GENERATED:END auth.step-up.binding -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.passkey-states
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.passkey.states
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.passkey.states -->
| Key | Value |
| --- | --- |
| credentialPresence | ["absent","present"] |
| enrollment | ["cancelled","completed","completing","expired","pending"] |
<!-- FSUSBLOG-GENERATED:END auth.passkey.states -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.mfa-states
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.mfa.states
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.mfa.states -->
- `disabled`
- `enabled`
- `pending_enrollment`
<!-- FSUSBLOG-GENERATED:END auth.mfa.states -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.recovery-states
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.recovery.states
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.recovery.states -->
- `active`
- `revoked`
- `used`
<!-- FSUSBLOG-GENERATED:END auth.recovery.states -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.credential-session-revocation
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.credential-session-revocation
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.credential-session-revocation -->
| Key | Value |
| --- | --- |
| failureModes | ["admin_principal_disabled","authentication_context_mismatch","refresh_token_replay","session_absolute_expired","session_idle_expired","session_mismatch","session_revoked","step_up_proof_consumed","step_up_proof_invalid"] |
| transitions | {"account_ban":{"effect":"refresh_reissues_restricted","from":"session_mode_normal","to":"session_mode_restricted"},"account_delete":{"effect":"mode_revoked","from":"sessions_active","to":"sessions_revoked"},"admin_principal_disable":{"effect":"login_and_step_up_denied","from":"principal_active","to":"principal_disabled"},"passkey_counter_risk":{"effect":"revoke_sessions_bound_to_credential","from":"credential_present","to":"credential_present"},"passkey_delete":{"effect":"revoke_sessions_bound_to_credential","from":"credential_present","to":"credential_absent"},"recovery_key_verify_with_session_revoke":{"effect":"optional_passkey_revoke","from":"sessions_active","to":"sessions_revoked"},"refresh_token_replay":{"effect":"compromise_refresh_family","from":"family_active","to":"family_revoked"},"session_logout_or_revoke":{"effect":"publish_revocation_snapshot","from":"session_active","to":"session_revoked"}} |
<!-- FSUSBLOG-GENERATED:END auth.credential-session-revocation -->

### Verified directional authentication relations

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.mfa-enabled-step-up-method
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.mfaEnabledStepUpMethod
render: relation-subject-predicate-object
-->

`auth.relation.mfa-enabled-step-up-method`：`auth.mfa.state.enabled` conditional `permits-proof-method` `auth.step-up.mfa-proof`；condition 为 `account is active and the requested credential mutation accepts the MFA proof method`，scope 为 `current-account`、`bound-session`、`declared-action`、`declared-subject`。

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.passkey-auth-strength
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.passkeyAuthStrength
render: relation-subject-predicate-object
-->

`auth.relation.passkey-auth-strength`：`auth.method.passkey` `results-in` `webauthn_uv`；condition 为 `successful user-verifying Passkey assertion`，scope 为 `current-account`、`bound-session`、`declared-action`、`declared-subject`。

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.passkey-is-not-totp
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.passkeyIsNotTotp
render: relation-subject-predicate-object
-->

`auth.relation.passkey-is-not-totp`：`auth.method.passkey` does not `is-equivalent-to` `auth.method.totp`；condition 为 `all authentication and step-up scopes`，scope 为 `current-account`、`bound-session`、`declared-action`、`declared-subject`。

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.recovery-auth-strength
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.recoveryAuthStrength
render: relation-subject-predicate-object
-->

`auth.relation.recovery-auth-strength`：`auth.method.recovery_key` `results-in` `auth.strength.recovery`；condition 为 `successful Recovery Key login completion`，scope 为 `current-account`、`bound-session`、`declared-action`、`declared-subject`。

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.recovery-does-not-mint-step-up
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.recoveryDoesNotMintStepUp
render: relation-subject-predicate-object
-->

`auth.relation.recovery-does-not-mint-step-up`：`auth.recovery.completion` does not `mints` `auth.step-up.proof`；condition 为 `successful Recovery Key login completion without a separate step-up flow`，scope 为 `current-account`、`bound-session`、`declared-action`、`declared-subject`。

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.step-up-binding
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.stepUpBinding
render: relation-subject-predicate-object
-->

`auth.relation.step-up-binding`：`auth.step-up.proof` `is-bound-to` `account+session+action+token+expiry`；condition 为 `proof validation and consumption`，scope 为 `current-account`、`bound-session`、`declared-action`、`declared-subject`。

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.step-up-consume-once
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.stepUpConsumeOnce
render: relation-subject-predicate-object
-->

`auth.relation.step-up-consume-once`：`auth.step-up.proof` `may-be-consumed` `exactly-once`；condition 为 `matching account, session, action, token, and unexpired proof`，scope 为 `current-account`、`bound-session`、`declared-action`、`declared-subject`。

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.refresh-preserves-auth-context
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.refreshPreservesAuthContext
render: relation-subject-predicate-object
-->

`auth.relation.refresh-preserves-auth-context`：`auth.refresh.rotation` `preserves` `auth_method+auth_strength+auth_time+duration_policy+authenticated_credential_row_id`；condition 为 `active session context passes fail-closed validation`，scope 为 `current-account`、`bound-session`、`declared-action`、`declared-subject`。

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.refresh-does-not-rebuild-step-up
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.refreshDoesNotRebuildStepUp
render: relation-subject-predicate-object
-->

`auth.relation.refresh-does-not-rebuild-step-up`：`auth.refresh.rotation` does not `rebuilds-or-extends` `auth.step-up.proof`；condition 为 `all refresh rotations`，scope 为 `current-account`、`bound-session`、`declared-action`、`declared-subject`。

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.passkey-delete-revokes-bound-sessions
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.passkeyDeleteRevokesBoundSessions
render: relation-subject-predicate-object
-->

`auth.relation.passkey-delete-revokes-bound-sessions`：`auth.passkey.credential-delete` `revokes` `sessions-bound-to-deleted-credential`；condition 为 `credential row is deleted successfully`，scope 为 `current-account`、`bound-session`、`declared-action`、`declared-subject`。

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.passkey-delete-does-not-revoke-unbound-sessions
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.passkeyDeleteDoesNotRevokeUnboundSessions
render: relation-subject-predicate-object
-->

`auth.relation.passkey-delete-does-not-revoke-unbound-sessions`：`auth.passkey.credential-delete` does not `revokes` `all-account-sessions`；condition 为 `credential row is deleted successfully`，scope 为 `current-account`、`bound-session`、`declared-action`、`declared-subject`。
