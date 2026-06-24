# 安全模型

本文档说明 FsusBlog 采用的安全机制及其实现要点。

## 纵深防御层次

```text
网络层      Nginx/OpenResty：SSL 终端、HTTPS 强制、未知 Host 拒绝、真实 IP 传递
传输层      HTTPS only（生产启动拒绝 HTTP CORS Origin）
应用层      PoW → 速率限制 → 认证 → MFA / Passkey → RBAC
数据层      BCrypt 密码哈希、JWT 短寿命、会话隔离、密码学安全随机数
客户端      SameSite Cookie、HttpOnly、Secure；CSP、XFO、XCTO、Referrer-Policy、Permissions-Policy；真人阅读 proof
```

## 安全密钥域隔离

`Jwt:SecretKey` 只用于 JWT 签发和校验，不能作为其他安全子系统的派生材料。生产启动校验要求以下配置项全部存在、长度至少 32 字符，且不得与 `Jwt:SecretKey` 相同：`Security:Pow:SigningKey`、`Security:CaptchaV1:SigningKey`、`Security:RecoveryKeyPepper`、`AnonymousCredentialIssuer:SubjectHashPepper`、`VisitLog:IpHashPepper`、`Moderation:RegionPolicy:IpHashKey`。缺失、模板值或跨域复用会使生产启动失败；运行时服务本身也会 fail closed，不回退到 JWT、本机名、应用目录或硬编码开发字面量。

这些密钥分别保护 PoW 签名、CaptchaV1 provider payload、Recovery Key lookup/hash、匿名凭证签发限频 subject hash、阅读 IP 匿名化和地区策略 IP hash。任一密钥泄露只允许影响其所属安全域；轮换时只替换对应配置并滚动重启，不应同步替换其他域密钥，除非有明确的泄露范围证据。

日志、审计、指标和 structured fallback 不得打印原始客户端 IP。需要关联访问来源时，只能写入由所属安全域 pepper 派生的 HMAC-SHA256 hash；PoW 验证日志统一使用 `VisitLog:IpHashPepper` 生成 `ClientIpHash`，不得回退到 raw `GetClientIp()`、`RemoteIpAddress`、`X-Forwarded-For` 或 `X-Real-IP`。

---

## Proof of Work (PoW)

在密码注册、登录等高风险操作之前，客户端须先解决 PoW 挑战，以提高批量自动化攻击的成本。

- 挑战端点：`GET /api/binary/auth/pow-challenge`（匿名，IP 速率限制，AEDS `PowChallenge` frame）
- 有效期：挑战存入 Redis，TTL 过期后自动失效
- 服务端验证：注册 / 登录端点在执行业务逻辑前校验 PoW 解答，失败拒绝请求
- IP 绑定：PoW proof 的 HMAC 签名和一次性 replay identity 只绑定 `GetClientIp()` 返回的规范化客户端 IP；PoW 层不探测 raw remote IP、localhost 或 Docker bridge gateway。代理迁移必须通过 `ForwardedHeadersMiddleware` 的 `ReverseProxy:KnownProxies` / `ReverseProxy:KnownNetworks` 配置修正。
- 日志隐私：PoW 内部异常和拒绝访问日志只能写 `ClientIpHash`，该值由 `VisitLog:IpHashPepper` 对规范化客户端 IP 做 HMAC-SHA256 生成；日志模板禁止出现 `{IP}` 或原始 IP 参数。
- 安全门控覆盖：缺失、篡改、重放形态的 PoW 请求不得产生 2xx，且不得写入业务状态。
- 难度语义：`difficulty` 表示 SHA-256 摘要的 bit 级前导零数量，而不是半字节 / nibble 数；默认阶梯为 16/20/24/28 bits。
- 客户端求解器：PoW 延迟优化只发生在 `src/frontend/wasm/pow` 的 C++23/Wasm 层，proof wire 格式与 Redis/HMAC 绑定语义不变。
- Wasm 分层：运行时按 `threads -> relaxed SIMD -> SIMD128 -> basic` 选择可用资产；任一高阶资产初始化或求解失败时自动降级到下一层，不影响 API 语义。
- 多核约束：threads 层只在 `crossOriginIsolated`、`SharedArrayBuffer` 和 Wasm atomics 可用时启用，worker 数上限为 `min(4, hardwareConcurrency - 1)`。

---

## 速率限制（Rate Limiting）

- 基础策略：`fixed_ip`（固定窗口，按客户端 IP 计数），作为认证、PoW、写入和审核端点的 fallback。
- 管理后台兜底策略：`fixed_ip` 只对独立 admin principal（`identity_kind=admin_principal` + `admin_id`）进入后台 fixed-window 分区；普通账号 token 的 `role=admin` 不会进入 admin 分区。后台写操作使用 `RateLimiting:AdminPermitLimit` / `RateLimiting:AdminQueueLimit`，边缘网关同时用 `fsus_admin_limit` 保护 `/api/binary/admin/**` 与 `/api/binary/author/**`。
- 公开读策略：`public_read` 按 `IP + path` 分区；verified search crawler 使用独立高额度分区，social preview bot 使用低额度公开 HTML/静态资源分区，普通匿名公开 API 使用中等配额。
- 强匿名评论 ticket 申请使用 `public_read` 分区，并额外要求强匿名请求不得携带 Cookie、session、Authorization 或其他登录态污染；污染失败返回 AEDS `ApiError`，业务 handler 不会执行。
- 真人阅读策略：`read_proof` 专门保护 `/api/binary/read-proof/challenge.aeds` 与 `/api/binary/read-proof/submit.aeds`，按 `IP + route` 或 `IP + deviceFp + route` 分区，避免匿名 challenge/submit 被无限打。旧 `/api/read-proof/**` JSON 路径已移除。
- 超限响应：`429 Too Many Requests`，响应头携带 `Retry-After`，并通过 `ISecurityRiskSignalSink` 写入 `RateLimited` 风险事件。
- 客户端 IP 提取：`GetClientIp()` 只读取 `ForwardedHeadersMiddleware` 按 `ReverseProxy:KnownProxies` / `ReverseProxy:KnownNetworks` 处理后的 `Connection.RemoteIpAddress`；业务代码不得直接信任原始 `X-Forwarded-For` / `X-Real-IP` 请求头。
- 受保护端点：PoW 挑战、匿名账号 bootstrap、Token 续签、Passkey 登录开始/完成、MFA challenge verify、Recovery Key verify、评论审核队列和单条/批量审核写入、ReadProof challenge/submit、RiskControl challenge issue/verify、公开评论读取、公开 taxonomy 与 related-reading。
- MFA challenge verify 的失败计数同时按 ticket、客户端 IP hash 和账号稳定 subject hash 累加；账号维度固定为 `fail:subject:{accountSubjectHash}`，不得恢复 `fail:user:{userId}`。`accountSubjectHash` 来自匿名账号快照或 ticket 内保存的 subject hash，短 TTL 旧 ticket 缺失该字段时只允许按 `legacy-account:{accountId}` fallback 重新派生。MFA failure audit context 使用 `AccountId` 与 `AccountSubjectHash`，不得写 `UserId`。

## 防爬虫闭环

`ShieldMiddleware` 在常规 endpoint 前分类处理请求：

- search crawler：`Googlebot` / `Google-InspectionTool` / `bingbot` / `msnbot` 先按 CIDR 验证，`Baiduspider` / `Sogou` 继续使用 rDNS + forward DNS；只有验证通过后才写 `HttpContext.Items["VerifiedCrawler"] = true`。`observe` 模式下验证失败会放行并记录 `FakeCrawler` 风险事件，但不得设置 verified crawler 标记或进入高额度限流分区。
- social preview bot：`Twitterbot`、`facebookexternalhit`、`Discordbot`、`Slackbot`、`TelegramBot`、`LinkedInBot`、`WhatsApp` 只允许公开 HTML、OG/静态资源、`robots.txt` 的 GET/HEAD，不允许访问 `/api/**`。
- unknown bot、工具型 UA、空 UA：返回轻量 403，记录 `fsus.security.event.count`，并向风险分写入原因；路径穿越、双斜杠、反斜杠和双重编码路径仍直接 `Abort()`，同时记录指标。

`CrawlerUpdateWorker` 按运行时策略快照加载搜索引擎 CIDR：远程官方 JSON（Google `googlebot.json`、Bing `bingbot.json`）→ 本地 last-known-good snapshot → `Security:CrawlerCidrs:*` 配置 → empty degraded。默认更新间隔为 1440 分钟，后台可热更新 `CidrAutoUpdateEnabled`、`CidrUpdateIntervalMinutes`、`CidrMinUpdateIntervalMinutes`、Google/Bing URL 和 snapshot path；最小间隔默认 30 分钟，避免管理员误设过低造成外部请求风暴。状态通过 admin-only ops probe `GET /api/ops/crawler-ranges/status` 和生产前端 `/api/binary/admin/security/anti-crawler/crawler-ranges/status` 暴露；后者额外返回自动更新开关、当前/最小 interval、下次同步时间和 worker 运行状态，并支持 `POST /api/binary/admin/security/anti-crawler/crawler-ranges/sync` 手动同步。

统一安全风险由 `ISecurityRiskSignalSink`、`ISecurityRiskScoreReader` 和 `ISecurityRiskPolicyProvider` 抽象承载；旧 `CrawlerRiskService` 只是兼容实现，不再代表反爬虫子系统。Shield 写入 `anti-crawler` 来源信号，RateLimiter 写入 `rate-limiter`，PoW 写入 `pow`，HumanReadProof 写入 `human-read-proof`，公开读过滤器写入 `public-read`，Passkey assertion 写入 `passkey`；legacy `auth` source 仅保留给迁移/测试期历史 password 登录信号，不对应生产 endpoint。生产 RiskControl 归因词表还保留稳定 source wire value：`captcha`、`pospace`、`device-fingerprint`、`region-policy`、`comment-governance`、`admin-step-up` 与 `risk-control`；reason 枚举追加在旧值之后，旧 `VerifiedCrawler` 到 `CommentNullifierAbuse` 的数值不得重排。新增稳定 reason 名包括 `CaptchaInvalid`、`CaptchaReplay`、`CaptchaSolveTooFast`、`DeviceFingerprintMissing`、`DeviceFingerprintChanged`、`RegionPolicyHit`、`CommentSpamPatternHit`、`AnonymousNullifierAbuse`、`AuthFailureBurst`、`PasskeyAssertionFailure`、`AdminStepUpRequired`、`AdminStepUpFailed`、`ChallengeExpired`、`ChallengeKindMismatch` 与 `ChallengeSignatureInvalid`；未知枚举值进入 sink 时必须按原始数值字符串记录，不得抛出。风险分仍落在 `SecurityPowRisk` key 上以保持 `AdaptivePowGovernor` 兼容；`SecurityRiskEventSink` 先写 Redis 热路径，再把事件以 `security_risk_event` 持久化到 PostgreSQL，表内保存 source/reason/action/score/TTL、subjectHash、routeKey、clientIpHash、deviceFpHash、path/method/userAgent/detail/traceId 等审计字段，不保存客户端 IP 原文或设备指纹原文。持久化失败不得影响业务判定，只写 `security-risk-persist-failed` structured fallback log；Redis miss 时按 PostgreSQL 事件剩余 TTL 线性衰减聚合并回填 `SecurityPowRisk` 热缓存。策略主形态是 `SecurityRiskPolicySnapshotV2`，`RiskDecisionService` 负责把 risk context、V2 策略和当前风险分转换为 allow/challenge/block 等裁决，旧 `SecurityRiskPolicySnapshot` 仅作为迁移期兼容投影保留。`RiskAwarePublicReadFilter` 已接入该裁决服务：风险分达到 `RequireChallengeScore` 时引用 `security.pow` challenge，达到 `BlockScore` 时返回 429。该策略只作用于动态公开 API，不影响 PublicHotRead artifact 命中路径。

RiskControl challenge 采用 Redis + PostgreSQL 双层职责：Redis 只承担一次性消费和低延迟热路径，PostgreSQL `security_challenge` / `security_challenge_attempt` 是签发、验证、失败、重放、过期和撤销的审计真源。持久化记录只保存 kind、algorithm、action、routeKey、subjectHash、clientIpHash、deviceFpHash、policyVersion、payloadHash、traceId、traceparent 和时间戳；不得保存 challenge payload 原文、proof 原文、客户端 IP 原文或设备指纹原文。状态集合固定为 `issued | verified | expired | replayed | failed | revoked`，provider / orchestrator 后续只能通过 `ISecurityChallengePersistenceService` 写入或转移状态，避免端点绕过审计链。签发、验证成功、验证失败、重放和解题耗时分别打到 `fsus.security.challenge.issued.count`、`fsus.security.challenge.verified.count`、`fsus.security.challenge.failed.count`、`fsus.security.challenge.replayed.count` 与 `fsus.security.challenge.solve.duration`，只使用 kind、action、policyVersion、outcome、reason 等低基数 tag。

RiskControl verify 的 endpoint-level attempt gate 由 `ISecurityChallengeVerifyRateLimiter` 承载，端点不得保存进程内静态 dictionary 或自行 prune。计数使用统一缓存 `SecurityChallengeVerifyRateLimit` policy，Redis identity 形态为 `verify:{windowStartTicks}:{clientIpHash}:{deviceFpHash}:{normalizedAction}:{challengeIdHash}`，TTL 为 2 分钟，窗口为 1 分钟，最多允许 3 次；key 不包含原始 IP、device fingerprint 或 challengeId。计数必须通过统一缓存原子 `INCRBY` + `PEXPIRE` primitive 完成，不允许 `GET` 后 `SET` 的 read-modify-write。超限时继续返回通用 challenge failure，并写 `SecurityChallengeRejected` 风险信号。

RiskControl proof token 使用 `X-Fsus-Challenge-Proof` header，不能替代 admin-sensitive `X-Fsus-Mfa-Proof`，也不迁移 legacy `X-Fsus-Pow-Proof`。`ISecurityChallengeProofService.MintProofAsync` 生成 opaque proof token，Redis 只保存 claims 绑定：challengeId、kind、action、routeKey、subjectHash、clientIpHash、deviceFpHash、issuedAt、expiresAt、nonce 和 policyVersion。RiskControl actor context 必须分离普通账号和 AdminPrincipal：普通 `identity_kind=anonymous_account` 才填 `UserId/AccountSubjectHash/SessionId`；`identity_kind=admin_principal` 只填 `AdminPrincipalId/AdminSessionId`，`UserId/SessionId` 必须为 null。普通账号 RiskControl subjectHash 和 authenticated proof binding 只从 `identity_kind + account_subject_hash` 派生；`ClaimTypes.NameIdentifier` / `nameid` 仅保留账号容器兼容用途，不得作为 subject hash 材料。缺少有效 `account_subject_hash` 的历史会话在风险事件持久化中回退到 clientIpHash，避免重新引入裸 userId 聚合。`ConsumeProofAsync` 必须通过 Redis GETDEL / consume-once 语义先消费 token，再比较所有绑定字段；replay、Redis miss、action/route/IP/device mismatch 或过期均返回拒绝并写入 `security_challenge_attempt`，调用方不得进入业务写入。

perception-sealed@v2 的服务端真相使用 `IPerceptionSealedTokenService` 生成 AEAD sealed token；sealed payload 包含 challenge、task、action、route、subject/client/device/UA hash、algorithm/family/variant、recipe hash、expected answer/point/step hash、容差、时长、attempt、nonce、keyVersion 和 policyVersion。token envelope 只明文携带解密所需的非 secret AAD 字段：challengeId、algorithm、taskKind、action、routeKey、recipeHashHex、issuedAtUnixMs、expiresAtUnixMs 和 keyVersion；AAD 还绑定 sealed ciphertext 的 SHA-256，密文 payload 内保存 payload binding hash，覆盖 subject/client/device/UA、family/variant、answer/point/step、attempt、duration、nonce 和 policyVersion 等 payload-only 字段。answer、coordinate、expected step 及其 hash 只在密文内。`Security:PerceptionSealedToken:CurrentKeyVersion` 和 `Security:PerceptionSealedToken:Keys:{version}` 支持 key rotation；验证时按 envelope keyVersion 选择 key，未知 keyVersion、AAD 篡改、密文篡改、payload binding mismatch、envelope/payload context mismatch 或过期均 fail closed。该 sealed token 只保护 challenge 解答真相，不提供 Redis consume-once 语义，也不能替代 `X-Fsus-Challenge-Proof` 或 admin `X-Fsus-Mfa-Proof`。

