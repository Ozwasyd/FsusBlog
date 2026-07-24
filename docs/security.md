# 安全模型

本文档说明 FsusBlog 采用的安全机制及其实现要点。

主题 CSS 是不可信的声明式输入。安装和激活都通过
`ThemeCssSafetyScanner` fail closed：只允许 exact `data-theme` 稳定 scope，
拒绝 Element Plus internal selector、远程或未知资源、script-like URL、
full-viewport fixed overlay、超预算 z-index/filter、无限 motion、layout
transition，以及 CSS/asset/preview/selector/depth/`!important`/duration
超限。激活从内容寻址存储重开 archive 并重验 package hash，失败不会改变现有
activation。无需重启的回退是禁用受影响 scope 或切回仍能通过重扫的已安装主题，
不得绕过 scanner 或放宽 hard ceiling。详细合同与 release evidence 见
[Theme CSS safety and asset budgets](themes/css-safety.md)。

> 2026-07-16 匿名资格最小披露覆盖说明：运行时 contract 为 `fsus.anonymous.comment.v5` / layout `6`。精确 credential epoch/level、reputation bucket 和 account age 不再是 public input，也不得进入 ticket、comment、moderation/provider、stats/admin 或 release evidence。公开只允许 `is_eligible`、`may_comment`、`rate_class=common|unknown`、`requires_moderation` 与 root/version/hash 绑定；Production 匿名集下限为 20，低于阈值必须合并重证或 fail closed。v5 ceremony 尚未执行且 `production_usable=false`，旧 layout/key/ticket codec 不能回退启用。发布前运行 `check:privacy-zk-prod-release`；无需重启的回退是热更新 `AnonymousIdentity:ZkProd:Enabled=false`（并关闭 ZK anonymous comments），不删除已写入的匿名评论、root 或 vault 数据。

Production build 同样遵守该 fail-closed 边界。`FSUSBLOG_ZK_PRODUCTION_ENABLED` 默认 `0`；当前 v5 trusted-setup manifest 为 `production_usable=false` 时，Docker/Wasm/CI build 不读取、不复制也不发布 proving key 或 browser prover manifest，普通 AEDS/PoW/search/image Wasm 仍正常构建。只有显式设置为 `1` 才会进入 ZK prover 打包，并且必须先通过 `tools/security/comment-privacy-build-contract.mjs`：circuit/setup/config 必须全部为 `fsus.anonymous.comment.v5` / layout `6`，ceremony 与 phase2 为 `verified`，贡献数、transcript、R1CS、proving key、verifying key、prover bundle 与 verifying-key binding 的 SHA-256 必须完整且与实际文件一致。任何缺失、路径越界、淘汰 layout 或 digest 漂移都会在昂贵编译前失败；旧 key 没有兼容、恢复或回退入口。

Security-risk 持久化只使用独立、带 epoch 且按 IP/device/account 域隔离的 HMAC pseudonym，并停止保留请求 path 与 User-Agent。生产 key ring、轮换、遗留 unkeyed hash 删除迁移、retention 和流量回退要求见 [security-risk identity pseudonyms](security/security-risk-pseudonyms.md)。

普通账号 session 元数据也遵循最小化边界：`X-Fsus-Device-Fp` 明确不可信且不是 credential；`sys_user_session` 不保存原始 fingerprint、完整 IP 或完整 User-Agent，只保存账号作用域、epoch 隔离的 device/network HMAC 与 browser/OS/form-factor 标签。IPv4 先截断为 `/24`、IPv6 截断为 `/48`；缺失或变化的 signal 不能独立授权、绑定账号、豁免 step-up 或扩大撤销范围。旧值清理、30 天默认 retention、key rotation 与无需重启的风险信号降级见 [user-session metadata privacy](security/user-session-metadata-privacy.md)。

历史 VisitLog IP pseudonym 仍按受限 pseudonym 而非匿名数据处置；当前 read analytics 不再创建该 pseudonym，也不把任何地址或地址 hash 放进 `VisitLogMessage`。遗留 `VisitLog:IpPseudonymization` key 只供仍在迁移期使用 `security-log` domain 的安全日志调用方，不能恢复 `analytics` 写入。历史 raw IP 的删除必须同步覆盖 backup、WAL archive、日志、Redis legacy keys 与 ETL/S3，保留上限、DSR export/delete、脱敏审计和月度全链扫描见 [historical raw-IP lifecycle](security/ip-anonymization-lifecycle.md)。不得用备份加密代替删除，也不得为按用户查找访问记录重建账号关联。

## 纵深防御层次

```text
网络层      Nginx/OpenResty：SSL 终端、HTTPS 强制、未知 Host 拒绝、真实 IP 传递
传输层      HTTPS only（生产启动拒绝 HTTP CORS Origin）
应用层      PoW → 速率限制 → 认证 → MFA / Passkey → RBAC
数据层      BCrypt 密码哈希、JWT 短寿命、会话隔离、密码学安全随机数
客户端      SameSite Cookie、HttpOnly、Secure；CSP、XFO、XCTO、Referrer-Policy、Permissions-Policy；真人阅读 proof
```

## 安全密钥域隔离

`Jwt:SecretKey` 只用于 JWT 签发和校验，不能作为其他安全子系统的派生材料。所有新 JWT 都把 `Jwt:KeyVersion` 写入 JOSE `kid`；验证只接受 current key 或仍处于 `AcceptUntilUtc` 窗口内、版本精确匹配的 `Jwt:PreviousKeys`，未知/过期版本 fail closed。旧版无 `kid` token 只允许在显式 `Jwt:LegacyNoKidAcceptUntilUtc` 一次性迁移窗口内验证，不能永久 try-all。生产启动校验要求 JWT key ring 的版本唯一、密钥至少 32 bytes、各密钥独立且窗口不超过 `Jwt:RotationWindowDays`。完整蓝绿轮换与无需重启的流量回退见 [JWT signing-key rotation](security/jwt-key-rotation.md)。生产启动还要求 PoW、sealed perception、Recovery Key、PublicAot、MFA、匿名凭证、VisitLog 和 moderation 各自使用独立配置密钥。VisitLog key 必须是 Base64 编码的至少 32-byte KMS/secret-manager root；缺失、模板值、旧 `VisitLog:IpHashPepper` 或跨域复用会使生产启动失败。运行时服务不回退到 JWT、本机名、应用目录或硬编码开发字面量。

Integrity proof signing keys are separate from JWT, PoW, Perception, audit, anonymous identity, and moderation secrets. `SiteIntegritySigningService` uses .NET built-in `ECDSA_P256_SHA256` with payload domain separator `fsusblog.integrity.publish-proof.v1`; it does not use Ed25519 unless a future release adds an explicit reviewed dependency. Private keys must come only from server-side environment variables, secret volumes, or controlled configuration and must never be logged, sent to the browser, placed in public manifests, or managed by C++/Wasm. Missing production signing configuration degrades integrity proof signing to `Disabled`/`Pending` and must not mint fake signatures. Revoked keys may still verify historical signatures before `revokedAtUtc`; compromised keys reject all verification. Lifecycle details are documented in [Site Integrity Signing Keys](integrity/site-signing-keys.md).

这些密钥分别保护 PoW 签名、sealed perception token、Recovery Key lookup/hash、匿名凭证签发限频 subject hash、遗留 security-log IP pseudonym 和地区策略 IP hash。read analytics 的短期去重使用 `HumanReadProof:Dedup` 独立 key。任一密钥泄露只允许影响其所属安全域。

ASP.NET Core Data Protection 使用独立 X.509 RSA 证书保护共享 key ring 的静态 XML。生产环境必须配置 `DataProtection:KeyProtection:Mode=Certificate`、当前 PKCS#12 证书路径，并保持 `ApplicationName=FsusBlog`；缺少 protector、证书不可加载、当前证书无 RSA 私钥/已过期，或共享 ring 中发现遗留明文 key 时启动 fail closed。证书私钥不能放进共享 key-ring 目录、镜像或备份包。蓝绿实例同时挂载同一 ring，并在证书轮换期间同时配置 current 与 previous certificates，公共 Cookie、antiforgery 和 Data Protection payload 的 wire 语义不变。部署、轮换、明文 ring 迁移和无需重启的流量回退步骤见 [Data Protection Key Ring At-Rest Protection](security/data-protection-key-ring.md)。

日志、审计、指标和 structured fallback 不得打印原始客户端 IP。PoW/crawler 日志只允许写 `VisitLogIpPseudonymizer` 的 `security-log` 域 128-bit UTC 日假名；read analytics 不再使用或持久化 `analytics` IP pseudonym。所有路径都不得回退到 raw `GetClientIp()`、`RemoteIpAddress`、`X-Forwarded-For`、`X-Real-IP` 或其他密钥。普通日志同样不得输出 raw PoW salt、MFA `AccountId`、audit `TargetId`、SQL 文本/参数、LocalAuth fixture stdout/stderr、本地绝对路径、moderation dictionary exception message、issuer private/public key readiness flag、raw User-Agent、raw request path 或可逆 token/proof/challenge material；生产启动状态与 readiness 输出也只允许固定错误类别，不得携带底层 exception message 或运行时类型。需要排障时只记录短 hash、固定错误类别、数量或低基数状态。

文件系统路径和本地脚本执行必须先转换为 `Path.GetFullPath` 后再用 `Path.GetRelativePath` 确认仍位于预期根目录内，不能只依赖字符串 `StartsWith`。LocalAuth fixture 只能执行仓库 `tests/frontend/fixtures/prepare-auth-smoke-users.mjs`；Public AOT hydration sidecar 读写必须留在 web root；SSR worker script 必须留在 frontend client root；upload/image 和 integrity asset file 检查必须留在 `wwwroot/uploads` 或对应 upload sandbox。任何越界、绝对路径覆盖、`..` segment 逃逸或控制字符日志输入都按固定类别拒绝或降级，不回显路径细节。

所有匿名或后台可触达的文本输入在进入昂贵 DB/regex/tokenizer/ArrayPool 路径前必须有显式长度上限。搜索 keyword 最大 128 字符，search index body tokenization 最大 256 KiB，CJK 连续 segment 最大 4096 rune；ContentFilter 在租用 `ArrayPool<char>` 前以 256 KiB fail closed；authoring binary body 最大 1 MiB，draft 字段保留独立 MaxLength；评论内容默认 `1000` 字符 / UTF-8 `4096` bytes，管理员只能通过匿名评论策略热更新到硬上限 `3000` 字符 / UTF-8 `12288` bytes，写入 frame 仍受 16 KiB payload 上限保护；subscription email 最大 254 字符；public navigation snapshot path 最大 512 字符；LocalAuth fixture redirect 最大 2048 字符且 storage-state JSON 最大 256 KiB；audit 列表页码最大 50000。超过上限的请求必须在业务昂贵路径前返回 validation/empty/fail-closed，不得只依赖 Kestrel 默认 body limit 或数据库 `Take`。

Passkey assertion JSON 另受 `64 KiB` 字符与 32 层深度硬上限约束。超限长度必须在初始化 `JsonSerializerOptions` 或执行 JSON 反序列化前直接拒绝，以免攻击者通过首个超限请求触发与输入解析无关的显著分配；深度超限由同一 parser fail closed，不能进入 Passkey domain service。

AEDS pooled response buffer 采用敏感优先分类：未知 frame 以及 auth、session、MFA、Passkey、匿名凭证、admin/private、错误响应一律 `clearArray:true`；只有 `AedsFrameSensitivity` 中逐项登记的公开 immutable response frame 可以在 `Seal(frameType)` 后跳过最终清零。writer 扩容时尚未得知 frame type，因此被替换的中间 buffer 始终清零。新增 frame 若未同步进入公开白名单会保守清零，禁止全局 `clearArray:false`。若运行中怀疑公开 frame 分类或缓存所有权异常，通过现有 cache action/version invalidation 清除对应 raw frame 与 PublicHotRead snapshot，使请求回落到 L2/dynamic rebuild；敏感和未知 frame 不受该降级影响，不需要重启或放宽清零边界。

公开 immutable artifact 的“已生成”不等于“永久可公开”。文章删除、永久删除、清空回收站或转为 Draft/Scheduled/Archived 时，mutation 链必须在异步 projector 前持久化 generation tombstone。各 edge 先通过 Redis Pub/Sub 加载未确认 marker 并立即 fail closed；只有 CDN purge receipt 已持久化的 confirmed marker 才触发本地 rebuild。命中 marker 的公开 artifact 一律返回无 body `410 Gone`、`no-store`、`X-Fsus-Generation` 和 `X-Fsus-Revoked`，并移除 validator/encoding header。CDN purge 使用 generation 幂等键；provider 不可用时 mutation/outbox 报错重试，本机与已收到通知的 edge 继续 fail closed。bearer token、删除原因、文章标题、账号、IP 与请求路径不得进入 tombstone、响应头或 Pub/Sub payload。

撤回 marker 只允许由成功发布替代 snapshot 的 worker 以 generation compare-delete 清除；旧 worker、重复 outbox 或乱序 clear 不得清除较新撤回。`PublicHotRead:Enabled=false` 只是无重启 fast-path 降级开关，独立 revocation middleware 仍然生效。生产验证除本机 410 smoke 外，还必须核对 CDN provider request/receipt 与另一 edge 节点收到 revoke/clear 通知；没有 provider receipt 时只能声明 origin fail closed，不能宣称 CDN 已清除。

## HTTPS 响应压缩隔离

通用 `ResponseCompressionMiddleware` 默认不压缩任何 endpoint。只有同时带 `AllowAnonymous` 与 `PublicResponseCompressionMetadata` 的公开 GET/HEAD endpoint，且最终响应为 `200`、显式 `Cache-Control: public`、安全 `Vary`、无 `Set-Cookie` / `Content-Disposition` / 既有 `Content-Encoding` 时，才允许进入 Brotli/Gzip。当前白名单只有 feed、sitemap、robots 与公开 integrity manifest；允许媒体类型固定为 `application/atom+xml`、`application/feed+json`、`application/json`、`application/rss+xml`、`application/xml`、`text/plain`。

任一 Cookie、Authorization、`X-Fsus-Csrf-Token`/常见 CSRF header、已认证 principal、authorization/antiforgery metadata、WebSocket、notification stream、`/auth`、`/admin`、`/account`、`/user`、`/manage`、`/internal`、`/api/binary`、非 200、`private`/`no-store`/`no-cache`、按 Cookie/Authorization/CSRF 变化或 HTML/binary media type 都 fail closed 为 identity。带随机 CSP nonce 的 SPA fallback 同样固定 identity；公共 HTML/AEDS 只有 publication 阶段生成且不含请求反射的 immutable artifact 可以使用各自预生成 br/gzip variant。nonce HTML compiler 必须拒绝畸形 self-closing marker、非法 unquoted attribute 和带属性的 `script`/`style` closing tag；请求已取消时不得先把模板 bytes 写入 response pipe 再由 flush 报错。错误响应不得为了节省流量重新开放动态压缩。

运行时若发现白名单或代理缓存行为异常，在 reload-capable 配置源把 `ResponseCompressionPolicy:Enabled=false`；下一请求即停用通用 endpoint 压缩，无需重启，认证、admin、account、notification 与 binary 边界继续保持 identity。确认 header/cache/BREACH 负向 smoke 后再热更新为 `true`。该开关不改变 PublicHotRead immutable artifact 的独立 variant negotiation。

---

## Proof of Work (PoW)

在密码注册、登录等高风险操作之前，客户端须先解决 PoW 挑战，以提高批量自动化攻击的成本。

- 挑战端点：`GET /api/binary/auth/pow-challenge`（匿名，IP 速率限制，AEDS `PowChallenge` frame）
- 有效期：挑战存入 Redis，TTL 过期后自动失效
- 服务端验证：注册 / 登录端点在执行业务逻辑前校验 PoW 解答，失败拒绝请求
- IP / 上下文绑定：legacy PoW proof 的 HMAC 签名和一次性 replay identity 只绑定 `GetClientIp()` 返回的规范化客户端 IP；RiskControl `sha256PowV1` 额外把 challengeId、action、routeKey、subjectHash、clientIpHash、deviceFpHash 和 policyVersion 绑定进 HMAC 上下文。PoW 层不探测 raw remote IP、localhost 或 Docker bridge gateway。代理迁移必须通过 `ForwardedHeadersMiddleware` 的 `ReverseProxy:KnownProxies` / `ReverseProxy:KnownNetworks` 配置修正。
- 日志隐私：PoW 内部异常和拒绝访问日志只能写 `ClientIpHash`，该值是 `security-log` 用途、当前 KMS epoch 和 UTC 日窗口派生的 128-bit 假名；日志模板禁止出现 `{IP}` 或原始 IP 参数。
- 安全门控覆盖：缺失、篡改、重放形态的 PoW 请求不得产生 2xx，且不得写入业务状态。
- 难度语义：`difficulty` 表示 SHA-256 摘要的 bit 级前导零数量，而不是半字节 / nibble 数；默认阶梯为 16/20/24/28 bits。
- 客户端求解器：PoW 延迟优化只发生在 `src/frontend/wasm/pow` 的 C++23/Wasm 层，proof wire 格式与 Redis/HMAC 绑定语义不变。
- Wasm 分层：运行时按 `threads -> relaxed SIMD -> SIMD128 -> basic` 选择可用资产；任一高阶资产初始化或求解失败时自动降级到下一层，不影响 API 语义。
- 多核约束：threads 层只在 `crossOriginIsolated`、`SharedArrayBuffer` 和 Wasm atomics 可用时启用，worker 数上限为 `min(4, hardwareConcurrency - 1)`。

---

## 速率限制（Rate Limiting）

- 基础策略：`fixed_ip`（固定窗口，按客户端 IP 计数），作为认证、PoW、写入和审核端点的 fallback。
- 管理后台兜底策略：`fixed_ip` 只对独立 admin principal（`identity_kind=admin_principal` + `admin_id`）进入后台 fixed-window 分区；普通账号 token 的 `role=admin` 不会进入 admin 分区。后台写操作使用 `RateLimiting:AdminPermitLimit` / `RateLimiting:AdminQueueLimit`，边缘网关同时用 `fsus_admin_limit` 保护 `/api/binary/admin/**` 与 `/api/binary/author/**`。
- 公开读策略：`public_read` 按 `IP + path` 分区；verified search crawler 使用独立高额度分区，social preview bot 使用低额度公开 HTML/静态资源分区，普通匿名公开 API、公开 HTML 和 hot-read binary artifact 候选使用中等配额。
- 本地测试策略：`fixed_ip`、`public_read`、`read_proof`、`notification_stream` 对服务端解析出的 loopback 客户端（`127.0.0.1` / `::1`）统一使用 `NoLimiter`，因此本地预热、hydration、浏览器和接口回归可以保持真实并发而不会互相制造 `429`。专门验证限流行为的测试必须显式设置非 loopback 测试地址，或设置 `RateLimiting:LoopbackBypassEnabled=false`，再断言配额与拒绝语义；该配置按请求读取，接入可热重载配置源时可无需重启关闭豁免。生产外部流量不得通过自定义请求头声明 loopback 身份。
- 强匿名评论 ticket 申请使用 `public_read` 分区，并额外要求强匿名请求不得携带 Cookie、session、Authorization 或其他登录态污染；污染失败返回 AEDS `ApiError`，业务 handler 不会执行。
- 真人阅读策略：`read_proof` 专门保护 `/api/binary/read-proof/challenge.aeds` 与 `/api/binary/read-proof/submit.aeds`，按 path + 一分钟 epoch 的用途隔离 HMAC 分区；partition 不含 raw IP、forwarded header 或 device fingerprint。旧 `/api/read-proof/**` JSON 路径已移除。
- 超限响应：`429 Too Many Requests`，响应头携带 `Retry-After`。RateLimiter 拒绝路径通过 `RateLimiterRejectionRiskSampler` 按 IP/route/minute 对 `ISecurityRiskSignalSink` 写入做上限采样；采样命中写入 `RateLimited` 风险事件，超出上限只记录 `rate_limiter_risk` drop 指标，避免攻击流量把拒绝路径反向放大成 DB/Redis/后台风险写入压力。
- 客户端 IP 提取：`GetClientIp()` 只读取 `ForwardedHeadersMiddleware` 按 `ReverseProxy:KnownProxies` / `ReverseProxy:KnownNetworks` 处理后的 `Connection.RemoteIpAddress`；业务代码不得直接信任原始 `X-Forwarded-For` / `X-Real-IP` 请求头。
- 受保护端点：PoW 挑战、匿名账号 bootstrap、Token 续签、Passkey 登录开始/完成、MFA challenge verify、Recovery Key verify、评论审核队列和单条/批量审核写入、ReadProof challenge/submit、RiskControl challenge issue/verify、公开评论读取、公开 taxonomy、related-reading、公开 HTML 与 PublicHotRead hot binary artifact 候选。
- MFA challenge verify 的失败计数同时按 ticket、客户端 IP hash 和账号稳定 subject hash 累加；三类计数必须通过统一缓存的单次 Redis Lua 原子递增并返回同一 post-increment 快照，lock 决策只能使用该快照。账号维度固定为 `fail:subject:{accountSubjectHash}`，不得恢复 `fail:user:{userId}`。`accountSubjectHash` 只能来自 `sys_user.account_subject_hash` 投影、匿名账号快照或已签名 ticket 内保存的 subject hash；缺失或格式错误必须拒绝 challenge/proof，不得按账号 id 重新派生。MFA failure audit context 使用 `AccountId` 与 `AccountSubjectHash`，不得写 `UserId`。

## PerceptionCharacterV3 资源安全边界

V3 allocation 只由 `IPerceptionCharacterV3ResourcePlanner` 决定。配置必须满足 representation/total 的 `0 <= critical < low < high`、正数 minute/rolling-hour lease 与 exact-byte egress budgets、正数 IP-prefix/server-device/subject/action quota，以及 comment/enrollment/account-recovery/admin-sensitive/public-read/other 的完整 exhaustion disposition；生产启动在 pool 接流量前验证这些不变量。缺配置、乱序 watermark、hour budget 小于 minute budget或 disposition 缺失均 fail closed。

pool manifest v1 只增加旧 runtime 可忽略的非秘密 additive `artifactBytes`，startup 仍完整认证 ciphertext、解密 record，并确认该值等于最终 PNG/Ogg bytes 且不超过 hard limit。Redis Lua 把 entry burn、ready/leased inventory、exact-byte budget、各身份维度 quota 与 operation retry fence 一次提交；ambiguous reply 后 retry 不会租第二项或重复计费。Redis key 只使用用途隔离的 IP prefix hash、server-device hash、subject hash、coarse action 与 operation hash，不写 raw IP、answer、token、media、challenge ID 或自由文本 reason。

运行时紧急停止使用 reload-capable `Security:PerceptionCharacterV3:Resources:AllocationsEnabled=false`，下一次 planner decision 即按 action table queue/fail closed，无需重启。恢复前必须确认 active generation 未 revoked/corrupted、inventory 和 rolling budget 健康；该开关不能重新激活 retired generation。公开 read、notification stream 和 binary frame contract 不变，既有 challenge 只允许 verify/cancel 到期 drain，不回退在线渲染。

## 防爬虫闭环

`ShieldMiddleware` 在常规 endpoint 前分类处理请求；精确的 search crawler / social-preview family 必须先于通用 `bot|spider|crawler` unknown-bot 关键词判断：

