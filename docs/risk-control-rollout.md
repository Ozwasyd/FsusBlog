# RiskControl production rollout gates

本文档定义 RiskControl 生产上线顺序、降级开关、故障处置和回滚边界。它不引入新的代码开关；所有名称必须与当前运行时配置、策略快照或 header 契约一致。

## Runtime controls

RiskControl 的运行控制来自三层：

| Layer | Current source | Names |
| --- | --- | --- |
| Global / action policy | `security_policy_snapshot` active `SecurityRiskPolicySnapshotV2` | `GlobalMode`, action `ModeOverride`, `ActionOverrides`, `SubsystemModes`, `LastKnownGoodSnapshotId` |
| Config fallback | app configuration | `AntiCrawler:Mode`, `Security:AntiCrawler:Mode`, `Pow:Mode`, `Security:PoSpaceV1:Mode`, `Security:Risk:RequireChallengeScore`, `Security:Risk:BlockScore`, `Security:Risk:MaxRiskScore`, `Security:Risk:DefaultRiskTtlSeconds`, `Security:Risk:ZeroRiskCacheTtlSeconds` |
| Provider config | app configuration and DI | `Security:CaptchaV1:SigningKey` or `Jwt:SecretKey`, `Security:PoSpaceV1:MemoryKib`, `Security:PoSpaceV1:Iterations`, `Security:PoSpaceV1:Lanes`, `Security:PoSpaceV1:TargetDurationMs`, registered `ISecurityChallengeProvider` implementations |

Valid system modes are exactly `disabled`, `observe`, `enforce`, `strict` and `lockdown`.

- `disabled`: decision layer allows traffic for that policy scope and does not enforce challenges from that scope.
- `observe`: computes and records would-have-enforced outcomes, but does not require challenge proof or block.
- `enforce`: production default for enabled scopes; challenge, step-up, queue, throttle and block are enforced.
- `strict`: enforcing mode with higher effective risk weighting.
- `lockdown`: enforcing mode that can block anonymous writes when `AnonymousWriteAllowed=false`.

Default `SecurityRiskPolicySnapshotV2` action policies use the `perception-sealed@v2` decision matrix. The base score bands are 0-19 allow, 20-39 `sha256PowV1`, 40-59 `perceptionTextTaskV2`, 60-79 `perceptionLocalizationV2 + sha256PowV1`, 80-89 action-specific critical routing, and 90+ block. The 80-89 band routes `public.read` and `recovery-key.verify` to throttle, `comment.create` / `comment.reply` to moderation queue, `notification.subscribe` to `argon2idPoSpaceV1` only when PoSpace is enforcing, and `admin.security.write` to RiskControl admin step-up. Legacy `auth.login` policy may remain in stored snapshots for migration/test compatibility but no production endpoint consumes it. `recovery-key.verify` still has a 0-score `captchaV1` requirement, and anonymous `notification.subscribe` still has a 0-score `sha256PowV1` requirement.

## Rollout order

Move one stage at a time. Do not advance while the previous stage has elevated 4xx, provider error, replay, timeout or readiness regressions.

| Stage | Scope | Required gate |
| ---: | --- | --- |
| 1 | `observe` globally | `riskControl` readiness is ready; metrics and audit are visible; simulator matches expected decisions. |
| 2 | public-read enforce | `public.read` challenges are enforced only for dynamic public APIs; verified crawler and social preview paths still behave as documented. |
| 3 | auth enforce | `auth.passkey.begin`, `auth.passkey.complete` and `recovery-key.verify` enforce their configured challenges; recovery key still keeps legacy PoW and no-store. |
| 4 | comment enforce | `comment.create` and `comment.reply` enforce challenge / queue / block semantics before persistence; high-risk queue writes `risk_control_queue`. |
| 5 | admin policy enforce | `admin.security.write` and admin policy mutation paths require admin principal, `system.config` and `X-Fsus-Mfa-Proof`; RiskControl proof never replaces admin step-up. |
| 6 | strict optional | Raise selected actions or global mode to `strict` only after stage 1-5 error budgets are stable. |

`lockdown` is an incident mode, not a normal rollout stage. Use it only when anonymous writes must be stopped while authenticated/admin operations remain available.