### perception-sealed@v2 威胁模型、协议与上线

`fsu.challenge/perception-sealed@v2` 是 sealed perception challenge，不是普通图片验证码。它的目标是在 RiskControl 已经判定需要 challenge 时，用客户端可渲染、服务端可验证的 perception task 提高脚本化提交、离线 replay、payload tamper、label oracle 和低成本批量尝试的成本；它不识别自然人身份，不授予 session / role / admin 权限，不替代 PoW、PoSpace、Passkey 或 AdminPasskeyStepUp。

可信边界如下：客户端 renderer、worker、DOM event、pointer 坐标、solve duration、device fingerprint 原文和 provider verify payload 全部视为攻击者可控；服务端只信任 `SecurityChallengeAssignment` 绑定字段、AEAD sealed token、Redis attempt/consume-once 结果、RiskControl policy snapshot 和后续由 orchestrator 签发的一次性 `X-Fsus-Challenge-Proof`。公开 issue payload 禁止包含 `answerText`、`expectedAnswer`、`expectedX`、`expectedY`、`expectedStep`、`labelId`、`semanticId`、`objectClass`、`clientIp`、`deviceFp`、`userId`、raw UA、proof token、admin session、MFA proof 或可反推解答的字段；只允许传递 render recipe、recipe hash、sealed token、signature、task/family/variant、assignment 和时间窗口。

协议热路径分为两段：

| 阶段 | 允许 | 禁止 | 失败行为 |
|------|------|------|----------|
| issue | 根据 RiskControl decision 选择 `perceptionTextTaskV2` / `perceptionCharacterV2`、`perceptionLocalizationV2` 或 `perceptionMicroInteractionV2`；生成非语义 render recipe；用 AEAD sealed token 封存期望答案、坐标或步骤；返回 AEDS `PerceptionSealedChallengeV2` | 服务端渲染 PNG / canvas / 图片；在 sealed truth 生成路径写 PostgreSQL 或 Redis；把答案、坐标、语义标签、原始 IP/设备指纹写入 payload | provider missing、recipe invalid、token seal failure 或 assignment invalid 均 fail closed；`observe` 模式只记录裁决，不签发实际 challenge |
| verify | 解封 AEAD；校验 challengeId/action/routeKey/subjectHash/clientIpHash/deviceFpHash/policyVersion/recipeHash/keyVersion，并校验 payload binding hash；校验 `solveDurationMs`、答案/坐标/步骤；用 Redis `INCR` 做 attempt gate，用 Redis `SETNX` 做 consume-once；成功后只 mint `X-Fsus-Challenge-Proof` | 直接把 provider proof 交给业务 endpoint；把普通 challenge proof 当 MFA proof；verify 时查询 PostgreSQL 作为授权真相；在 Redis 不可用时默默放行写操作 | AEAD key missing/unknown、token tamper、AAD mismatch、context mismatch、过期、绑定不匹配、answer invalid、attempt exceeded、Redis unavailable 或 replay 均 fail closed |

三类 task 的强度递进必须保持可解释：text-task / Character challenge 只要求读出或输入 recipe 中的短文本，适合中风险；Localization 要求在客户端渲染图形上定位目标点，通常与 `sha256PowV1` 组合用于高风险；Micro-interaction 要求完成短步骤或最终 pointer 位置，仅用于可选的极高风险/strict 阶段，且默认由 `Security:PerceptionV2:MicroInteraction:Mode` 控制为 disabled。`perceptionTextTaskV2` 是 policy-facing wire kind，AEDS sealed task 仍按 `character` payload 解析；`perceptionCharacterV2` 是同一类 task 的 contract kind。

RiskControl 的关系保持分层：V2 provider 只证明某个 challenge 被解决，业务放行仍由 `RequiresRiskControlFilter` 消费 `X-Fsus-Challenge-Proof`、`X-Fsus-Challenge-Id` 和 `X-Fsus-Challenge-Kind` 后决定。HumanReadProof 只用于 `public.read` 阅读计数和 public-read 风险降分，不能授权 `comment.*`、`auth.*` 或 `admin.*` 写操作。`adminPasskeyStepUpV1` 只产生普通 RiskControl proof；admin-sensitive 写入仍必须通过 `/api/binary/auth/admin/step-up/passkey/begin|complete` 获取 action=`admin-sensitive` 的 `X-Fsus-Mfa-Proof`，普通 `X-Fsus-Challenge-Proof` 不得替代。

运行和回滚矩阵：

| 场景 | 行为 |
|------|------|
| `Security:RiskControl:GlobalMode=disabled` | 不签发 RiskControl challenge，业务按基础鉴权/PoW/MFA/RBAC 继续执行 |
| `Security:RiskControl:GlobalMode=observe` | 记录 perception-sealed@v2 裁决、risk score 和原因，不拦截、不挑战，适合首阶段观测 |
| text-task enforce | 中风险 band 启用 `perceptionTextTaskV2` / `perceptionCharacterV2`；回滚为 `observe` 或关闭对应 action 的 `commentRiskControlEnabled` / `authRiskControlEnabled` |
| localization enforce | 高风险 band 启用 `perceptionLocalizationV2 + sha256PowV1`；Redis、AEAD key 或 provider 异常必须 fail closed，必要时回滚到 text-task 或 `captchaV1` / `sha256PowV1` 组合 |
| micro-interaction optional | 只在 `Security:PerceptionV2:MicroInteraction:Mode=enforce|strict|lockdown` 且高升级等级命中时签发；异常时立即切回 disabled，不影响 text-task/localization |
| `strict` / `lockdown` | `strictRiskMultiplierPercent` 放大风险分，`lockdown` 额外阻断不允许的匿名写；回滚只通过 `/api/binary/admin/security/risk-control/options` 或 `/rollback`，必须携带 admin principal、`system.config` 和 `X-Fsus-Mfa-Proof` |

故障预算按安全优先级分层：Redis attempt/consume-once 不可用时，写操作、auth、admin、notification subscription 的 enforced challenge 一律 fail closed；PostgreSQL 只承载审计、聚合和 policy snapshot，challenge 解答真相不得依赖请求期 PostgreSQL 查询，持久化失败会降低审计完整性并影响 readiness/admin 写入，但不得成为 verify 放行依据；AEAD key 不存在、keyVersion 未知或 key rotation 未覆盖旧 key 时，相关 token 只能失败，不能降级到明文答案或客户端自证。性能预算是 issue 端 O(1) CPU、零服务端 rasterize、sealed truth 路径零 DB/Redis 写；verify 端 O(1) AEAD + hash compare + Redis `INCR`/`SETNX`，不进入昂贵 renderer、不扫表、不按 payload 大小做非线性工作。安全预算是 fail-closed 优先、单次 proof、低基数指标、无原始 IP/设备指纹/答案落库，且所有 bypass 都必须表现为显式 `observe` / `disabled` 策略而不是隐式异常放行。

RiskControl challenge provider 通过 `ISecurityChallengeProvider` 接入，不允许业务 filter 直接依赖 PoW、Captcha、PoSpace、HumanReadProof 或 Passkey step-up 的具体实现。`SecurityChallengeOrchestrator` 按 `RiskDecision.RequiredChallenges` 从 DI 中查找 provider，可一次返回多个 assignment；provider 未注册、provider 返回失败、assignment 无效或 proof mint 失败均 fail closed，写入 `SecurityChallengeRejected` 风险事件，且不进入业务 handler。provider verify 成功后只签发统一 proof token，业务是否放行仍由后续 filter 消费该 token 决定。

RiskControl 可观测性集中在 `FsusObservability`：风险事件写 `fsus.security.risk.event.count`，裁决写 `fsus.security.decision.count`，当前策略版本通过 `fsus.security.policy.version.active` gauge 暴露。编排层记录 provider missing / provider exception / proof mint failure 的 structured log 与失败指标；metrics/listener/exporter 异常必须在 observability 层吞掉，不得改变 allow/challenge/block/queue 裁决或业务错误码。`/api/ops/health/ready-detail` 的 `riskControl` 检查同时验证 active policy、last-known-good policy、Redis consume-once 能力和 challenge provider registry；缺 active policy 或 Redis 一次性消费不可用时 readiness 返回 `not_ready`。Redis 不可用时写类 challenge fail closed，公开读仍只按当前策略允许的降级路径处理。

`sha256PowV1` 由 `Sha256PowChallengeProvider` 提供，复用现有 `IPowService`、`AdaptivePowGovernor` 和 legacy FPOW 二进制 proof 解析逻辑。签发时 provider 返回统一 `SecurityChallengeAssignment`，并通过 `/api/binary/security/challenge` 返回 provider payload：`salt`、`difficulty`、`timestamp`、`signature`；持久化层只保存 payload hash，不保存原始 salt/signature 或 proof。验证时 `/api/binary/security/challenge/verify` 只接受 payload 中的 legacy Base64 FPOW proof，继续按客户端 IP 绑定、当前 difficulty、签名、过期时间和 Redis consume-once 规则校验；成功后返回一次性 `proofToken`，失败 attempt 写入 `security_challenge_attempt`。旧 `X-Fsus-Pow-Proof` / `RequiresPowFilter` 路径继续保留。

`captchaV1` 由 `CaptchaV1ChallengeProvider` 提供，使用 `fsu.captcha/chebyshev-noise@v1` seed/参数 payload。服务端只签发 seed、参数、HMAC signature 和一次性 challenge state，不生成 PNG 或图片字段；客户端渲染后提交 answer、response token、nonce 和 solve duration。verify 先校验签名与 action/route/IP/device/policy 绑定，再一次性消费 `SecurityCaptchaChallenge` cache，随后校验答案、nonce 前导零、response token 和过快/过慢时长。错误、篡改和过期写 `CaptchaInvalid` detail，重放写 `CaptchaReplay`，过快写 `CaptchaSolveTooFast`；成功后仍由 orchestrator 签发统一 proof token。默认 V2 policy 中，legacy `auth.login` action 仅为迁移/测试保留，`comment.create` 和 `comment.reply` 在中风险阈值触发 `captchaV1`，高风险阈值触发 `captchaV1 + sha256PowV1` 组合 challenge；`recovery-key.verify` 从 0 风险分起强制 `captchaV1` challenge，并在高风险时升级到组合 challenge；低风险的其他 action 继续放行，`observe` 模式只记录裁决原因而不签发实际 challenge。

`argon2idPoSpaceV1` 由 `Argon2idPoSpaceV1ChallengeProvider` 提供，默认 `Security:PoSpaceV1:Mode=disabled`，不会被默认 V2 policy 签发。启用后仍受参数上限和移动端保护约束：`memoryKib` 只允许 `1024..65536`，移动 UA 最大 `8192`，`iterations` 只允许 `1..6`，`lanes` 只允许 `1..4`，`targetDurationMs` 只允许 `100..5000`。verify 使用一次性 `SecurityPoSpaceChallenge` cache，按 challengeId、action、routeKey、subject/client/device hash、policyVersion 和 client nonce 重新派生 Argon2id proof；payload/参数/proof 错误、replay 或 provider disabled 都 fail closed。RiskDecision 在 PoSpace 子系统 disabled 或移动 UA 时降级为 `captchaV1`，避免误伤弱设备。

`humanReadProofV1` 由 `HumanReadProofV1ChallengeProvider` 提供，只允许 `public.read` action 使用。issue 复用现有 HumanReadProof challenge 生成逻辑并只持久化 payload hash；verify 复用现有 HumanReadProof submit 校验，成功后最多签发绑定 `public.read` / routeKey / subject / IP / device 的统一 proof token。provider 对 `comment.create`、`comment.reply`、`auth.*`、`admin.*` 等写操作一律 fail closed；即使客户端提交 `X-Fsus-Challenge-Kind: humanReadProofV1`，`RequiresRiskControlFilter` 也会因 required challenge kind 不匹配而返回 428，不会消费 proof 或进入业务 handler。HumanReadProof 成功还会写入 `ReadProofAccepted` 负分风险信号，用于降低后续 public-read 风险；失败继续写 `ReadProofRejected`，不得替代 PoW、Captcha 或 Passkey step-up。

`passkeyStepUpV1` 与 `adminPasskeyStepUpV1` 将 WebAuthn / Passkey step-up 接入同一 RiskControl provider 编排。普通用户 provider 只接受已认证且非 `identity_kind=admin_principal` 的请求，challenge 使用当前 userId 绑定的 allowCredentials，verify 成功后只返回 provider success，由 orchestrator 签发一次性 `X-Fsus-Challenge-Proof`。admin provider 只接受 `identity_kind=admin_principal`、`admin_id` 与 `admin_sid` 完整的请求，复用 admin step-up challenge 与 WebAuthn 校验，但走 verify-only 路径，不调用 `CreateAdminStepUpProofTokenAsync`，不写 `SecurityMfaProof`，也不签发 `X-Fsus-Mfa-Proof`。`GET /api/binary/auth/admin/me` 只在 admin session 已通过 `admin_session` 回查和 token hash 校验后返回 `AdminPrincipalSnapshot`，前端用它从 HttpOnly admin Cookie 恢复侧栏管理状态；该快照不能替代后端权限校验。普通 RiskControl proof 不能满足 admin-sensitive 写入，admin-sensitive proof 也不能作为普通 challenge proof 提交；客户端必须按业务入口分别使用 `X-Fsus-Challenge-*` 或 `X-Fsus-Mfa-Proof`。

`RequiresRiskControlFilter` 是新业务入口的统一 enforcement filter。endpoint 必须通过 `WithRiskAction(action, routeKey)` 或等价 metadata 声明 action / routeKey；filter 读取 `RiskDecisionService` 输出，`allow` 才进入业务 handler，`challenge` / `step-up` 必须携带 `X-Fsus-Challenge-Proof`、`X-Fsus-Challenge-Id`、`X-Fsus-Challenge-Kind` 并由 `ISecurityChallengeProofService.ConsumeProofAsync` 一次性消费后才放行，缺失、重放或 action/route/IP/device mismatch 返回 428。`block`、`throttle` 不进入业务 handler，返回 429 并写 `risk-control` 来源的拒绝事件；`queue` 写入 `RiskControlDecisionContext` 后只允许已显式处理排队语义的业务 handler 继续执行。`POST /api/binary/comment` 在 comment.create / comment.reply 上使用该 queue 语义，把高风险评论保留在待审队列并写入 `risk_control_queue` 审核原因。`/api/binary/security/challenge` 在裁决包含 `captchaV1` 时额外写 `CaptchaChallengeRequired` 风险事件，用于区分 Captcha 阶梯触发和 provider/verify 拒绝。`RequiresPowFilter` 保持 legacy wrapper，只处理旧 `X-Fsus-Pow-Proof`。

`POST /api/binary/comment/anonymous-ticket` 是 ZK 匿名评论的预验证与一次性凭据签发边界。端点先做 frame size、articleId、scope、reply context、nullifier hash、proof/public input 长度等廉价校验，再读取当前缓存 root snapshot 并调用 `IZkAnonymousProofService.VerifyCommentProofAsync`；root 不可用、root 过期或 verifier 失败均 fail closed。通过验证后，服务端用 nullifier 服务做并发安全 reservation，blocked/scope-limit/race loser 不会签发 ticket。成功 ticket 使用 32 bytes 密码学随机数，响应只返回一次；缓存只保存 `SHA256(ticket)` 对应的短 TTL compact binary payload，并在后续 `POST /api/binary/comment/anonymous` 中通过 consume-once 读取。payload 绑定 articleId、scope、parentId/rootId/replyToCommentId、nullifierHash、credentialEpoch、credentialLevel、reputationBucket 和 expiresAt，不保存 user id、credential commitment、proof 原文、客户端 IP 原文或可反查账号的状态。匿名 submit 端点同样拒绝 Cookie/Authorization/bridge session/已认证 principal，成功只写 `comment.user_id = null`、`author_mode = zk_anonymous`、匿名治理字段、region compliance 和 Pending 审核状态。