- search crawler：`Googlebot` / `Google-InspectionTool` / `bingbot` / `msnbot` 先按 CIDR 验证，`Baiduspider` / `Sogou` 继续使用 rDNS + forward DNS；只有验证通过后才写 `HttpContext.Items["VerifiedCrawler"] = true`。`observe` 模式下验证失败会放行并记录 `FakeCrawler` 风险事件，但不得设置 verified crawler 标记或进入高额度限流分区。
- social preview bot：`Twitterbot`、`facebookexternalhit`、`Discordbot`、`Slackbot`、`TelegramBot`、`LinkedInBot`、`WhatsApp` 只允许公开 HTML、OG/静态资源、`robots.txt` 的 GET/HEAD，不允许访问 `/api/**`。
- unknown bot、工具型 UA、空 UA：返回轻量 403，记录 `fsus.security.event.count`，并向风险分写入原因；路径穿越、双斜杠、反斜杠和双重编码路径仍直接 `Abort()`，同时记录指标。

`CrawlerUpdateWorker` 按运行时策略快照加载搜索引擎 CIDR：远程官方 JSON（Google `googlebot.json`、Bing `bingbot.json`）→ 本地 last-known-good snapshot → `Security:CrawlerCidrs:*` 配置 → empty degraded。远程 URL 只接受 HTTPS，host 只允许 `developers.google.com` 或 `www.bing.com`，并且不得使用非默认 HTTPS 端口；生产启动校验、admin 策略更新和 worker 发起 HTTP 请求前都会强制执行该约束，非法 URL 直接拒绝，不回退到旧 URL。snapshot path 只允许相对路径，解析时固定落在 `FSUSBLOG_DATA_ROOT/security` 下；绝对路径、`..` segment 或带盘符/冒号的路径必须拒绝。默认更新间隔为 1440 分钟，后台可热更新 `CidrAutoUpdateEnabled`、`CidrUpdateIntervalMinutes`、`CidrMinUpdateIntervalMinutes`、Google/Bing URL 和 snapshot path；最小间隔默认 30 分钟，避免管理员误设过低造成外部请求风暴。状态通过 admin-only ops probe `GET /api/ops/crawler-ranges/status` 和生产前端 `/api/binary/admin/security/anti-crawler/crawler-ranges/status` 暴露；后者额外返回自动更新开关、当前/最小 interval、下次同步时间和 worker 运行状态，并支持 `POST /api/binary/admin/security/anti-crawler/crawler-ranges/sync` 手动同步。

统一安全风险由 `ISecurityRiskSignalSink`、`ISecurityRiskScoreReader` 和 `ISecurityRiskPolicyProvider` 抽象承载。Shield、RateLimiter、PoW、HumanReadProof、公开读与 Passkey 分别写入稳定 source；当前生产 source 还包括 `pospace`、`device-fingerprint`、`region-policy`、`comment-governance`、`admin-step-up` 与 `risk-control`。未知 reason 数值进入 sink 时保留原始数值字符串。风险热路径使用 Redis，事件审计写 PostgreSQL，不保存客户端 IP 或设备指纹原文；持久化失败不改变当前业务裁决。`RiskDecisionService` 把 context、active policy 与风险分转换为 allow/challenge/block 等裁决，公开读只能在门控允许后继续搬运 artifact bytes。

Passkey 登录 assertion 与普通账号 step-up assertion 的 FIDO 验证前读取必须保持单次 PostgreSQL 查询：同一查询返回 credential 字段、`passkey_credential.xmin::text` rowVersion 以及 `sys_user` 状态/删除/passkey user handle。FIDO 验证后仍通过 `signcount = @expectedSignCount AND xmin::text = @rowVersion` 更新 signCount 与 `LastUsedAt`，不得退回无 rowVersion 的 blind update。CAS 失败属于 `ConcurrentConflict`：服务端重新读取 credential counter/rowVersion；数据库已推进到本次值或更高时允许当前已验证 assertion，数据库仍低于本次值时只重试一次 CAS，无法收敛则 fail closed，但不把并发冲突记录成 credential clone。

Passkey signature counter 使用显式状态机：`0 -> 0` 是认证器不支持 counter 的 `Unsupported`，登录与 step-up 正常通过且不得撤销 Session；`actual > stored` 是 `Advanced` 并原子推进；至少一端非零且 `actual <= stored` 是 `Risk`，只表示 non-monotonic 风险而不是已确认克隆。风险 assertion 始终拒绝并写 high-value audit；默认 `PasskeyCounterRisk:ResponseAction=reject_credential` 不撤销任何现有 Session，只有热重载配置明确设为 `revoke_account_sessions` 才按账户级 compromise 处置，原子撤销 active `sys_user_session`、bump `AccountSnapshotVersion` 并发布不含 session/credential 标识的 `SessionRevoked` notification。配置缺失、未知或回退时都收敛到 credential-only 拒绝，无需重启；完整状态、可观测性与运维回退见 [Passkey counter risk response](security/passkey-counter-risk-response.md)。

浏览器跨 tab 认证广播由纯 transport `authBroadcastRuntime` 持有 BroadcastChannel/localStorage fallback 生命周期；它不导入 Pinia 或任何 Store，只投影 `{ type, at }`，收到的额外 Token、Session ID、account/admin id、Proof 或其他字段在进入 subscriber 前丢弃。`authBroadcastComposition` 在 account session bootstrap 中显式注入 user logout publisher、notification session-revoked callback，并分别处理普通账号与 admin session 事件；Store 不导入 runtime。重复的同 type/timestamp 事件至多处理一次，dispose/rebuild 会重新绑定当前 Pinia root。异常时可在不重启后端的情况下停用前端跨 tab transport；当前 tab 的服务端 session 校验仍是安全真相，notification stream 的 `SessionRevoked` 与下一请求继续 fail closed，不得以重新引入 Store↔Runtime 导入或带身份数据的 payload 作为回退。

普通账号 `guest` 与独立管理账号 `missing` 只允许作为当前 tab、当前页面 epoch 的短期负缓存；LocalStorage 不保存认证结论、校验时间或可用于跳过 `/auth/me`、admin session 校验的标记。Store 初始化会删除旧 `fsus_user_storage`，避免升级后的首个页面沿用历史 Guest 结论。登录、账号切换、Passkey 完成、admin step-up、对应的 login/admin-changed 认证广播以及页面 focus/visible 都立即把两类负缓存退回 `unknown`；logout/expiry 广播则可在失效旧缓存后建立本次事件已确认的 `guest`，重验期间的网络错误仍保持 `unknown`。`authenticated` 与 admin `active` 只能来自服务端 HttpOnly Cookie/Session 对应的 snapshot，权限判断还必须同时满足 active admin state 和当前 server principal，`guest`/`missing` 不能成为授权事实。若前端资源需回退，可切回上一静态资源槽并保留服务端 session 校验；回退版本不得恢复持久化负缓存。

Passkey complete、MFA verify 与匿名 bootstrap 在 Cookie 写入成功后必须进入同一个前端 post-auth commit：先让当前 tab 的 guest 负缓存失效，再强制读取 `GET /api/binary/auth/me`，只有 snapshot 使 `userStore.isLoggedIn=true` 后才能标记 session active、广播 login 或进入私有路由。`ensureBootstrap`、业务响应中的用户片段或 Cookie 写入成功本身都不能替代该提交。commit 使用全局 generation 使重复提交只保留最新一轮，并在组件卸载时 abort 所拥有的 `/auth/me` 请求；失败、取消或未知网络结果保持公开页面且不广播认证成功。无需重启的回退仍是切回上一静态资源槽，服务端 Cookie/session 校验语义不变。

Challenge capability 是签发前安全边界：枚举可解析、provider 已注册、客户端 executor 存在和目标 action 的 UI/headless host 可达必须独立判定。浏览器 UI 与 Notification headless 流程共用同一 registry；占位 slot 或组件文件存在不能声明可用。manifest version 未知、provider 缺失、executor 缺失或 host 缺失都 fail closed，不记录设备高熵信息、账号/admin 身份、Token 或 Proof。无重启回退路径是把对应 RiskControl/Perception 子系统切到 `disabled`/`observe`，或回滚到 last-known-good policy；不得通过重新允许 placeholder kind 降级。

RiskControl challenge 采用 Redis + PostgreSQL 双层职责。每次组合裁决生成 UUIDv7 `envelopeId`，按 `RiskDecision.RequiredChallenges` 原序固化最多 8 个 member；单 challenge 仍是 `memberCount=1` 的同一 envelope。Redis 保存 TTL 不晚于最短 member expiry 的 ordered challengeIds/requiredKinds/verifiedMembers/version，并通过 versioned CAS 原子校验 envelopeId、next ordinal、member state、action/route/subject/client/device binding 与 policyVersion 后推进 progress；进程内 read-modify-write、客户端自报 completed、PostgreSQL audit replay 都不能替代该 CAS。任一 member 失败、过期、撤销、重放、顺序错乱或 envelope replacement 必须让聚合完成 fail closed；重复 verify 不得重复计数或 mint。

PostgreSQL `security_challenge` / `security_challenge_attempt` 是每个 member 签发、验证、失败、重放、过期和撤销的审计真源。持久化记录仍按 challengeId 保存 kind、algorithm、action、routeKey、subjectHash、clientIpHash、deviceFpHash、policyVersion、payloadHash、traceId、traceparent 和时间戳；不得保存 challenge payload 原文、proof 原文、客户端 IP 原文或设备指纹原文。member 状态固定为 `issued | verified | expired | replayed | failed | revoked`；Redis envelope 状态为 `active | completed | failed | expired | revoked`，replay 作为拒绝 reason 处理。provider / orchestrator 后续只能通过统一 persistence/envelope-state service 写入或转移状态，避免端点绕过审计链。签发、验证成功、验证失败、重放和解题耗时分别打到 `fsus.security.challenge.issued.count`、`fsus.security.challenge.verified.count`、`fsus.security.challenge.failed.count`、`fsus.security.challenge.replayed.count` 与 `fsus.security.challenge.solve.duration`，只使用 kind、action、policyVersion、outcome、reason 等低基数 tag。

RiskControl verify 的 endpoint-level attempt gate 由 `ISecurityChallengeVerifyRateLimiter` 承载，端点不得保存进程内静态 dictionary 或自行 prune。计数使用统一缓存 `SecurityChallengeVerifyRateLimit` policy，Redis identity 形态为 `verify:{windowStartTicks}:{clientIpHash}:{deviceFpHash}:{normalizedAction}:{challengeIdHash}`，TTL 为 2 分钟，窗口为 1 分钟，最多允许 3 次；key 不包含原始 IP、device fingerprint 或 challengeId。计数必须通过统一缓存原子 `INCRBY` + `PEXPIRE` primitive 完成，不允许 `GET` 后 `SET` 的 read-modify-write。超限时继续返回通用 challenge failure，并写 `SecurityChallengeRejected` 风险信号。

RiskControl proof token 使用 `X-Fsus-Challenge-Proof` header，不能替代 admin-sensitive `X-Fsus-Mfa-Proof`，也不迁移 legacy `X-Fsus-Pow-Proof`。单个 member verify 成功只推进 Redis envelope state；只有 CAS 确认全部 ordered required members verified 后，`ISecurityChallengeProofService.MintProofAsync` 才生成一个 opaque aggregate proof token。Redis claims 绑定 envelopeId、ordered requiredKinds、最后一个 ordered member 的 challengeId/kind、action、routeKey、subjectHash、clientIpHash、deviceFpHash、issuedAt、expiresAt、nonce 和 policyVersion。三项最终 header 为兼容现有 transport 仍用最后 member 的 challengeId/kind，但服务端必须从 proof claims 校验 envelopeId 与完整 ordered requiredKinds，不能接受多枚独立 token、只完成第一项或客户端重排 kinds。

RiskControl actor context 必须分离普通账号和 AdminPrincipal：普通 `identity_kind=anonymous_account` 才填 `UserId/AccountSubjectHash/SessionId`；`identity_kind=admin_principal` 只填 `AdminPrincipalId/AdminSessionId`，`UserId/SessionId` 必须为 null。普通账号 RiskControl subjectHash 和 authenticated proof binding 只从 `identity_kind + account_subject_hash` 派生；`ClaimTypes.NameIdentifier` / `nameid` 仅保留账号容器兼容用途，不得作为 subject hash 材料。缺少有效 `account_subject_hash` 的历史会话在风险事件持久化中回退到 clientIpHash，避免重新引入裸 userId 聚合。`ConsumeProofAsync` 必须通过 Redis GETDEL / consume-once 语义先消费 token，再比较所有 aggregate 绑定字段；replay、Redis miss、action/route/IP/device mismatch、requiredKinds mismatch、incomplete/replaced envelope 或过期均返回拒绝并写入 `security_challenge_attempt`，调用方不得进入业务写入。

浏览器侧 aggregate proof 只存在于内存 store 的 typed lease。通用 binary transport 是评论、Recovery Key 与 Passkey begin/complete 的唯一 header writer：它不接受任意字符串 map，不把 proof 写入 URL、持久存储、broadcast、日志或 telemetry；legacy PoW 仍独立计算和发送。普通命令必须先到服务端，428 再通过 `X-Fsus-Risk-Decision`、`X-Fsus-Challenge-Action`、`X-Fsus-Challenge-Route-Key`、`X-Fsus-Challenge-Policy-Version` 交付本次权威裁决；页面不得预先 issue、解析错误文案或保存 action→kind 映射。

UI challenge host 与 notification headless flow 共用一个 envelope runner 和 executor registry。runner 读取完整 ordered assignments 与各自 provider payload，逐 member 提交 verify，只在 `envelopeCompleted=true` 时发布 aggregate lease；默认顺序执行，policy 明示并行也必须以固定小并发上限约束 PoSpace、perception 等 expensive Worker，不能按 assignment 数量无界启动。refresh、cancel、身份变化、route generation 变化、unmount/dispose 会终止整个 envelope 并使迟到结果失效。runtime 只在 action/routeKey 与原命令 identity 完全一致时 issue 当前服务端选择的 capability，policy 热切换后按最新 428 重新签发或 fail closed。发送前取消可恢复；一旦进入 fetch，普通业务拒绝或未知网络状态都视为 proof 可能已消费。旧客户端无法执行 `memberCount>1` 时必须得到明确 capability/version incompatibility，不能只执行 `assignments[0]`。

无需重启的回退是通过 reload-capable policy 禁用 multi-challenge band、热切换对应 RiskControl action 或 `globalMode=observe`，或回滚 last-known-good policy；保留认证、admin、notification、binary 和 legacy PoW 边界。已签发多 member envelope 按原 TTL fail closed，不降级为单 member proof，不重新启用手写 header、多个 token 或 JSON fallback。

### PerceptionCharacterV3 规范边界

`PerceptionCharacterV3` 是原位破坏性重定义后的独立协议身份：wire name `perceptionCharacterV3`，algorithm `fsu.challenge/perception-character-artifact@v3`。其完整规范见 [PerceptionCharacterV3 protocol](security/perception-character-v3-protocol.md)，唯一 machine-readable source 位于 `src/shared/Contracts/Validation/Security/perception-character-v3-contract.json`。运行时以独立 enum/provider/parser/typed AEDS frame 实现，不形成 V1/V2 或 retired V3 compatibility path。

V3 服务端只交付最终 `384 x 144`、4-bit grayscale、无 alpha 的 PNG，或固定 mono Opus-in-Ogg audio；hard limit 分别为 32 KiB 与 48 KiB。客户端永远不接收答案 tag、seed、recipe、atlas variant、warp/noise 参数或音素顺序。答案由 26 字符 alphabet 独立无偏采样五次，ASCII-only normalization 后使用独立 256-bit answer key 做 length-prefixed HMAC；状态由另一套独立 versioned 256-bit key以 AES-256-GCM 封装。`artifactHash` 覆盖 exact transported final-media bytes，AAD、密文、Redis 原子状态共同绑定 challenge/envelope、action/route、subject/device/IP、policy、representation、media type、dimensions 和 artifact hash。每个 identity 仅有两次原子 attempt，visual/audio 切换撤销旧 identity 并签发完全独立的新 state。

V3 只提高 OCR/model/relay 的成本，不是 humanity proof。公开失败只按 recoverability/state 映射为 `retryable`、`reissueRequired`、`unavailable` 或 `rejected`，不能泄露 crypto/binding/parser/Redis 内因。无需重启的回退是热更新 policy 停止新 V3 签发并让已签发短 TTL identity fail closed 或过期；不得回退到公开 recipe、明文答案、V1/V2 alias 或客户端自行选择 representation/provider。

V3 签发只从预部署的 immutable encrypted packfile 租用最终媒体。离线命令以独立外部 256-bit pool key 对每条 media+answer record 使用 fresh AES-GCM nonce；manifest 只保存 compact offset/length、nonce、ciphertext digest 和非敏感表示信息。运行时 Redis 只保存 generation revocation 与 `burned` lease marker；一个 Lua `SET NX` 在响应前永久消耗 entry，取消、进程失败或 reply loss 都不归还、不重试第二条，也不触发在线 renderer。startup gate 会逐条认证合同 digest、pack/record digest、artifact hash/type/limit、duplicate ID 与 key；启用 V3 但没有有效 active generation 时拒绝启动。

独立发布门禁在 clean checkout 中一次性生成不少于 10,000 个 visual 与 2,000 个 audio 的确定性 corpus，检查唯一性、答案位置无偏、固定 baseline recognizer、PNG/Ogg 结构与媒体字节预算；随后用真实 Redis 连续执行两次同一 cutover，证明第二次只命中同一幂等回执、没有 pool lease、旧 envelope/namespace 仍不可消费。门禁还比较 retired online renderer 与 pool issue 的 CPU/非 payload allocation，并验证 1,000 次 pre-admission rejection 为零 lease。实现校验与独立复核由两个不同脚本生成 machine-readable receipt，二者绑定同一完整 commit、release target、pool generation/manifest digest、corpus/benchmark/migration evidence hash 和不可变命令清单；任一 high/critical finding、摘要漂移或敏感字段进入证据都会 fail closed。

无需重启的门禁失败回退仍是从 reload-capable RiskControl policy 移除 `perceptionCharacterV3` 并撤销 active generation；允许其他 challenge、认证、admin MFA、notification stream 与 binary 路由继续服务。该路径不会恢复 retired renderer、旧格式或公开 answer recipe。

前端动态 import 的启动恢复只使用固定 `fsus:bootstrap-import-retry` SessionStorage key；value 仅保存低敏 build id 与尝试时间，不得包含 pathname、query、hash、对象 ID 或筛选条件。Public AOT 与 Full SPA 共用同一单次 reload 控制器；成功启动、build id 变化或五分钟窗口过期会清理 marker。存储不可用时不 reload，原错误继续上抛；无需后端重启即可通过发布新 build id 清除旧版本状态。

perception-sealed@v2 的服务端真相使用 `IPerceptionSealedTokenService` 生成 AEAD sealed token；sealed payload 只包含 Localization/MicroInteraction 所需的 challenge、task、action、route、subject/client/device/UA hash、algorithm/family/variant、recipe hash、expected point 或 step hash、容差、时长、attempt、nonce、keyVersion 和 policyVersion。token envelope 只明文携带解密所需的非 secret AAD 字段；ciphertext 完整性由 AES-GCM tag 覆盖。`Security:PerceptionSealedToken:CurrentKeyVersion` 和 `Security:PerceptionSealedToken:Keys:{version}` 支持 key rotation；未知 keyVersion、AAD/密文篡改、payload binding mismatch、context mismatch 或过期均 fail closed，不读取旧 schema 或派生 fallback key。sealed token 不提供 Redis consume-once 语义，也不能替代普通 challenge proof 或 admin MFA proof。

### 当前感知挑战威胁模型、协议与上线

当前字符感知挑战只使用 `perceptionCharacterV3`。`fsu.challenge/perception-sealed@v2` 只承载 `perceptionLocalizationV2` 与 `perceptionMicroInteractionV2`；它们保留 AEAD sealed token、坐标/步骤响应、render recipe 与 `RecipeHash`。三者共享 `SecurityChallengeEnvelope`、assignment、一次性 proof、action/route/subject/IP/device/policy binding，不存在跨版本 alias、parser fallback 或 sealed-token schema fallback。

客户端 renderer、worker、DOM event、pointer 坐标、步骤、solve duration 和 provider verify payload 都视为攻击者可控。公开 issue payload 不得包含期望答案、期望坐标、期望步骤、语义标签、原始 IP/device/user、raw UA、proof、admin session 或可反推解答的字段。服务端只信任 assignment binding、sealed token、`RecipeHash`、Redis attempt/consume-once 结果与当前 policy snapshot；verify 成功只 mint `X-Fsus-Challenge-Proof`。

| 阶段 | 当前行为 | 失败行为 |
| --- | --- | --- |
| issue | RiskControl 只选择 V3、LocalizationV2 或 MicroInteractionV2；返回 AEDS assignment/envelope/provider payload | 未知 kind、provider/manifest mismatch、recipe/token/assignment 无效均 fail closed |
| verify | 校验 challenge/action/route/identity/policy/recipe binding；V2 解封 AEAD 后验证坐标或步骤；执行 Redis attempt gate 与 consume-once | token/recipe/payload tamper、过期、binding mismatch、attempt exceeded、Redis unavailable 或 replay 均 fail closed |
| proof | orchestrator mint 统一短效 proof；业务 filter 一次性消费 | 普通 proof 不能替代 admin MFA proof，业务拒绝后不能恢复已消费 proof |

Localization 通常与 `sha256PowV1` 组合用于高风险；MicroInteraction 只在显式启用的 strict 策略中使用。V3 是字符任务的唯一实现。PoSpace 能力不足时客户端只能提交低基数原因和原 assignment binding；服务端按当前策略改发仍允许的 challenge 或拒绝，客户端不能自选 fallback。

上线按 `observe -> V3/localization enforce -> micro-interaction optional -> strict/lockdown`。无需重启的回退通过 admin binary policy API 把受影响 action 切到 `observe`，或恢复 last-known-good snapshot；不得恢复退休 kind、旧 schema、JSON fallback 或弱绑定 proof。

验收必须覆盖匿名请求、登录请求、admin 请求、notification stream 和 binary：匿名/登录业务都只消费 action-bound proof；admin 写仍要求 admin principal、权限与 `X-Fsus-Mfa-Proof`；notification preflight 消费 proof 后只签 path-bound 短效 grant，重连不复用；issue/verify/业务恢复全程只走 AEDS。

RiskControl challenge provider 通过 `ISecurityChallengeProvider` 接入，不允许业务 filter 直接依赖 PoW、Perception、PoSpace、HumanReadProof 或 Passkey step-up 的具体实现。`SecurityChallengeOrchestrator` 按 `RiskDecision.RequiredChallenges` 从 DI 中查找 provider，可一次返回多个 assignment；provider 必须先持久化 challenge，再返回可下发 assignment，orchestrator 只在所有 provider 成功返回后组装 envelope。provider 未注册、provider 返回失败、assignment 无效或 proof mint 失败均 fail closed，写入 `SecurityChallengeRejected` 风险事件，且不进入业务 handler。provider verify 成功后只签发统一 proof token 和权威绝对 expiry，业务是否放行仍由后续 filter 消费该 token 决定。proof 的公开失败面只允许 expired、replayed/missing、binding mismatch、revoked 与 generic rejected；内部 Redis identity、subject/IP/device 值和详细校验字段不得返回客户端。普通业务拒绝发生在 proof 已消费之后，不能触发客户端恢复 token。

