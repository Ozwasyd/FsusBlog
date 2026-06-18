# RiskControl production tracking plan

本文档是 RiskControl Control Plane 的生产跟踪计划。它只固定架构、顺序和验收边界；具体实现仍由后续子 issue 独立交付、独立测试、独立验收。

## Production architecture

```text
Risk Signal -> Risk Score -> Risk Decision -> Challenge Orchestration -> Proof Verification -> Enforcement -> Audit / Metrics / Admin Policy
```

最终目标是把 PoW、RateLimiter、AntiCrawler、HumanReadProof、Passkey step-up、匿名评论和 notification stream 的风险信号收敛到同一个决策面：

- Risk Signal：按 action、source、reason、device fingerprint、viewer identity 和 route 汇总输入。
- Risk Score：把事件窗口、历史失败、速率、设备可信度和 proof 结果转换为可解释风险分。
- Risk Decision：输出 allow、challenge、step-up、block、shadow-audit 等裁决，不在端点里散落条件分支。
- Challenge Orchestration：按策略选择 Sha256Pow、CaptchaV1、PoSpace、Passkey step-up 或后续 provider。
- Proof Verification：所有 proof 一次性消费，绑定 action、subject、device、IP/UA hash、challenge id 和过期时间。
- Enforcement：Minimal API filter / middleware 执行裁决；业务 handler 只处理已通过的请求。
- Audit / Metrics / Admin Policy：策略版本、模拟器、事件、readiness、rollback 和审计全部进入后台安全控制面。

## Contract rules

- AEDS / binary contract first：新公开安全交互优先通过 `/api/binary/**` frame 暴露。
- no public JSON fallback：不得为了 RiskControl 新增公开 JSON fallback；内部 bridge 仍必须保持 admin-only、binary-bridge internal-only。
- 所有策略必须有 observe / enforce / strict 或等价降级路径；生产 readiness 必须能区分配置缺失、disabled 和 fail-closed。
- 每个子 issue 只交付自己的最小实现单元，不抢跑后续 provider、UI 或策略持久化。
- 子 issue 的测试必须覆盖匿名请求、登录请求、admin 请求、notification stream 和 binary 边界中与该 issue 有关的路径。

## Action registry baseline

RiskControl action 名称集中由 `RiskActionNames` 定义。首批生产 action 为 `public.read`、`comment.create`、`comment.reply`、`auth.login`、`auth.passkey.begin`、`auth.passkey.complete`、`recovery-key.verify`、`notification.subscribe`、`admin.security.write` 和 `admin.comment.batch`。Endpoint 必须通过 `WithRiskAction(...)` 或等价 metadata 声明 action / routeKey；测试和开发环境可以用 `RiskActionRegistry.FindMissingActionMetadata(...)` 扫描受保护 endpoint 的缺失声明。

## Context factory baseline

`RiskControlContextFactory` 是后续 Risk Score / Decision 的唯一请求上下文抽取入口。它只读取 `HttpContext` 中已经归一或显式标记的字段：客户端 IP 使用 `GetClientIp()`，因此不会直接信任 raw `X-Forwarded-For` / `X-Real-IP`；UA 使用 `GetUserAgent()` 并保留 missing/present 状态；action / routeKey 来自 endpoint `RiskActionEndpointMetadata`；actor 从 `ClaimTypes.NameIdentifier`、`identity_kind`、`sid`、`admin_id` 和 `admin_sid` claim 解析；`VerifiedCrawler` / `SocialPreviewBot` 只读取 `HttpContext.Items` 中由反爬虫中间件设置的布尔标记。`X-Fsus-Device-Fp` 会先做长度和字符集校验，只输出状态、长度和 SHA-256 hash，不保留 raw 值；region 只作为请求 hint 归一为短字符串并带来源，不参与法律地区裁决。

## Policy snapshot v2 baseline

`SecurityRiskPolicySnapshotV2` 固定生产 RiskControl 的策略外形：全局模式为 `disabled`、`observe`、`enforce`、`strict` 或 `lockdown`；每个 action 可覆盖 allow / challenge / hardChallenge / queue / block 阈值、challenge kind、escalation level 和匿名写入锁定语义；snapshot 带 `PolicyVersion`、`LastKnownGoodSnapshotId`、子系统模式和 max risk score。迁移期 `SecurityRiskPolicySnapshotV2Adapter` 从现有 AntiCrawler / PoW runtime snapshot 生成 V2，并把 V2 投影回旧 `SecurityRiskPolicySnapshot`，保持 `RiskAwarePublicReadFilter` 的旧读取路径不变。默认 public-read 行为与旧逻辑等价：低于 `RequireChallengeScore` 放行，达到后要求 `security.pow`，达到 `BlockScore` 后 block；observe 只记录不执行挑战或拦截；strict 使用风险权重提前触发阈值；lockdown 在后续 filter 接入时用于关闭匿名写入。