匿名评论进入审核、外部 anti-spam provider、管理端治理和高价值审计后仍保持无 deanonymization 后门。外部 anti-spam provider 只接收 content、submit/viewer region、policy snapshot、credential level、reputation bucket、account age bucket 和 anonymous-safe moderation subject hash；provider request DTO 与 metadata sanitizer 均禁止 user id、username、public handle、credential commitment、proof、raw nullifier、raw IP 和 device fingerprint。审核队列只显示匿名展示名、author mode 安全文案、region policy、risk signals、credential/reputation/account-age bucket 和 nullifier 状态摘要；匿名行不得返回真实 user id，也不得提供按真实账号查找匿名评论。管理员可执行 approve/reject/hide、block nullifier、revoke anonymous credential 和查看 root/verifier/circuit 状态，但不得查看 credential secret/witness/proof、导出 credential 到 account 映射或执行反匿名查询。高价值审计只记录不可逆 target 摘要、scope、结果和状态，不记录 raw nullifier、proof、credential commitment 或账号映射。

Passkey login begin/complete 和 Recovery Key verify 都声明各自 RiskControl action：`auth.passkey.begin`、`auth.passkey.complete`、`recovery-key.verify`。旧 `auth.login` password action 仅为 migration/test policy 保留，不再绑定生产用户侧 endpoint。Passkey assertion 失败写 `PasskeyAssertionFailed` 正分信号，Passkey assertion 成功写 `PasskeyAssertionAccepted` 负分信号并继续以 `mfaVerified=true` 完成登录，因此不再额外要求普通 TOTP MFA。Recovery Key verify 即使当前风险分为 0 也必须提交 RiskControl proof，同时保留 legacy PoW proof 和 no-store 响应；缺任一 proof 都不得进入 recovery key 验证或一次性使用状态变更。

RiskControl 生产控制面按 `Risk Signal -> Risk Score -> Risk Decision -> Challenge Orchestration -> Proof Verification -> Enforcement -> Audit / Metrics / Admin Policy` 演进；完整 tracking plan、子 issue 顺序与 binary-first 边界见 `docs/risk-control-plan.md`，生产 rollout gates、故障矩阵、紧急开关和回滚流程见 `docs/risk-control-rollout.md`。

RiskControl 运行态支持 `disabled | observe | enforce | strict | lockdown`。`disabled` 放行业务且不签发 RiskControl challenge；`observe` 只记录裁决原因，不拦截、不挑战；`enforce` 按阈值 challenge/queue/block；`strict` 在阈值前按 `StrictRiskMultiplierPercent` 放大风险分；`lockdown` 额外关闭匿名写入。运行态子系统开关包括 `CaptchaV1`、`PoSpaceV1`、`PublicReadChallenge`、`CommentRiskControl` 和 `AuthRiskControl`：关闭 CaptchaV1 时不得签发 captcha challenge，关闭 PoSpaceV1 时不得签发 Argon2id PoSpace challenge，公开读、评论和认证开关会投影到对应 action override。`PUT /api/binary/admin/security/risk-control/options` 通过 admin security policy 热更新 active snapshot，写 `security_policy_snapshot(policy_id=risk-control)`、高价值审计和 last-known-good 指针；`POST /api/binary/admin/security/risk-control/options/rollback` 优先回滚持久化 LKG。启动时 `SecurityPolicySnapshotHostedService` 优先加载 active risk-control snapshot，active 损坏则回退 LKG；没有持久化快照时读取 `Security:RiskControl:*` 环境/配置 fallback，不改变 AntiCrawler mode 语义。

RiskControl admin 模拟器位于 `/api/binary/admin/security/risk-control/simulate` 和 `/user/manage/security/simulator`。它只调用当前 `SecurityRiskPolicySnapshotV2` 与生产 `RiskDecisionService` 做 dry-run，返回 risk score、decision、reasons、required challenges 和 policy version；不会调用 challenge orchestrator、不会写入 `security_challenge`、不会 reset 或增加真实风险分，也不会修改 active policy。模拟器仍要求 admin principal + `system.config`，每次成功或参数拒绝都写入 admin security audit；它不是绕过 `RequiresRiskControlFilter` 的业务放行接口。

管理后台新增 `/user/manage/security` 安全系统：

- `/user/manage/security`：安全总览，展示 AntiCrawler、PoW 和统一风险信号摘要。
- `/user/manage/security/crawler`：反爬虫系统，管理模式、局部开关、CIDR 更新、风险事件、allow/blocklist、规则和模拟器。
- `/user/manage/security/simulator`：RiskControl dry-run，预演 allow、challenge、queue 和 block 决策，不执行业务写入。
- `/user/manage/security/pow`：PoW 系统，管理独立模式、默认 difficulty、proof TTL、replay 防护和风险分联动。

安全后台生产 API 全部使用原生 `/api/binary/admin/security/**` AEDS v2 frame；外部 `/api/admin/security/**` JSON 入口和 internal bridge 兼容层均已移除。security binary endpoint 直接执行 admin principal + `AdminPermissions.SystemConfig` authorization、`fixed_ip` 限流、`X-Fsus-Mfa-Proof` admin passkey step-up、device fingerprint header 和高价值安全审计，失败统一编码为 `ApiError` frame。策略修改、回滚、反爬虫规则/list 变更和风险重置的 actor 必须来自 independent admin principal 的 `admin_id`，内部统一写作 `admin:{admin_id}`；缺失 `identity_kind=admin_principal` 或 `admin_id` 必须 fail closed，不得回退到普通账号 `NameIdentifier` / `GetUserId()`。

AntiCrawler 与 PoW 管理写操作会同步写入 PostgreSQL `security_policy_snapshot`，以 `policy_id + version` 保留不可变历史版本，并用单 active partial unique index 约束每个策略只有一个生效版本。写入、激活和回滚仍要求 admin principal、`system.config` 权限和一次性 `X-Fsus-Mfa-Proof`；缺失或无效 proof 返回 `428 + MFA_PROOF_REQUIRED`，不得进入策略写入。启动时 `SecurityPolicySnapshotHostedService` 在 schema bootstrap 后加载 active 快照；active 文档损坏或无法反序列化时，只回退到最近 `is_last_known_good=true` 的历史版本并写 warning，不从请求路径同步查 DB。策略表只保存策略 JSON、版本、mode、admin principal id、时间戳和回滚元数据，不保存 proof token、session token、客户端 IP 原文或设备指纹原文。`security_policy_snapshot.created_by_admin_id`、策略快照内的 `ChangedBy` / `UpdatedBy` 和高价值 audit actor 必须指向同一个 admin principal 归因平面。

AntiCrawler 支持 `disabled | observe | enforce | strict`。`disabled` 只关闭 crawler 类处置和 crawler 风险写入，不关闭 PoW、认证、授权、CORS、Fetch Metadata、路径穿越硬拦截等基础安全能力；`observe` 记录事件但不拦截、不触发 public read challenge 升级；`enforce` 是生产默认策略；`strict` 会提高 crawler 类风险分。局部开关包括 public read challenge、search crawler verification、social preview guard、risk scoring、event persistence、dashboard aggregation、CIDR auto update 和 illegal path hard abort。PoW 使用独立 `PowPolicySnapshot`，不受 AntiCrawler mode 直接控制。

---

## 真人阅读计数 proof

浏览计数不再由公开 GET 请求副作用产生。文章 `Views` 和后台访问统计统一来自 `HumanReadProofService` 接受的真人阅读事件：

- Challenge：`POST /api/binary/read-proof/challenge.aeds`，请求体为 `HumanReadChallengeRequest` frame。
- Submit：`POST /api/binary/read-proof/submit.aeds`，请求体为 `HumanReadSubmitRequest` frame。
- 客户端要求：SPA hydration 后，主内容进入视口并累计可见停留至少 8 秒，再携带 `X-Fsus-Device-Fp` 提交 proof。
- 服务端绑定：HMAC token 绑定 scope、routeKey、articleId、设备指纹哈希、IP 哈希、UA 哈希、签发时间、过期时间、最小停留时间和 nonce。
- 拒绝条件：无 JS/AOT 未 hydration、直接 API 请求、缺失 Fetch Metadata、跨站 Origin/Referer、爬虫 UA、已验证 crawler、停留不足、过期 token、篡改 token、重放 proof。
- 成功提交会以 `human-read-proof` 来源写入 `ReadProofAccepted` 负分风险信号，仅用于降低 `public.read` 风险；拒绝与超限继续写入 `ReadProofRejected` 正分风险，但不会阻断公开内容访问；HumanReadProof 只决定阅读事件是否计数，不能授权 comment/auth/admin 写操作。
- 成功阅读事件写入 VisitLog 时只保存服务端 HMAC 匿名化的 `ip_hash`、viewer key hash、proof id、route/article、event type、region 与时间，不保存登录账号 ID 或原始 IP；数据库最终态删除 `sys_visit_log.userid` / `sys_visit_log.user_id` 历史账号绑定列，并移除 `sys_visit_log.ip`。`ip_hash` 使用 `VisitLog:IpHashPepper`，生产环境应配置为稳定高熵 pepper；后台统计只使用这些匿名化字段聚合 `totalReads`、`humanVerifiedReads`、`uniqueViewerKeyEstimate`、`articleReads` 与 `siteReads`。
- 降级开关：`HumanReadProof:Mode=paused` 暂停计数写入，但不影响内容读取。

该机制提高浏览计数的真人口径，不用于身份认证，也不承诺识别所有未知自动化行为。

---

## 实时通知通道

- 通道：`/api/notifications/stream` 使用 WebSocket，子协议固定为 `fsus-aeds.v2`
- 预检：`/api/notifications/stream/preflight` 复用认证、RiskControl / legacy PoW、cursor 和协议校验，不要求 WebSocket upgrade；成功返回 204，失败返回 AEDS `ApiError` frame 与 `X-Fsus-Notification-Stream-*` 头
- Origin：preflight 与正式 WebSocket 握手必须先执行同一套 Origin 校验，允许来源来自 `Seo:BaseUrl`、`Fido2:Origins`、`CORS_ALLOWED_HOSTS`，开发环境额外允许 localhost；生产环境跨站、非 HTTPS/WSS 或浏览器缺失 Origin 均返回 `403` + `origin_not_allowed`
- 载荷：所有通知、心跳和正式 WebSocket 握手失败均为 AEDS binary frame；握手失败返回 `ApiError` frame
- 匿名订阅：优先通过 `notification.subscribe` RiskControl action 准入；preflight 可携带 `X-Fsus-Challenge-Proof`、`X-Fsus-Challenge-Id`、`X-Fsus-Challenge-Kind`，正式 WebSocket 可携带等价的 `challengeProof`、`challengeId`、`challengeKind` query 参数，preflight 不消费一次性 proof，正式握手消费。旧 `pow` query 参数继续兼容，值为二进制 FPOW 证明的 base64 文本形式
- 登录订阅：复用同站点认证 Cookie，不接受文本事件流降级
- 续传：客户端用 `cursor` query 参数提交最后消费的事件 ID
- 封禁/删除账号：握手层返回 `account_blocked` 或 `account_deleted`，前端必须停止重连并展示账户状态错误

---

## 密码存储

- 算法：BCrypt（BCrypt.Net-Next 4.1.0）
- Work Factor：cost ≥ 10（生产建议 12）
- 永不明文存储，注册/修改密码时即时哈希
- 密码注册成功后立即创建标准登录会话，并下发 HttpOnly 认证 Cookie

---

## JWT 认证

| 参数 | 值 |
|------|-----|
| Access Token 有效期 | 15 分钟 |
| Refresh Token 形式 | HttpOnly Cookie（SameSite=Strict，Secure） |
| 续签方式 | `POST /api/binary/auth/refresh-token`，基于 `UserSession.RefreshTokenHash` 的原子 CAS 轮换（旧 Token 立即失效） |
| 签名算法 | HS256（密钥来自环境变量，生产启动时强制校验非占位值） |

Refresh Token 只以哈希形式保存在 `sys_user_session`；`sys_user` 不再保存明文 Refresh Token 或全局刷新过期时间。刷新请求必须同时匹配当前 session id、旧 refresh hash、未撤销状态、idle/absolute 过期窗口；CAS 失败或旧 Token 重用会撤销对应 session 并清理客户端 Cookie。

**生产启动保护**：如果 JWT 密钥与已知占位值相同，服务器拒绝启动，防止弱密钥上线。

**Anonymous identity cold-start reset**：切换到匿名身份模型时，旧 `sys_user`、`sys_user_session`、legacy Passkey、MFA secret/recovery-code hash、refresh/session 记录、历史评论、`comment_anonymous_nullifier`、`comment_region_compliance`、`comment_moderation_signal`、`account_recovery_key`、`anonymous_credential`、`anonymous_credential_issuance_audit` 和旧用户绑定的消息状态会被故意删除，并在事务提交后清理旧用户的 blacklist/blocking、未读消息和用户评论游标缓存。公共 ZK circuit/root metadata（如 `anonymous_credential_root`、`anonymous_credential_epoch`、`anonymous_credential_revocation`）不是旧用户绑定数据，reset 不把它作为历史身份数据删除；如需轮换由 root lifecycle/治理流程重建。该 reset 只在 `FSUSBLOG_CONFIRM_IDENTITY_RESET=DELETE_LEGACY_USERS` 时运行；缺少确认值会在 destructive SQL 前失败。旧密码登录和旧 `role=admin` 账户不迁移、不可继续使用，必须按新的匿名身份/admin bootstrap 流程重建。

**Anonymous identity mode**：设置 `FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1` 后，`sys_user` 只作为匿名账号容器使用，`public_handle` 与 `identity_kind=anonymous_account` 是展示/身份语义；物理 `username/password/role/lastusernameupdatetime/last_username_update_time` 列由 `20260621-post-user-legacy-identity-columns-finalize` 删除，代码层不得再映射或读取这些 legacy 字段，不能作为展示名、普通登录凭据或 admin 权限来源。生产环境必须启用该模式，`ProductionStartupValidator` 和 `/health/ready` 会拒绝缺失、`0`、`false` 等关闭值，`FSUSBLOG_ALLOW_INSECURE_STARTUP=true` 只能让进程降级可观测启动，不能把 readiness 变成可上线状态。该模式禁用旧密码注册、密码登录、改密、自助删号中的密码证明；管理端不暴露匿名账号密码重置能力，只治理匿名账号状态、session、Passkey、Recovery Key、匿名凭据和 nullifier/scope。TOTP 保留为可选 step-up，但 secret、pending secret、验证时间和 TOTP recovery-code hash 只存放在 `user_mfa_profile`；旧 password proof 不再参与 TOTP rebind/disable/recovery-code regeneration。普通账号 access token 只携带 account id、`identity_kind`、可选 `account_subject_hash`、session id 与 MFA 状态，不携带 legacy username 或 role claim；`account_subject_hash` 由稳定账号 handle 派生，供 RiskControl subject/proof binding 使用，不得从裸 `userId` 派生。因此旧 `sys_user.role=admin` 无法进入 admin group、admin rate partition、评论管理员删除分支、普通账号状态治理保护条件或审计 admin actor。独立 admin principal 由后续 bootstrap/Passkey 流程提供。`sys_user` 不保存原始 last login IP/time；登录观测只能进入 `sys_user_session.last_ip`、安全事件或审计哈希维度。

**Anonymous gateway profile**：即使未来接入统一账号网关，FsusBlog 也只接受匿名 profile 所需的最小请求头集合。`AnonymousGatewayHeaderGuardMiddleware` 在 `UseAuthentication()` 之前执行，所有入站 `X-Fsus-*` 请求头必须命中显式 allowlist：RiskControl challenge、device fingerprint、admin bootstrap/MFA、notification stream protocol、public AOT token、region、subscription proof、test session 和 upload chunk 元数据。`X-Fsus-Username`、`X-Fsus-Email`、`X-Fsus-Role`、`X-Fsus-Account-Role`、`X-Fsus-User-Id`、`X-Fsus-Password`、`X-Fsus-Totp` 以及包含 register/login/password/TOTP 传统账号语义的头一律返回 400，未知 `X-Fsus-*` 也默认拒绝。该 guard 不读取敏感头值、不创建 principal、不把外部账号 ID 映射到评论作者、审计 actor 或 session 主体；管理员后台仍只接受 FsusBlog 独立 admin principal 与明确的 admin proof。