## Pre-production checklist

- Active policy has a non-empty `PolicyVersion`, a `LastKnownGoodSnapshotId`, explicit global mode and explicit action policies for `public.read`, `auth.passkey.begin`, `auth.passkey.complete`, `recovery-key.verify`, `comment.create`, `comment.reply`, `notification.subscribe`, `admin.security.write` and `admin.comment.batch`; legacy `auth.login` may exist only for migration/test compatibility.
- `Security:CaptchaV1:SigningKey` is set to at least 32 characters, or `Jwt:SecretKey` is valid and accepted as the signing fallback.
- `Security:PoSpaceV1:Mode` is intentionally `disabled`, `observe`, `enforce`, `strict` or `lockdown`; if enabled, `MemoryKib`, `Iterations`, `Lanes` and `TargetDurationMs` are inside the documented provider limits.
- Redis supports consume-once operations for `SecurityChallengeProof`, `SecurityCaptchaChallenge`, `SecurityPoSpaceChallenge`, legacy PoW and MFA proof caches.
- PostgreSQL migrations for `security_risk_event`, `security_policy_snapshot`, `security_challenge` and `security_challenge_attempt` are applied.
- `/api/ops/health/ready-detail` reports `riskControl` ready with active policy, last-known-good policy, Redis consume-once and provider registry checks passing.
- The admin simulator can dry-run public read, auth login, comment create/reply, notification subscribe and admin write contexts without mutating challenge state.
- Metrics are visible for `fsus.security.risk.event.count`, `fsus.security.decision.count`, `fsus.security.challenge.issued.count`, `fsus.security.challenge.verified.count`, `fsus.security.challenge.failed.count`, `fsus.security.challenge.replayed.count` and `fsus.security.challenge.solve.duration`.
- Alerts exist for provider missing, proof mint failure, replay spikes, Redis consume-once failure, policy snapshot load failure, challenge persistence failure and elevated 428 / 429 rates.
- HumanReadProof is confirmed to authorize only `public.read`; it must never satisfy `comment.*`, `auth.*` or `admin.*` required challenges.
- AdminPasskeyStepUp is confirmed separate: admin-sensitive writes use `X-Fsus-Mfa-Proof`; ordinary RiskControl proof uses `X-Fsus-Challenge-Proof` with `X-Fsus-Challenge-Id` and `X-Fsus-Challenge-Kind`. The RiskControl provider kind `adminPasskeyStepUpV1` must never mint or consume the admin-sensitive MFA proof cache entry.

## Fail-open / fail-closed matrix