## Decision service baseline

`RiskDecisionService` 把 `RiskControlContext`、`SecurityRiskPolicySnapshotV2` 和当前风险分转换为 `RiskDecision`。业务 filter / middleware 不再内联阈值判断，只根据 `RiskDecisionKind` 执行已有 proof 校验、排队、限流或拦截。`RiskAwarePublicReadFilter` 是迁移期第一个接入点：verified crawler 与 social preview bot 继续直接 allow；public-read 低于 challenge 阈值 allow，达到阈值返回 challenge，达到 block 阈值返回 block；PoW proof 的签发与校验仍由旧 PoW 服务负责，后续 challenge orchestrator 再替换。

## Ordered implementation units

| Order | Unit | Issue | Acceptance boundary |
|---:|---|---|---|
| 1 | Risk action registry | #459 | Protected flows have stable action ids, owner, subject type, default policy and binary/admin labels. |
| 2 | Risk control context factory | #460 | Request, viewer, device, route and admin context are normalized before scoring. |
| 3 | Risk policy snapshot v2 | #461 | Versioned modes, thresholds, provider toggles and rollout metadata are represented without changing old public APIs. |
| 4 | Risk decision service | #462 | Score inputs produce allow/challenge/block decisions with reason codes and no endpoint-specific scoring. |
| 5 | Security challenge contract | #463 | Challenge assignment and proof envelopes have AEDS frame contracts and validation constants. |
| 6 | Challenge persistence schema | #464 | Durable challenge state supports expiry, attempt limits, consumed state and audit-friendly metadata. |
| 7 | Challenge proof token service | #465 | Proof token is one-time, action-bound and replay-resistant. |
| 8 | Challenge orchestrator | #466 | Provider selection, assignment creation and verification flow through one service interface. |
| 9 | PoW provider migration | #467 | Legacy PoW becomes Sha256Pow provider without changing existing proof semantics. |
| 10 | RequiresRiskControlFilter | #468 | New filter executes RiskControl decisions; legacy RequiresPowFilter remains as compatibility wrapper. |
| 11 | CaptchaV1 backend | #470 | Captcha provider is server-verifiable and disabled-by-default until policy enables it. |
| 12 | CaptchaV1 frontend | #471 | FsusUI challenge component and worker can solve/display assignment without endpoint-specific glue. |
| 13 | CaptchaV1 integration policy | #472 | Auth/comment escalation rules choose CaptchaV1 only through RiskControl policy. |
| 14 | PoSpace contract/provider | #473 | Argon2idPoSpaceV1 provider is behind disabled-by-default policy and explicit resource limits. |
| 15 | PoSpace frontend worker | #474 | Device capability gate and worker execution are isolated from business forms. |
| 16 | HumanReadProof risk integration | #476 | Read proof lowers risk or adds negative signals only; it does not become identity proof. |
| 17 | Auth/recovery risk integration | #478 | Login, passkey and recovery flows route through action ids and challenge decisions. |
| 18 | Anonymous comment risk integration | #480 | Anonymous create/reply uses RiskControl before comment persistence. |
| 19 | Notification stream risk integration | #481 | Anonymous stream gating uses RiskControl challenge policy while preserving AEDS/WebSocket semantics. |
| 20 | Admin risk console | #490 | `/user/manage/security` exposes policy, events and challenges without bypassing admin principal checks. |
| 21 | Risk simulator | #492 | Admin can simulate action/context inputs and see decision reasons without mutating state. |
| 22 | Metrics/audit/readiness | #494 | RiskControl emits structured logs, metrics, audit events and readiness checks. |
| 23 | Full test matrix | #495 | Unit, integration, E2E and performance gates cover the control plane and provider fallbacks. |
| 24 | Production rollout gates | #498 | Rollout policy defines observe-first, emergency disable, fail-closed and rollback criteria. |

## Dependency notes

- #469 challenge issue/verify endpoints land after the core filter/orchestrator shape is clear and before Captcha/PoSpace providers depend on runtime assignment APIs.
- Privacy/ZK anonymous comment work (#475, #477, #479, #482, #483-#503) depends on the RiskControl action/context/challenge foundation but keeps its own credential, ticket and proof acceptance criteria.
- Later security changes must update this table if they insert a new prerequisite before an existing unit.