普通账号自助 `/api/binary/auth/*` 端点必须显式挂 `RequireAnonymousAccountPrincipal()` 或等价策略，只接受 `identity_kind=anonymous_account` 的账号主体；`EndpointUserContext` 只把该平面暴露为 `AccountId`，同时保留 `AdminPrincipalId`、`IdentityKind`、`SessionId` 与 `IsAnonymousAccount` / `IsAdminPrincipal` 供边界判定。请求审计和 Serilog log context 也只能使用 `AccountId`、`AdminPrincipalId` 和 `AuditActorId` 这些明确维度，告警/仪表盘不得继续消费泛化 `UserId`。`/auth/me`、public handle、普通 session、MFA、Recovery Key、Passkey credential 和自助注销/登出端点不得使用裸 `.RequireAuthorization()` 或把 AdminPrincipal 的 `NameIdentifier` 当作账号 id。AdminPrincipal 访问这些普通自助端点必须在授权层返回 403，不进入业务 handler，并通过 `security.auth.self_service_principal_rejected` 高价值审计记录拒绝；AdminPrincipal 只能使用 `/auth/admin/*` 控制面端点。

普通消息 `/api/binary/messages/**` 端点属于匿名账号自服务平面，也必须挂 `RequireAnonymousAccountPrincipal()`，并通过 `AccountPrincipalContext.AccountId` 读取账号身份；不得使用 legacy `CurrentUser` binder 或裸 `.RequireAuthorization()`。管理消息 `/api/binary/admin/messages/**` 保持 independent admin principal 平面，写入操作只通过 `AdminMessageActor(adminPrincipalId, adminSessionId)` 归因。

普通可归因评论 `POST /api/binary/comment` 与 `GET /api/binary/comment/me` 同属匿名账号自服务平面，必须挂 `RequireAnonymousAccountPrincipal()` 并通过 `AccountPrincipalContext.AccountId` 读取账号身份；不得在 handler 内调用 `GetUserId()` 或接受 AdminPrincipal。`DELETE /api/binary/comment/{id}` 同时承载账号自删和管理删除，但服务边界必须拆成账号 actor 与 `AdminPrincipalActor(adminPrincipalId, adminSessionId)` 两条路径，不得用 `int userId + bool isAdmin` 混合表达身份平面。

**Independent admin principal plane**：后台控制面身份保存在 `admin_principal`、`admin_session`、`admin_passkey_credential` 和 `admin_audit_log`，不复用 `sys_user` / `sys_user_session`。首次 root admin 只能通过 `/api/binary/auth/admin/bootstrap/passkey/begin|complete` 创建，必须提供 `X-Fsus-Admin-Bootstrap-Token`，其值来自 `FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN` 或 `Admin:BootstrapToken`；一旦存在 active root admin，bootstrap 永久拒绝再次执行。root bootstrap complete 必须在数据库事务内获取 PostgreSQL transaction-scoped advisory lock，重新检查 active root，插入 `admin_principal`、`admin_passkey_credential`、`admin_session` 并写 `admin_audit_log`；`admin_principal` 还必须有 active root partial unique index，唯一冲突统一返回 `Root admin already exists`，不得留下 orphan credential/session。admin 登录只走 `/api/binary/auth/admin/login/passkey/begin|complete` 的 Passkey/Security Key assertion，不接受 username/password。成功后只写独立 `AdminAccessToken` / `AdminSessionId` 或 `__Host-AdminAccessToken` / `__Host-AdminSessionId` Cookie，JWT claims 包含 `identity_kind=admin_principal`、`admin_id`、`admin_sid` 和多值 `admin_permission`，不携带 `ClaimTypes.Role` / `role=admin`。当前权限集合包括 `article.write`、`article.publish`、`comment.moderate`、`anonymous.comment.configure`、`anonymous.nullifier.block`、`anonymous.credential.revoke`、`audit.read`、`system.config`、`admin.manage`。后台控制面 endpoint 必须通过 `RequireAdminPermission(...)` 或等效 policy 同时校验 `identity_kind=admin_principal` 与具体 `admin_permission`，不得接受 legacy `sys_user.role=admin` 或 `[Authorize(Roles=\"admin\")]` / `RequireRole(\"admin\")`。每次 admin access token 通过 JWT 签名、issuer、audience 和 exp 校验后，还必须请求期回查 `admin_session`：`admin_id/admin_sid` 必须存在，principal 必须 active，session 必须未撤销、未 idle/absolute 到期，`AccessTokenHash` 必须匹配当前 token，且 session 的 principal id 必须与 token 一致；失败时拒绝认证并清理 admin cookies，成功时更新 `LastSeenAtUtc`。bootstrap、login、admin passkey step-up 和后续 recovery/session 治理操作必须写入 `admin_audit_log`；普通用户 MFA/TOTP 不参与 admin-sensitive 授权。

前端管理工作区同样只能从 `GET /api/binary/auth/admin/me` 恢复 independent admin principal，并以 `adminSessionStatus=active` 与 `admin_permission` 列表决定 `canManage`、导航可见性和 route guard。普通 `/auth/me` 匿名账号 snapshot 只用于 `/user` 自服务区域；前端不得保留 `legacy.admin` 万能权限、`syncLegacyAdminPrincipal` 桥接或通过 `userInfo.role === 'admin'` 解锁管理区。

admin-sensitive step-up 使用 `/api/binary/auth/admin/step-up/passkey/begin|complete`。challenge 必须绑定 `identity_kind=admin_principal`、`admin_id`、当前 `admin_sid`、action=`admin-sensitive`、challenge token 和过期时间；bootstrap、login 和 step-up 的 admin Passkey complete 路径必须通过 `IUnifiedCache.ConsumeOnceAndGetAsync` 原子取出并消费 challenge，消费失败不得进入 WebAuthn 校验或 DB 写入。complete 成功后通过 `CachePolicyId.SecurityMfaProof` 写入一次性 proof，key 为 `admin:{adminId}:{adminSid}:admin-sensitive:{token}`。所有批量封禁、匿名账号 suspend/unsuspend、session/passkey/recovery/credential 治理、站点备份导出、integrity fix、审核策略和安全策略写操作只接受该 admin proof，经 `X-Fsus-Mfa-Proof` 传递；缺失、过期、复用、跨 session 或普通用户 MFA proof 均返回 `428` + `MFA_PROOF_REQUIRED`。

admin 登出和 session 管理只使用 `/api/binary/auth/admin/logout`、`/api/binary/auth/admin/sessions`、`/api/binary/auth/admin/sessions/{sessionId}/revoke` 与 `/api/binary/auth/admin/sessions/revoke-others`，全部要求 `admin.manage`。登出必须写入 `admin_session.RevokedAtUtc` 与 `RevokeReason=logout`，并只清理 admin Cookie；不得调用普通用户 `/auth/logout` 或清理普通用户 refresh/session Cookie 作为替代。

`BannedUserMiddleware` 按 `identity_kind` 分流：`identity_kind=admin_principal` 的后台主体不读取 `sys_user`、不查询普通用户 blacklist，也不受同 ID 普通用户封禁/删除状态影响；它只放行给后续 admin authorization、admin session 和 permission 检查。`identity_kind=anonymous_account` 与 legacy user 仍按普通用户账号状态和封禁写锁处理。普通账号 JWT 必须携带 `account_subject_hash`，封禁与 account-state 热缓存都以该 subject hash 为命名维度；`NameIdentifier` 只允许作为数据库回源 account id，不能作为 Redis/L1 cache key。

**Recovery Key**：匿名账号的账户恢复使用独立 `account_recovery_key` 表，不复用 `user_mfa_profile.mfa_recovery_codes_hash` 或 TOTP recovery-code 语义。Create/rotate 只在 AEDS `RecoveryKeyCreateResponse` 中返回一次明文，新格式为 `frk_<lookupId>_<secret>`，`lookupId` 为 128-bit hex 随机值；服务端保存 `account_id`、带 `RecoveryKeyPepper` 的 `lookup_id_hash`、完整 key 的 HMAC + PBKDF2-SHA256 哈希、key version 和 created/used/revoked timestamps，不保存明文 lookup id 或 secret。`account_recovery_key` 的账号外键最终态列名必须是 `account_id`，索引使用 `idx_account_recovery_key_account` / `idx_account_recovery_key_version(account_id, key_version DESC)`；历史 `user_id` 列和 `idx_account_recovery_key_user` 只能通过 schema migration 兼容迁移，不得在 CodeFirst 最终态保留。`/api/binary/auth/recovery-key/verify` 是匿名、`fixed_ip` 限流、RiskControl challenge、PoW 和 no-store 端点；请求不接受 account id，服务端用 key 内 lookup id 的 peppered hash 定位候选记录，再校验完整 key。旧无 lookup id 的 key 不做全表扫描兼容，会统一失败并计入 attempt limiter。验证成功后 Recovery Key 立即标记 used，只返回短期 recovery session token 与过期时间，用于 `/auth/recovery-key/passkey/register/begin|complete` 绑定新 Passkey，不返回 account id、user id 或 internalUserId。请求可选择撤销现有 sessions，并在新 Passkey 绑定成功后撤销旧 passkey credentials；不提供 email/phone fallback。

普通账号 session 管理只允许对外展示 session id、设备指纹/标签、最近活跃时间、当前会话标记和 MFA 状态。`sys_user_session.last_ip` 可继续作为服务端风险判定输入，但不得进入 `AuthSessionList`、frontend adapter 或 IdentityCenter 原始 IP 展示；独立 admin session 列表仍按 admin 控制面契约处理。

普通账号安全凭据变更统一走 `IUserSecurityStepUpService`，action 固定为 `passkey.delete`、`passkey.credential-name.update`、`recovery-key.create`、`recovery-key.rotate`。Passkey 删除、Passkey 凭据友好名称更新、Recovery Key create/rotate 的生产 binary endpoint 不直接判断 MFA 或密码状态，只提交当前 account、action 和 `X-Fsus-Mfa-Proof` 给统一服务；这些 endpoint 不读取 `MfaPasswordProofRequest` body。已启用 MFA 的账号只接受对应 action 的一次性 proof；`FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1` 时禁止 legacy password fallback，只接受一次性 step-up proof。非匿名 legacy password fallback 如仍需保留，必须在显式隔离的兼容路径处理，不得进入匿名生产敏感操作路径。`/api/binary/auth/mfa/challenge/start` 不得为这些 action 在无 MFA 时直接签发空 proof，避免绕过等效 proof 要求。MFA challenge ticket 持久化 `AccountId` 与 `AccountSubjectHash`；验证失败时 Redis/L1/L2 计数以 `fail:subject:{accountSubjectHash}` 聚合，使匿名账号重建或内部 id 重排不会重置同一主体的失败窗口。回滚只应删除 `SecurityMfaChallenge` 中对应 `fail:subject:*` / ticket key，让用户重新发起短 TTL challenge，不需要重启服务，也不得降级回裸 `userId` key。

**ZK strong-anonymous comment path**：ZK 只作为评论作者模式 `zk_anonymous` 的强匿名扩展点保留，不参与普通账号登录、Passkey 登录、admin Passkey 登录或 JWT/session 认证。生产密码学选型由 [ADR-ZK-CircuitNative-Groth16.md](architecture/decisions/ADR-ZK-CircuitNative-Groth16.md) 固定为 circuit-native credential v2 + Groth16 anonymous comment proof，`circuit_id = fsus.anonymous.comment.v2`，`public_input_layout_version = 3`，`verifying_key_hash` 只能绑定 trusted setup vk hash；credential root / revocation root、issuer public key hash、policy hash、`nullifier = PRF(credential_secret, action_context, scope)` 与 fail-closed 语义不得由后续实现放宽。默认 `IZkProofVerifier` 为 `DisabledZkProofVerifier`，`AnonymousIdentity:ZkAnonymousCommentsEnabled=false`；即使配置打开但没有真实 verifier，`IZkAnonymousProofService` 也返回 `verifier_unavailable` 并拒绝写评论。生产 verifier adapter 只在 `AnonymousIdentity:ZkVerifier:Enabled=true` 且 `CircuitId`、`VerifyingKeyHash`、`PublicInputLayoutVersion`、`MaxProofBytes`、`Backend` 与对应 backend adapter 都完整可用时 `IsConfigured=true`；否则不得半启用。ZK proof 的 public inputs 包括 `action_context`、article/comment scope、`circuit_id`、`verifying_key_hash`、`public_input_layout_version`、`credential_epoch`、nullifier、credential commitment、credential root、revocation root、issuer public key hash、policy hash、credential level 和 reputation bucket；缺失 proof、缺失 public inputs、verifier unavailable 或 invalid proof 都必须 fail closed，不写入评论。`CommentActorResolver` 的 `zk_anonymous` 分支不得读取 user id 或 ProofToken 来派生 nullifier；nullifier hash、credential commitment/root/revocation root、issuer public key hash、policy hash、epoch、circuit id 和 verifying key hash 必须来自 public input model，并在调用 verifier 前完成廉价格式校验。

`AnonymousIdentity:ZkProd:*` 是生产强匿名评论的外层发布 gate，默认 `Enabled=false`。Production 下 `AllowDevVerifier=true` 或 `FallbackToLegacyAnonymous=true` 一律启动失败；`Enabled=true` 时还必须同时满足 native Groth16 verifier configured、trusted setup verified + verifying key hash present、circuit-native credential ready、运行态 issuer configured、anonymous credential root snapshot ready，否则 startup / readiness fail closed。credential ready 不能单独宣称生产可用；没有真实 circuit-native issuer backend 时 issuer 必须保持 unavailable，不得用 hash/HMAC fixture 或 placeholder signature 冒充。root snapshot ready 必须包含 credential root、revocation accumulator root 和 issuer public key hash，且未超过 grace 窗口。`GET /api/binary/comment/policy` 只暴露 coarse readiness 与枚举式 unavailable reason，不返回 proof、witness、credential secret、verifying key 内容或 backend 细节。前端只依据该 policy snapshot 决定是否展示/尝试 ZK-Prod 入口，不读取 env 或组件内硬编码绕过。

生产 circuit-native issuer backend 为 `AnonymousCredentialIssuer:CircuitNative:Backend=managed_circuit_native_v2`。实现必须是托管 .NET 10 代码，不引入 GPL 代码或后端 JS 依赖。启用时必须同时提供 32B issuer private key、64B BN254 issuer public key、public key SHA256、`Enabled=true`，并通过私钥派生公钥一致性检查；否则 issuer `IsConfigured=false`。`ProductionCircuitNativeCredentialIssuer` 使用纯 C# BN254 G1 Schnorr signer，签名格式固定为 `R.x || R.y || s` 96B，`s` 必须是 low-S canonical response；签发端只接受 circuit-native credential request，输出 issuer signature，并用 `MaxConcurrentSignatures`/`TimeoutMs` 做并发背压；verify 必须拒绝 high-S response、非曲线点和非 prime-order subgroup 点，避免签名延展性影响审计去重或 circuit 绑定。日志和高价值审计不得记录 raw request、credential secret、proof response 或 signature。旧 Blind BBS issuer/provider 不是生产兼容层，必须改造或删除。

ZK-Prod 后端依赖策略固定为 .NET 10 + `System.Text.Json`。trusted setup、verifying key、proof、manifest 和 evidence JSON 只允许用 `System.Text.Json` source generation、`Utf8JsonReader` 或 `JsonDocument` 解析；不得为 comment.v2 ZK 路径引入 `Newtonsoft.Json` 作为直接 parser。`Nethereum.ZkProofs*` / RapidSnark NuGet 路线当前会在 restore 中拉入 `Newtonsoft.Json 11.0.2` 并触发 high-severity NU1903，因此被 `comment-v2-feasibility.manifest.json` 标记为 `rejected-transitive-high-vulnerability`，不得进入生产 verifier/prover 集成。`Nethermind.MclBindings` `1.0.5` 已选作后端 verifier 的 MIT/BSD-3-Clause pairing 内核，覆盖真实 pairing/Groth16 verify equation；`check:privacy-zk-contract` 会运行 `tools/security/check-mcl-platform-assets.mjs`，要求恢复后的 NuGet package 同时包含 `linux-x64`、`linux-arm64`、`osx-x64`、`osx-arm64`、`win-x64`、`win-arm64` 六个主流服务器 RID 的 native MCL asset。该 gate 不声明 `linux-musl`/Alpine、移动端或浏览器 wasm 已覆盖；浏览器 prover 由仓库 C++23/Emscripten WASM 模块单独构建和校验。`Groth16.Net` / `Bn254.Net` 在 license expression、native binary provenance 和 CI evidence 完成前不得导入。