浏览器 proof 只能存在于进程内 store，不得进入 LocalStorage、SessionStorage、URL、BroadcastChannel、日志或错误上下文。store 以 reservation 隔离并发请求；只有确定 fetch 尚未开始时允许恢复，可能到达服务器的请求一律重新 issue。登录、登出、账号切换、admin session 变化会清空 store；action/route key 本身也是隔离键。notification stream preflight 用 headers 消费原 proof并设置 path-bound、HttpOnly、SameSite=Strict session grant cookie；WebSocket 只消费该短效一次性 grant，断线重连不复用原 proof。

RiskControl 可观测性集中在 `FsusObservability`：风险事件写 `fsus.security.risk.event.count`，裁决写 `fsus.security.decision.count`，当前策略版本通过 `fsus.security.policy.version.active` gauge 暴露。编排层记录 provider missing / provider exception / proof mint failure 的 structured log 与失败指标；metrics/listener/exporter 异常必须在 observability 层吞掉，不得改变 allow/challenge/block/queue 裁决或业务错误码。`/api/ops/health/ready-detail` 的 `riskControl` 检查同时验证 active policy、last-known-good policy、Redis consume-once 能力和 challenge provider registry；缺 active policy 或 Redis 一次性消费不可用时 readiness 返回 `not_ready`。Redis 不可用时写类 challenge fail closed，公开读仍只按当前策略允许的降级路径处理。

`sha256PowV1` 由 `Sha256PowChallengeProvider` 提供，复用现有 `IPowService`、`AdaptivePowGovernor` 和 legacy FPOW 二进制 proof 解析逻辑。签发时 provider 返回统一 `SecurityChallengeAssignment`，并通过 `/api/binary/security/challenge` 返回 provider payload：`salt`、`difficulty`、`timestamp`、`signature`；`signature` 是无 padding Base64Url HMAC，验证端不接受旧标准 Base64 `+`、`/`、`=` 兼容格式；持久化层只保存 payload hash，不保存原始 salt/signature 或 proof。验证时 `/api/binary/security/challenge/verify` 只接受 payload 中的 legacy Base64 FPOW proof，继续按客户端 IP 绑定、当前 difficulty、签名、过期时间和 Redis consume-once 规则校验；成功后返回一次性 `proofToken`，失败 attempt 写入 `security_challenge_attempt`。旧 `X-Fsus-Pow-Proof` / `RequiresPowFilter` 路径继续保留。

PoW proof replay lease 使用固定 5 分钟 TTL，和签名 timestamp 接受窗口一致；不得根据剩余秒数缩短 replay lease，避免窗口尾部 proof 在签名仍有效时被重复消费。`/api/binary/security/challenge/verify` 的失败限流 identity 绑定 challenge/action/IP/device hash，但不包含分钟取整时间片；Redis `IncrementWithExpiryAsync` 负责从首次失败开始的固定 TTL 计数，避免分钟边界附近重置或双计数。

`argon2idPoSpaceV1` 由 `Argon2idPoSpaceV1ChallengeProvider` 提供，默认 `Security:PoSpaceV1:Mode=disabled`，不会被默认 V2 policy 签发。参数边界只来自 `src/shared/Contracts/Validation/Security/pospace-v1-contract.json`，并由 `tools/contracts/generate-pospace-v1-contract.mjs` 同时投影到 Shared C# 与 frontend TypeScript：`memoryKib=19456..65536`、`iterations=2..6`、`lanes=1..4`、`targetDurationMs=100..5000`，配置和 wire 字段必须是规范无符号十进制，禁止 silent fallback 或 clamp。verify 使用一次性 `SecurityPoSpaceChallenge` cache，按共享契约的 challengeId、action、routeKey、subject/client/device hash、policyVersion、nonce 与 target 顺序重新派生 Argon2id proof；payload/参数/proof 错误、replay 或 provider disabled 都 fail closed。

移动端和低内存设备不执行 PoSpace，也不能自行选择降级 kind。客户端仅可回送原 assignment 绑定、低基数 capability reason 与有限重签序号；服务端核验全部 binding，撤销旧 assignment/cache，并选择策略允许的剩余当前 challenge 或 block。无需重启的回退路径是热更新 RiskControl policy 禁用 PoSpace；不得恢复客户端权威 fallback。

浏览器只允许一个共享 PoSpace executor 拥有 Worker、Argon2 求解、verify 与取消生命周期；可视 challenge host 和 notification headless host 都是该 executor 的调用方。assignment refresh、组件卸载、notification stop、登录身份变化或新 generation 到达时必须 dispose 旧 Worker 并忽略迟到结果。notification 不得把 PoSpace proof 写入 URL、SessionStorage、日志或重连状态，只能从内存 proof store reserve 后交给 preflight；能力不足时最多执行两次服务端权威 reissue，不能自选 challenge/allow。运行时回退不需要重启：热关闭 PoSpace policy 后新签发停止，现有短 TTL assignment/proof 自然过期，Sha256PoW 和 guest legacy PoW 仍可继续工作。

`humanReadProofV1` 由 `HumanReadProofV1ChallengeProvider` 提供，只允许 `public.read` action 使用。issue 复用现有 HumanReadProof challenge 生成逻辑并只持久化 payload hash；verify 复用现有 HumanReadProof submit 校验，成功后最多签发绑定 `public.read` / routeKey / subject / IP / device 的统一 proof token。provider 对 `comment.create`、`comment.reply`、`auth.*`、`admin.*` 等写操作一律 fail closed；即使客户端提交 `X-Fsus-Challenge-Kind: humanReadProofV1`，`RequiresRiskControlFilter` 也会因 required challenge kind 不匹配而返回 428，不会消费 proof 或进入业务 handler。HumanReadProof 成功还会写入 `ReadProofAccepted` 负分风险信号，用于降低后续 public-read 风险；失败继续写 `ReadProofRejected`，不得替代 PoW、Perception 或 Passkey step-up。

`passkeyStepUpV1` 与 `adminPasskeyStepUpV1` 将 WebAuthn / Passkey step-up 接入同一 RiskControl provider 编排。普通用户 provider 只接受已认证且非 `identity_kind=admin_principal` 的请求，challenge 使用当前 userId 绑定的 allowCredentials，verify 成功后只返回 provider success，由 orchestrator 签发一次性 `X-Fsus-Challenge-Proof`。普通账号敏感凭据变更另走 `/api/binary/auth/step-up/passkey/begin|complete`，complete 成功才 mint action 绑定的 `X-Fsus-Mfa-Proof` proof token；`passkeyStepUpV1` 的 `X-Fsus-Challenge-Proof` 不能替代它。admin provider 只接受 `identity_kind=admin_principal`、`admin_id` 与 `admin_sid` 完整的请求，复用 admin step-up challenge 与 WebAuthn 校验，但走 verify-only 路径，不调用 `CreateAdminStepUpProofTokenAsync`，不写 `SecurityMfaProof`，也不签发 `X-Fsus-Mfa-Proof`。`GET /api/binary/auth/admin/me` 只在 admin session 已通过 `admin_session` 回查和 token hash 校验后返回 `AdminPrincipalSnapshot`，前端用它从 HttpOnly admin Cookie 恢复侧栏管理状态；该快照不能替代后端权限校验。普通 RiskControl proof 不能满足 admin-sensitive 写入，admin-sensitive proof 也不能作为普通 challenge proof 提交；客户端必须按业务入口分别使用 `X-Fsus-Challenge-*` 或 `X-Fsus-Mfa-Proof`。

`RequiresRiskControlFilter` 是业务入口的统一 enforcement filter。endpoint 必须声明 action / routeKey；只有 allow 或成功一次性消费 action-bound proof 才进入 handler。challenge/step-up 缺失、重放或 binding mismatch 返回 428；block/throttle 返回 429；queue 只允许显式处理排队语义的 handler 继续。`RequiresPowFilter` 保持独立 PoW wrapper。

Development 与本地 fixture 模式下，RiskControl 对本机、RFC1918 私网、link-local 与 IPv6 ULA 来源启用 `development_local_bypass`，用于浏览器调试、notification stream 和 fixture 验收，避免本机重复探测把 428/429 带进 UI。该放行只由 `IWebHostEnvironment.IsDevelopment()` 或 `fsus:allowLocalAuthFixture=true` 触发；生产启动校验仍要求 `fsus:allowLocalAuthFixture` 在非 Development 环境为 false，因此该豁免不得作为公网或生产反向代理信任边界使用。

`POST /api/binary/comment/anonymous-ticket` 是 ZK 匿名评论的预验证与一次性凭据签发边界。端点先做 frame size、articleId、scope、reply context、nullifier hash、proof/public input 长度等廉价校验，再读取当前缓存 root snapshot 并调用 `IZkAnonymousProofService.VerifyCommentProofAsync`；root 不可用、root 过期或 verifier 失败均 fail closed。通过验证后，服务端用 nullifier 服务做并发安全 reservation，blocked/scope-limit/race loser 不会签发 ticket。成功 ticket 使用 32 bytes 密码学随机数，响应只返回一次；缓存只保存 `SHA256(ticket)` 对应的短 TTL compact binary payload，并在后续 `POST /api/binary/comment/anonymous` 中通过 consume-once 读取。payload 绑定 articleId、scope、parentId/rootId/replyToCommentId、nullifierHash、credentialEpoch、`rate_class=common|unknown`、`requires_moderation` 和 expiresAt，不保存精确 credential/reputation/account-age 属性、user id、credential commitment、proof 原文、客户端 IP 原文或可反查账号的状态。强匿名写入只能走 ticket endpoint + anonymous submit；`CommentCreateV2Request` / `CommentActorResolver` 遇到 `authorMode=zk_anonymous` 必须返回 `anonymous_ticket_required`，不得直接验收可重放的 ZK proof。匿名 submit 端点同样拒绝 Cookie/Authorization/bridge session/已认证 principal，成功只写 `comment.user_id = null`、`author_mode = zk_anonymous`、匿名治理字段、region compliance 和 `Approved` 初始状态；后续模型风险隐藏只写审核/审计信号，不伪造站内信收件人。

scope 只接受服务端 canonical v1：`comment:v1:article:{articleId}:top` 或 `comment:v1:article:{articleId}:thread:{rootId}`，并与 ticket 的 article/root context 交叉校验；客户端不能用自定义值跨文章或拆分同一讨论串额度。ticket issue 的 nullifier 检查是非消费 precheck；最终 submit 在评论事务内以 `(nullifier_hash, scope)` 原子消费，顶层上限 1、线程回复上限 3，并发 loser 回滚评论写入。删除、审核拒绝、隐藏及同版本策略调整不减少 `use_count`，凭据轮换通过新 nullifier 开启新周期；scope ownership 变化必须提升版本。无重启回退使用 reloadable `AnonymousIdentity:ZkAnonymousCommentsEnabled=false` 或 `AnonymousIdentity:ZkProd:Enabled=false` 停止新 ticket，公开评论读取、notification stream 与 binary read 不受影响。

评论 Markdown 策略是发布前格式安全边界，不是模型审核边界。公开署名与强匿名评论都只接受受限 Markdown 源文：图片语法、引用式图片、raw HTML、`<img>`、危险 URL scheme、LaTeX 和 Mermaid 在前后端同一 policy 中拒绝；渲染层使用评论专用 renderer，固定不输出图片或 HTML。长度策略只改变允许的源文大小，不改变这些 Markdown 禁用项。内容风险、广告词和模型分数不在前端阻断发送；服务端写入后再执行模型处置，风险命中时按 disposition policy 自动隐藏并按规则通知或进入人工队列。

匿名评论进入审核、外部 anti-spam provider、管理端治理和高价值审计后仍保持无 deanonymization 后门。外部 anti-spam provider 只接收 content、submit/viewer region、policy snapshot、`rate_class=common|unknown`、`requires_moderation` 和 anonymous-safe moderation subject hash；provider request DTO 与 metadata sanitizer 均禁止 user id、username、public handle、精确 credential level、reputation/account-age bucket、credential commitment、proof、raw nullifier、raw IP 和 device fingerprint。审核队列只显示匿名展示名、author mode 安全文案、region policy、risk signals、coarse rate class、moderation predicate 和 nullifier 状态摘要；匿名行不得返回真实 user id，也不得提供按真实账号查找匿名评论。管理员可执行 approve/reject/hide、block nullifier、revoke anonymous credential 和查看 root/verifier/circuit 状态，但不得查看 credential secret/witness/proof、导出 credential 到 account 映射或执行反匿名查询。高价值审计只记录不可逆 target 摘要、scope、结果和状态，不记录 raw nullifier、proof、credential commitment 或账号映射。

Passkey login begin/complete 和 Recovery Key verify 都声明各自 RiskControl action：`auth.passkey.begin`、`auth.passkey.complete`、`recovery-key.verify`。旧 `auth.login` password action 仅为 migration/test policy 保留，不再绑定生产用户侧 endpoint。Passkey assertion 失败写 `PasskeyAssertionFailed` 正分信号，Passkey assertion 成功写 `PasskeyAssertionAccepted` 负分信号并继续以 `mfaVerified=true` 完成登录，因此不再额外要求普通 TOTP MFA。Recovery Key verify 即使当前风险分为 0 也必须提交 RiskControl proof，同时保留 legacy PoW proof 和 no-store 响应；缺任一 proof 都不得进入 recovery key 验证或一次性使用状态变更。

RiskControl 生产控制面按 `Risk Signal -> Risk Score -> Risk Decision -> Challenge Orchestration -> Proof Verification -> Enforcement -> Audit / Metrics / Admin Policy` 演进；完整 tracking plan、子 issue 顺序与 binary-first 边界见 `docs/risk-control-plan.md`，生产 rollout gates、故障矩阵、紧急开关和回滚流程见 `docs/risk-control-rollout.md`。

RiskControl 运行态支持 `disabled | observe | enforce | strict | lockdown`。admin binary policy API 热更新 active snapshot 并写高价值审计与 last-known-good 指针；rollback endpoint 恢复持久化 LKG。active 损坏时启动只回退已验证 LKG。无需重启的回退是把受影响 action 热更新为 `observe` 或恢复 LKG，下一请求生效。

RiskControl admin 模拟器位于 `/api/binary/admin/security/risk-control/simulate` 和 `/user/manage/security/simulator`。它只调用当前 `SecurityRiskPolicySnapshotV2` 与生产 `RiskDecisionService` 做 dry-run，返回 risk score、decision、reasons、required challenges 和 policy version；不会调用 challenge orchestrator、不会写入 `security_challenge`、不会 reset 或增加真实风险分，也不会修改 active policy。模拟器仍要求 admin principal + `system.config`，每次成功或参数拒绝都写入 admin security audit；它不是绕过 `RequiresRiskControlFilter` 的业务放行接口。

管理后台新增 `/user/manage/security` 安全系统：

- `/user/manage/security`：安全总览，展示 AntiCrawler、PoW 和统一风险信号摘要。
- `/user/manage/security/crawler`：反爬虫系统，管理模式、局部开关、CIDR 更新、风险事件、allow/blocklist、规则和模拟器。
- `/user/manage/security/simulator`：RiskControl dry-run，预演 allow、challenge、queue 和 block 决策，不执行业务写入。
- `/user/manage/security/pow`：PoW 系统，管理独立模式、默认 difficulty、proof TTL、replay 防护和风险分联动。

安全总览是处置工作台而不是子系统目录。全量安全导航只由安全系统顶层
tabs 提供；总览按待处理异常、关键趋势和最近策略变化组织。每条异常仅暴露
对应子系统的 contextual next action，不新增权限、写操作或绕过 admin
principal / `system.config` / MFA step-up 的入口。总览 binary overview
不可用时只显示固定错误类别并允许重试，不输出底层异常详情；已有成功结果
可继续显示并明确标记刷新失败。

安全后台生产 API 全部使用原生 `/api/binary/admin/security/**` AEDS v2 frame；外部 `/api/admin/security/**` JSON 入口和 internal bridge 兼容层均已移除。security binary endpoint 直接执行 admin principal + `AdminPermissions.SystemConfig` authorization、`fixed_ip` 限流、`X-Fsus-Mfa-Proof` admin passkey step-up、device fingerprint header 和高价值安全审计，失败统一编码为 `ApiError` frame。策略修改、回滚、反爬虫规则/list 变更和风险重置的 actor 必须来自 independent admin principal 的 `admin_id`，内部统一写作 `admin:{admin_id}`；缺失 `identity_kind=admin_principal` 或 `admin_id` 必须 fail closed，不得回退到普通账号 `NameIdentifier` / `GetUserId()`。

AntiCrawler 与 PoW 管理写操作会同步写入 PostgreSQL `security_policy_snapshot`，以 `policy_id + version` 保留不可变历史版本，并用单 active partial unique index 约束每个策略只有一个生效版本。写入、激活和回滚仍要求 admin principal、`system.config` 权限和一次性 `X-Fsus-Mfa-Proof`；缺失或无效 proof 返回 `428 + MFA_PROOF_REQUIRED`，不得进入策略写入。启动时 `SecurityPolicySnapshotHostedService` 在 schema bootstrap 后加载 active 快照；active 文档损坏或无法反序列化时，只回退到最近 `is_last_known_good=true` 的历史版本并写 warning，不从请求路径同步查 DB。策略表只保存策略 JSON、版本、mode、admin principal id、时间戳和回滚元数据，不保存 proof token、session token、客户端 IP 原文或设备指纹原文。`security_policy_snapshot.created_by_admin_id`、策略快照内的 `ChangedBy` / `UpdatedBy` 和高价值 audit actor 必须指向同一个 admin principal 归因平面。

AntiCrawler 支持 `disabled | observe | enforce | strict`。`disabled` 只关闭 crawler 类处置和 crawler 风险写入，不关闭 PoW、认证、授权、CORS、Fetch Metadata、路径穿越硬拦截等基础安全能力；`observe` 记录事件但不拦截、不触发 public read challenge 升级；`enforce` 是生产默认策略；`strict` 会提高 crawler 类风险分。局部开关包括 public read challenge、search crawler verification、social preview guard、risk scoring、event persistence、dashboard aggregation、CIDR auto update 和 illegal path hard abort。PoW 使用独立 `PowPolicySnapshot`，不受 AntiCrawler mode 直接控制。

---

## 真人阅读计数 proof

浏览计数不再由公开 GET 请求副作用产生。文章 `Views` 和后台访问统计统一来自 `HumanReadProofService` 接受的真人阅读事件：

- Challenge：`POST /api/binary/read-proof/challenge.aeds`，请求体为 `HumanReadChallengeRequest` frame。
- Submit：`POST /api/binary/read-proof/submit.aeds`，请求体为 `HumanReadSubmitRequest` frame。
- 客户端要求：SPA hydration 后，主内容进入视口并累计可见停留至少 8 秒；read-proof 请求不发送稳定设备指纹。
- 服务端绑定：proof signing key 与短期去重 key 相互独立。challenge 绑定 scope、routeKey、articleId、15 分钟 epoch、article/epoch scoped HMAC 摘要、签发/过期时间、最小停留时间和 nonce；摘要由瞬时 IP/UA 输入派生，但离开 Redis lease 或 token 后不保存。
- 拒绝条件：无 JS/AOT 未 hydration、直接 API 请求、缺失 Fetch Metadata、跨站 Origin/Referer、爬虫 UA、已验证 crawler、停留不足、过期 token、篡改 token、重放 proof。
- 成功提交会以 `human-read-proof` 来源写入 `ReadProofAccepted` 负分风险信号，仅用于降低 `public.read` 风险；拒绝与超限继续写入 `ReadProofRejected` 正分风险，但不会阻断公开内容访问；HumanReadProof 只决定阅读事件是否计数，不能授权 comment/auth/admin 写操作。
- 成功提交在入队前降精度为 UTC 小时、`articleId`/site 类型和四档 dwell bucket；不保存 IP/UA/设备指纹及其哈希、viewer key、proof id、route、精确请求时间或精确 dwell。`sys_visit_log` 由最终迁移整体 DROP，admin route/search/not-found rollup 清空且不再返回；`uniqueViewerKeyEstimate` 兼容字段固定为 `0`。
- 同一 article/epoch 的 Redis 去重 lease 最长 20 分钟并随独立 key rotation 密码学失效；跨 article 或 epoch 的摘要不同。低样本 region/dwell release 使用 `k=10` 与固定 UTC 日 DP noise，预算为每 scope `ε=0.5`、两种 scope 合计每日 `ε=1.0`。
- 降级开关：`HumanReadProof:Mode=paused` 暂停计数写入，但不影响内容读取。

该机制提高浏览计数的真人口径，不用于身份认证，也不承诺识别所有未知自动化行为。

---

## 实时通知通道

- 通道：`/api/notifications/stream` 使用 WebSocket，子协议固定为 `fsus-aeds.v2`
- 预检：`/api/notifications/stream/preflight` 复用认证、RiskControl / legacy PoW、cursor 和协议校验，不要求 WebSocket upgrade；成功返回 204，失败返回 AEDS `ApiError` frame 与 `X-Fsus-Notification-Stream-*` 头
- Origin：preflight 与正式 WebSocket 握手必须先执行同一套 Origin 校验，允许来源来自 `Seo:BaseUrl`、`Fido2:Origins`、`CORS_ALLOWED_HOSTS`，开发环境额外允许 localhost；生产环境跨站、非 HTTPS/WSS 或浏览器缺失 Origin 均返回 `403` + `origin_not_allowed`
- 载荷：所有通知、心跳和正式 WebSocket 握手失败均为 AEDS binary frame；握手失败返回 `ApiError` frame
- 匿名订阅：优先通过 `notification.subscribe` RiskControl action 准入；preflight 通过 `X-Fsus-Challenge-Proof`、`X-Fsus-Challenge-Id`、`X-Fsus-Challenge-Kind` 原子消费 proof，并设置短效一次性 HttpOnly grant；正式 WebSocket 只消费 grant，不在 URL 携带原 proof。旧 `pow` query 参数继续兼容，值为二进制 FPOW 证明的 base64 文本形式
- 登录订阅：复用同站点认证 Cookie，不接受文本事件流降级
- 资源配额：preflight 与正式 WebSocket endpoint 都挂 `notification_stream` 固定窗口限流；正式连接在 `AcceptWebSocketAsync` / per-connection channel 分配之前获取实例内原子租约，默认 `NotificationStream:MaxConnectionsGlobal=10000`、`NotificationStream:MaxConnectionsPerIp=100`、`NotificationStream:MaxConnectionsPerAccount=10`。账号分区使用认证账号，匿名分区使用 `anonymous:{clientIp}`；超限返回 `429`、`notification_connection_limit`、`Retry-After: 60` 与 `X-Fsus-Notification-Stream-Limit-Scope`。
- 回退：若误伤正常流量，优先热调大 `RateLimiting:NotificationStreamPermitLimit` / `RateLimiting:NotificationStreamQueueLimit` 与上述 `NotificationStream:*` 配额；已经建立的连接在断开、握手失败、accept 失败、heartbeat/backlog 异常或请求取消路径都会释放租约，不需要重启进程清理计数。
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

### 账号 subject 物理投影

普通账号的稳定安全主体只来自 `sys_user.account_subject_hash`。新账号在创建事务中持久化最终 digest；缓存只接受 `account:subject-v1:*` 命名空间中包含有效物理投影的 snapshot，不能在读取时调用 `AccountSubjectHasher.Create`，也不能从 account id、public handle 或 Passkey handle 重新派生。

JWT 签发、binary auth、credential step-up、blacklist/account-state cache 和 notification stream admission 都必须先取得有效物理投影。缺失或格式错误分别沿既有协议返回 `ACCOUNT_SUBJECT_REQUIRED`、`account_subject_invalid` 或对应 fail-closed 结果，并且必须在 proof 验证、blacklist lookup 或业务 mutation 前终止。修复数据投影后使旧 snapshot 失效并从 PostgreSQL 重载即可；历史 session 需要重新认证以取得携带物理 subject 的 token，不得恢复 identity reset 或 id-derived fallback。