| Failure | Public read | Auth / recovery | Comment write | Admin policy write | Required action |
| --- | --- | --- | --- | --- | --- |
| Redis unavailable for challenge proof consume-once | Fail closed when proof is required; otherwise follow current policy decision. | Fail closed. | Fail closed or queue only when current policy explicitly chose queue before proof. | Fail closed. | Do not bypass consume-once. Switch affected actions to `observe` only through an audited policy change. |
| PostgreSQL challenge persistence unavailable | Fail closed for challenge issue / verify because audit truth is unavailable. Risk event persistence failures outside challenge flow may fail open with structured fallback logging. | Fail closed. | Fail closed before persistence. | Fail closed. | Restore DB or activate last-known-good policy that avoids new challenges. |
| Active policy missing or corrupt | Readiness `not_ready`; runtime may use loaded last-known-good only if available. | Same. | Same. | Same. | Restore last-known-good `security_policy_snapshot`; do not invent inline defaults in endpoints. |
| No last-known-good policy | Readiness `not_ready`; do not promote. | Same. | Same. | Same. | Recreate policy snapshot through admin-controlled migration/runbook before exposing traffic. |
| Captcha provider missing or signing key invalid | Fail closed for actions requiring `captchaV1`. | Fail closed for recovery when `captchaV1` is required; legacy `auth.login` is not production-routable. | Fail closed for comment challenge; queue only if policy chooses queue without challenge. | Fail closed if required. | Remove `captchaV1` from active policy or switch affected actions to `observe`; fix `Security:CaptchaV1:SigningKey`. |
| PoSpace provider unavailable or disabled | Non-notification PoSpace challenge can fall back before issue; `notification.subscribe` critical route rejects instead of downgrading. | Same. | Same. | Same. | Keep `Security:PoSpaceV1:Mode=disabled` unless capacity tests pass; expect notification critical traffic to block while disabled. |
| PoSpace parameter out of bounds | Fail closed for PoSpace verify; decision should fall back before issue when subsystem disabled. | Same. | Same. | Same. | Restore valid `Security:PoSpaceV1:*` values or disable subsystem. |
| HumanReadProof unavailable | Public reads still render; read event proof may not lower risk or count views. | Not applicable. | Must not authorize writes. | Must not authorize writes. | Use `HumanReadProof:Mode=paused` only for read counting; never add it to write challenge requirements. |
| Challenge kind mismatch / expired / replayed proof | 428 when proof is required; no handler execution. | 428; no auth state change. | 428 before comment write. | 428 before policy write. | Treat as attack signal; do not retry with relaxed binding. |
| AdminPasskeyStepUp missing or expired | Not applicable. | Not applicable. | Not applicable unless endpoint is admin-sensitive. | 428 + `MFA_PROOF_REQUIRED`; no write. | Re-run `/api/binary/auth/admin/step-up/passkey/begin | complete`; never substitute`X-Fsus-Challenge-Proof` or `adminPasskeyStepUpV1` provider proof. |
| Provider timeout / exception | Fail closed when provider required. | Fail closed. | Fail closed or queue only if policy selected queue before provider issue. | Fail closed. | Switch affected policy scope to `observe` or restore last-known-good after incident approval. |

## Emergency switches

- Switch observe: activate a new `security_policy_snapshot` with `GlobalMode=observe` or targeted action `ModeOverride=observe`. This is the preferred live rollback because it preserves risk scoring, metrics and audit without requiring a process restart.
- Disable CaptchaV1: there is no `Security:CaptchaV1:Mode` runtime switch. Remove `captchaV1` from `ChallengeKind` / `HardChallengeKinds` or set affected actions to `observe`, then fix `Security:CaptchaV1:SigningKey` before re-enabling.
- Disable PoSpace: set `Security:PoSpaceV1:Mode=disabled` and keep `SubsystemModes["pospace"]="disabled"` in the active policy. The decision service can prefer `captchaV1` fallback for non-notification PoSpace-required decisions, but `notification.subscribe` critical routing rejects rather than issuing a substitute challenge.
- Pause HumanReadProof counting: set `HumanReadProof:Mode=paused`. This pauses read-event writes only; it does not grant write authorization and does not replace RiskControl challenge proof.
- Restore last-known-good policy: activate the snapshot referenced by `LastKnownGoodSnapshotId` or the most recent `is_last_known_good=true` record. Keep the rollback audit reason explicit and verify readiness after activation.
- AntiCrawler emergency observe: set `AntiCrawler:Mode=observe` or `Security:AntiCrawler:Mode=observe` for config fallback, or update the active policy subsystem/action mode if policy snapshots are already active.
- PoW compatibility fallback: keep legacy `X-Fsus-Pow-Proof` / `RequiresPowFilter` paths available during rollout; do not remove them while auth/comment RiskControl is still ramping.
- Lockdown anonymous writes: set selected write actions or global mode to `lockdown` only for active abuse incidents. Document the reason and exit criteria before enabling.

## Stage validation

Each stage must record:

- Active `PolicyVersion`, `GlobalMode`, relevant action modes and `SubsystemModes`.
- `/api/ops/health/ready-detail` `riskControl` result.
- Simulator samples for anonymous, authenticated and admin contexts.
- Challenge issue / verify counts, replay counts, provider failure counts and p95/p99 solve duration.
- 428 / 429 rate by action and routeKey.
- Redis and PostgreSQL error rate.
- Confirmation that admin writes still require `X-Fsus-Mfa-Proof`.
- Confirmation that HumanReadProof only affects `public.read` and risk score reduction.

Do not advance to the next stage until rollback has been tested in the same environment by switching the affected scope back to `observe` or restoring last-known-good policy.