`fsus.anonymous.comment.v2` 的 circuit / trusted setup 仓库资产入口固定为 `security/zk/comment-v2-circuit.manifest.json`、`security/zk/comment-v2-tamper-cases.manifest.json`、`security/zk/comment-v2-feasibility.manifest.json`、`security/zk/comment-v2-trusted-setup.manifest.json` 与 `config/zk/anonymous-comment-v2-verifying-key.manifest.json`，说明文档位于 `docs/zk/anonymous-comment-v2-circuit.md` 和 `docs/zk/trusted-setup-ceremony.md`。当前 checkout 已有自写 circuit source `circuits/anonymous-comment-v2/comment_v2.circuit.json`、deterministic R1CS IR `artifacts/zk/comment-v2/comment_v2.r1cs`、用于 phase-2 的二进制 R1CS `artifacts/zk/comment-v2/comment_v2_groth16.r1cs`、self-written phase transcript、`comment_v2_final.fsg16pk`、`comment_v2_verifying_key.bin`、`comment_v2_verifying_key.json` 和 `comment_v2_prover_wasm.tar.gz`；IR 明确不是 Groth16 phase-2 ceremony input。trusted setup/config manifest 现在是 `ceremony_status=verified`、`production_usable=true`，`verifying_key_hash=27ea8a04e27eb66a5b61aab2251762a372bb3f39217c896bc5ad850fd859143c`，任何 `vk-sha256` / placeholder hash 都不得进入生产配置。`comment-v2-feasibility.manifest.json` 记录已选择 circuit-native credential v2，并将 BLS12-381/BBS in-circuit 与 split-BBS 方案标记为拒绝，同时记录 MCL 主流服务器 RID native asset gate。`tools/crypto/check-zk-comment-v2-manifests.mjs` 负责校验 public input layout、七条安全断言、nullifier secret/action/scope 绑定、revocation non-membership witness、identity-field 禁止项、tamper cases、feasibility gate、MCL RID asset gate、R1CS source/hash 绑定、SRS/transcript consistency 规则和 vk hash 绑定。

生产发布前必须运行 `npm --prefix src/frontend run check:privacy-zk-prod-smoke` 和 `npm --prefix src/frontend run check:privacy-zk-prod-release`。smoke 在 `AnonymousIdentity:ZkProd:Enabled=false` 或浏览器 prover artifact 缺失时只允许输出 `expected_unavailable`、trace id 和业务状态，不得伪造真实 proof 通过；真实上线 evidence 必须以 `--real-evidence` + `--require-real` 声明 `evidenceKind=real-groth16-cross-stack`、`circuitId=fsus.anonymous.comment.v2`、layout version 3、`proofSystem=Groth16`、真实 `verifyingKeyHash`、R1CS/proving-key/verifying-key/native-verifier/wasm-prover SHA-256、`performance.wasmProverP95Ms<=3000` 与 `performance.nativeVerifierP99Ms<=50`，并证明 frontend wasm prover 生成 proof、backend native verifier 接受同一 public inputs、tamper cases 全拒绝、`hashingFixtureUsed=false`、ticket issue、anonymous submit pending、identity headers omitted 与 sensitive payload redacted。真实 evidence 还必须携带 `artifacts.r1cs`、`artifacts.provingKey`、`artifacts.verifyingKey`、`artifacts.nativeVerifier`、`artifacts.wasmProver`、`artifacts.proofFixture`、`artifacts.publicInputs`、`artifacts.tamperCases` 的本地 `path` + `sha256`；smoke 和 release gate 会读取这些本地文件重算 SHA-256，且前五项必须与 `artifactHashes` 对应字段一致。release gate 在 `AnonymousIdentity:ZkProd:Enabled=false` 时只接受安全关闭基线；在开启时要求 native verifier 库、trusted setup manifest、issuer public key、anonymous credential root bootstrap evidence、ZK-Prod smoke evidence 和 rollback 文档同时就绪，且 smoke evidence 的 `verifyingKeyHash` 必须同时匹配生产配置、trusted setup manifest 与 canonical verifying key artifact hash；root bootstrap evidence 必须通过 `--root-bootstrap-evidence` 绑定同一个 `fsus.anonymous.comment.v2`、layout version 3 与 trusted setup `verifying_key_hash`。回滚只允许把 `AnonymousIdentity:ZkProd:Enabled=false` 下发到当前发布配置并重新运行 gate；不删除已写入的匿名评论，不改变审核队列数据，不影响 public opt-in 评论路径。

`ProductionZkProofVerifier` 在调用昂贵 verifier backend 前先做 cheap checks：action 必须是 `comment.create`，circuit/verifying-key/layout 必须匹配 immutable 配置快照，credential root、revocation root 和 issuer public key hash 必须同时命中 `IAnonymousCredentialRootReader` 的 active/grace runtime snapshot，proof 大小不得超过 `MaxProofBytes`，nullifier hash、credential commitment、policy hash、credential level、reputation bucket 和 root token 必须格式合法。ticket service 还会用 `NativeGroth16PublicInputCodec`、当前 root snapshot 和当前 policy snapshot hash 重建 canonical public inputs，并在 byte-for-byte mismatch 时 fail closed，不进入 native verifier。backend 调用使用 bounded concurrency 和明确 timeout，并支持 `CancellationToken`；timeout、取消、backend reject 或异常都统一返回 `invalid_proof`。日志只允许记录 backend 名称和 fail-closed 类别，不记录 proof 原文、witness、credential secret、credential commitment 原文或内部 verifier 失败细节。

`AnonymousIdentity:ZkVerifier:NativeGroth16:LibraryPath=managed:mcl` 使用 `Nethermind.MclBindings` 的 .NET 10/MCL 内核执行真实 BN_SNARK1 pairing verify equation；外部原生库路径仍支持 `fsus_zk_groth16_verify` C ABI。两条路径都必须先通过 verifying key path + SHA-256 绑定，MCL 内核只接受仓库定义的 `FSG16VK1` / `FSG16PF1` artifact 格式，按 `SHA256(canonical publicInputs)->Fr` 绑定 public input transcript，proof/publicInputs 任一篡改都 fail closed。浏览器 prover bundle 位于 `src/frontend/public/wasm/comment-privacy-prover.js`、`comment_privacy_runtime.wasm`、`comment-privacy-prover.zkey` 和 `comment-privacy-prover.manifest.json`，由 `npm --prefix src/frontend run build:wasm` 生成；cross-stack 测试会加载该 WASM bundle 并用 C# MCL fixture tool 校验证明。

仓库内的 `tests/fixtures/zk/comment-v2/mcl-pairing/fixture.manifest.json` 是 #555 的后端 verifier 子验收 fixture：`tools/security/ZkCommentV2MclFixture` 用 .NET 10 + `System.Text.Json` + MCL 生成 deterministic vk/proof/publicInputs/tamper metadata，`ZkCommentV2CrossStackFixtureTests` 通过真实 `NativeGroth16ZkProofBackend` 验证接受和篡改拒绝，`check:privacy-zk-contract` 与 `check:privacy-zk-backend` 都会执行该 gate。浏览器 prover 子验收由 `tests/security/zk-comment-v2-cross-stack-fixture.test.mjs` 覆盖：它加载 public WASM bundle 生成 proof/publicInputs，再调用同一 C# MCL fixture tool 校验。完整上线仍需 prod smoke/release evidence、issuer/root readiness 和 rollout 配置通过。

强匿名 ticket / submit 端点必须先挂 `RequireStrongAnonymousRequest()` / `RejectIdentifiedPrincipalFilter`，再组合 PoW、RiskControl 或业务 filter。该守卫只做 `Cookie`、`Authorization`、`X-Fsus-Access-Token`、`X-Fsus-Bearer-Token`、`X-Fsus-Session-Id`、future auth bridge header 的 presence check，并检查 `HttpContext.User.Identity.IsAuthenticated`；它不解析 cookie、不读取 header 原文、不访问数据库或 Redis。污染请求返回 AEDS `ApiError`，`Details=anonymous_identity_contaminated`，用户态文案固定为“匿名发布请求不能携带登录态，请刷新后重试。”；安全审计只记录 trace id、path、reason 和 presence flag。`/api/binary/comment/anonymous-ticket` 在读取请求体前还必须检查 ZK-Prod policy ready；feature flag 关闭、native verifier 未配置、trusted setup/issuer/root readiness 缺失时返回 `anonymous_comment_ticket_unavailable`，不得调用 ticket service、nullifier reservation 或 dev verifier fallback。

**Anonymous credential issuance**：`POST /api/binary/anonymous-credential/issue` 是登录用户领取强匿名凭证的唯一入口，必须挂 `RequireAnonymousAccountPrincipal()` 并只接受 `identity_kind=anonymous_account` 的普通匿名账号主体；AdminPrincipal、缺失 `identity_kind`、账号不存在/已删除或 `anonymous_credential_status != active` 必须在读取请求体和调用 issuer 前拒绝，并通过 `IAuditEventService.RecordHighValueAsync` 记录拒绝 reason。登录态只用于校验账号未注销、可登录、匿名凭证状态和 epoch 频率；被封禁账号是否允许领取由 `AnonymousCredentialIssuer:AllowBannedAccountIssuance` 显式配置，默认拒绝。服务端通过 `anonymous_credential_issuance_audit(subject_hash, epoch)` 唯一约束做频率真源，`subject_hash` 由账号 id 经独立 `AnonymousCredentialIssuer:SubjectHashPepper` HMAC 盲化得到，不保存 raw `user_id`，且不得回退到 `Jwt:SecretKey`、主机/路径材料或硬编码字面量；表内只保存 `subject_hash`、`epoch`、`status`、`created_at_utc` 和 `trace_id`，不得保存 `request_hash`、credential commitment、nullifier、proof witness、credential secret、credential request、issuer signature 或 issuer response 原文。`SubjectHashPepper` 必须在共享/生产环境保持稳定；轮换前需要接受当前 epoch 限频连续性重置。`anonymous_credential_issuance_audit` 由每日 retention cleanup 按 90 天清理，避免长期保留可关联的盲化签发频率记录。签发计算只通过 circuit-native issuer 返回可在 comment.v2 circuit 内验证的 issuer signature；默认 unavailable issuer fail-closed，不再由服务端使用 SHA256/HMAC fixture 派生可关联 commitment。高价值审计只记录签发状态、epoch、trace id 和短 subject hash，不写 raw account id；后续匿名评论 ticket / submit 不得借该表反查真实账号。

`AnonymousCredentialIssuer:CircuitNative:IssuerPrivateKeyPath` 是可伪造强匿名凭证的根密钥材料。启用 circuit-native issuer 时，启动校验必须拒绝位于 `wwwroot`、`uploads` 或 `backups` 目录下的私钥路径；Unix 平台上私钥文件权限不得宽于 `0600`。权限或路径不合规必须抛异常中止启动，不允许降级为可签发状态，也不提供运行时绕过开关。回退路径是修正文件位置/权限后重启，不复制私钥到公开静态目录。

**Anonymous credential root metadata**：`GET /api/binary/anonymous-credential/root` 与 `/circuit` 是公开 metadata 端点，只返回 root/circuit/verifying-key/issuer-public-key/public-input-layout/ZK 配置位，不签发凭证、不验证 proof、不读取 user session、Cookie、Authorization 或当前账号。`anonymous_credential_root` 表不得包含 user/account/session 映射字段；root miss、revocation root 缺失、issuer public key hash 缺失、过期或 verifier/root 未配置时返回 AEDS `anonymous_root_unavailable`，避免以 JSON 或登录态错误泄漏内部状态。撤销 accumulator 只保存不可逆 `revocation_handle_hash` 与公开 root，不写真实 userId、credential secret、witness 或签发审计关联材料；撤销审计不得记录原始 handle。

**Anonymous credential revocation witness**：`POST /api/binary/anonymous-credential/revocation-witness` 是公开 AEDS-only witness 读取端点，必须 `AllowAnonymous()`、`public_read` 限流、`RequireNoStoreResponse()` 并先挂 `RequireStrongAnonymousRequest()`，拒绝携带 Cookie、Authorization、`X-Fsus-*` session/token 或 authenticated principal 的请求。端点只根据 active root snapshot、请求内公开 circuit/root/issuer 字段和不可逆 `revocationHandleHash` 计算 `circuit-friendly-non-membership.v1` witness；metadata 未声明 `productionZkReady=true`、root mismatch、handle 已撤销或 accumulator 不可用时 fail closed。前端只缓存 `encodeCommentPrivacyRevocationWitnessMaterial` 生成的 witness envelope，wasm prover adapter 必须先用 `parseCommentPrivacyRevocationWitnessMaterial` 校验 algorithm/pathDepth/leaf/witness/siblings，再把 witness 传给 prover delegate。响应和日志不得包含 credential secret、issuer signature、proof 原文、真实账号标识、原始 revocation handle 或 witness 以外的内部 verifier 细节；该 endpoint 不生成也不验证 Groth16 proof。

**Anonymous comment governance**：匿名评论策略由 `IAnonymousCommentPolicyService` 统一裁决，默认 author mode 是 `anonymous`，`public` 必须有显式 opt-in；当 `AnonymousIdentity:AnonymousCommentsEnabled=false` 或 admin policy 关闭匿名评论时，`anonymous` 和 `zk_anonymous` 都必须拒绝。评论写入通过 `CommentActor` 落库：匿名模式写入 nullable `user_id`、scope 内稳定的服务端生成 display name、hash 后的 nullifier/subject projection，公开模式才写入真实 `user_id` 和 `public_handle`。`comment.user_id` 与 `reply_to_user_id` 是显式白名单兼容字段：分别只服务 public attribution 和旧回复投影兼容，不能作为默认匿名身份或撤回授权来源；后台审核归因只写 `moderated_by_admin_principal_id`，不得把 AdminPrincipal id 写入旧 `moderated_by_user_id`。账号侧 public attribution 查询必须绑定 `author_mode = public` 并使用 `idx_comment_attributable_public_user_id_desc` partial index。`anonymous_credential` 只保存 account-bound credential metadata：`account_id`、不可逆 `account_binding_hash`、credential type/level/status 和 revoke 时间，不保存 ZK credential commitment、nullifier、proof witness、credential secret 或可用于强匿名评论反查账号的材料；强匿名/ZK runtime material 只存在于 root/epoch/revocation metadata 和 ticket/proof 流程中。`comment_anonymous_nullifier` 只保存 scope 内 nullifier 使用状态、首末评论 id 和 block 状态。普通审核 API 不提供 nullifier 到真实账号的反向查询，封禁/限流只能通过 credential level、nullifier block 和 moderation subject hash 等最小投影执行。治理后台只通过 `/api/binary/admin/anonymous-governance/**` 读取 root/verifier/revocation 聚合、masked nullifier 列表并执行 block/revoke；端点必须要求 admin principal、对应匿名治理 permission、`fixed_ip` 限流、device fingerprint 和一次性 `X-Fsus-Mfa-Proof`。响应和高价值审计不得包含真实 user id、username、public handle、credential commitment、proof/witness/secret、raw IP/device fingerprint 或 nullifier 到账号映射；action 审计 target 只能保存不可逆摘要。

---

## 多因素认证（MFA / TOTP）