Expand/backfill、完成查询和 nullable rolling-schema 边界只由 [Account Subject Physical Projection Cutover](database-migration.md#account-subject-physical-projection-cutover) 定义；永久 startup/readiness 顺序只由 [生产启动保护](architecture.md#生产启动保护) 定义；操作验收由 [Anonymous Identity Smoke Flow](anonymous-identity-smoke-flow.md#physical-account-subject-projection) 定义。

| 参数 | 值 |
| ------ | ----- |
| Access Token 有效期 | `Jwt:AccessTokenExpiresMinutes`（默认 15 分钟） |
| Refresh Token 形式 | HttpOnly Cookie（SameSite=Strict，Secure） |
| 续签方式 | `POST /api/binary/auth/refresh-token`，基于 `RefreshFamilyId + RefreshGeneration + RefreshTokenHash` 的原子 CAS 轮换（旧 Token 进入有限期 hash tombstone） |
| 签名算法 | HS256（密钥来自环境变量，生产启动时强制校验非占位值） |

Refresh Token 只以哈希形式保存在 `sys_user_session`；`sys_user` 不再保存明文 Refresh Token 或全局刷新过期时间。普通登录在同一事务内获取账号级 PostgreSQL advisory lock，先清理 idle/absolute 已过期会话，再按最近使用顺序将 active 会话收敛到 `Security:UserSessions:MaxActiveSessions - 1`，最后插入新 session；正常登录不再使用 `login_replaced` 撤销其他合法设备。默认上限为 10，可配置范围为 1-50；上限淘汰原因固定为 `active_session_limit`。

每条 session 在创建时生成独立 `RefreshFamilyId`，从 generation 0 开始。刷新以 token hash 定位当前 generation，并在单一事务中 CAS 当前 hash/generation、写入旧 hash tombstone、递增 generation、更新 `LastSeenAt` 和 idle expiry；`SessionId` Cookie 只做一致性检查。CAS loser 返回固定冲突而不取得新 token；已提交 tombstone 的旧 token replay（包括缺失 `SessionId`）会精确标记并撤销该 family，不按设备指纹或账号扩大处置。HTTP 交付边界继续在 Cookie 追加前后验证新 hash；任一验证/追加失败会把已轮换 family 标记为 delivery failure、清普通账号 Cookie并要求重新登录，不恢复旧 token。指标分别覆盖 rotation conflict、replay/family revoke、Cookie write 和 delivery failure。数据结构、30 天最大 tombstone 保留与无需重启的流量回退见 [Refresh Token lineage](security/refresh-token-lineage.md)。

PostgreSQL commit 与 HTTP `Set-Cookie` 无法组成分布式原子事务。双读能阻止已经失配的 rotation 被发送，但不能宣称消除“最终回查通过后、响应头到达浏览器前进程退出”的物理窗口；进程直接退出时本实例也可能来不及记录 cookie-write-failed 指标。客户端只对明确的 network transport failure 重试一次，401/协议错误不重试；若旧 token 已被 CAS 替换，服务端 replay-family guard 仍 fail closed，用户可能需要重新认证。不得为提高连续性重新接受旧 refresh hash 或禁用 family revoke。

普通账号 access token 通过签名、issuer、audience 与 `exp` 校验后，还必须在同一认证回调内校验 `sid` 对应的服务端会话。默认快路径直接读取 Redis L2 的 `SecurityUserSessionValidation` v3 版本快照，不使用进程内 L1；cache miss、Redis 异常或 payload 损坏都只允许按 `sys_user_session.sessionid` 主键做一次有界 PostgreSQL 权威查询，并联表核对账号状态、注销时间、`identity_kind`、session/account `xmin` 与 `session_mode`。DB fallback 由 `Security:UserSessionValidation:DbFallback` 的并发预算和连续失败熔断保护；被拒绝或数据库失败均 fail closed，不回退为只信 JWT。回源后用单调版本 CAS best-effort 修复缓存，修复冲突/失败不改变本次 DB 裁决。公开匿名请求没有 bearer principal，不进入该校验。普通会话校验失败只清理普通 access/refresh/session Cookie，不清理独立 admin Cookie；admin token 仍走既有 `IAdminSessionValidationService`，两个身份平面不得合并。

单会话撤销、撤销其他会话、logout、Recovery Key 会话撤销、账号注销与 refresh replay 必须在显式 PostgreSQL 事务中更新 `revokedat/revokereason/session_mode=revoked`，取得更新后的 `xmin`，并把 revoked snapshot 作为事务回调的最后一步发布到 Redis；只有跨实例 fence 已可见后才允许提交数据库事务。ban/unban 同样在账号状态事务内批量推进 active session 为 restricted/normal 并发布带账号版本的快照。发布失败必须让事务回滚。cache repair 和 producer publish 的 Redis Lua 均拒绝比当前数值 row version 更旧的 snapshot，所以旧 active/restricted 状态不能覆盖较新的 revoke；并发 repair 冲突仍按当前数据库读取结果裁决，不信任冲突 key。

`session_mode` 的安全序为 `normal < restricted < revoked`。JWT 携带 mode 供跨层表达，但服务端数据库/缓存快照是授权权威，不一致时只能取更严格值；因此 ban 后旧 normal token 下一请求成为 restricted，unban 后旧 restricted token 在 refresh/重新签发前仍 restricted。restricted principal 仅放行显式 `RestrictedAccountActionMetadata` 白名单（本人状态与封禁原因、logout、自有 sessions/revoke、delete、必要 step-up）；评论、消息、内容、身份、公开业务与 admin 路径默认拒绝，notification stream 也在 admission 前以 423 拒绝。不得用 path prefix、HTTP method 或客户端隐藏控件推断例外。

`Security:UserSessionValidation:DistributedCacheEnabled` 默认视为 `true`。若版本化 Redis 快路径自身需要在线隔离，可通过支持热重载的 configuration provider 将其改为 `false`，服务会立即切到 DB-only 安全模式：每个已签名普通 token 仍按 session 主键精确校验，撤销能力不降级，只暂时增加受保护请求的数据库读；Redis 发布在该模式下是显式 no-op，数据库事务提交即成为撤销可见边界。无需重启，也不得切换成只信任 JWT。恢复为 `true` 后，新请求按 Redis miss 回填当前 PostgreSQL 真相。运行时必须观察 `fsus.auth.session_validation.*` instruments 的 cache hit/miss/error、DB fallback success/rejected/error、repair outcome、latency/concurrency 与 Redis 故障附加 DB QPS；预算拒绝增长或数据库错误必须触发流量降载/DB-only runbook，而不是放宽认证。仅通过不支持 reload 的环境变量提供配置时，仍需滚动发布。完整竞态、回退和验收矩阵见 [user-session-revocation.md](user-session-revocation.md)。

JWT 签发结果必须同时携带 access token 字符串与其绝对 `ExpiresAtUtc`；普通登录、刷新轮换、MFA 登录、Passkey 登录以及 admin bootstrap/login 都把该同一绝对时间传给 Cookie 写入层。`AuthCookieService` 不读取 `Jwt` 配置，也不反向解析 JWT；AccessToken Cookie 的 `Expires` 必须与 JWT `exp` 的 UTC 秒边界一致，不能晚于 token，也不能继续使用独立的 15 分钟常量。通过可热重载 configuration provider 修改 `Jwt:AccessTokenExpiresMinutes` 只影响后续新签发 token；需要无重启回退时可恢复为 15，已签发 token 和其 Cookie 继续保持原同源生命周期，无需批量改写现有 Cookie。仅由环境变量提供配置且不支持 reload 的部署仍需按常规滚动发布应用新配置。

本地认证 fixture 也遵守同一绝对期限边界：它从 `user.storage-state.json` / `admin.storage-state.json` 读取各自 access Cookie 的 Unix expiry，并原样交给 `AuthCookieService`，不得用当前时间或 JWT 配置重新计算。fixture refresh runner 只会从 `Development` 且显式启用的 loopback + shared-secret 端点解析；默认实现仅通过 `node` 的 `ArgumentList` 执行仓库内固定 `tests/frontend/fixtures/prepare-auth-smoke-users.mjs`，设有 60 秒超时、取消和非零退出处理，并丢弃 stdout/stderr 内容。runner 失败发生在任何 Cookie 写入之前，只返回固定错误；Production 不映射该端点，也不得解析或调用 runner。测试可通过 DI 注入无进程 fake runner，但不能把请求、配置或环境变量中的 executable/script path 引入默认执行链。

**生产启动保护**：如果 JWT 密钥与已知占位值相同，服务器拒绝启动，防止弱密钥上线。

**Anonymous identity mode**：设置 `FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1` 后，`sys_user` 只作为匿名账号容器使用，`public_handle` 与 `identity_kind=anonymous_account` 是展示/身份语义；物理 `username/password/role/lastusernameupdatetime/last_username_update_time` 列由 `20260621-post-user-legacy-identity-columns-finalize` 删除，代码层不得再映射或读取这些 legacy 字段，不能作为展示名、普通登录凭据或 admin 权限来源。生产环境必须启用该模式，`ProductionStartupValidator` 和 `/health/ready` 会拒绝缺失、`0`、`false` 等关闭值，`FSUSBLOG_ALLOW_INSECURE_STARTUP=true` 只能让进程降级可观测启动，不能把 readiness 变成可上线状态。该模式禁用旧密码注册、密码登录、改密、自助删号中的密码证明；管理端不暴露匿名账号密码重置能力，只治理匿名账号状态、session、Passkey、Recovery Key、匿名凭据和 nullifier/scope。TOTP 保留为可选 step-up，但 secret、pending secret、验证时间和 TOTP recovery-code hash 只存放在 `user_mfa_profile`；旧 password proof 不再参与 TOTP rebind/disable/recovery-code regeneration。普通账号 access token 只携带 account id、`identity_kind`、必需的 `account_subject_hash`、session id 与 MFA 状态，不携带 legacy username 或 role claim；该 claim 必须逐字取自 `sys_user.account_subject_hash`，供 RiskControl subject/proof binding 使用，不得在请求期从裸 `userId`、public handle 或 Passkey handle 重新派生。物理投影缺失时 token 签发、缓存预热和普通账号安全边界全部 fail closed，永久启动门禁也拒绝承接流量。因此旧 `sys_user.role=admin` 无法进入 admin group、admin rate partition、评论管理员删除分支、普通账号状态治理保护条件或审计 admin actor。独立 admin principal 由后续 bootstrap/Passkey 流程提供。`sys_user` 不保存原始 last login IP/time；登录观测只能进入 `sys_user_session.last_ip`、安全事件或审计哈希维度。

**Anonymous gateway profile**：即使未来接入统一账号网关，FsusBlog 也只接受匿名 profile 所需的最小请求头集合。`AnonymousGatewayHeaderGuardMiddleware` 在 `UseAuthentication()` 之前执行，所有入站 `X-Fsus-*` 请求头必须命中显式 allowlist：RiskControl challenge、device fingerprint、admin bootstrap/MFA、CSRF header、无账号语义的 `X-Fsus-Client-Mutation-Id`、notification stream protocol/drill HMAC、public AOT token、region、subscription proof、test session 和 upload token/chunk 元数据。`X-Fsus-Username`、`X-Fsus-Email`、`X-Fsus-Role`、`X-Fsus-Account-Role`、`X-Fsus-User-Id`、`X-Fsus-Password`、`X-Fsus-Totp` 以及包含 register/login/password/TOTP 传统账号语义的头一律返回 400，未知 `X-Fsus-*` 也默认拒绝。该 guard 不读取敏感头值、不创建 principal、不把外部账号 ID 映射到评论作者、审计 actor 或 session 主体；管理员后台仍只接受 FsusBlog 独立 admin principal 与明确的 admin proof。

普通账号自助 `/api/binary/auth/*` 端点必须显式挂 `RequireAnonymousAccountPrincipal()` 或等价策略，只接受 `identity_kind=anonymous_account` 的账号主体；`EndpointUserContext` 只把该平面暴露为 `AccountId`，同时保留 `AdminPrincipalId`、`IdentityKind`、`SessionId` 与 `IsAnonymousAccount` / `IsAdminPrincipal` 供边界判定。请求审计和 Serilog log context 也只能使用 `AccountId`、`AdminPrincipalId` 和 `AuditActorId` 这些明确维度，告警/仪表盘不得继续消费泛化 `UserId`。`/auth/me`、public handle、普通 session、MFA、Recovery Key、Passkey credential 和自助注销/登出端点不得使用裸 `.RequireAuthorization()` 或把 AdminPrincipal 的 `NameIdentifier` 当作账号 id。AdminPrincipal 访问这些普通自助端点必须在授权层返回 403，不进入业务 handler，并通过 `security.auth.self_service_principal_rejected` 高价值审计记录拒绝；AdminPrincipal 只能使用 `/auth/admin/*` 控制面端点。

普通消息 `/api/binary/messages/**` 端点属于匿名账号自服务平面，也必须挂 `RequireAnonymousAccountPrincipal()`，并通过 `AccountPrincipalContext.AccountId` 读取账号身份；不得使用 legacy `CurrentUser` binder 或裸 `.RequireAuthorization()`。管理消息 `/api/binary/admin/messages/**` 保持 independent admin principal 平面，写入操作只通过 `AdminMessageActor(adminPrincipalId, adminSessionId)` 归因。

消息域永久保留必要的 admin principal，但不得长期保存 raw admin session ID。
`Messages:AdminSessionAuditReferenceKey` 必须是至少 32 字符、与 JWT 独立的部署 secret；新写入只保存
其 HMAC-SHA256 audit reference，已有 raw session 替换为独立随机 legacy audit ID 后清空，并由
数据库约束阻止重新写入。notification stream append/upsert 不携带正文或预览，结构化日志、
metrics 和 outbox delivery identity 也不得记录 subject/body。保留清理按 open/pending 365 天、
closed 180 天、system governance 90 天清除内容；下一次 cleanup 检测到账号注销 tombstone 后清除账号 authored content、主题、
附件和账号关联，但保留调查所需的 admin principal 与不可逆 audit reference。
`Messages:RetentionCleanupEnabled=false` 可无需重启暂停未来清理；已 redacted 的正文不可逆恢复。

普通可归因评论 `POST /api/binary/comment` 与 `GET /api/binary/comment/me` 同属匿名账号自服务平面，必须挂 `RequireAnonymousAccountPrincipal()` 并通过 `AccountPrincipalContext.AccountId` 读取账号身份；不得在 handler 内调用 `GetUserId()` 或接受 AdminPrincipal。`DELETE /api/binary/comment/{id}` 同时承载账号自删和管理删除，但服务边界必须拆成账号 actor 与 `AdminPrincipalActor(adminPrincipalId, adminSessionId)` 两条路径，不得用 `int userId + bool isAdmin` 混合表达身份平面。

**Independent admin principal plane**：后台控制面身份保存在 `admin_principal`、`admin_session`、`admin_passkey_credential` 和 `admin_audit_log`，不复用 `sys_user` / `sys_user_session`。首次 root admin 只能通过 `/api/binary/auth/admin/bootstrap/passkey/begin|complete` 创建，必须提供 `X-Fsus-Admin-Bootstrap-Token`，其值来自 `FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN` 或 `Admin:BootstrapToken`；一旦存在 active root admin，bootstrap 永久拒绝再次执行。root bootstrap complete 必须在数据库事务内获取 PostgreSQL transaction-scoped advisory lock，重新检查 active root，插入 `admin_principal`、`admin_passkey_credential`、`admin_session` 并写 `admin_audit_log`；`admin_principal` 还必须有 active root partial unique index，唯一冲突统一返回 `Root admin already exists`，不得留下 orphan credential/session。admin 登录只走 `/api/binary/auth/admin/login/passkey/begin|complete` 的 Passkey/Security Key assertion，不接受 username/password。成功后只写独立 `AdminAccessToken` / `AdminSessionId` 或 `__Host-AdminAccessToken` / `__Host-AdminSessionId` Cookie，JWT claims 包含 `identity_kind=admin_principal`、`admin_id`、`admin_sid` 和多值 `admin_permission`，不携带 `ClaimTypes.Role` / `role=admin`。当前权限集合包括 `article.write`、`article.publish`、`comment.moderate`、`anonymous.comment.configure`、`anonymous.nullifier.block`、`anonymous.credential.revoke`、`audit.read`、`system.config`、`admin.manage`。后台控制面 endpoint 必须通过 `RequireAdminPermission(...)` 或等效 policy 同时校验 `identity_kind=admin_principal` 与具体 `admin_permission`，不得接受 legacy `sys_user.role=admin` 或 `[Authorize(Roles=\"admin\")]` / `RequireRole(\"admin\")`。每次 admin access token 通过 JWT 签名、issuer、audience 和 exp 校验后，还必须请求期回查 `admin_session`：`admin_id/admin_sid` 必须存在，principal 必须 active，session 必须未撤销、未 idle/absolute 到期，`AccessTokenHash` 必须匹配当前 token，且 session 的 principal id 必须与 token 一致；失败时拒绝认证并清理 admin cookies，成功时更新 `LastSeenAtUtc`。bootstrap、login、admin passkey step-up 和后续 recovery/session 治理操作必须写入 `admin_audit_log`；普通用户 MFA/TOTP 不参与 admin-sensitive 授权。

前端管理工作区同样只能从 `GET /api/binary/auth/admin/me` 恢复 independent admin principal，并以 `adminSessionStatus=active` 与 `admin_permission` 列表决定 `canManage`、导航可见性和 route guard。普通 `/auth/me` 匿名账号 snapshot 只用于 `/user` 自服务区域；前端不得保留 `legacy.admin` 万能权限、`syncLegacyAdminPrincipal` 桥接或通过 `userInfo.role === 'admin'` 解锁管理区。

admin-sensitive step-up 使用 `/api/binary/auth/admin/step-up/passkey/begin|complete`。challenge 必须绑定 `identity_kind=admin_principal`、`admin_id`、当前 `admin_sid`、action=`admin-sensitive`、challenge token 和过期时间；bootstrap、login 和 step-up 的 admin Passkey complete 路径必须通过 `IUnifiedCache.ConsumeOnceAndGetAsync` 原子取出并消费 challenge，消费失败不得进入 WebAuthn 校验或 DB 写入。complete 成功后通过 `CachePolicyId.SecurityMfaProof` 写入 45 秒 TTL 的一次性 proof，key 为 `admin:{adminId}:{adminSid}:admin-sensitive:{token}`。所有批量封禁、匿名账号 suspend/unsuspend、session/passkey/recovery/credential 治理、文章删除/恢复/永久删除/清空回收站、站点备份导出、integrity fix、审核策略和安全策略写操作只接受该 admin proof，经 `X-Fsus-Mfa-Proof` 传递，并要求请求 `Origin` 或 `Referer` 命中 `CORS_ALLOWED_HOSTS` / `Fido2:Origins` / `Seo:BaseUrl` 可信来源；缺失、过期、复用、跨 session、跨站来源或普通用户 MFA proof 均返回 `428`/`403` 且不得进入业务 handler。清空回收站还必须使用 `fixed_ip` 限流，并通过高价值审计记录 actor、销毁数量、trace id 和 success/failure outcome。

admin 登出和 session 管理只使用 `/api/binary/auth/admin/logout`、`/api/binary/auth/admin/sessions`、`/api/binary/auth/admin/sessions/{sessionId}/revoke` 与 `/api/binary/auth/admin/sessions/revoke-others`，全部要求 `admin.manage`。登出必须写入 `admin_session.RevokedAtUtc` 与 `RevokeReason=logout`，并只清理 admin Cookie；不得调用普通用户 `/auth/logout` 或清理普通用户 refresh/session Cookie 作为替代。admin session validation 在回查 `admin_session` 后，只能用 `xmin` row-version、旧 `AccessTokenHash`、旧 idle/absolute 过期时间和未撤销谓词推进 `LastSeenAtUtc`；stale 更新必须返回 conflict，不得让已撤销或 token 已变化的 session 继续刷新活跃时间。admin session revoke 必须先读取 `xmin` row-version，再带版本谓词更新 `admin_session`；重复或并发 stale revoke 返回 conflict，不覆盖最早成功写入的 `RevokeReason`。每个成功 revoke 只写一条 `admin_audit_log`，action 固定为 `admin.session.revoked`，用于保留独立审计轨迹。

前端管理员登出必须先调用上述独立 admin endpoint，再销毁本标签页的 admin principal、admin fixture、在途 admin session snapshot 与私有浏览器状态。网络传输失败只允许对幂等登出重试一次；明确 `401` 表示服务端已不再接受该 admin session，可归类为 `already_inactive`。其他失败必须记录为 `local_only` 并向调用方抛出固定、无 session 标识的“撤销未确认”结果，不能显示或记录为完整登出成功。无论服务端结果如何，前端都通过只含 `type/at` 的 `admin-logout` 跨标签事件立即清除各标签页 admin plane，并把仍在管理区的路由安全替换到普通账号自服务页或公开首页；普通账号 store、Cookie 和 account logout 广播保持不变。

`BannedUserMiddleware` 按 `identity_kind` 分流：`identity_kind=admin_principal` 的后台主体不读取 `sys_user`、不查询普通用户 blacklist，也不受同 ID 普通用户封禁/删除状态影响；它只放行给后续 admin authorization、admin session 和 permission 检查。`identity_kind=anonymous_account` 与 legacy user 仍按普通用户账号状态和封禁写锁处理。普通账号 JWT 必须携带 `account_subject_hash`，封禁与 account-state 热缓存都以该 subject hash 为命名维度；`NameIdentifier` 只允许作为数据库回源 account id，不能作为 Redis/L1 cache key。

**Recovery Key**：匿名账号的账户恢复使用独立 `account_recovery_key` 表，不复用 `user_mfa_profile.mfa_recovery_codes_hash` 或 TOTP recovery-code 语义。Create/rotate 只在 AEDS `RecoveryKeyCreateResponse` 中返回一次明文，新格式为 `frk_<lookupId>_<secret>`，`lookupId` 为 128-bit hex 随机值；服务端保存 `account_id`、带 `RecoveryKeyPepper` 的 `lookup_id_hash`、完整 key 的 HMAC + PBKDF2-SHA256 哈希、key version 和 created/used/revoked timestamps，不保存明文 lookup id 或 secret。提交的 recovery key 在任何 HMAC/PBKDF2、lookup 或失败计数前限制为 256 字符，超长值统一返回 `RECOVERY_KEY_INVALID`；失败计数 identity 来自 peppered lookup/attempt identity，不使用原始 IP 或 User-Agent 作为共享锁定维度。`account_recovery_key` 的账号外键最终态列名必须是 `account_id`，索引使用 `idx_account_recovery_key_account` / `idx_account_recovery_key_version(account_id, key_version DESC)`；历史 `user_id` 列和 `idx_account_recovery_key_user` 只能通过 schema migration 兼容迁移，不得在 CodeFirst 最终态保留。`/api/binary/auth/recovery-key/verify` 是匿名、`fixed_ip` 限流、RiskControl challenge、PoW 和 no-store 端点；请求不接受 account id，服务端用 key 内 lookup id 的 peppered hash 定位候选记录，再校验完整 key。旧无 lookup id 的 key 不做全表扫描兼容，会统一失败并计入 attempt limiter。验证成功后 Recovery Key 立即标记 used，只返回短期 recovery session token 与过期时间，用于 `/auth/recovery-key/passkey/register/begin|complete` 绑定新 Passkey，不返回 account id、user id 或 internalUserId。请求可选择撤销现有 sessions，并在新 Passkey 绑定成功后撤销旧 passkey credentials；不提供 email/phone fallback。

Recovery Passkey 完成会话使用 `pending -> completing -> completed` 状态机；`completing` 由 Redis compare-and-set 认领并携带 90 秒短租约，同一会话并发最多只有一个请求进入 WebAuthn/数据库写入。验证失败、数据库事务失败或请求取消时只把仍由本请求持有的精确 `completing` 值恢复为 `pending`，因此用户不需要再次提交已标记 used 的 Recovery Key。新 credential、可选旧 credential 撤销和 `sys_user.passkey_enabled=true` 在同一数据库事务内提交；提交成功后再推进账号快照版本并移除注册 challenge。若提交后响应或 cache 清理丢失，`passkey_credential.recovery_session_hash` 唯一标记与 `recovery_request_hash` 请求绑定允许同请求重放继续完成幂等清理，不允许不同请求借用已完成会话。原始 recovery session token 不入库。迁移、失败语义和无需重启的回退步骤见 [recovery-passkey-completion.md](recovery-passkey-completion.md)。

普通账号 session 管理只允许对外展示 session id、设备指纹/标签、最近活跃时间、当前会话标记和 MFA 状态。`sys_user_session.last_ip` 可继续作为服务端风险判定输入，但不得进入 `AuthSessionList`、frontend adapter 或 IdentityCenter 原始 IP 展示；独立 admin session 列表仍按 admin 控制面契约处理。

普通账号安全凭据变更统一走 `IUserSecurityStepUpService`，action 固定为 `account.delete`、`passkey.delete`、`passkey.credential-name.update`、`recovery-key.create`、`recovery-key.rotate`。Passkey 删除、Passkey 凭据友好名称更新、Recovery Key create/rotate 与账号注销的生产 binary endpoint 不直接判断 MFA 或密码状态，只提交当前 account、action 和 `X-Fsus-Mfa-Proof` 给统一服务；这些 endpoint 不读取 `MfaPasswordProofRequest` body。普通账号可通过 `/api/binary/auth/step-up/passkey/begin|complete` 使用当前账号 Passkey 断言换取同 action 的一次性 proof，complete 必须一次性消费 challenge 并校验 begin 时绑定的 action。该通道必须先读取 `Auth:PasskeyStepUp:Enabled`，默认开启；关闭时 begin/complete 都 fail closed，返回 503 + `PASSKEY_STEP_UP_DISABLED`，且不得创建 WebAuthn challenge、消费 assertion 或签发 proof。已启用 MFA 的账号也可通过 TOTP challenge 获取对应 action proof；proof token 使用 32 字节 CSPRNG，并把 cache identity 绑定到 `accountSubjectHash`、action 与 token 后再 consume-once。`FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1` 时禁止 legacy password fallback，只接受一次性 step-up proof。非匿名 legacy password fallback 如仍需保留，必须在显式隔离的兼容路径处理，不得进入匿名生产敏感操作路径。`/api/binary/auth/mfa/challenge/start` 不得为这些 action 在无 MFA 时直接签发空 proof，避免绕过等效 proof 要求。MFA challenge ticket 持久化 `AccountId` 与 `AccountSubjectHash`，并使用 `MfaChallenge:TicketSigningKey` 对 ticket bytes 做 HMAC-SHA256；读取时必须固定时间比较 MAC，拒绝 legacy unsigned ticket。验证失败时 Redis/L1/L2 计数以 `fail:subject:{accountSubjectHash}` 聚合，使匿名账号重建或内部 id 重排不会重置同一主体的失败窗口。回滚只应删除 `SecurityMfaChallenge` 中对应 `fail:subject:*` / ticket key，让用户重新发起短 TTL challenge，不需要重启服务，也不得降级回裸 `userId` key。

**ZK strong-anonymous comment path**：ZK 只作为 `zk_anonymous` 评论的强匿名扩展点，不参与账号、Passkey、admin 或 session 认证。issuance 决策见 [ADR-Anonymous-Credential-Blind-Issuance.md](architecture/decisions/ADR-Anonymous-Credential-Blind-Issuance.md)：当前 proof contract 为 `fsus.anonymous.comment.v5` / layout 6，credential possession 必须验证浏览器 finalized RFC 9474 credential，并继续约束 root、revocation、policy 与 `nullifier = PRF(credential_secret, action_context, scope)`。credential commitment、final signature、serial、issuer record id 等稳定值只能是私有 witness，不能进入 public input、ticket、日志或审核数据。当前没有完成 ceremony 的 current prover/verifier artifact，默认 verifier 与 ZK-Prod 均关闭；任何缺失、非当前 transcript 或 invalid proof 都 fail closed，不写评论。

`AnonymousIdentity:ZkProd:*` 是生产强匿名评论的外层发布 gate，当前所有模板默认 `Enabled=false`。Production 下 `AllowDevVerifier=true` 或 `FallbackToLegacyAnonymous=true` 一律启动失败；未来启用必须同时满足 native Groth16 verifier、v5 trusted setup + verifying key hash、blind issuer、v5 root snapshot 与真实浏览器 prover evidence。`CredentialReady=true` 不能绕过 `IRfc9474BlindCredentialSigner.IsConfigured` 和 reload gate。`GET /api/binary/comment/policy` 只暴露 coarse readiness 与枚举 unavailable reason，不返回 proof、witness、secret、SPKI private material 或 verifier 细节。

浏览器把 comment policy 的完整 ZK-Prod 位、受控 reason 和 client contract version 归一化为单一 readiness；不得只凭 `zkProdEnabled=true` 放行。verifier、trusted setup、credential requirement/root 任一缺失，未知 reason、旧 layout、损坏字段或 64-hex policy hash 缺失都必须禁用强匿名 ticket 准备与提交，且不能回退 public 发送。后端仍是 readiness 权威，前端状态只负责禁用入口和呈现低信息量原因。无需重启的安全回退是热更新 `AnonymousIdentity:ZkAnonymousCommentsEnabled=false` 或 `AnonymousIdentity:ZkProd:Enabled=false`；下一次 policy 读取会进入 `disabled`，前端清除/停止私有 ticket 准备，公开读取、显式 public 评论、admin 与 notification stream 不受影响。

评论正文的浏览器草稿边界与 credential vault 分离：`zk_anonymous` 正文只存在于当前页面内存，不能写入 `localStorage`、`sessionStorage`、IndexedDB 或 Cache Storage；只有用户明确选择公开署名后，正文才可进入 `fsus:comment-public-draft:v2:*`。持久 key 使用每个本地账号生命周期随机生成的 scope，不包含原始 account id；logout、account switch、session expiry、account deletion、panic wipe 会同时清除 scope 与公开草稿。login/account-switch 广播必须等待发送标签页的统一清理完成，panic wipe 在 registry 清理后再次删除所有 `fsus-` Cache Storage；任一清理失败都不能提前广播新的登录状态。切换到强匿名必须先删除同一公开副本，删除失败时匿名提交 fail closed；credential epoch/key/root 轮换或 feature disable 会清除当前匿名内存正文。policy hash 不匹配的公开草稿只显示“审查草稿”入口，不自动加载正文、作者模式或发布确认。旧 `fsus:comment-draft:v1:*` 一律视为可能含匿名明文并在初始化和统一清理链路中删除。完整威胁模型、存储矩阵与验证方法见 [Comment draft privacy](security/comment-draft-privacy.md)。

生产 issuer backend 仅为本地 `AnonymousCredentialIssuer:BlindRsa` RFC 9474 signer，不使用后端 JS 或托管网络。配置必须同时具备 `Enabled=true`、固定 profile、非占位 key id、3072-bit/e=65537 PKCS#8 DER private key、匹配的 SPKI SHA-256、并发与 timeout 上限；任一不符则 `IsConfigured=false`。不存在第二套 issuer 配置或兼容路由。

ZK-Prod 后端依赖策略固定为 .NET 10 + `System.Text.Json`。trusted setup、verifying key、proof、manifest 和 evidence JSON 只允许用 `System.Text.Json` source generation、`Utf8JsonReader` 或 `JsonDocument` 解析。当前 verifier 只接受 v5/layout 6 的外部 ceremony 材料；仓库不保留淘汰电路的依赖评估、生成器、native fixture 或 key artifact。

淘汰 circuit、R1CS、ceremony 与 key 链不保留仓库 ownership、生成、部署或恢复入口。v5/layout 6 manifest 必须保持 `ceremony_status=not-run`、`production_usable=false` 与空 active verifying-key hash，直到新电路和 ceremony 完成。`security/evidence-contracts/anonymous-credential-blind-issuance.json` 是 `implementation-attestation`，只描述 issuance primitive 的 focused 实现状态；其 `freshExecution=false`，不能作为 presentation circuit 或 release closeout 证据。

生产发布前必须先运行 blind issuance checker/backend/frontend tests，再运行现有 privacy-ZK smoke/release gate。功能关闭时只接受 `expected_unavailable`；真实上线 evidence 必须声明 `circuitId=fsus.anonymous.comment.v5`、layout 6、Groth16，并绑定真实 v5 R1CS/key/verifier/prover hashes、完整 tamper matrix 和至少 100 scopes 的 transcript unlinkability。回滚设置 `BlindRsa:Enabled=false` 与 `ZkProd:Enabled=false`；不删除评论、root 或 vault 数据，不重新启用 legacy issuance。
`tools/deploy-production.sh` 是生产一键部署入口，会在 `docker compose up` 前加载 `.env.production`、检查只读挂载的真实 ZK config/secrets 目录，并强制运行 `check:privacy-zk-prod-release`；该入口不提供跳过 ZK release gate 的参数或环境变量，缺少 v5 ceremony、key、issuer/root 或 cross-stack smoke 的真实材料时必须停在引导输出，不得直接启动。

`ProductionZkProofVerifier` 在调用昂贵 verifier backend 前先做 cheap checks：action 必须是 `comment.create`，circuit/verifying-key/layout 必须匹配 immutable 配置快照，credential root、revocation root 和 issuer public key hash 必须同时命中 `IAnonymousCredentialRootReader` 的 active/grace runtime snapshot，proof 大小不得超过 `MaxProofBytes`，nullifier hash、issuer public key hash、credential root 和 revocation root 必须是固定 64 字符 hex token，policy hash 与 root token 必须格式合法；公开谓词只接受 `is_eligible=true`、`may_comment=true`、`rate_class=common|unknown` 和布尔 `requires_moderation`。精确 credential level、reputation/account-age bucket 与 credential commitment 都不属于 public verifier request。root runtime snapshot 只接受 root lifecycle 生成的 `root_attestation`：签名材料绑定 epoch、credential root、revocation root、issuer public key hash、circuit id、verifying key hash、layout version 和 circuit metadata，使用独立 `AnonymousCredentialRoot:AttestationKey` HMAC；缺失、key id 不匹配或签名错误的 root 不进入 snapshot。revocation accumulator profile 必须是 production-ready 的 circuit-friendly sparse Merkle non-membership profile，hash/tree/pathDepth 必须匹配 circuit metadata；Grace root 还受 `AnonymousCredentialRoot:GraceRootMaxAgeSeconds` freshness 窗口限制，revocation 或 rotation 会重签并刷新 snapshot。ticket service 还会用 `NativeGroth16PublicInputCodec`、当前 root snapshot 和当前 policy snapshot hash 重建 canonical public inputs，并在 byte-for-byte mismatch 时 fail closed，不进入 native verifier。backend 调用使用 bounded concurrency 和明确 timeout，并支持 `CancellationToken`；timeout、取消、backend reject 或异常都统一返回 `invalid_proof`。日志只允许记录 backend 名称和 fail-closed 类别，不记录 proof 原文、witness、credential secret、credential commitment 原文或内部 verifier 失败细节。

`AnonymousIdentity:ZkVerifier:NativeGroth16:LibraryPath=managed:mcl` 使用 `Nethermind.MclBindings` 的 .NET 10/MCL 内核执行真实 BN_SNARK1 pairing verify equation；外部原生库路径仍支持 `fsus_zk_groth16_verify` C ABI。两条路径都必须先通过 verifying key path + SHA-256 绑定，按 `SHA256(canonical publicInputs)->Fr` 绑定 public input transcript，proof/publicInputs 任一篡改都 fail closed。Wasm 基础构建仍输出 `comment-privacy-prover.js` 与 `comment_privacy_runtime.wasm`，但只有显式、已验证的 v5 production build 才额外输出 `comment-privacy-prover.zkey` 和 `comment-privacy-prover.manifest.json`；默认 fail-closed build 中后二者必须不存在。仓库不生成或保存 production ceremony material。

强匿名 ticket / submit 端点必须先挂 `RequireStrongAnonymousRequest()` / `RejectIdentifiedPrincipalFilter`，再组合 PoW、RiskControl 或业务 filter。该守卫只做 `Cookie`、`Authorization`、`X-Fsus-Access-Token`、`X-Fsus-Bearer-Token`、`X-Fsus-Session-Id`、future auth bridge header 的 presence check，并检查 `HttpContext.User.Identity.IsAuthenticated`；它不解析 cookie、不读取 header 原文、不访问数据库或 Redis。污染请求返回 AEDS `ApiError`，`Details=anonymous_identity_contaminated`，用户态文案固定为“匿名发布请求不能携带登录态，请刷新后重试。”；安全审计只记录 trace id、path、reason 和 presence flag。`/api/binary/comment/anonymous-ticket` 在读取请求体前还必须检查 ZK-Prod policy ready；feature flag 关闭、native verifier 未配置、trusted setup/issuer/root readiness 缺失时返回 `anonymous_comment_ticket_unavailable`，不得调用 ticket service、nullifier reservation 或 dev verifier fallback。

**Anonymous credential blind issuance**：唯一入口为 RFC 9474 `POST /api/binary/anonymous-credential/blind-issue`；公开 SPKI/profile 由 `/blind-issuer` 提供，不注册其他 issuance 路由。浏览器在本地生成 randomized prepared message、PSS salt 与 invertible blind factor，issuer 只看到 384B blinded representative。最终 RSA-PSS signature、credential secret、opening、commitment、revocation handle、nullifier 和 presentation transcript 都不回传，因此 issuer 不能用签发 transcript 测试最终 credential equality。服务端必须用 3072-bit RSA、`e=65537`、SHA-384、48B salt profile，并在每次 private operation 后做 public fault check；浏览器 Finalize 后再次校验 SPKI SHA-256/key size/exponent 并 WebCrypto verify。malformed、tamper、key rotation 和 metadata drift 全部 fail closed。

浏览器侧 Blind-RSA 公共类型只由 `commentPrivacyContracts.ts` 拥有；该模块没有 API、store、Vue 或密码实现依赖。provider 是唯一 suite 选择和生命周期 owner，依赖 contracts 与具体 Blind-RSA suite；suite 只依赖 contracts，禁止反向导入 provider。请求字段、opening/proof 字节、取消与任何 suite 异常继续映射为现有 fail-closed `null`，不得增加备用 suite、文本 fallback 或兼容 provider。静态 contract snapshot 固定导出集合和这组有向依赖；若前端实现可疑，仍通过热关闭 ZK anonymous comments 降级，不需要重启，也不影响 public、登录、admin、notification stream 或非匿名凭据 binary 路径。

blind endpoint 只接受 `identity_kind=anonymous_account`；AdminPrincipal、普通登录主体、缺失 identity kind、删除/禁用/封禁账号、配额冲突、runtime disable 与 signer failure 使用相同错误和延迟桶。该路径不得调用旧 `RecordAnonymousCredentialIssueDeniedAsync` 或 `IAuditEventService`，因为其中的 actor、trace、path 和 identity kind 会建立独立关联域。配额表只保存 `HMAC-SHA256(SubjectHashPepper, epoch || accountId)`、epoch、`issued` 和 UTC 小时桶；该 subject 不进入 credential message/root/ticket，旧 trace 值由 schema migration 清空，新实体无 trace 映射。禁止保存 raw account id、request hash/body、blind signature、最终 signature、credential commitment/nullifier/witness/secret 或 response。retention 仍为 90 天。

`AnonymousCredentialIssuer:BlindRsa:PrivateKeyPath` 是本机 PKCS#8 DER secret boundary，不能使用 PEM string、托管签名 SaaS、HSM 网络代理或任意外部 issuer。路径不得位于 `wwwroot`、`uploads`、`backups`，Unix mode 不宽于 `0600`；读取 DER、导出的 RSA private parameters 和 private-operation temporary buffers 必须在 `finally` 清零。`BlindRsa:Enabled` 由 reload-aware gate 读取：热改为 `false` 会同时关闭 metadata 与 private operation，无需重启；由于 signer 仅在启动时装载 secret，热开启不受支持。默认配置保持 disabled。

签发拒绝的延迟目标是 `max(MinimumResponseMilliseconds, TimeoutMs+100)`；耗时超过首桶时向上量化到下一完整桶，避免 eligibility、ban、quota 与正常签名的快速路径形成直接 oracle。该措施不能消除宿主机负载、网络和上游认证 middleware 的全部统计侧信道，剩余风险由固定 IP 限流、容量监控和 threat model 记录。运行时回退只需热设 `BlindRsa:Enabled=false`；旧 route 不得重新启用，已签 credential 不被服务器撤回或重新关联。

**Anonymous credential root metadata**：`GET /api/binary/anonymous-credential/root` 与 `/circuit` 是公开 metadata 端点，只返回 root/circuit/verifying-key/issuer-public-key/public-input-layout/ZK 配置位，不签发凭证、不验证 proof、不读取 user session、Cookie、Authorization 或当前账号。`anonymous_credential_root` 表不得包含 user/account/session 映射字段；root miss、revocation root 缺失、issuer public key hash 缺失、过期或 verifier/root 未配置时返回 AEDS `anonymous_root_unavailable`，避免以 JSON 或登录态错误泄漏内部状态。撤销 accumulator 只保存不可逆 `revocation_handle_hash` 与公开 root，不写真实 userId、credential secret、witness 或签发审计关联材料；撤销审计不得记录原始 handle。

账号绑定匿名凭证撤销先更新 `anonymous_credential` 状态；若 credential metadata 明确携带 `credentialEpoch` / `rootHash` / `revocationRootHash` / `revocationHandleHash` 这组公开撤销材料，则同一事务向 `anonymous_credential_revocation` 插入不可逆 handle，使用 `(epoch, revocation_handle_hash)` 冲突幂等。metadata 缺失时不得猜测 revocation handle；调用方必须走匿名治理撤销入口补齐公开 accumulator 材料。

**Anonymous credential public revocation distribution**：credential-specific witness endpoint 已永久 retired，`POST /api/binary/anonymous-credential/revocation-witness` 对任意 body/query/header 固定返回 `410`。root attestation 的 circuit metadata 绑定公共 epoch/version/content address/full/delta path；artifact 只经 bodyless anonymous GET 分发，使用 immutable cache，不含 account、credential commitment、handle、leaf key 或 stable client id。指定 full/delta artifact 尚不存在返回 `404`，root/provider 暂不可用返回 `503`，不得把任一状态降级为空成功帧。浏览器在 privacy worker 内验证 hash-binding、root、epoch/version、expiry 和精确 delta base，再用仅存于本地的 handle 构建 witness 并 zeroize transferable。tamper、rollback、stale、预算超限或 worker 超时均 fail closed。无需重启的降级是关闭 ZK anonymous runtime gate 并停止新匿名 ticket；已发布 immutable artifact 保持公共只读，禁止临时恢复旧 endpoint。详见 [threat model](security/anonymous-revocation-distribution-threat-model.md) 与 [runbook](security/anonymous-revocation-distribution-runbook.md)。MFA challenge 的失败与锁定审计分别使用固定 action `mfa_challenge_failed` / `mfa_challenge_locked`，两者都必须进入 `AuditRetentionCatalog`，未知 action 继续 fail closed。

**Anonymous comment governance**：生产新评论只允许显式 opt-in 的 `public` 和无身份态 `zk_anonymous`。旧 `anonymous` 服务器可见伪匿名模式已退休；策略、API、POD adapter 与前端都不得提供 fallback，命中旧模式必须在内容过滤、风险、限流、信誉或业务写入前返回 `anonymous_author_mode_retired`。ZK 默认 fail closed：feature flag、native verifier、trusted setup、credential root、root freshness、proof 或 ticket 任一不可用、过期或 invalid 都不得发布，也不得自动切换到 public。ticket/submit 端点拒绝 Cookie、Authorization、identity bridge header 和 identified principal。历史行迁移为 `legacy_server_visible_pseudonymous`，保留数量、父子层级、可见性、审核状态、正文和展示内容，但删除对应 nullifier 聚合并清空 nullifier/scope/moderation subject/credential/reputation 投影；legacy 行只参与历史展示，不参与 active moderation/rate/reputation 身份聚合。无重启降级只允许通过持久化 policy 关闭 `zk_anonymous`；public 仍须显式选择，绝不恢复旧 anonymous。

---

### 首枚 Passkey enrollment

anonymous bootstrap 只签发 15–30 分钟、HttpOnly/Strict、path 限定的 enrollment cookie；服务端只保存 SHA-256 token hash，且该 authority 只映射首枚 Passkey begin/complete、status、cancel。`sys_user.registration_state` 与 ban/delete `Status` 分开，provisional 主体不能获得 JWT、Refresh Token、普通 `UserSession`，也不能进入评论、消息、资料、notification stream 或 binary 业务能力。

complete 先用数据库状态、request hash 和 lease 排除并发，再在同一事务锁定 enrollment 与 provisional user，插入首枚 credential、稳定 handle、active 投影和 formal session；任何失败整体回滚。相同请求的响应丢失只允许恢复同一个已提交 session 的 refresh token，不同 attestation 冲突。过期清理只删除仍为 provisional 的账号；active 永不被该 worker 删除。无需重启的回退是关闭 bootstrap 入口并让已有 enrollment 自然 TTL 清理，保留 additive schema，禁止回退为“先正式登录再绑 Passkey”。

## 多因素认证（MFA / TOTP）

- 标准：RFC 6238 TOTP（Time-based OTP，30 秒窗口）
- 存储边界：`sys_user` 只保留 `MfaEnabled` 投影；TOTP secret、pending secret、verified time 和 TOTP recovery-code hash 均在 `user_mfa_profile`，不得回写 `sys_user.mfa*` legacy 列。
- 启用流程：`/mfa/setup/start` 只写 `user_mfa_profile.mfa_pending_secret_encrypted` / `mfa_pending_created_at`，展示二维码 + 密钥；`/mfa/setup/verify` 验证 pending secret 成功后才切换到 `mfa_secret_encrypted` 并启用 MFA
- 匿名身份模式：TOTP 只作为敏感操作 step-up，`/mfa/setup/start` 的 account label 固定为 `FsusBlog:account:{accountId}`，不得暴露 legacy username；`/mfa/setup/start`、`/mfa/disable` 与 `/mfa/recovery/regenerate` 必须用 `X-Fsus-Mfa-Proof` 提交 action=`mfa_setup|mfa_setup_rebind|mfa_disable|mfa_recovery_regenerate` 的一次性 proof，不读取旧 password body
- 重新绑定流程：已启用 MFA 的 legacy 非匿名用户调用 `/mfa/setup/start` 必须提交当前密码和当前 TOTP/恢复码；匿名身份模式下必须提交对应 action 的 step-up proof。`user_mfa_profile.mfa_secret_encrypted` 与 `sys_user.MfaEnabled` 投影在新 secret 验证前保持不变
- 登录流程：密码验证通过后，如用户已启用 MFA，颁发临时挑战令牌，等待 TOTP 码验证
- MFA challenge：`/api/binary/auth/mfa/challenge` 受 `fixed_ip` 限流保护，并对 ticket、账号 stable subject、IP 三个维度记录失败次数；三计数在 Redis 内一次性原子递增并返回同一快照，达到阈值后消费 challenge，所有失败返回通用错误
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

  ```yaml
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

- 普通账号 Session 的登录来源、认证强度、初始认证时间、可选 Passkey 内部来源、step-up 审计时间与持续时间策略统一由 [普通账号 Session 认证上下文](security/user-session-authentication-context.md) 定义。`MfaVerified` / JWT `mfa` 仅是兼容和粗粒度信号，不能代替绑定 account、当前 Session 与 action 的短期一次性 proof；refresh 保留初始认证上下文但不延长 step-up。
- `rememberMe=false` 映射为 `browser_session`，access/refresh/session Cookie 都不设置持久 `Expires`；`rememberMe=true` 映射为 `persistent_30d`。Refresh 必须沿用数据库中的 `DurationPolicy`，未知策略清理普通账号 Cookie 并要求重新登录。
- 普通账号会话列表只允许展示粗粒度设备标签、创建/最近活动时间、登录方法、Passkey 友好名称、当前会话标记和持续时间策略；不得返回内部 credential row ID、原始 WebAuthn credential ID、Refresh Token、JWT、proof、raw IP 或精确设备指纹。
- 每次登录创建独立会话记录（设备、IP、时间），存储于 PostgreSQL + Redis；一个普通账号允许多个 active `UserSession`。`Security:UserSessions:MaxActiveSessions` 默认 10、范围 1-50，登录 admission 在账号级事务锁内清理过期项并优先淘汰最久未使用的旧会话，新创建会话不参与本轮淘汰。
- 匿名账号 bootstrap 与 Passkey login complete 复用同一会话创建逻辑（`CompleteLoginAsync`），bootstrap 默认创建非 remember-me 标准会话，Passkey 登录按客户端 rememberMe 请求创建。
- `CompleteLoginAsync` 是 access token、refresh token 与 `UserSession` 记录的最终签发边界；该边界使用 PostgreSQL transaction-scoped advisory lock 串行化 login、revoke-others、账户注销和上限淘汰，并在 insert 前重新确认账户未注销。`sys_user_session` 不再保留“每账号一个 active session”的 partial unique index，而使用 active recency partial index 支持有界淘汰。MFA、Passkey 或匿名 bootstrap 已完成验证后，`User.Status == Banned` 会签发受限会话并写入 session，用于展示账号状态、登出、撤销会话、删除本人账号等安全收尾操作。`Deleted` / `DeletedAt` 仍必须返回注销失败且不得生成 token。
- 登录、匿名 bootstrap、MFA login finalize、Passkey login complete 和 refresh 响应写 Cookie 时，`AuthCookieService.SetTokenCookies` 只接受上游显式传入的 `SessionId`；服务端不会为了写 `SessionId` Cookie 再调用 `JwtSecurityTokenHandler.ReadJwtToken` 解析刚签发的 access token。上游未提供 session id 时只写 access/refresh Cookie，不写 session Cookie，等同于旧解析失败 fallback。
- Refresh rotation 的 Cookie 交付必须保持 `CAS commit -> current hash/session verify -> append ordinary user cookies -> current hash/session verify -> binary success frame`。verify 或 append 失败会在响应尚未开始时追加删除普通账号 Cookie，并返回 AEDS `ApiError`/401；不得清除独立 admin cookies，也不得降级为在响应 body 返回 token。
- JWT bearer 入口只在 `OnMessageReceived` 读取一次 `AuthCookieService`，并把 admin cookie path 决策缓存到 `HttpContext.Items["Fsus.AdminCookiePathDecision"]`。命中 admin access cookie 时，raw token 写入 `HttpContext.Items["Fsus.AdminAccessToken"]`，`OnTokenValidated` 在 `SecurityToken.RawData` 不可用时复用该值，不再次读取 admin cookie；cookie 命名和 host-prefixed cookie 选择保持不变。legacy plain cookie fallback 已移除：生产只读取 `__Host-*` Cookie，开发环境只有显式启用 `AuthCookies:AllowInsecureTransportCookies` 时才读取当前非 host-prefixed cookie 名称。
- 普通账号 JWT 的 `sid` 不是只用于展示的 claim。`OnTokenValidated` 必须调用 `IUserSessionValidationService`，按 Redis L2 版本快照或 PostgreSQL 主键回源确认 session 仍 active；任一 revoke 路径必须在数据库 commit 前同步发布 `xmin` 版本，发布失败回滚事务，commit 失败则清理可能提前发布的 key，旧 access token 在下一次请求即失效。
- 封禁状态的业务真源是 PostgreSQL `sys_user.Status/BanReason`。`SecurityBlacklistUser` Redis key 只作为无过期加速缓存，suffix 固定为 `account:{accountSubjectHash}`，不得使用裸 `UserId` / `AccountId`。缓存值必须是 `v1|rowVersion|status|reason` 版本化状态快照，`rowVersion` 来自 `sys_user.xmin::text`；ban/unban 持久化后强制发布当前 DB 版本，cache-miss 回填只能通过 Redis Lua 在当前 key 缺失或版本相同时写入，版本不匹配必须拒绝旧快照。任何缓存 miss 都必须回查 PostgreSQL，不得接受旧 reason-only 缓存值，也不能把 Redis 过期、驱逐或 flush 解释为用户已解封。若需要在线降级或纠错，只删除受影响的 `account:{accountSubjectHash}` key，让下一次请求按 PostgreSQL 真源回填；不得重建旧 `userId` key 空间。
- `GET /api/binary/auth/sessions`：列出当前活跃会话
- `POST /api/binary/auth/sessions/{id}/revoke`：主动吊销单个会话
- `POST /api/binary/auth/sessions/revoke-others`：仅保留当前会话，吊销全部其他
- 单条撤销、revoke-others、账户级安全撤销与上限淘汰会发布不含 session id 的 `SessionRevoked` 事件。事件按账号广播，各 tab 必须强制回查 `/auth/me`；只有自身 session 已失效的 tab 才清理本地状态，未被撤销的设备保持登录。
- 无需重启的行为回退：通过支持 reload 的配置源把 `Security:UserSessions:MaxActiveSessions` 调为 `1`，下一次登录即恢复单 active session 行为；环境变量 provider 不支持 reload 时仍需滚动发布。该回退不恢复旧 unique index，也不关闭服务端 `sid` 校验。
- 登出（`/logout`）：立即吊销当前 Refresh Token，清除 Cookie

---

## 角色与访问控制（RBAC）

FsusBlog 采用三级角色体系：

| 角色 | 覆盖 | 典型操作 |
| ------ | ------ | ---------- |
| `anonymous` | 所有人 | 阅读公开文章、评论、搜索 |
| `authenticated` | 已登录用户 | 发评论、管理 Passkey/MFA、会话管理、消息 |
| `admin` | 管理员 | 用户管理、MFA 重置、Binary 统计、系统广播 |

权限通过 ASP.NET Core `[Authorize]` / `RequireAuthorization()` 在端点级别声明。

封禁用户写入限制由 `BannedUserMiddleware` 在 endpoint routing 之后执行。该中间件只对普通 `sys_user` 身份读取 `IBlacklistService.GetBanStateAsync(accountId, accountSubjectHash)`，以 Redis 版本化状态快照为快路径、数据库为回源真相；封禁或解封入口必须先持久化 `sys_user.Status/BanReason`，再同步带 `xmin` row-version 的 `account:{accountSubjectHash}` 缓存。封禁账号的普通业务写入默认返回 `423 Locked`，Binary `ApiError.Details` 固定为 `ACCOUNT_BANNED_WRITE_LOCKED`；前端只能把它当作账号写锁，不能在前端单独决定安全边界。允许封禁用户完成的安全收尾操作必须在端点上显式声明 `AllowRestrictedAccountAction(RestrictedAccountAction.*)` metadata，当前仅用于登出、删除本人账号、撤销本人会话、撤销其他本人会话和申诉入口；消息创建、回复、已读等普通业务写入不得声明该 metadata。不得再通过 URL 片段、HTTP path 或 group 名称推导放行策略。

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
- 认证读取只接受当前传输模式下签发的 Cookie：安全传输使用 `__Host-AccessToken`、`__Host-RefreshToken`、`__Host-SessionId`、`__Host-AdminAccessToken` 与 `__Host-AdminSessionId`；允许本地非安全传输时只由写入端签发未前缀 Cookie。旧未前缀 Cookie 不再作为读取 fallback，只在 logout/clear 路径删除以帮助浏览器收敛。
- `SameSite=Strict` 阻止跨站请求自动携带 Cookie
- 前端主调用凭据是 HttpOnly Cookie session / AEDS auth frame；credentialed binary mutation 会在存在 `<meta name="fsus-csrf-token">` 或 `XSRF-TOKEN` cookie 时附带 `X-Fsus-Csrf-Token`，服务端仍保留 `UseAntiforgery()` 与 CSRF Origin guard。匿名强隐私请求显式 `credentials=omit`，不得携带该 token 或 Cookie。高风险写操作还会叠加 PoW、admin step-up proof、RBAC 与 no-store metadata，避免只依赖自动携带 Cookie。

## 作者工作台、订阅与 RUM 隐私

插件 Manifest 只声明权限请求，不产生授权。运行时 capability 使用封闭的强类型目录，
默认 grant 集为空；敏感 capability 需要管理员明确确认，且只能授予已在签名后 Manifest
中声明的子集。`database.raw`、裸文件系统/网络、进程、反射、程序集加载、
`IServiceProvider` 与 unrestricted CLR 不属于可授权 capability。每次 Host API 调用都在
代理边界重新检查 grant；Level 1 JavaScript/Lua profile 默认关闭所有 CLR import，并强制
timeout、memory、instruction、call-depth、output、log 与 cancellation budget。连续失败会
进入 Degraded/Quarantined，恢复必须由管理员确认。完整分级、隔离状态、风险和无需重启的
fail-closed 回退见 [Plugin permission and sandbox boundary](security/plugin-sandbox.md)。
Lua 运行时进一步只允许 `string/table/math/utf8`，并在编译前要求 engine adapter 明确支持
CLR/assembly/reflection/raw I/O/process 隔离、六维资源计费与 cancellation；缺少任一能力就
在 Hook 注册前拒绝加载。当前依赖图没有具体 Lua engine，默认 adapter 因而明确
fail closed，不用宿主自制解析器伪装执行。入口加载、Hook 原子发布与无需重启卸载流程见
[Controlled Lua plugin runtime](architecture/lua-plugin-runtime.md)。
Hook 执行只通过 [Plugin Hook Dispatcher](architecture/plugin-hook-dispatcher.md)：签名后
Manifest 中每个 Hook 必须同时声明其封闭 capability，dispatcher 在 runtime 前逐次复核，
登录相关 Hook 额外要求敏感的 `user.auth.hook`，且调用方不得把凭据、Cookie、JWT、
Passkey assertion 或原始请求头放入 Hook DTO。`cluster-once` / `scheduled` / `leased`
必须声明幂等并使用 fencing lease；隔离、清空 grant 和移除本地注册均可在不重启时
阻断后续调用。TypeScript 仅在开发期通过仓库内 private SDK/alias 提供类型；服务端只执行
验证后的 ESM JavaScript。Jint 以 strict、禁用 string compilation、未启用 `AllowClr` 的
Level 1 profile 运行，并直接限制 memory、statements、recursion、timeout、regex 与
cancellation；Host API 输入、输出、日志和调用深度继续由共享 budget guard 计量。engine
只在一次调用中独占，完成或失败后丢弃并补充预热实例，避免捕获的 payload/Host delegate
跨请求残留。完整运行时边界见
[TypeScript plugin SDK and Jint runtime](plugins/typescript-sdk.md)。

站点订阅写入与退订 ownership proof 只使用 `Subscription:EmailHashPepper` 派生的 `hmac-v1` identity。运行时不接受 `sha256-legacy` lookup、OR fallback 或 `LegacySha256EmailHash`；finalize migration 会隔离 legacy rows 并断言遗留计数为零。发生 cutover 问题时暂停 subscription mutation 并在隔离恢复库诊断，不得重新启用可关联的无密钥 SHA-256 identity。

认证 Cookie 的生产读取只接受当前 `__Host-*` 名称。Development 的 `AuthCookies:AllowInsecureTransportCookies` 仅控制本地非 HTTPS transport 下的当前 cookie 名称，不是旧 plain-cookie 名称回退。旧 cookie 应清除并重新认证；不得恢复 `AllowLegacyPlainCookieRead`。

- `/api/binary/author/**` 全部要求 admin principal，并按路由声明 `AdminPermissions.*`：草稿、预览、修订、资产、导入导出和 AI 辅助要求 `article.write`，评论队列/审核要求 `comment.moderate`，匿名治理分别要求 `anonymous.comment.configure` / `anonymous.nullifier.block` / `anonymous.credential.revoke`，审计查询要求 `audit.read`，审核运行时、缓存和完整性运维要求 `system.config`。外部 `/api/author/**` JSON 入口和 internal bridge 兼容层均已移除。
- 服务端草稿按 `ownerAdminPrincipalId + draftKey` 唯一保存，owner 来自 independent admin principal 的 `admin_id`，不复用普通匿名账号 id；浏览器 localStorage 只能保存 draftKey、保存时间、来源文章和 client revision 这类不可恢复正文的 metadata，不得保存标题、摘要、正文 Markdown 或未发布内容。跨设备/刷新恢复必须通过 admin cookie 读取 `/api/binary/author/drafts/{draftKey}`，不得落入公开 AOT、Service Worker shell cache 或搜索索引。
- 修订历史正文详情只允许 admin 在作者工作台读取；回滚必须走正式文章更新服务以写入新修订、审计记录和分发缓存失效，不允许通过 SQL/API 直接覆盖公开正文。
- `/api/binary/upload/**` 分片上传会话只接受可规范化为 32 位 GUID `N` 格式的 `uploadId`。`FileService` 在 status、part map、part upload、complete、abort、cleanup 和 session lock 边界统一规范化为小写 canonical 值；`.upload-sessions` 使用 full path 作为目录沙箱，Unix 平台上 session root / session / parts 目录必须限制为 owner-only，manifest 和 part 文件以 owner read/write 创建。manifest 写入必须使用随机 sibling temp path + private file mode，并通过 replace/move 原子发布，不得使用固定 `manifest.aeds.tmp`。非法 `uploadId` 返回 validation/not found，不创建 session lock，不执行递归删除，也不向响应泄露物理路径。上传总大小上限为 20 MiB，Kestrel request body limit 必须覆盖该上限和协议开销；`/part` 必须携带明确 `Content-Length`，不接受 chunked transfer-encoding。上传图片只允许 jpg/jpeg/png/gif/webp；品牌图标生成允许上传 ICO favicon 成品，并通过 ICO 目录头签名校验；AVIF 和 SVG 在引入像素维度、decoder bomb 防护与 SVG 清洗前不得进入 upload allow-list。
- 未发布正文只允许出现在 admin-only JSON 响应中；预览 HTML 带 `data-preview-only=true` 和 `data-markdown-renderer=server-preview`，所有 Markdown HTML 输入先转义，前端写入 `srcdoc` 前再次剥离可执行标签/事件属性，并仅以 sandboxed unique-origin iframe 展示，不得写入 PublicAOT cache、search index、feed、sitemap 或 related-reading。

## 测试 Fixture Secret 与本地护栏

- 测试代码不得内置可复用的 admin/user 密码、JWT signing key 或生产域名配置；需要登录真实 UI 的验收脚本必须从 `FSUSBLOG_USER_PASSWORD` / `FSUSBLOG_ADMIN_PASSWORD` 读取，fixture token 生成必须显式提供 `FSUSBLOG_TEST_SESSION_SECRET` 或测试环境专用 `Jwt__SecretKey`。
- Playwright / smoke fixture 允许使用 `loginWithFixtureSessionBypass` 直接生成本地测试 session，但该名称必须保持显式，不得重新包装成密码登录语义。生成的 storage-state 凭据属于短期本地工件，运行后应清理，不得提交或长期保留。浏览器原生 WebSocket 无法携带 Playwright 注入的 `X-Fsus-Test-Session`；仅在 Development/Test 已启用隔离时，notification preflight 可把通过同一格式校验的 session id 桥接为 `/api/notifications/stream` path-bound、HttpOnly、SameSite=Strict session cookie，正式 upgrade 在 authentication 前恢复 header。生产不注册该 middleware，桥接 cookie 不是身份凭据，且不得在 notification stream 之外读取。
- 会执行 SQL 的 fixture 脚本只允许连接名称匹配 `fsusblog-dev*`、`fsusblog-test*` 或 `fsusblog-ci*` 的容器；对 admin draft 的 raw cookie replay cleanup 只能指向 localhost / 127.0.0.1 / ::1 后端。

## 部署与 CI 供应链护栏

- 生产 OpenResty 模板必须显式限定 `TLSv1.2 TLSv1.3`、固定现代 AEAD cipher/curve、关闭 session tickets，并使用 `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`。网关必须提供 CSP、COOP、COEP、CORP 与 `X-Permitted-Cross-Domain-Policies: none` 作为应用层 sanitizer 之外的防线。
- OpenResty 应用 upstream 必须来自受控生成的单行 `127.0.0.1:8081` / `:8082` include；不得接受 operator hostname、任意端口、多 server 或请求输入拼接。切流/回滚共用宿主机排他锁，并在原子 rename 前后校验完整配置；只有 loopback 与公网 `X-Fsus-Release-Id` / `X-Fsus-Release-Slot` 同时匹配 immutable release state 才能提交 generation。这两个响应头是非敏感部署身份，不授予权限也不替代 Cookie/Passkey/PoW。切流 evidence 只保存 slot/release/digest、检查布尔值、时间、失败阶段和恢复动作，递归拒绝 password/token/private key/secret/credential 字段及完整生产配置。
- `appsettings.Production.json` 必须显式声明生产 `AllowedHosts`，不得依赖基础配置里的 wildcard；Docker build context 必须忽略 `.env` / `.env.*`，仅允许示例模板进入上下文。
- GitHub Actions 的 `uses:` 必须 pin 到 40 位 commit SHA，并在注释里保留原版本 tag。Dockerfile 只接受 detached checkout 到固定 `VCPKG_COMMIT`，外部 wasm release artifact 必须带 `SHA256SUMS` 并在 frontend build stage 校验。
- related-reading 只基于公开文章的分类、标签、正文关键词和发布时间生成，不使用点赞、收藏、关注、登录用户、订阅邮箱或用户画像；端点和 PublicAOT 共用同一服务，防止 SPA/AOT 暴露面分叉。
- SEO 预览只读取当前表单和站点 SEO 配置；canonical/slug/OG image 预览不得对外生成路由或缓存。发布/定时发布前检查返回的 `error` 必须阻断提交，覆盖危险 HTML、未闭合代码块、不安全协议、私有站内路径和无效 public route 格式；`warning` 只能在作者填写跳过理由后继续提交，并由服务端记录 `prepublish-warning-override` 审计事件，不能自动降级为公开可见内容。
- 统一 SEO/品牌配置的 favicon、PWA icon、logo、wordmark、admin/login 图标 URL 只能保存空值、站内绝对路径或 `http/https` 绝对 URL；后端拒绝 `javascript:`、`data:`、协议相对 URL 和空字节。外部图片展示只扩展 `img-src`，不得扩展 script/style/connect CSP。当前品牌资产字段只引用已存在上传/静态资源；默认 favicon/PWA/社交图来自随仓库提交的 `/favicon/*` 与 `/social/*`，不保留根目录旧 favicon / Apple Touch Icon / `/icons/*` 品牌入口，且不得在运行时代码或配置中引用本机 Downloads 源目录。设置页上传入口只接受 PNG/JPG/WebP 栅格图和 favicon ICO 成品，图标组生成只从 PNG/JPG/WebP 派生 ICO/PNG，不生成 SVG。SVG 只允许手填已清洗的安全 URL；如果后续支持 SVG 原文上传或服务端转存，必须先做 MIME/header 校验与 SVG 脚本、事件属性、外链清洗和审计，并继续走 admin + PoW + 审计链路。
- 资产库只在 admin-only 作者工作台可见；重建索引只采集 `/uploads/illustration/*` 正文图片与封面 URL，孤儿清理只删除 `referenceCount=0` 的资产库索引行，不删除上传文件本体，也不得暴露为匿名目录浏览能力。运维保留期脚本默认也不删除上传资产；若显式启用上传资产扫描，必须提供 `FSUSBLOG_RETENTION_REFERENCED_ASSETS`，脚本会保护仍被文章引用的 `/uploads/illustration/*` 文件并在 `assetGuard.protectedReferencedAssets` 中记录证据。
- PWA 离线缓存仅限公开 shell 路由和搜索索引；`/user`、`/admin`、`/login` 与私有 API 不得被 service worker 离线命中。离线公开文章 smoke 通过 `check:pwa-offline-smoke` 验证 `X-Fsus-Offline-Stale: 1`，并验证私有 console 路由在离线时失败。
- 作者分析 dashboard 只读取 admin-only `/api/binary/author/analytics`。后端聚合 `VisitLog.routeKey`、`dwellMs`、`viewerKeyHash`、`proofId` 和 PublicAOT miss 审计；公开搜索词与 404 路径会被截断并聚合展示，不采集正文输入、账号、email、token、cookie 或可识别行为链。管理端最近评论统计只读取 comment author snapshot 字段，不通过 `sys_user` 反查账号作者。
- 评论创建默认先写入 `Approved`，公开评论 API 只返回 `Approved` 且未被 viewer region 屏蔽的项。创建入口必须先做 endpoint payload 上限、字符数、UTF-8 字节数和评论 Markdown 安全策略校验；图片 Markdown、raw HTML 和危险链接 scheme 在入库前拒绝，内容过滤词典命中只写 comment 专用风险信号，不直接阻断发布。回复只能挂到同文章、未删除且已通过的父评论/根评论。submit/viewer region 从连接 IP 或可信代理地区头解析；可信代理地区头只在 loopback 或 `ReverseProxy:KnownProxies` / `ReverseProxy:KnownNetworks` 命中时生效，直连请求不能靠伪造 `X-Fsus-Region`、`CF-IPCountry` 或 `X-Geo-Country` 改变地区。IP 只以独立 `Moderation:RegionPolicy:IpHashKey` HMAC hash 写入 `comment_region_compliance`，缺失或少于 32 字符必须 fail closed，不得回退到硬编码字面量或 JWT；匿名评论 moderation subject 只由 `HMAC-SHA256(Moderation:Pepper, nullifierHash)` 派生，不拼接 scope，不使用裸 SHA-256，缺失 pepper 时 fail closed；CN-MAINLAND 严格策略只作用于 CN-MAINLAND submit/viewer，不自动外溢到 CN-HK/CN-MO/CN-TW。submit region 未知时记录人工复核/地区原因但不因地区未知默认隐藏；viewer region 未知时对非空 `blocked_regions` 保守隐藏。评论写入还会在 handler 前预读 AEDS payload 区分 root create 与 reply，仅写 RiskControl action metadata，不读取或改写匿名身份投影；内容过滤、地区合规和 nullifier 重复/封禁会写入 comment 专用风险信号。
- 匿名凭证签发只接受配置完整且 runtime gate 开启的 RFC 9474 blind RSA issuer；服务端只对 blinded representative 做 private operation 和 public fault check，最终 signature 仅由浏览器复验。`anonymous_credential_issuance_audit` 只执行 `(epoch-scoped subject_hash, epoch)` 唯一约束，不记录跨 epoch 稳定 subject、trace 或路径。评论 nullifier 只能来自经 verifier 校验的 ZK public input；服务端不得再从 author mode、article scope、账号凭证或 pepper 派生工程匿名 nullifier。scope-use 检查在 reservation 阶段原子增加 `use_count`，评论写入失败日志只记录 scope hash，不输出 raw scope。
- 多地区审核词库是 FsusBlog 自有硬规则层，位于模型 provider 之前。`config/moderation/**` 只输出 `category/severity/reason/evidence`，并支持 `evidence_policy=redact`；`submit_action`、`display_action`、`blocked_regions` 只能由 `RegionLegalModerationService` 结合地区策略计算。CN-MAINLAND 必须加载 `political-sensitive`、`porn-strict`、`public-order`、`national-security`，但严格动作只作用于 CN-MAINLAND submit/viewer。词库加载、reload 失败、checksum 变化和 replay preview 写入结构化审计，context 只含版本/checksum/数量等 metadata，不记录词条明文。
- 可选反垃圾模型只在 `Moderation:AntiSpamModel:Enabled=true` 时调用，默认关闭。生产路径只使用内置 `FsusAntiSpamModel` portable runtime loader：它读取 `manifest.json`、`runtime_config.json`、`model_state.json`、`weights.int8.json`、`threshold_policy.json`、`test_vectors.jsonl` 和按需 `manifest.sig`，校验 runtime format、artifact digest、signature/trusted key、threshold policy 与测试向量后构建 immutable scorer snapshot。第三方模型只能作为同格式、已签名、受信任的数据包载入，不能通过插件、外部服务或任意可执行逻辑进入生产链路；`legacy/python` 和 audit-only 来源只能用于迁移审计，生产加载必须拒绝。模型请求只包含内容、地区、策略和匿名安全 actor metadata；匿名评论不得向模型暴露真实 account id、username、public handle 或 credential commitment。模型结果在持久化前会拒绝 `allow/reject_submit/geo_block/blocked_regions/submit_action/display_action` 等最终动作字段；模型不可用、契约错误或测试向量失败只写 fail-open 信号并保持评论在正常审核链路中。模型 `status=ok` 且命中风险时由 FsusBlog disposition policy 自动隐藏评论，有账号归属时发送“评论审核提醒”站内信；该提醒不构成封禁、限流、信誉扣分或匿名凭证处理。风险命中且置信度低于 `Moderation:AntiSpamModel:BorderlineRiskConfidenceThreshold`（默认 `0.90`）时，隐藏后进入人工审核队列。
- 审核队列、单条审核、批量审核和封禁联动全部位于 admin-only `/api/binary/author/comments/**`，并显式要求 `comment.moderate` 细粒度权限。审核读取和写入受 `fixed_ip` 限流；单条/批量审核还必须提交当前 admin 会话一次性 `X-Fsus-Mfa-Proof`，proof action 固定为 `admin-sensitive`，缺失或消费失败返回 step-up required。审核动作写入 `comment-moderation` / `comment-moderation-bulk` 审计；审核队列、审核通过实时推送和回复站内通知只能使用 comment / parent comment 行内作者快照生成展示名，不得通过 `user_id`、`reply_to_user_id` 或 `sys_user` 回退账号 username / public handle。拒绝/隐藏时的封禁联动只作用于非 admin、非注销用户，并同步黑名单缓存。匿名评论策略更新、治理后台读取、nullifier 封禁和匿名凭证撤销分别要求 `anonymous.comment.configure`、`anonymous.nullifier.block`、`anonymous.credential.revoke` 权限，均要求 admin passkey step-up 并通过 `IAuditEventService.RecordHighValueAsync` 写脱敏高价值审计；这些匿名治理权限不授予普通评论审核，`comment.moderate` 也不授予匿名治理。
- 第三方审核模型只允许提供同格式 portable runtime 数据包，不得决定 `reject_submit`、`geo_block`、`blocked_regions`、发布或地区合法性，也不得返回最终审核动作字段。评论隐藏由 FsusBlog 内部 disposition policy 根据模型风险信号执行；FsusBlog 仍负责硬词库、地区策略、viewer 过滤、策略 replay diff、模型风险隐藏和管理员最终动作。第三方数据包格式与签名要求见 [moderation/third-party-model-development.md](moderation/third-party-model-development.md)。
- 作者 AI 辅助默认 `Authoring:AiAssist:Enabled=false`；默认路径只做本地摘要/标签/结构建议，不把未发布正文发往外部 provider。外部 provider 只有在 `Authoring:AiAssist:Enabled=true`、`Authoring:AiAssist:Provider` 非 `local`、`Authoring:AiAssist:AllowExternalProvider=true` 且 `Authoring:AiAssist:ExternalProviderReviewed=true` 同时满足时才标记为 allowed；当前服务不直接持有 `HttpClient` 外发正文，每次调用都会写入 `author-ai-assist` 审计事件。
- `site_subscription` 只保存由 `Subscription:EmailHashPepper` 派生的 `HMAC-SHA256(normalizedEmail)` keyed lookup identifier、`hash_version`、channel、启用状态和退订时间，不保存明文 email，不构建读者画像或社交关系链。该 identifier 仅在当前部署内用于去重/查找，不是明文 email 或跨系统稳定身份；旧裸 SHA-256 值只允许作为迁移期一次性匹配来源，下一次订阅写入会升级为当前 HMAC。公开退订必须提交 `X-Fsus-Subscription-Proof`，proof 与 keyed email hash/channel 绑定并受 TTL 约束；端点先做非消费校验，只有 `site_subscription` 退订更新成功后才提交一次性消费，DB 超时、请求取消或事务失败时原 proof 仍可重试。缺失、重放、过期或绑定不匹配返回 428，不能仅凭 email 更新订阅状态。默认实现不接入 SMTP、第三方邮件或 Web Push provider；生产 proof 投递若由仓库外邮件域完成，必须只接收本服务签发的 opaque proof token、使用 TLS 传输、保留 proof nonce/traceId 级审计且不得回传明文 email 给本服务。RSS/Atom/JSON Feed 是主订阅通道，`channel=email` 仅记录显式订阅偏好，后续外发能力必须先补配置开关、退订 smoke 和安全评审。
- PWA Service Worker 只缓存公开 shell 路由；`/user`、`/admin`、`/login` 和 `/api/binary/**` 不进入 shell cache。离线公开页必须带 `X-Fsus-Offline-Stale`。
- RUM 仅采集公开页 `pageType`、`aotSource`、LCP、CLS、hydration time、Wasm decode/render timing、navigation timing 等匿名性能指标；私有页面不发送 Core Web Vitals，payload 不包含账号、email、token、cookie、正文输入。生产前端只调用 `POST /api/binary/telemetry/rum`，使用 `credentials: omit`、batched AEDS `RumMetricBatchRequest` frame、8192 bytes 帧上限和 `fixed_ip` 限流；服务端只允许固定 metric 名称、`value/domInteractive/responseStart/durationMs` 数值字段与低基数 dimension 白名单，未知字段会被丢弃或计入 rejectedCount。旧 `/api/telemetry/rum` JSON endpoint 已移除；净化后写入独立 `frontend_rum_metric` 表，不再混入安全审计表。
- 安全后台 dashboard、RiskControl 模拟器、AntiCrawler、PoW、风险分重置、规则与 allow/blocklist 管理只允许 admin 通过 `/api/binary/admin/security/**` 访问；策略更新、CIDR 手动同步、风险重置、规则/list 写入和 PoW 策略更新继续要求一次性 `X-Fsus-Mfa-Proof`，并写入 high-value security audit。RiskControl 模拟器不要求 `X-Fsus-Mfa-Proof`，但必须写入 security audit 且不能修改 challenge、策略或风险状态。外部 `/api/admin/security/**` JSON endpoint 已移除。
- `/api/binary/security/challenge/verify` 在 binary frame decode 和 challengeId/action/routeKey/kind 基础校验后，必须先执行 provider payload JSON 的 byte/char 上限检查，再执行 `SecurityChallengeVerifyRateLimiter`；只有限流通过后才流式解析 provider payload 并调用 provider verify。被限流请求即使携带 malformed payload 也返回泛化 `challenge_failed`，不泄露 parser 细节，也不提前消耗 dictionary allocation。payload 超过 cheap 上限仍按 validation fail closed；provider 语义和 wire contract 不变。
- `/api/binary/security/challenge/cancel` 只接受 AEDS `SecurityChallengeCancelRequest`，按服务端重新派生的 subject/client IP/device hash 加 action/route/policyVersion CAS revoke 整个 envelope，并把全部 member 记为 revoked。V3 在撤销外层 envelope 前还必须解析当前 server-issued device authority、用旧 answer-key version 派生 device HMAC，并对 authoritative challenge row 执行完整 binding 的原子 revoke；跨设备、伪造 cookie 或同一 NAT 下另一有效 device lease 不能借存储态 device 值撤销。missing、重复或 binding mismatch 均返回相同 `EmptySuccess`，不提供 envelope 枚举 oracle；V3 Redis/crypto/device-authority 故障只公开 `unavailable`，内部 audit 区分 revoked、terminal、binding mismatch 与具体基础设施原因。已完成但尚未消费的 aggregate proof，以及已经原子交换但尚未由 WebSocket 消费的 notification grant，都会在 envelope revoked 后立即 fail closed。客户端 refresh/cancel/身份或路由变化/卸载先 tombstone generation，再发 keepalive cancel，迟到 transport 结果不得恢复本地 proof。
- PublicHotRead 使用位于通用 endpoint pipeline 之前的专用安全数据面，但不缩减安全控制。`PublicHotReadCrossCuttingControlCatalog` 是横切控制覆盖真源：release/security headers、deployment tracking、Shield/exception/binary 和 correlation 是 `global-before-branch`；`public_read` limiter 与轻量 request audit context 是 `early-replayed`，并用 execution state 防止 miss fallback 重复取得 lease/重复建立上下文；CORS、antiforgery/CSRF、anonymous gateway header guard、authentication、banned-user、authorization 只有在 executable classifier 已证明精确 allowlist、匿名无凭据、无 `Origin`、`GET`/`HEAD` 时才能登记为 `endpoint-only/not-applicable`。classifier 仍以完整 segment 拒绝 auth/admin/author/manage/internal/billing/audit，并让登录 principal、credential/CSRF header、Origin、非安全方法、notification stream 和 dynamic/private binary 回常规安全链。启动必须在任何 stage 注册前校验 required controls 恰好覆盖、两端 stage/guard、route policy、synthetic metadata 和实际 probe；`tools/check-public-hot-read-cross-cutting-controls.mjs --self-test` 在 CI 同时检查两端，新增控制缺一侧即失败。early request audit 只推入已有 request/Serilog context，不做持久写入或 actor lookup。L0 hit 仍在 release/security headers、Shield、trace correlation、public-read limiter/gate 之后；miss 保留已通过结果并只执行一次 audit/limiter。
- artifact projector 以同一个 cutoff 在查询与最终 frame 物化两次执行公开可见性判断，并把 `published-visible-at-cutoff-v1`、`sourceVisibility=public`、candidate source version、cutoff、published-only/deleted/future exclusion 写入 publication evidence；store 只原子发布 evidence 与 candidate version 完全一致的 snapshot。仓库没有独立 `Private` 文章状态，因此 private/non-public 验收由“只有 `Published` 可进入”证明：`Draft`、`Scheduled`、`Archived`、`Deleted`、`IsDeleted=true`、未来 `PublishedAt` 与未来 `ScheduledPublishAt`/embargoed 均在真实 frame materializer 编码前排除。focused 测试还必须比较 fast 与 production canonical endpoint 的原始响应 bytes。出现 bypass alert、目录不确定或 evidence invalid 时，热更新 `PublicHotRead:Enabled=false` 即刻停止 classifier；匿名、登录、admin、notification stream 与 binary 全部恢复原 routing/CORS/authentication/authorization/audit 链，revocation、PoW、risk、rate limit、安全头和 notification stream 保持启用。重新开启前运行 catalog checker、byte parity、身份/route 边界和全状态 visibility 负例。
  具体控制矩阵、修改流程和回退步骤见 [PublicHotRead 横切控制与回退手册](security/public-hot-read-cross-cutting-controls.md)。
- Public HTML CSP nonce 由 CSPRNG 每请求生成，发布阶段编译器为每个 `script`、`style` 和 `csp-nonce` meta 预定位 slot；预渲染 nonce、重复 nonce、重复 head、未闭合 script/style、原始 placeholder 和不受支持的属性形态一律拒绝 publication。请求内同一 nonce 同时进入 CSP header 与所有 slot，不能跨请求复用。nonce 页面强制 `private,no-store`、移除 strong ETag/304 与静态压缩 variant，避免缓存带 nonce 的实体或把模板 validator 错当实体 validator。构建期同时从完全静态 inline script/style 生成与 artifact identity/digest 绑定的 SHA-256 source 清单，仅作为可行性证据；在 browser CSP smoke 与安全评审完成前不切换到 hash-only，也不允许 `unsafe-inline`。紧急回退先热更新 `PublicHotRead:Enabled=false` 让 L0 回到常规 Public AOT/SPA 链，再失效对应 AOT document 并重建；不得固定 nonce 或关闭 CSP。
- Production HTML、Public AOT 与 OpenResty 静态响应必须在现有 nonce CSP 上额外启用 `require-trusted-types-for 'script'; trusted-types vue fsusblog fsusblog-spa-entry`。`vue` 是当前 Vue runtime 使用的固定 policy name；仓库前端只创建 module-private `fsusblog` policy，并只向已清洗 HTML、非可执行 data script text、固定同源 `/wasm/comment-privacy-prover.js`、固定同源 `/sw.js`（仅允许可选 immutable build id），以及同源、无 query/hash、构建 hash 命名的 Markdown/commentPrivacy/perception-v2/pospace/pow/wasmDecode Worker 暴露窄封装。Public AOT 的 nonce bootstrap 另在闭包内创建 `fsusblog-spa-entry`，其 `createScriptURL` 只接受服务端已解析的单一 SPA entry，并且 policy object 不对外暴露。构建关闭 Vite runtime modulepreload helper，由 Public AOT bootstrap 独占服务端审计后的 SPA entry 与 modulepreload 注入，避免浏览器端 raw string 进入 `TrustedScriptURL` sink；稳定 `fsus-spa-entry.js` 只 import hashed entry，保持单一 ESM identity，禁止复制入口或启用 `allow-duplicates`。导航进度条使用固定 DOM 节点与外部 CSS，不加载会写 `innerHTML`/inline style 的 NProgress runtime。禁止 `default`、`*`、`'allow-duplicates'`、第三方 script、任意外部/blob URL、任意 worker/prover query，以及 service worker 上除单一 immutable `build` 外的 query 或公开 policy object。普通 Development/Vite HMR 不启用 Trusted Types enforcement，但仍保持 nonce 与原有 CSP；本地 release acceptance 在保留 Development-only fixture endpoints 的同时显式设置 `Testing:EnforceProductionCsp=true`，使普通 HTML 与 PublicHotRead 共用 production CSP。非 Development 环境始终使用 production policy，该测试开关不能降低生产 CSP。production 必须用后端普通 HTML、PublicHotRead AOT、OpenResty 三条可执行断言防止 header 漂移。若评论 prover boundary 异常，先通过 reloadable policy 热关 ZK anonymous comments；Trusted Types 不能按功能热关闭，兼容性回滚必须把前端与 CSP 作为同一发布单元回滚，不能放宽 policy allowlist。凭证隔离、残余风险与 release evidence 见 [Comment privacy credential vault](security/comment-privacy-credential-vault.md)。
- AntiCrawler / public-read / challenge 相关正向风险分累加必须使用 Redis Lua 原子 `IncrementClampedWithExpiryAsync`，在同一 Redis 往返中完成当前分读取、增量、`MaxRiskScore` clamp 和 TTL 设置，避免并发 AddRisk 丢增量。`scoreDelta == 0` 的观察模式或禁用评分路径只记录事件，不读取或写入 Redis 分数；正分写入会清除 zero-risk cache，reset 仍显式删除 `SecurityPowRisk` key。若需要降级或纠错，只删除受影响 IP 的 risk key / zero-risk entry，让下一次安全请求重建状态，不得恢复应用层读-改-写。
- 结构化审计写入 `sys_audit_log`：保留 `source/type/action/outcome/severity/actor/target`、trace/path/method、原因码和低基数 context；IP、User-Agent、session id、设备指纹只保存 SHA-256 hash。Serilog 到审计表的 mapper 只接受显式 `AuditActorType` + `AuditActorId` 作为 actor，不得从裸 `UserId`、`AccountId`、`InternalUserId` 或 `AdminPrincipalId` 自动推断审计主体；这些身份平面字段也不得进入普通 context payload。高价值 admin/security/audit 事件通过 `IAuditEventService` 同步写库，失败时写入 `FSUSBLOG_DATA_ROOT/audit-fallback/critical-audit-*.jsonl`，避免关键审计静默丢失。每条审计生成 `record_hash`，配置 `Audit:TamperEvidenceKey` 或 `Security:AuditTamperEvidenceKey` 时额外生成 `record_mac`；同一 `chain_id` 内写入时必须把当前行 `prev_hash` 链接到前一行 `record_hash`，批内和跨批都不能断链。`/user/manage/audit` 可查询详情并校验单条 hash/mac 以及同链前驱 hash，前驱缺失或重排会使校验失败。审计查询默认 `pii-redacted`，普通 `audit.read` admin 只能看到 `pii-redacted` 占位；只有同时具备 `audit.investigate` 并显式请求 `piiMode=investigation` 时，列表/详情才返回完整 `IpHash`、`UserAgentHash`、`SessionIdHash`、`DeviceFingerprintHash`，且该读取必须写高价值审计并标记 `sensitiveFieldsRead=true`。
- OpenTelemetry 自定义属性只允许 `fsus.*` 枚举字段，覆盖 route kind、状态码、组件、缓存 policy、AOT source、搜索模式、后台任务计数等低基数维度；不得写入原始路径参数、请求/响应正文、Authorization、Cookie、token、email、用户名、IP 或 User-Agent。`X-Fsus-Trace-Id` 仅用于用户报告和日志/trace 关联，不表示认证身份。

## 审计级别

普通审计记录用于低风险读取、预览和运营查询，允许异步写入并保留低基数 context。高价值审计用于 admin/security/audit、审计 investigation hash 读取、admin passkey step-up、PoW 策略、审核策略、评论公开可见性、不可逆修复、缓存/索引重建和会影响公开分发的写操作；这类事件必须通过 `IAuditEventService.RecordHighValueAsync` 同步落库，失败时写入 `FSUSBLOG_DATA_ROOT/audit-fallback/critical-audit-*.jsonl`，并保留 `source/type/action/outcome/severity/is_high_value/actor/target/trace/path/method/reason_code` 与 hash 化 IP、User-Agent、session id、device fingerprint。admin principal plane 的登录、step-up 和 session revoke 兼容审计仍写 `admin_audit_log`，但必须通过 `IAdminAuditLogChannel` 有界队列和后台批量 flush；队列满或批量写失败时同步 fallback direct write，记录 queued/dropped/batch/fallback 指标，且不得降低现有 admin audit 查询可见性。

审计 context 不得包含 Authorization、Cookie、token、email、用户名、请求/响应正文、原始 IP、原始 User-Agent、裸 `UserId`、`InternalUserId`、`AccountId` 或 `AdminPrincipalId`。配置 `Audit:TamperEvidenceKey` 或 `Security:AuditTamperEvidenceKey` 后，高价值与普通结构化审计都必须维持 `record_hash` / `record_mac` / `prev_hash` 链式证据；`/user/manage/audit` 查询和 verify 端点只展示结构化摘要与防篡改校验结果。

`Audit:DetachedCheckpoint` 是与 Audit HMAC/JWT/PoW/Data Protection/Site Integrity 分离的 ECDSA P-256 trust domain。生产启动只接受唯一 current key、绝对 `.der` SPKI/PKCS#8 路径、0600 私钥、相对 `FSUSBLOG_DATA_ROOT` 的输出目录，以及 30 秒到 24 小时的有界周期和 1..10000 的批量大小；current private key 与历史 public-only registry 必须分离。后台 worker 在追加前验证现有签名链和数据库 Merkle/range/head，追加后以新 expected head 再验证；失败不得覆盖旧 package、生成无签名 checkpoint 或报告成功。热更新 `Audit:DetachedCheckpoint:Enabled=false` 可在不重启的情况下停止新 checkpoint，现有审计写入与只读证据保持不变。该本地 transport 不是 WORM；同主机 root 仍可删除目录，真正的删除抵抗需要独立 custody，但本地-only 范围不调用 TSA、S3 Object Lock 或公共链。

`AuditRetentionCatalog` 为每个可持久化 audit action 声明有限的 full/pseudonym/aggregate age、anchor、legal-hold 和 cryptographic-erasure key domain；未知 action 在写入和 CI 都 fail closed。敏感 payload 使用 retention-epoch AES-256-GCM envelope，DEK 独立保存在 owner-only `audit-retention/epoch-keys`，不会进入站点 backup package。到期批次必须先生成无身份 Merkle/checkpoint anchor，再销毁 DEK、写只含 domain/epoch hash、count/root/checkpoint digest 的签名 destruction evidence，最后 fenced 删除 ciphertext；high-value/Critical 不得绕过该顺序。legal hold 默认关闭，只允许 catalog 明示 action，且必须 purpose、approval、最长 30 天期限，过期自动恢复清理；匿名凭证签发禁止 hold。investigation 查询仍要求 `audit.investigate`、purpose、可信 origin、已消费 admin step-up，最多 200 行且无 raw bulk export。安全回退只能暂停 cleanup worker并保留 encrypted writes；不得恢复 raw payload、跳过 anchor 或无限保留 DEK。

## Secret Rotation And Recovery

单作者生产环境的 secret 轮换必须先生成站点备份包：

```bash
tools/operations/backup-site.sh
```

- JWT signing key：按 [JWT signing-key rotation](security/jwt-key-rotation.md) 的两阶段蓝绿流程更新 `Jwt__KeyVersion`、`Jwt__SecretKey` 与有截止时间的 `Jwt__PreviousKeys`。不得用立即替换单密钥的方式制造全量 `401`，也不得永久接受无 `kid` token。
- 独立安全域密钥：PoW、sealed perception、Recovery Key、PublicAot、MFA、匿名凭证、VisitLog 和 moderation 必须分别生成和轮换，不能复制 `Jwt__SecretKey` 或 risk pseudonym key。各域只按自己的 runbook 轮换。
- DataProtection keyring：默认追加新 key，不删除旧 key；每个 key XML 必须由独立 X.509 protector 加密。只有确认旧 cookie、MFA pending payload、恢复窗口以及 previous certificate 解密窗口全部过期后，才在离线维护窗口清理旧 key 和旧证书。迁移服务器时必须分别恢复 keyring 与受控证书 secret，且不得把证书私钥打入 `data-protection-keyring.tar.gz`；缺少任一侧都会 fail closed。
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
- **RiskControl aggregate envelope**：同一 fixture 覆盖 `issue [A,B] -> verify A progress(no proof) -> verify B completed(aggregate proof) -> business consume-once` 与 `memberCount=1`；匿名请求、普通登录请求、admin principal 分别校验 subject/session plane，admin aggregate proof 不能替代 `X-Fsus-Mfa-Proof`。负例覆盖 member 失败/过期/撤销/重放、顺序错乱、重复 verify、envelope replacement、身份/route generation 变化、只完成第一项、requiredKinds 重排和 aggregate replay，均不得进入业务 handler。
- **输入攻击**：XSS-like、SQL-like（登录用户名、admin keyword、数值查询 / 路由边界）、路径穿越、双重编码、method override、超长 payload、错误 content-type。
- **Binary / Notification Stream**：AEDS v2 challenge issue 保留完整 ordered assignments/provider payload 映射，verify frame 往返覆盖 envelopeId/progress/aggregate proof；另覆盖截断 frame、错误 frame type、错误版本。notification UI/headless 使用共享 runner，匿名 preflight 只接受 completed aggregate proof，WebSocket 非升级、错误子协议、缺 RiskControl / legacy PoW proof、incomplete/replayed envelope 均 fail closed。
- **真人计数**：无 proof 读取不增加浏览数，challenge 篡改、route/article 不匹配、停留不足、重放、直接 API、crawler/scanner 不写入计数事件。
- **浏览器安全面**：CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy、Permissions-Policy、CORS allow/deny/preflight、auth/PoW no-store。
- **DAST**：OWASP ZAP baseline 对本地运行目标执行 spider + passive scan；FAIL 级告警会阻断发布，报告保存在 `.tmp/security/zap/`。独立的 authenticated DAST 在同一个 fresh production runtime 中重新创建 lane 专属 user/admin 会话，随后通过 Playwright API request context 对 anonymous、user、admin、author-console 执行真实主动变异请求，覆盖身份分离、越权、SQL-like、XSS-like、template-like、malformed binary 与 hostile Origin。执行器只接受 loopback origin，不允许扫描生产/预发布目标；它不读取历史通过状态，也不接受环境变量把未执行扫描标成成功。权威 summary 必须为 `status=ok`、`executionSource=fresh-current-lane`、`activeScan.executed=true`，且四类 context 都有实际请求、零失败。
- **本机 fresh 暴露面**：production local profile 每次都运行 `tools/security/check-local-runtime-exposure.mjs`，对当前 namespace 的 backend/frontend/release-preview 做真实 HTTP 与安全头探针，读取主机 TCP listener，并用 Docker inspect 校验 PostgreSQL/Redis 只绑定动态 loopback host port。bootstrap 自身同样把 Vite、preview、PostgreSQL、Redis 绑定到 `127.0.0.1`。证据 `.tmp/security/local-runtime-exposure.json` 固定声明 `loopbackRuntimeOnly=true`、`externalProductionDnsChecked=false`、`externalFirewallEvidenceChecked=false`、`countsAsProductionCloseout=false`；它消除本地门禁内部 skip，但绝不冒充外部生产 DNS/firewall/HSTS closeout。
- **安全域 ownership**：`security/catalog/security-domain.json` 将安全声明拆分到 `security/matrices/`、`security/policies/`、`security/zk/contracts/`、`security/zk/provenance/` 与 `security/evidence-contracts/`。`tools/security/check-security-domain-layout.mjs` 聚合拒绝 flat root files、旧路径、schema/owner/scope 缺失、ZK contract/provenance 混用、hash 漂移与静态 evidence 冒充 fresh evidence；详见 [`docs/security/security-domain-layout.md`](security/security-domain-layout.md)。
- **ASVS / WSTG / WebAuthn 追踪**：`security/matrices/standards/asvs-v5.0.0.yml`、`security/matrices/standards/wstg-v4.2.yml` 与 `security/matrices/authentication/webauthn.yml` 将安全控制映射到代码、测试、证据与 owner；`security/matrices/catalog.json` 声明 family/schema/version/owner/checker，`tools/security/check-security-matrices.mjs` 会在 `security` / `production` 门禁中聚合校验矩阵结构、版本化 ID 和本地路径。
- **ZAP WARN 策略**：`security/policies/zap-warn-policy.yml` 为每个 ZAP WARN 规则登记 owner、接受理由、修复期限、状态和升级为 FAIL 的条件；`tools/security/check-zap-warn-policy.mjs` 在 ZAP baseline 前校验清单，并保持关键规则为 FAIL。
- **供应链审计**：`tools/security/check-supply-chain-audit.sh` 执行 `dotnet list package --vulnerable --include-transitive --format json` 与 `npm audit --omit=dev --audit-level=high --json`，并要求 `src/frontend/package-lock.json` 以及每个 audited `.csproj` 旁的 `packages.lock.json` 存在；高危或严重漏洞会阻断 `security` / `production` 门禁，结果保存在 `.tmp/security/supply-chain/`。
- **依赖变更审查**：仓库不配置普通 Dependabot version updates；维护者按需集中处理 npm、NuGet 与 GitHub Actions 升级，但仓库设置持续启用 Dependabot alerts 与 security updates。所有人工或安全修复依赖变更仍由 `.github/workflows/dependency-review.yml` 在 PR 上阻断 high/critical advisory，并对 AGPL/GPL/LGPL license 风险 fail closed。
- **SBOM**：`tools/security/generate-sbom.sh` 从 NuGet lock files、`src/frontend/package-lock.json` 和 `FSUSBLOG_IMAGE_DIGEST` 生成 CycloneDX 1.5 SBOM，包含私有 GitHub Packages 组件和容器 digest 状态；release evidence 会复制 `.tmp/security/sbom/`。
- **隐私快照**：RUM、subscription、author AI assist、OpenTelemetry 和 audit log 都有静态或单元测试保护；audit context mapper 会丢弃 `Authorization`、cookie、token、email、request body、原始 client IP、原始 user agent 和 username 字段，只保留 trace correlation、低基数字段以及 IP/UA/session/fingerprint hash。
- **安全证据留存**：`check-security-attack-matrix.mjs` 和 `check-permission-matrix.mjs` 会分别写入 `.tmp/security/attack-matrix.json` 与 `.tmp/security/permission-matrix.json`。`tools/operations/collect-release-evidence.sh` 会把这些文件、DAST/ZAP 目录、production exposure status、DNS readiness/delegation、live exposure 和可用 firewall policy evidence 复制到 `.tmp/release-evidence/<release-identity>/`，并在 `manifest.json.securityEvidenceIndex` 中索引；完整发布身份下目录名绑定 release ID、完整 commit SHA 与 image digest，缺少身份时的时间戳目录只用于 blocked 诊断。`manifest.json.evidenceSummary.externalExposure` 记录外部证据是否有效；`valid=false` 表示 release 被阻塞而不是可发布。缺失的真实 firewall/DNS/live 证据不能用合成通过件替代；缺失状态应保留为 `null` 加 `production-exposure-status.json` blocker。

测试矩阵覆盖已知攻击类和回归风险，不构成对未知攻击的绝对安全承诺；新增风险必须补到矩阵或 ZAP 配置中。

---

## 生产安全检查清单

生产环境通过 `ProductionStartupValidator`、最小 `/health/ready` 与 `./tools/test.sh security` 执行以下校验；详细失败明细只通过受保护的 `/api/ops/health/ready-detail` 暴露。匿名 `/health/ready` 只能公开整体状态和固定失败类别，例如 `configuration_invalid` / `dependency_unavailable`，不得返回配置键、origin、CIDR、连接串、backend/provider 名称、exception type 或 validator 原始错误列表。启动阶段校验失败会 fail-closed 阻止应用启动；危险开关 `FSUSBLOG_ALLOW_INSECURE_STARTUP=true` 仅限本地诊断，且不能绕过 JWT 默认/占位密钥、wildcard `AllowedHosts`、缺失反向代理信任边界或 HTTP 生产来源这类安全关键错误。允许降级的非关键项也必须写出 critical 告警，readiness 仍会返回 `503`，发布流程必须把该状态视为阻断。启动 validator 日志只记录错误数量和固定类别，不写入完整 validation error 字符串。

发布控制面 `/api/ops/deployment/status|activate|drain` 不因位于 `/api/ops` 就获得匿名信任：它同时要求独立 admin principal、`system.config` 权限、现有固定 IP rate limit 和 Kestrel 看到的 loopback remote address。宿主脚本把 admin header 保存在 mode-0400/0600 单行文件中，通过明确 HTTPS Origin 发往固定 `127.0.0.1:<blue-or-green-port>`；不得从公网反代暴露这些路由，不得信任任意 `X-Forwarded-For` 伪造 loopback，也不得把 Cookie/Bearer、完整请求或身份写入 lifecycle/gateway evidence。release ID、slot、generation 三者均精确匹配才可改变状态；错误或重放到另一实例的控制请求 fail closed 并写高价值审计。无需重启的安全回退是保留 source Active、恢复 source upstream，并把已激活 target CAS-drain；无法证明 target 已中和时保持 `rollback_required` 等待人工处理。

同一边界覆盖 `/api/ops/deployment/fence/status|acquire|revoke` 与 `/api/ops/deployment/notification-stream/restart/**`。Fence acquire 还绑定 image digest，并以 PostgreSQL durable witness 的事务 CAS 拒绝 generation 倒退或 expected owner 漂移，再单调镜像到 Redis；同 generation witness 身份分歧必须 fail closed，不能自动选择某个 owner。Fence identity 不是客户端认证凭据，也不能通过 public header 获得控制权。Notification restart 只允许受信宿主发起 1012 drain/replay drill，事件 payload、cursor、Cookie/Bearer 均不得进入证据。`FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE` 和 notification auth storage state 必须是 0400/0600 regular non-symlink file；命令行只传路径。

`IBackgroundWorkerLease` 的 active-release ticket 与 `IActiveReleaseCommitGuard` 共同限制后台副作用：worker 获取 lease 后，仍要在最靠近不可逆 transaction/file delete/atomic publish 的位置重新验证 release/slot/generation/digest。旧 source 失去 fence 后，即使进程和旧 lease 尚存，也不能提交 scheduled publish、outbox effect、crawler snapshot、cleanup chunk、projection checkpoint、PublicAOT finalize 或 upload delete。无需重启的降级是动态设置 `ActiveReleaseFence:MutationEnabled=false`，停止 acquire/revoke，保留 durable witness 读取、commit guard 与 pending work，并让 current target 或后续 fresh generation replay；不得临时关闭 commit guard，也不得在 production 启用 synthetic local fence。

production 不允许以 stale in-memory fence 维持授权。强制 startup probe 必须读到 PostgreSQL durable witness；运行期第一次读取失败就使 readiness、claim 与 renew fail closed。连续失败窗口由 `ActiveReleaseFence:RefreshIntervalMs` 和 `ActiveReleaseFence:StaleThresholdSeconds` 动态计算，达到 hard-stale 后只允许 `StopApplication()` graceful shutdown 与 fresh startup probe，不能通过忽略错误、延长本地 ticket 或猜测 active owner 恢复写入。

Destructive worker qualification 只能运行在隔离的 `ASPNETCORE_ENVIRONMENT=Test` topology，使用受限 process-group/PID identity 和显式 file handshake。它必须与 production normal rollout 使用不同 rollout ID，且不能强杀 production source、复用真实 admin secret 或把 nine-kind qualification ledger 写成 normal evidence。最终 evidence bundle 只收集 hash-bound allowlist，不复制 env、header、storage state、完整请求或任意未引用文件。

- [ ] JWT 密钥来自部署 secret，不在共享配置中保存默认值，且不为默认/占位/短密钥
- [ ] `Messages:AdminSessionAuditReferenceKey` 来自独立部署 secret，长度至少 32 字符且不复用 JWT 密钥
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
- [ ] `status|activate|drain|fence|notification restart` 控制面仅由 loopback 宿主调用，admin header/storage-state 文件为 0400/0600 且 evidence 不含 secret
- [ ] 零停机主机满足 4 CPU / 6144 MiB memory / 10240 MiB free disk；2C/2G 只运行单槽，不以资源不足为由关闭 fence、drain 或 security gates
- [ ] 生产 OpenResty/Nginx 默认拒绝未知 Host，并为 `/login`、`/admin`、`/api/binary/auth/**`、`/api/binary/admin/**`、`/api/binary/author/**` 配置认证/后台限流
- [ ] `.tmp/security/authenticated-dast/summary.json` 来自本次 fresh namespace，四类身份主动扫描均真实执行且零失败；不得用人工标记、旧 summary 或 `collected-blocked` 代替
- [ ] 使用 `FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE=.tmp/security/production-exposure-live.json tools/security/complete-production-exposure-closeout.sh`，确认生产 DNS 已解析、只有 `80/443` 对公网开放、SSH 仅允许固定管理 IP/VPN/私有管理网段、`6379/5432/8080` 不可公网访问，且所有生产域名 HTTPS + HSTS 正常；脚本验证通过后会写出 `status=ok`

外部云安全组、防火墙和 Redis/PostgreSQL 私网访问控制仍需在基础设施层执行；仓库内检查只能防止应用配置和部署模板回退。

### 前端私有运行时边界

账户 Cookie 与独立 admin Cookie 是两条会话线。无 Session、仅账户、仅 admin
和双 Session 的路由结果由本地 Memory History 矩阵锁定；Guest/missing
负缓存不能授予权限。跨标签身份变化只广播事件类型与时间，不广播账号、权限、
令牌或 proof。远端账户代际变化会丢弃当前快照和旧请求提交，并卸载已挂载的私有
页面；组件卸载负责中止请求和取消订阅。

私有 query、redirect 与 history 使用逐路由字段 allowlist；未声明字段、私有 fragment
和疑似凭据不会写入登录回跳。Binary failure telemetry 只允许类别、状态、frame type
等枚举信息，不含 URL/query、服务端 details、自由文本、token、trace ID 或业务 ID。
退出、过期、账户切换和 shared-device wipe 统一清除 Private Storage Registry、隐私
credential vault 与 Service Worker 私有缓存。Service Worker 对 `/api/**` 和私有页面
继续 network-only，Public AOT 只保留显式公共 shell。详细本地验收、风险和无需重启的
回退路径见 [frontend private runtime governance](testing/frontend-private-runtime-governance.md)。
路由状态四级分类、登录回跳 metadata gate、逐字段值校验与 Memory History 验收见
[frontend navigation privacy](security/frontend-navigation-privacy.md) 和
[issue #1247 private navigation matrix](testing/issue-1247-private-navigation-matrix.md)。

---

## 依赖与版本

| 依赖 | 版本 | 用途 |
| ------ | ------ | ------ |
| BCrypt.Net-Next | 4.1.0 | 密码哈希 |
| Fido2 | 4.0.1 | WebAuthn / FIDO2 |
| Jint | 4.13.0 | Level 1 JavaScript plugin runtime（CLR interop 默认关闭） |
| System.Buffers.Text.Base64Url | .NET 10 BCL | WebAuthn ID 编解码（替代旧版 FIDO2 helper 的 `Base64Url` 类） |
| ASP.NET Core Data Protection | 10 | Cookie 保护 |
| ASP.NET Core RateLimiting | 10 | IP 速率限制 |

## PerceptionCharacterV3 运行时边界

V3 runtime 只从 embedded canonical `perception-character-v3-contract.json` 读取 identity、alphabet、artifact bounds 和 crypto 尺寸；不得引用 `tools/contracts/perception-character-v3-reference.mjs`。answer、token 与 pool encryption 使用三个互相独立的 versioned 256-bit key ring。启用 provider 时 hosted startup gate 在监听流量前拒绝 missing、非 32-byte、equal、unknown-current、非法 version、placeholder、checked-in vector key、无效 active generation 或无法认证的 pack；test vector 仅允许 `environment=Test && AllowTestVectors=true`。

服务端用 answer key 对 server-issued device authority 做 domain-separated HMAC，并与 pseudonymous IP、subject、action、route、envelope/challenge、issued policy、representation、media hash 同时写入 AES-GCM state 与 Redis authoritative state。authenticated/admin authority 来自服务端会话 claim；anonymous authority 来自 Redis 租约和 `__Host-` cookie，client fingerprint 不能创建或轮换 device bucket。Redis Lua 在一个原子操作内检查全部 binding、处理 expiry/revoke、递增两次尝试并写入 consumed/exhausted；timeout、连接失败或 ambiguous result fail closed。replacement 的旧 token hash/envelope/full binding 也在该原子 transition 内校验，避免 challenge-ID 撤销 oracle。日志只保留 operation/outcome/internal reason 等低基数审计字段，严禁 token、answer、key、seed、media 或原始 IP/device material。

V3 初次签发以 Redis state+TTL+active-index 的单脚本 NX 为权威；active-index 使用不随 answer/token key rotation 变化的 server-device stable digest，禁止用具体 challenge 的 `DeviceBindingHash` 作为索引身份。同表示 refresh 和 representation switch 以旧 binding/active-index 为 CAS 条件，在一个脚本内撤销旧 state、创建带 TTL 的新 state并交换 index；旧 binding 使用旧 state 记录的 answer-key version 校验，新 challenge 才使用 current version。客户端不以异步 cancel 作为 refresh 正确性条件。脚本结果回包丢失时只读取同一 operation result；无法确定时保留 ambiguous fence并拒绝后续 mutation，避免把一次 verify/replace 计为两次。无需重启的紧急回退：从热 RiskControl policy 移除 `perceptionCharacterV3`，立即停止新签发和 replacement；随后通过 cancel/revocation 批量撤销 active identity。已签发 challenge 使用 envelope 记录的 policy version，普通策略发布不会误杀它；显式 revoke 始终生效。`Enabled` 与 key-ring 变更是启动边界，恢复时应使用独立安全域上一版有效 key 并滚动部署，禁止借用 JWT、PoW 或 V2 key。

浏览器 V3 adapter 在读取媒体 slice 前先验证 algorithm、UUIDv7 identity、representation、时间窗、
attempt budget、所有 slice 边界以及最终 PNG/Ogg Opus 的固定结构、尺寸和字节上限。visual 直接
创建受限 `image/png` Blob URL；audio 只创建受限 `audio/ogg; codecs=opus` Blob URL。replacement、
close、路由变化与组件卸载释放 object URL、audio 和由 FsusUI primitive 接管的 bitmap。前端 verify 只回传 typed
`algorithm/challengeId/envelopeId/representation/answer/stateToken`；不得产生或记录 solve duration、
recipe、seed、glyph id、risk score、answer verifier 或内部失败原因。

运行时回退不需要重新部署前端：热策略停止新 V3 签发后，共享 Dialog 对现有 pending command
展示统一 unavailable 状态或允许用户取消；撤销 endpoint 保持幂等，其他 challenge kind 与
notification stream 不受影响。恢复策略前必须确认 backend provider 与当前 FsusUI public primitive
均可用，客户端没有 V1/V2 alias fallback。

前端 production shared RiskControl flow 的可审计清单当前只有 Passkey login begin/complete、
Recovery Key verify 与 comment/reply。account self-service 和 admin command 目前都没有 shared
RiskControl proof endpoint/flow；admin-sensitive 操作继续使用独立的 `X-Fsus-Mfa-Proof`，不得把
该 MFA step-up 记作 shared challenge dialog 覆盖。未来 account/admin flow 只有在服务端 endpoint
接入 shared RiskControl proof 且客户端通过 shared coordinator 提交命令后才算纳入；该接入会复用
唯一的 application-level `SecurityChallengeDialogHost`，禁止创建 account/admin 私有 challenge host。
## 评论作者管理 capability

强匿名评论的后续管理使用与创建 ticket 分离的 256-bit capability。服务端仅保存 SHA-256 commitment；capability 和一次性 challenge 禁止写入 URL、日志、缓存键、localStorage、telemetry 或任何 account/credential/nullifier 映射。challenge 绑定 comment id 与 edit/delete/status/appeal purpose，五分钟过期且通过数据库 CAS 只消费一次；所有入口执行 `fixed_ip` 限流。伪造、重放和跨评论 challenge 统一失败，不泄漏评论是否存在。capability 丢失不可恢复，客户端必须在提交后明确告知。管理员可读取完整修订历史；匿名与公开读取只获得当前可见正文和 edited bit。

无需重启的降级路径是将 `Comments:AuthorEditWindowMinutes` 收紧到最小窗口，阻止新的历史编辑；删除、状态查询、申诉、公共读取、notification stream 与 admin 审核边界不改变。迁移仅增加 nullable/defaulted 列和新表，旧客户端可继续读取既有 comment POD。
评论举报的匿名凭据与作者 capability 分域：举报凭据经 `Moderation:ReportPepper`（未单配时使用 `Moderation:Pepper`）和 comment id 做 HMAC，只能在同一评论内去重，不能跨评论、账号、nullifier 或 credential root 关联。原始凭据、IP、匿名证明不进入 report/event 表、审计 payload 或 telemetry；请求期 `fixed_ip` 限流仅在同步边界使用。运行时可通过动态限流策略收紧/关闭匿名举报而无需重启，账号举报与既有审核读取继续可用。

申诉 capability 只证明当前评论作者控制权；申诉绑定最新 Hidden/Rejected event，并由数据库唯一索引限制每个决定一次。`Moderation:Appeals:RequireDifferentReviewer=true` 为默认安全值，原审核 admin principal 不能复核自己的决定。紧急降级可在配置 reload 后拒绝新的 appeal decision 写入，同时保留 timeline/report 读取；不得删除或改写既有事件。

文章级评论 override 只能收紧全站 author-mode 开关；ticket 签发与最终提交都重新读取 `site -> article -> thread` 有效快照。线程锁只阻止目标根树的新回复，既有评论和其他线程继续可读写。慢速模式以评论 actor 的 privacy-safe moderation subject hash 为作用域，在评论事务内 CAS 更新；不得使用 IP 原文、设备指纹、credential commitment、nullifier 原文或账号可逆标识。策略管理要求 admin permission、step-up、乐观版本，并把原因与版本写入 append-only `comment_policy_audit_event`。

## Cluster membership diagnostics

Cluster membership diagnostics are private operational metadata. Only independent admin principals with `system.config` may call `GET /api/ops/cluster/nodes`; the endpoint also uses `fixed_ip` and `no-store`. Normal signed-in accounts, legacy user admin roles, anonymous requests, and admin principals without the exact permission are rejected. The additive scheduler graph exposes only stable responsibility/capability IDs, replica/node placement, bounded score/reason, assignment time and optional fencing token; it never exposes lease IDs, Redis keys, queue payloads or module requests. The response contains no Cookie, token, session ID, raw network address, connection string, exception text, or secret.

Distributed state ownership is fail-closed. Cluster heartbeat establishes liveness but does not grant write authority; only the current resource lease and its monotonically increasing fencing token authorize checkpoint or terminal task-state writes. Renew and release require the original `leaseId + token`, and a stale process cannot complete, retry, dead-letter, or compensate a task after another node takes over. Idempotency records retain only task/object/operation identity, execution state, bounded checkpoint payload, result digest, low-sensitivity failure code, node ID, and lease metadata; they must not contain Cookie values, bearer tokens, MFA/RiskControl proof, raw client IP, device fingerprint, anonymous witness/proof, or credential material.

State-control storage failure never disables authentication, authorization, PoW, RiskControl, binary framing, or notification-stream admission. In multi-node modes it instead stops new stateful worker writes until Redis recovers or another healthy node acquires the expired lease. Operators may drain the affected node without restart; they may not switch a running multi-node process to the in-memory store or reset fencing counters to regain progress.

The Redis record uses the runtime key scope and only stable capability IDs plus bounded health/load/resource hints. Operator-controlled `Draining` and `Maintenance` states are preserved by failure detection. If scheduling must be stopped without restarting the public service, responsibilities are removed and the node is marked `Draining` or `Maintenance`; binary routes and notification stream continue under their existing security controls.