- 标准：RFC 6238 TOTP（Time-based OTP，30 秒窗口）
- 存储边界：`sys_user` 只保留 `MfaEnabled` 投影；TOTP secret、pending secret、verified time 和 TOTP recovery-code hash 均在 `user_mfa_profile`，不得回写 `sys_user.mfa*` legacy 列。
- 启用流程：`/mfa/setup/start` 只写 `user_mfa_profile.mfa_pending_secret_encrypted` / `mfa_pending_created_at`，展示二维码 + 密钥；`/mfa/setup/verify` 验证 pending secret 成功后才切换到 `mfa_secret_encrypted` 并启用 MFA
- 匿名身份模式：TOTP 只作为敏感操作 step-up，`/mfa/setup/start` 的 account label 固定为 `FsusBlog:account:{accountId}`，不得暴露 legacy username；`/mfa/setup/start`、`/mfa/disable` 与 `/mfa/recovery/regenerate` 必须用 `X-Fsus-Mfa-Proof` 提交 action=`mfa_setup|mfa_setup_rebind|mfa_disable|mfa_recovery_regenerate` 的一次性 proof，不读取旧 password body
- 重新绑定流程：已启用 MFA 的 legacy 非匿名用户调用 `/mfa/setup/start` 必须提交当前密码和当前 TOTP/恢复码；匿名身份模式下必须提交对应 action 的 step-up proof。`user_mfa_profile.mfa_secret_encrypted` 与 `sys_user.MfaEnabled` 投影在新 secret 验证前保持不变
- 登录流程：密码验证通过后，如用户已启用 MFA，颁发临时挑战令牌，等待 TOTP 码验证
- MFA challenge：`/api/binary/auth/mfa/challenge` 受 `fixed_ip` 限流保护，并对 ticket、user、IP 三个维度记录失败次数；达到阈值后消费 challenge，所有失败返回通用错误
- MFA proof、PoW replay proof 等只需布尔结果的安全一次性 token 通过 `IUnifiedCache.ConsumeOnceAsync` 消费；需要取回 payload 的 WebAuthn challenge 通过 `IUnifiedCache.ConsumeOnceAndGetAsync` 消费。两个 primitive 都必须先失效进程内 L1 cache；`ConsumeOnceAsync` 使用 Redis `Condition.KeyExists + KeyDelete` transaction，`ConsumeOnceAndGetAsync` 使用 Redis GETDEL 语义。调用方取消时不得继续创建 Redis mutation 或执行 registry unregister，避免 L2 已删除但 L1 仍可重放的进程内窗口。
- 恢复码：启用 MFA 时生成一批 128-bit 分组恢复码，服务端保存 `v3$argon2id` per-code salt + memory-hard hash（64MiB、t=3、p=4），并在 `user_mfa_profile.hash_version` 标记当前恢复码哈希版本；恢复码单次使用，耗尽后可通过 `/mfa/recovery/regenerate` 重新生成
- 旧恢复码迁移：裸 SHA-256 legacy hash 只允许在 2026-09-01 00:00:00Z 前消费一次，消费成功会移除该 hash 并标记需要重生成恢复码；deadline 后 legacy hash fail closed。TOTP 正常验证成功时，如 profile 仍是旧 `hash_version`，服务端会清空旧恢复码并要求重新生成。不得保留 PBKDF2 v2 或旧 `TryConsumeRecoveryCode` 兼容入口。
- MFA 恢复码不是账户 Recovery Key，不允许用于匿名账号恢复或 Passkey 重绑；匿名恢复只能走 Recovery Key + recovery session token。
- 管理员兜底不暴露旧文本 MFA reset 端点；账户恢复必须走受控安全流程和已登记的 `/api/binary/**` 管理端能力。
- Passkey 免 MFA：使用 Passkey 登录的用户视为已完成双因素，直接跳过 MFA 挑战

---

## 通行密钥（Passkey / WebAuthn / FIDO2）

- 规范：W3C Web Authentication Level 3（FIDO2）
- 凭证类型：Discoverable Credential（resident key），支持无用户名流程（usernameless）
- 库：Fido2 4.0.1
- 上限：每用户最多 5 枚 Passkey
- 持久化 schema：普通账号 Passkey credential 仍在 `passkey_credential` 表中，但账号外键最终态列名必须是 `account_id`，索引为 `idx_passkey_account_id`；历史 `user_id` / `idx_passkey_user_id` 只能作为迁移输入出现，服务代码不得继续通过 `PasskeyCredential.UserId` 读写凭据归属。
- 匿名账号 metadata：`FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1` 时，注册 begin 不再使用 legacy username 或内部数字 id；POD/DTO 字段使用 `accountHandle`、`accountName`、`accountDisplayName` 表达 Passkey-safe 账号句柄和显示标签，前端仅在 WebAuthn adapter 边界映射到浏览器要求的 `user.id/name/displayName`。WebAuthn `user.id` 来自 `sys_user.passkey_user_handle` 中持久化的 32B 随机 Base64Url 句柄。该句柄在同一账号多次注册和 Recovery Key 重绑后保持稳定，不能由数据库 id 推导。`Name` 固定为 `fsus-anonymous-account`，`DisplayName` 只有在用户显式配置 `public_handle` 时才使用公开 handle，否则使用 `Anonymous account`。
- 注册保护：已启用 MFA 的用户注册新 Passkey 须提供有效的 MFA proofToken
- 管理保护：删除或更新 Passkey 凭据友好名称必须先通过统一账号安全 step-up；proof 绑定 `passkey.delete` 或 `passkey.credential-name.update` 且单次消费，MFA enabled 账号不接受 password fallback，anonymous identity mode 禁止 legacy password fallback。
- 删除保护：匿名账号不能删除最后一枚可用 Passkey，除非已启用 Recovery Key / recovery path；拒绝时返回 `CannotRemoveLastCredentialWithoutRecovery`，避免冷启动账号失去全部登录能力。
- 传输契约：Passkey 注册/登录选项、attestation、assertion 与凭证管理均走 `/api/binary/auth/passkey/**`，请求与响应为 `application/octet-stream` AEDS frame；不再暴露文本字符串载荷
- 本地开发豁免：浏览器可把 `localhost` / `127.0.0.1` 视为 secure context，因此 Debug 环境允许在这两个 loopback origin 上用 HTTP 执行 WebAuthn ceremony。该豁免仅限本机开发和自动化测试；生产、共享预览、LAN IP 与自定义域名仍必须使用 HTTPS、匹配 RP ID 和明确的 `Fido2:Origins`。自动化中的“Passkey 注入”只能注入浏览器 WebAuthn virtual authenticator，然后走正常注册 / admin bootstrap / login complete 流程；不得通过数据库写入固定凭据替代 ceremony。
- 服务端配置：

  ```
  ServerDomain: 来自 Fido2:ServerDomain 配置（默认 localhost）
  ServerName:   来自 Fido2:ServerName 配置（默认 FsusBlog）
  Origins:      来自 Fido2:Origins 配置（HashSet<string>）
  TimestampDriftTolerance: 300000 ms
  ```

- 注册与登录均要求 `UserVerification=Required`；登录断言的 `assertionResponse.Id` 为 Base64Url 字符串（直接使用，不重复编码）
- 凭证唯一性：注册时校验凭证 ID 全局唯一（`IsCredentialIdUniqueToUserCallback`）
- 传输方式：存储 `RegisteredPublicKeyCredential.Transports` 数组（`.Length`）

---

## 会话管理

- 每次登录创建会话记录（设备、IP、时间），存储于 PostgreSQL + Redis
- 匿名账号 bootstrap 与 Passkey login complete 复用同一会话创建逻辑（`CompleteLoginAsync`），bootstrap 默认创建非 remember-me 标准会话，Passkey 登录按客户端 rememberMe 请求创建。
- `CompleteLoginAsync` 是 access token、refresh token 与 `UserSession` 记录的最终签发边界；MFA、Passkey 或匿名 bootstrap 已完成验证后，`User.Status == Banned` 会签发受限会话并写入 session，用于展示账号状态、登出、撤销会话、删除本人账号等安全收尾操作。`Deleted` / `DeletedAt` 仍必须返回注销失败且不得生成 token。
- 封禁状态的业务真源是 PostgreSQL `sys_user.Status/BanReason`。`SecurityBlacklistUser` Redis key 只作为无过期加速缓存，suffix 固定为 `account:{accountSubjectHash}`，不得使用裸 `UserId` / `AccountId`。任何缓存 miss 都必须回查 `sys_user.Status == Banned` 并重新回填缓存，不能把 Redis 过期、驱逐或 flush 解释为用户已解封。若需要在线降级或纠错，只删除受影响的 `account:{accountSubjectHash}` key，让下一次请求按 PostgreSQL 真源回填；不得重建旧 `userId` key 空间。
- `GET /api/binary/auth/sessions`：列出当前活跃会话
- `POST /api/binary/auth/sessions/{id}/revoke`：主动吊销单个会话
- `POST /api/binary/auth/sessions/revoke-others`：仅保留当前会话，吊销全部其他
- 登出（`/logout`）：立即吊销当前 Refresh Token，清除 Cookie

---

## 角色与访问控制（RBAC）

FsusBlog 采用三级角色体系：

| 角色 | 覆盖 | 典型操作 |
|------|------|----------|
| `anonymous` | 所有人 | 阅读公开文章、评论、搜索 |
| `authenticated` | 已登录用户 | 发评论、管理 Passkey/MFA、会话管理、消息 |
| `admin` | 管理员 | 用户管理、MFA 重置、Binary 统计、系统广播 |

权限通过 ASP.NET Core `[Authorize]` / `RequireAuthorization()` 在端点级别声明。

封禁用户写入限制由 `BannedUserMiddleware` 在 endpoint routing 之后执行。该中间件只对普通 `sys_user` 身份读取 `IBlacklistService.GetBanStateAsync(accountId, accountSubjectHash)`，以 Redis 为快路径、数据库为回源真相；封禁或解封入口必须先持久化 `sys_user.Status/BanReason` 再同步 `account:{accountSubjectHash}` 缓存。封禁账号的普通业务写入默认返回 `423 Locked`，Binary `ApiError.Details` 固定为 `ACCOUNT_BANNED_WRITE_LOCKED`；前端只能把它当作账号写锁，不能在前端单独决定安全边界。允许封禁用户完成的安全收尾操作必须在端点上显式声明 `AllowRestrictedAccountAction(RestrictedAccountAction.*)` metadata，当前仅用于登出、删除本人账号、撤销本人会话、撤销其他本人会话和申诉入口；消息创建、回复、已读等普通业务写入不得声明该 metadata。不得再通过 URL 片段、HTTP path 或 group 名称推导放行策略。

认证安全流响应的 `Cache-Control: no-store` 由端点 `RequireNoStoreResponse()` metadata 驱动，统一中间件在响应开始前写入 no-store / no-cache 头。PoW challenge、登录、登出、refresh、删除账号等认证端点必须同时声明该 metadata，而不是新增路径分支。

---

## CORS

- 仅允许明确配置的 Origin（`appsettings.json / Cors:AllowedOrigins`）
- 生产启动保护：如 `AllowedOrigins` 中包含任何 `http://` 来源，服务器拒绝启动
- 开发环境：允许 `http://localhost:*` 以支持 Vite HMR

---

## CSRF 防护

- Refresh Token 使用 `SameSite=Strict, HttpOnly, Secure` Cookie
- 生产环境认证 Cookie 使用 `__Host-*` 前缀、`Path=/`、无 `Domain`、`HttpOnly`、`Secure`、`SameSite=Strict`
- 生产认证读取只接受 `__Host-AccessToken`、`__Host-RefreshToken`、`__Host-SessionId`、`__Host-AdminAccessToken` 与 `__Host-AdminSessionId`；未前缀 legacy Cookie 只保留在清理路径，或在 Development/Local 且显式 `AuthCookies:AllowLegacyPlainCookieRead=true` 时用于普通用户本地迁移。AdminPrincipal Cookie 不支持未前缀读取 fallback，生产启动校验拒绝开启该 flag。
- `SameSite=Strict` 阻止跨站请求自动携带 Cookie
- 前端主调用凭据是 HttpOnly Cookie session / AEDS auth frame；如服务端内部仍签发短期 JWT，它不是浏览器主调用的 Bearer Header 事实。高风险写操作还会叠加 PoW、admin step-up proof、RBAC 与 no-store metadata，避免只依赖自动携带 Cookie。

## 作者工作台、订阅与 RUM 隐私

- `/api/binary/author/**` 全部要求 admin principal，并按路由声明 `AdminPermissions.*`：草稿、预览、修订、资产、导入导出和 AI 辅助要求 `article.write`，评论队列/审核要求 `comment.moderate`，匿名治理分别要求 `anonymous.comment.configure` / `anonymous.nullifier.block` / `anonymous.credential.revoke`，审计查询要求 `audit.read`，审核运行时、缓存和完整性运维要求 `system.config`。外部 `/api/author/**` JSON 入口和 internal bridge 兼容层均已移除。
- 服务端草稿按 `ownerAdminPrincipalId + draftKey` 唯一保存，owner 来自 independent admin principal 的 `admin_id`，不复用普通匿名账号 id；浏览器本地缓存仅作为断网兜底；跨设备恢复必须通过 admin cookie 读取 `/api/binary/author/drafts/{draftKey}`，不得落入公开 AOT、Service Worker shell cache 或搜索索引。
- 修订历史正文详情只允许 admin 在作者工作台读取；回滚必须走正式文章更新服务以写入新修订、审计记录和分发缓存失效，不允许通过 SQL/API 直接覆盖公开正文。
- `/api/binary/upload/**` 分片上传会话只接受可规范化为 32 位 GUID `N` 格式的 `uploadId`。`FileService` 在 status、part map、part upload、complete、abort、cleanup 和 session lock 边界统一规范化为小写 canonical 值；`.upload-sessions` 使用 full path 作为目录沙箱，manifest、parts 和 session delete 的路径解析必须保持在该根目录下。非法 `uploadId` 返回 validation/not found，不创建 session lock，不执行递归删除，也不向响应泄露物理路径。
- 未发布正文只允许出现在 admin-only JSON 响应中；预览 HTML 带 `data-preview-only=true` 和 `data-markdown-renderer=server-preview`，所有 Markdown HTML 输入先转义，前端写入 `srcdoc` 前再次剥离可执行标签/事件属性，并仅以 sandboxed unique-origin iframe 展示，不得写入 PublicAOT cache、search index、feed、sitemap 或 related-reading。
- related-reading 只基于公开文章的分类、标签、正文关键词和发布时间生成，不使用点赞、收藏、关注、登录用户、订阅邮箱或用户画像；端点和 PublicAOT 共用同一服务，防止 SPA/AOT 暴露面分叉。
- SEO 预览只读取当前表单和站点 SEO 配置；canonical/slug/OG image 预览不得对外生成路由或缓存。发布/定时发布前检查返回的 `error` 必须阻断提交，覆盖危险 HTML、未闭合代码块、不安全协议、私有站内路径和无效 public route 格式；`warning` 只能在作者填写跳过理由后继续提交，并由服务端记录 `prepublish-warning-override` 审计事件，不能自动降级为公开可见内容。
- 统一 SEO/品牌配置的 favicon、PWA icon、logo、wordmark、admin/login 图标 URL 只能保存空值、站内绝对路径或 `http/https` 绝对 URL；后端拒绝 `javascript:`、`data:`、协议相对 URL 和空字节。外部图片展示只扩展 `img-src`，不得扩展 script/style/connect CSP。当前品牌资产字段只引用已存在上传/静态资源；如果后续支持 SVG 原文上传或服务端转存，必须先做 MIME/header 校验与 SVG 脚本/外链清洗，并继续走 admin + PoW + 审计链路。
- 资产库只在 admin-only 作者工作台可见；重建索引只采集 `/uploads/illustration/*` 正文图片与封面 URL，孤儿清理只删除 `referenceCount=0` 的资产库索引行，不删除上传文件本体，也不得暴露为匿名目录浏览能力。运维保留期脚本默认也不删除上传资产；若显式启用上传资产扫描，必须提供 `FSUSBLOG_RETENTION_REFERENCED_ASSETS`，脚本会保护仍被文章引用的 `/uploads/illustration/*` 文件并在 `assetGuard.protectedReferencedAssets` 中记录证据。
- PWA 离线缓存仅限公开 shell 路由和搜索索引；`/user`、`/admin`、`/login` 与私有 API 不得被 service worker 离线命中。离线公开文章 smoke 通过 `check:pwa-offline-smoke` 验证 `X-Fsus-Offline-Stale: 1`，并验证私有 console 路由在离线时失败。
- 作者分析 dashboard 只读取 admin-only `/api/binary/author/analytics`。后端聚合 `VisitLog.routeKey`、`dwellMs`、`viewerKeyHash`、`proofId` 和 PublicAOT miss 审计；公开搜索词与 404 路径会被截断并聚合展示，不采集正文输入、账号、email、token、cookie 或可识别行为链。管理端最近评论统计只读取 comment author snapshot 字段，不通过 `sys_user` 反查账号作者。
- 评论创建默认进入待审状态，公开评论 API 只返回 `Approved` 且未被 viewer region 屏蔽的项。创建入口必须先做 endpoint payload 上限、字符数和 UTF-8 字节数校验，再进入内容过滤，避免超大正文消耗过滤器；回复只能挂到同文章、未删除且已通过的父评论/根评论。submit/viewer region 从连接 IP 或可信代理地区头解析，IP 只以独立 `Moderation:RegionPolicy:IpHashKey` HMAC hash 写入 `comment_region_compliance`，缺失或少于 32 字符必须 fail closed，不得回退到硬编码字面量或 JWT；CN-MAINLAND 严格策略只作用于 CN-MAINLAND submit/viewer，不自动外溢到 CN-HK/CN-MO/CN-TW。submit region 未知时评论进入待审且公开不可见；viewer region 未知时对非空 `blocked_regions` 保守隐藏。评论写入还会在 handler 前预读 AEDS payload 区分 root create 与 reply，仅写 RiskControl action metadata，不读取或改写匿名身份投影；内容过滤、地区合规和 nullifier 重复/封禁会写入 comment 专用风险信号。
- 多地区审核词库是 FsusBlog 自有硬规则层，位于模型 provider 之前。`configs/moderation/**` 只输出 `category/severity/reason/evidence`，并支持 `evidence_policy=redact`；`submit_action`、`display_action`、`blocked_regions` 只能由 `RegionLegalModerationService` 结合地区策略计算。CN-MAINLAND 必须加载 `political-sensitive`、`porn-strict`、`public-order`、`national-security`，但严格动作只作用于 CN-MAINLAND submit/viewer。词库加载、reload 失败、checksum 变化和 replay preview 写入结构化审计，context 只含版本/checksum/数量等 metadata，不记录词条明文。
- 可选反垃圾模型只在 `Moderation:AntiSpamModel:Enabled=true` 时调用，默认 `Provider=none`。`mock` 仅用于测试；`http-json` 外部 provider 必须同时配置 `AllowExternalProvider=true` 和 `ExternalProviderReviewed=true`，否则写 unavailable signal 并 fail-open。Provider 请求只包含内容、地区、策略和匿名安全 actor metadata；匿名评论不得向外部 provider 发送真实 account id、username、public handle、credential commitment 或 nullifier 原文。Provider 响应在持久化前会拒绝 `allow/reject_submit/geo_block/blocked_regions/submit_action/display_action` 等最终动作字段；模型超时、不可用或契约错误都不能绕过 Pending 人审。
- 审核队列、单条审核、批量审核和封禁联动全部位于 admin-only `/api/binary/author/comments/**`，并显式要求 `comment.moderate` 细粒度权限。审核读取和写入受 `fixed_ip` 限流；单条/批量审核还必须提交当前 admin 会话一次性 `X-Fsus-Mfa-Proof`，proof action 固定为 `admin-sensitive`，缺失或消费失败返回 step-up required。审核动作写入 `comment-moderation` / `comment-moderation-bulk` 审计；审核队列、审核通过实时推送和回复站内通知只能使用 comment / parent comment 行内作者快照生成展示名，不得通过 `user_id`、`reply_to_user_id` 或 `sys_user` 回退账号 username / public handle。拒绝/隐藏时的封禁联动只作用于非 admin、非注销用户，并同步黑名单缓存。匿名评论策略更新、治理后台读取、nullifier 封禁和匿名凭证撤销分别要求 `anonymous.comment.configure`、`anonymous.nullifier.block`、`anonymous.credential.revoke` 权限，均要求 admin passkey step-up 并通过 `IAuditEventService.RecordHighValueAsync` 写脱敏高价值审计；这些匿名治理权限不授予普通评论审核，`comment.moderate` 也不授予匿名治理。
- 第三方审核模型 Provider 只允许提供风险信号，不得决定 `reject_submit`、`geo_block`、`blocked_regions`、发布、隐藏或地区合法性。FsusBlog 负责硬词库、地区策略、viewer 过滤、策略 replay diff 和管理员最终动作；Provider 契约、schema、CLI/HTTP 示例和 conformance 工具见 [moderation/third-party-model-development.md](moderation/third-party-model-development.md)。
- 作者 AI 辅助默认 `Authoring:AiAssist:Enabled=false`；默认路径只做本地摘要/标签/结构建议，不把未发布正文发往外部 provider。外部 provider 只有在 `Authoring:AiAssist:Enabled=true`、`Authoring:AiAssist:Provider` 非 `local`、`Authoring:AiAssist:AllowExternalProvider=true` 且 `Authoring:AiAssist:ExternalProviderReviewed=true` 同时满足时才标记为 allowed；当前服务不直接持有 `HttpClient` 外发正文，每次调用都会写入 `author-ai-assist` 审计事件。
- `site_subscription` 只保存 `SHA256(email)`、channel、启用状态和退订时间，不保存明文 email，不构建读者画像或社交关系链。公开退订必须提交 `X-Fsus-Subscription-Proof`，proof 与 email hash/channel 绑定、TTL 生效并一次性消费；缺失、重放、过期或绑定不匹配返回 428，不能仅凭 email 更新订阅状态。默认实现不接入 SMTP、第三方邮件或 Web Push provider；RSS/Atom/JSON Feed 是主订阅通道，`channel=email` 仅记录显式订阅偏好，后续外发能力必须先补配置开关、退订 smoke 和安全评审。
- PWA Service Worker 只缓存公开 shell 路由；`/user`、`/admin`、`/login` 和 `/api/binary/**` 不进入 shell cache。离线公开页必须带 `X-Fsus-Offline-Stale`。
- RUM 仅采集公开页 `pageType`、`aotSource`、LCP、CLS、hydration time、Wasm decode/render timing、navigation timing 等匿名性能指标；私有页面不发送 Core Web Vitals，payload 不包含账号、email、token、cookie、正文输入。生产前端只调用 `POST /api/binary/telemetry/rum`，使用 `credentials: omit`、batched AEDS `RumMetricBatchRequest` frame、8192 bytes 帧上限和 `fixed_ip` 限流；服务端只允许固定 metric 名称、`value/domInteractive/responseStart/durationMs` 数值字段与低基数 dimension 白名单，未知字段会被丢弃或计入 rejectedCount。旧 `/api/telemetry/rum` JSON endpoint 已移除；净化后写入独立 `frontend_rum_metric` 表，不再混入安全审计表。
- 安全后台 dashboard、RiskControl 模拟器、AntiCrawler、PoW、风险分重置、规则与 allow/blocklist 管理只允许 admin 通过 `/api/binary/admin/security/**` 访问；策略更新、CIDR 手动同步、风险重置、规则/list 写入和 PoW 策略更新继续要求一次性 `X-Fsus-Mfa-Proof`，并写入 high-value security audit。RiskControl 模拟器不要求 `X-Fsus-Mfa-Proof`，但必须写入 security audit 且不能修改 challenge、策略或风险状态。外部 `/api/admin/security/**` JSON endpoint 已移除。
- 结构化审计写入 `sys_audit_log`：保留 `source/type/action/outcome/severity/actor/target`、trace/path/method、原因码和低基数 context；IP、User-Agent、session id、设备指纹只保存 SHA-256 hash。Serilog 到审计表的 mapper 只接受显式 `AuditActorType` + `AuditActorId` 作为 actor，不得从裸 `UserId`、`AccountId`、`InternalUserId` 或 `AdminPrincipalId` 自动推断审计主体；这些身份平面字段也不得进入普通 context payload。高价值 admin/security/audit 事件通过 `IAuditEventService` 同步写库，失败时写入 `FSUSBLOG_DATA_ROOT/audit-fallback/critical-audit-*.jsonl`，避免关键审计静默丢失。每条审计生成 `record_hash`，配置 `Audit:TamperEvidenceKey` 或 `Security:AuditTamperEvidenceKey` 时额外生成 `record_mac`；同一 `chain_id` 内写入时必须把当前行 `prev_hash` 链接到前一行 `record_hash`，批内和跨批都不能断链。`/user/manage/audit` 可查询详情并校验单条 hash/mac 以及同链前驱 hash，前驱缺失或重排会使校验失败。
- OpenTelemetry 自定义属性只允许 `fsus.*` 枚举字段，覆盖 route kind、状态码、组件、缓存 policy、AOT source、搜索模式、后台任务计数等低基数维度；不得写入原始路径参数、请求/响应正文、Authorization、Cookie、token、email、用户名、IP 或 User-Agent。`X-Fsus-Trace-Id` 仅用于用户报告和日志/trace 关联，不表示认证身份。

## 审计级别

普通审计记录用于低风险读取、预览和运营查询，允许异步写入并保留低基数 context。高价值审计用于 admin/security/audit、admin passkey step-up、PoW 策略、审核策略、评论公开可见性、不可逆修复、缓存/索引重建和会影响公开分发的写操作；这类事件必须通过 `IAuditEventService.RecordHighValueAsync` 同步落库，失败时写入 `FSUSBLOG_DATA_ROOT/audit-fallback/critical-audit-*.jsonl`，并保留 `source/type/action/outcome/severity/is_high_value/actor/target/trace/path/method/reason_code` 与 hash 化 IP、User-Agent、session id、device fingerprint。

审计 context 不得包含 Authorization、Cookie、token、email、用户名、请求/响应正文、原始 IP、原始 User-Agent、裸 `UserId`、`InternalUserId`、`AccountId` 或 `AdminPrincipalId`。配置 `Audit:TamperEvidenceKey` 或 `Security:AuditTamperEvidenceKey` 后，高价值与普通结构化审计都必须维持 `record_hash` / `record_mac` / `prev_hash` 链式证据；`/user/manage/audit` 查询和 verify 端点只展示结构化摘要与防篡改校验结果。

## Secret Rotation And Recovery

单作者生产环境的 secret 轮换必须先生成站点备份包：

```bash
tools/operations/backup-site.sh
```

- `Jwt__SecretKey`：生成新 secret 后滚动重启应用；旧 JWT 立即失效，依赖 refresh cookie 的会话也应通过用户 session 撤销或强制重新登录收口。
- 独立安全域密钥：`Security__Pow__SigningKey`、`Security__CaptchaV1__SigningKey`、`Security__RecoveryKeyPepper`、`AnonymousCredentialIssuer__SubjectHashPepper`、`VisitLog__IpHashPepper`、`Moderation__RegionPolicy__IpHashKey` 必须分别生成和轮换，不能复制 `Jwt__SecretKey`。PoW/Captcha/Recovery/SubjectHash/VisitLog/Region 任一路径缺少对应密钥都会 fail closed；回滚方式是恢复上一个同域密钥并滚动重启，而不是临时复用 JWT。轮换 `Moderation__RegionPolicy__IpHashKey` 后，旧 `comment_region_compliance.submit_ip_hash` 无法重哈希，必须使用 `tools/security/rotate-region-ip-hash-pepper.sh` 显式清空旧 hash，使旧 pepper 下的关联值失效。
- DataProtection keyring：默认追加新 key，不删除旧 key；只有确认旧 cookie、MFA pending payload 和恢复窗口全部过期后，才在离线维护窗口清理旧 key。迁移服务器时必须恢复 `data-protection-keyring.tar.gz`，否则受保护 cookie/MFA payload 不可读。
- Redis password：先更新 Redis ACL/密码，再更新 `ConnectionStrings__Redis` / `RedisOptions__Configuration`，重启后用 `/api/binary/author/ops/health` 验证 Redis 状态。Redis 数据不作为业务恢复来源。
- PostgreSQL password：先创建或切换数据库凭据，再更新 `ConnectionStrings__DefaultConnection`，重启前保留旧凭据到 readiness 通过。失败时恢复旧连接串或用最近数据库 dump 恢复。
- 域名/服务器迁移：同步恢复数据库、uploads、DataProtection keyring 和必要配置；更新 `SITE_BASEURL`、`CORS_ALLOWED_HOSTS`、`APP_ALLOWED_HOSTS`、Fido2/WebAuthn domain/origin 后，执行 `/health/ready`、`/user/manage/ops`、sitemap/feed 和登录/MFA smoke。

Secret 轮换、站点备份导出、数据巡检修复、批量封禁、匿名账号 suspend/unsuspend 与凭据治理等高价值操作必须写结构化审计。管理 UI 的危险操作策略来自 `/api/binary/author/ops/dangerous-operations/policy`：系统设置、导入、revision rollback、taxonomy 修改和 integrity fix 必须先展示 changed-fields diff；批量封禁、匿名账号状态治理、站点备份导出和 integrity fix 必须使用 admin passkey step-up。

## 安全测试矩阵

`./tools/test.sh security` 是安全边界的发布阻断门控，并被 `./tools/test.sh production` 调用。

- **生产入口配置**：Kestrel 只绑定宿主机回环地址、生产网关模板拒绝未知 Host、登录/admin/global 限流、隐藏文件和备份文件拒绝、WebSocket 代理头完整；`tools/security/check-production-network-baseline.sh` 同时运行 `tools/security/check-production-exposure-prereqs.sh` 与 `tools/security/test-production-exposure-tools.sh`，用合成证据回归测试 firewall policy verifier、DNS readiness/delegation evidence、live evidence verifier、status report、handoff/returned evidence 脚本与 production closeout 脚本。Prereq 会 fail-closed 校验 handoff bundle、returned evidence、returned handoff closeout 入口和 tar/find/xargs 等打包依赖存在且可执行。
- **生产公网暴露面 live 核验**：默认不在本地/CI 自动运行；设置 `FSUSBLOG_RUN_PRODUCTION_EXPOSURE_LIVE=1` 后，`./tools/test.sh security` 会调用 `tools/security/check-production-exposure-live.sh`，对生产域名的 DNS、`80/443`、禁止公开端口、HTTPS 与 HSTS 做实际网络探测。设置 `FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json` 可额外校验云安全组/主机防火墙策略证据：证据必须带新鲜 `generatedAt`、支持的 `evidenceSource.kind`、`evidenceSource.sourceSha256` 原始导出摘要、用 `appliesToHosts` 覆盖完整生产 host 列表，只允许公网 `80/443`，拒绝非私网来源上的非 Web 额外端口、覆盖额外端口的范围规则和 all-protocol 规则，SSH 必须限定为固定管理 IP、VPN 或私有管理网段，其中 `fixed-management-ip` 必须是单主机 CIDR，`private-management-network` 必须是真私网来源，Redis/PostgreSQL 只能来自私网来源，固定公网 CIDR 也会被拒绝；`tools/security/production-firewall-policy.evidence.example.jsonc` 只是占位模板，最终证据必须从真实云安全组或主机防火墙导出规范化而来。UFW 管理的生产主机可运行 `tools/security/collect-host-firewall-policy-evidence.sh` 从 `ufw status` 生成并立即校验 normalized evidence，采集器会解析 IPv4 与 `(v6)` 行、记录原始 UFW status sha256，并拒绝公网 IPv6 SSH；AWS EC2 security group 可先导出 `aws ec2 describe-security-groups`，再用 `tools/security/normalize-cloud-firewall-policy-evidence.sh` 转换并立即校验，normalizer 会记录原始 cloud export sha256。两个入口都会拒绝不完整或不安全规则；如果 normalized evidence 指向的 `sourceFile`/`statusFile` 在当前机器可读，verifier 会比对 `sourceSha256` 与原始文件。`tools/security/collect-production-hosts.sh` 会从 `FSUSBLOG_LIVE_HOSTS` 或生产 env 推导统一 host 集合，包括 SITE/SEO/CORS/AllowedHosts/Fido2 来源，并拒绝 wildcard、localhost、IP literal 或非法 hostname；`tools/security/check-production-dns-delegation.sh` 会为根生产域生成 DNS delegation evidence，要求公共 resolver 有 NS/SOA 且 TLD authoritative nameserver 有 NS 委派；`tools/security/check-production-dns-readiness.sh` 会为完整 host 集合单独生成 DNS readiness evidence，要求本地 resolver 和每个公共 resolver 至少有 A/AAAA 答案；live evidence 会写入 `generatedAt` 与 `requiredHosts`，verifier 会拒绝过期、缺少 `requiredHosts` 或遗漏任一 required host 的证据，DNS readiness 的 `requiredHosts` 与 DNS delegation 的 `delegationDomains` 也会在 status report/production closeout 中强制覆盖完整生产 scope；verifier、status report、standalone production closeout 都支持脚本生成的空格分隔字段或外部运维交回的 JSON array。status report 还会把 live evidence 的 host 集合与完整生产 host 集合交叉比对，standalone production closeout 也会用 evidence `requiredHosts` 约束 firewall policy，并要求 DNS readiness/delegation evidence 与 status report 同时通过。设置 `FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE=.tmp/security/production-exposure-live.json` 可保留机器可读 live 证据，并在 security gate 中追加 `tools/security/verify-production-exposure-evidence.sh` 机器校验；`tools/security/report-production-exposure-status.sh` 可把 firewall policy verifier、强制的新鲜 DNS readiness/delegation evidence 与 live evidence verifier 的当前阻塞原因汇总为 `.tmp/security/production-exposure-status.json`，用于 release notes 和 handoff request。脚本默认记录 `1.1.1.1` 和 `8.8.8.8` 的 A/AAAA 公共解析结果，可用 `FSUSBLOG_DNS_RESOLVERS` 覆盖。DNS 切换前可用 `FSUSBLOG_LIVE_TARGETS=fsus.blog=203.0.113.10,www.fsus.blog=203.0.113.10` 对指定地址做 Host/SNI 探测，但 production closeout 仍必须以真实 DNS 解析成功为完成依据。最终收口使用 `tools/security/complete-production-exposure-closeout.sh`；它会按顺序执行本地依赖检查、配置基线、DNS delegation、firewall policy verifier、DNS readiness、live probe、evidence verifier、status report 和 production closeout verifier，并拒绝任何不完整证据。
- **生产收口失败证据**：`tools/security/complete-production-exposure-closeout.sh` 遇到 DNS/firewall/live 阻塞时会尽量继续执行后续 evidence-generating checks，再写出 `FSUSBLOG_PRODUCTION_EXPOSURE_STATUS` 指向的 status report，默认是 `.tmp/security/production-exposure-status.json`，用于保留 firewall/DNS/live 阻塞原因和 release evidence 采集。失败路径保持 closeout status 为 blocked；只有所有 verifier 与 status report 都通过后才会进入 production closeout verifier。
- **生产证据请求包**：`tools/security/write-production-exposure-evidence-request.sh` 会从同一套 production host source 生成 `.tmp/security/production-exposure-evidence-request.json`，列出 required hosts、delegation domains、DNS resolver、必须开放/禁止开放端口、firewall policy 要求、云安全组或 UFW 采集入口、最终 closeout 命令、returned-evidence/returned-handoff closeout 命令和 release evidence 命令。请求包还会内嵌 `requiredEvidence`、`verificationCommands` 与 `handoffChecks`，明确每个必交 artifact 的目标文件、标准 release artifact 名称、直接 closeout、回传证据 verifier、回传目录 closeout、回传 handoff closeout 和 handoff 校验命令。请求包还会内嵌当前 status report 的 `currentStatus`、`blockers`、按 blocker source 生成的 `nextActions`，以及机器可读 `unblockPlan`；`unblockPlan` 会为每个 blocker source 写出 blocker count、对应 artifact 名称、evidence file path 和生成/验证命令，便于外部运维按源头补证据。`tools/security/complete-production-exposure-closeout.sh` 会在执行开始生成请求包，并在 status report 写出后再刷新一次请求包。该文件用于交给运维/云侧人员收集真实证据，不是通过证据。
- **生产证据 handoff 校验**：`tools/security/check-production-exposure-handoff.sh` 校验 request 与 status report 的 status、blocker count、blocker sources、blocker 明细、requiredHosts、delegationDomains、nextActions 覆盖、`unblockPlan` 覆盖和 `firewallPolicy`/`dnsReadiness`/`dnsDelegation`/`liveExposure`/`statusReport` evidence file 路径一致性；request 的 `requiredEvidence` 必须覆盖每个 evidence file 并声明标准 artifact 名称，firewallPolicy 条目必须声明 `sourceSha256Required=true`，`firewallPolicyRequirements.rawSourceSha256Required` 必须为 `true`，`verificationCommands`、顶层 closeout command 字段与 `handoffChecks` 必须包含直接 closeout、returned evidence verifier、returned evidence closeout、returned handoff closeout、release evidence 和 handoff 校验入口。传入 release manifest 时还会校验 bundle 内复制的 request/status/live/DNS/firewall artifact 是否使用标准文件名、是否存在且与源证据一致，并校验这些 artifact 的 `artifactDigests` sha256 摘要以及 `evidenceSummary.externalExposure.valid`、`evidenceSummary.externalExposure.blockers`、`evidenceSummary.externalExposure.request` 的 status、blocker count、blocker sources、nextActionSources、unblockPlanSources、unblockPlanCount、requiredHosts、delegationDomains、requiredEvidenceKeys、requiredEvidenceCount、firewallSourceSha256Required、rawSourceSha256Required、handoffCheckCount、verificationCommandNames、verificationCommandCount、returnedCloseoutCommandCount 与 closeoutCommands 是否与 request/status JSON 对齐。manifest 的 `firewallPolicy`、`dnsReadiness`、`dnsDelegation`、`liveExposure` 组件状态也必须与当前源证据推导结果一致，避免组件摘要被手工改写为通过。缺失 artifact 必须同时缺失 digest，避免旧 digest 被误读为通过证据。默认拒绝 `/tmp/tmp...` evidence path，避免自测 fixture 污染真实 handoff；只有测试场景可显式设置 `FSUSBLOG_ALLOW_TEMP_EVIDENCE=1`。`tools/security/export-production-exposure-handoff-bundle.sh <manifest.json>` 在 handoff 校验通过后才会生成外部交付包，包内包含 release evidence、`handoff-summary.json`、`operator-checklist.json`、`returned-evidence/expected-evidence-manifest.json`、`SHA256SUMS` 和 tarball 摘要，并在返回成功前自校验输出目录与 tarball，但 blocked manifest 仍不能作为生产 closeout 通过信号；`operator-checklist.json` 是给外部运维使用的短格式 blocker-source 清单，必须与 request 的 `unblockPlan`、artifact 名称和 closeout 命令一致；`returned-evidence/` 只是给运维回填标准 JSON 文件的空槽和 scope 清单，并保留 returned-evidence subset 的 unblock plan、plan source 列表与数量。`tools/security/check-production-exposure-handoff-bundle.sh <handoff-dir-or-tar.gz>` 会校验 bundle 目录或 tarball sha256、复制出的 release manifest artifactDigests、handoff summary、operator checklist、handoff README、returned-evidence manifest/README，并在解压前拒绝绝对路径、`..` archive member 或非普通文件/目录 entry，且拒绝 bundle 内任何 symlink，防止发送或回收时 artifact 摘要被改写、unblock plan/returned closeout 命令被丢失、标准文件名被删掉、scope 被改窄或校验过程跟随链接读取外部文件。外部证据回传后先运行 `tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>`；它会拒绝 returned evidence 目录自身或目录内文件为 symlink，要求标准文件名、先用当前 production host source 固定 requiredHosts/delegationDomains，校验可选的 `expected-evidence-manifest.json` 是否仍覆盖完整 scope、四个标准回传文件、manifest source metadata、returned `unblockPlan` sources/count 以及 plan evidence key/file/artifact/command/verifier 映射，并拒绝缩窄 scope 的 returned request 或 expected manifest，再复用 firewall/DNS/live/status verifier，刷新 returned 目录中的 status/request，生成并 handoff 校验 release manifest，避免把未验证的运维回传文件直接用于 production closeout。只有 returned status 为 `ok` 且目录保留 `expected-evidence-manifest.json` 时，`tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>` 才会调用标准 production closeout verifier。
- **回传 handoff 一键收口**：如果外部运维回传的是整个 handoff 目录或 `.tar.gz`，先运行 `tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>`。该入口会校验 tarball `.sha256`，并在输入包含 release evidence、`SHA256SUMS` 或 `handoff-summary.json` 时先运行 `check-production-exposure-handoff-bundle.sh`，确保 release manifest、summary、operator checklist、expected manifest 和 checksum 都未被改写或缩窄；之后才定位 `returned-evidence/`、要求 `expected-evidence-manifest.json` 保留完整 scope，再复用 returned-evidence verifier 和标准 production closeout verifier。直接把完整 handoff 下的 `returned-evidence/` 目录传给 `complete-production-exposure-from-returned-evidence.sh` 时，也会先检测并校验父级 handoff bundle。空回传槽、blocked evidence、scope 缩窄或 handoff bundle metadata 漂移都不得报告 closeout 成功。tarball 输入在 verifier 写出 blocked artifacts 后失败时，会把解包后的证据保留到 `.tmp/security/production-exposure-returned-handoff/`，避免失败诊断随临时目录一起丢失。
- **Firewall evidence 自动收口**：`tools/security/complete-production-exposure-closeout.sh` 支持显式接入 `FSUSBLOG_CLOUD_FIREWALL_SOURCE`、`FSUSBLOG_COLLECT_HOST_FIREWALL_POLICY=1` 或 `FSUSBLOG_UFW_STATUS_FILE`，先生成并校验 firewall evidence，再进入 live probe 和 production closeout verifier；未提供这些输入时仍要求已有 `FSUSBLOG_FIREWALL_POLICY_EVIDENCE`。
- **认证 / 会话**：注册、登录、refresh、logout、MFA、Passkey、会话吊销、伪造 Cookie/JWT。
- **鉴权 / RBAC**：匿名、普通登录用户、admin 对公开读、用户写、管理写、binary 路由的权限矩阵。
- **输入攻击**：XSS-like、SQL-like（登录用户名、admin keyword、数值查询 / 路由边界）、路径穿越、双重编码、method override、超长 payload、错误 content-type。
- **Binary / Notification Stream**：AEDS v2、截断 frame、错误 frame type、错误版本、WebSocket 非升级、错误子协议、匿名缺 RiskControl / legacy PoW proof。
- **真人计数**：无 proof 读取不增加浏览数，challenge 篡改、route/article 不匹配、停留不足、重放、直接 API、crawler/scanner 不写入计数事件。
- **浏览器安全面**：CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy、Permissions-Policy、CORS allow/deny/preflight、auth/PoW no-store。
- **DAST**：OWASP ZAP baseline 对本地运行目标执行 spider + passive scan；FAIL 级告警会阻断发布，报告保存在 `.tmp/security/zap/`。
- **ASVS / WSTG / WebAuthn 追踪**：`security/asvs-v5.0.0-matrix.yml`、`security/wstg-v4.2-matrix.yml` 与 `security/webauthn-matrix.yml` 将安全控制映射到代码、测试、证据与 owner；`tools/security/check-security-matrices.mjs` 会在 `security` / `production` 门禁中校验矩阵结构、版本化 ID 和本地路径。
- **ZAP WARN 策略**：`security/zap-warn-policy.yml` 为每个 ZAP WARN 规则登记 owner、接受理由、修复期限、状态和升级为 FAIL 的条件；`tools/security/check-zap-warn-policy.mjs` 在 ZAP baseline 前校验清单，并保持关键规则为 FAIL。
- **供应链审计**：`tools/security/check-supply-chain-audit.sh` 执行 `dotnet list package --vulnerable --include-transitive --format json` 与 `npm audit --omit=dev --audit-level=high --json`，并要求 `src/frontend/package-lock.json` 以及每个 audited `.csproj` 旁的 `packages.lock.json` 存在；高危或严重漏洞会阻断 `security` / `production` 门禁，结果保存在 `.tmp/security/supply-chain/`。
- **依赖变更审查**：`.github/dependabot.yml` 覆盖 npm、NuGet 与 GitHub Actions 更新；`.github/workflows/dependency-review.yml` 在 PR 上阻断 high/critical advisory，并对 AGPL/GPL/LGPL license 风险 fail closed。
- **SBOM**：`tools/security/generate-sbom.sh` 从 NuGet lock files、`src/frontend/package-lock.json` 和 `FSUSBLOG_IMAGE_DIGEST` 生成 CycloneDX 1.5 SBOM，包含私有 GitHub Packages 组件和容器 digest 状态；release evidence 会复制 `.tmp/security/sbom/`。
- **隐私快照**：RUM、subscription、author AI assist、OpenTelemetry 和 audit log 都有静态或单元测试保护；audit context mapper 会丢弃 `Authorization`、cookie、token、email、request body、原始 client IP、原始 user agent 和 username 字段，只保留 trace correlation、低基数字段以及 IP/UA/session/fingerprint hash。
- **安全证据留存**：`check-security-attack-matrix.mjs` 和 `check-permission-matrix.mjs` 会分别写入 `.tmp/security/attack-matrix.json` 与 `.tmp/security/permission-matrix.json`。`tools/operations/collect-release-evidence.sh` 会把这些文件、DAST/ZAP 目录、production exposure status、DNS readiness/delegation、live exposure 和可用 firewall policy evidence 复制到 `.tmp/release-evidence/<timestamp>/`，并在 `manifest.json.securityEvidenceIndex` 中索引。`manifest.json.evidenceSummary.externalExposure` 记录外部证据是否有效；`valid=false` 表示 release 被阻塞而不是可发布。缺失的真实 firewall/DNS/live 证据不能用合成通过件替代；缺失状态应保留为 `null` 加 `production-exposure-status.json` blocker。

测试矩阵覆盖已知攻击类和回归风险，不构成对未知攻击的绝对安全承诺；新增风险必须补到矩阵或 ZAP 配置中。

---

## 生产安全检查清单

生产环境通过 `ProductionStartupValidator`、最小 `/health/ready` 与 `./tools/test.sh security` 执行以下校验；详细失败明细只通过受保护的 `/api/ops/health/ready-detail` 暴露。启动阶段校验失败会 fail-closed 阻止应用启动；危险开关 `FSUSBLOG_ALLOW_INSECURE_STARTUP=true` 仅限本地诊断，且不能绕过 JWT 默认/占位密钥、wildcard `AllowedHosts`、缺失反向代理信任边界或 HTTP 生产来源这类安全关键错误。允许降级的非关键项也必须写出 critical 告警，readiness 仍会返回 `503`，发布流程必须把该状态视为阻断。

- [ ] JWT 密钥来自部署 secret，不在共享配置中保存默认值，且不为默认/占位/短密钥
- [ ] Redis 密码不为空
- [ ] `FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1`，生产不允许 legacy `sys_user.role=admin` 授予后台权限
- [ ] `SITE_BASEURL` 以 `https://` 开头
- [ ] `AllowedHosts` 显式列出生产域名，且不使用 `*`
- [ ] `ReverseProxy:KnownProxies` 或 `ReverseProxy:KnownNetworks` 只包含真实网关 IP / 私网 CIDR
- [ ] CORS AllowedOrigins 中无 `http://` 来源
- [ ] `AuthCookies:AllowInsecureTransportCookies=false`，Development 以外认证 Cookie 强制 `Secure` 与 `__Host-` 前缀
- [ ] Fido2 `ServerDomain` 与实际部署域名一致
- [ ] `Fido2:Origins` 包含实际部署来源
- [ ] `Fido2:Origins` 与 `SITE_BASEURL` / `CORS_ALLOWED_HOSTS` 对齐，且生产来源全部使用 HTTPS
- [ ] Docker compose 不把 Kestrel `8080`、Redis `6379`、PostgreSQL `5432` 暴露到公网
- [ ] 生产 OpenResty/Nginx 默认拒绝未知 Host，并为 `/login`、`/admin`、`/api/binary/auth/**`、`/api/binary/admin/**`、`/api/binary/author/**` 配置认证/后台限流
- [ ] 使用 `FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE=.tmp/security/production-exposure-live.json tools/security/complete-production-exposure-closeout.sh`，确认生产 DNS 已解析、只有 `80/443` 对公网开放、SSH 仅允许固定管理 IP/VPN/私有管理网段、`6379/5432/8080` 不可公网访问，且所有生产域名 HTTPS + HSTS 正常；脚本验证通过后会写出 `status=ok`

外部云安全组、防火墙和 Redis/PostgreSQL 私网访问控制仍需在基础设施层执行；仓库内检查只能防止应用配置和部署模板回退。

---

## 依赖与版本

| 依赖 | 版本 | 用途 |
|------|------|------|
| BCrypt.Net-Next | 4.1.0 | 密码哈希 |
| Fido2 | 4.0.1 | WebAuthn / FIDO2 |
| System.Buffers.Text.Base64Url | .NET 10 BCL | WebAuthn ID 编解码（替代旧版 FIDO2 helper 的 `Base64Url` 类） |
| ASP.NET Core Data Protection | 10 | Cookie 保护 |
| ASP.NET Core RateLimiting | 10 | IP 速率限制 |
