# 安全模型

本文档说明 FsusBlog 采用的安全机制及其实现要点。

字体包属于本地 supply-chain 输入。`.fsfont` 必须在写盘前验证 reviewed license、
非空本地 license 文件、结构化 package origin/source、每个 WOFF2 face 的声明
SHA-256、目录边界和 WOFF2 signature；未知 license/origin、remote URL、hash
mismatch、undeclared/out-of-root/non-WOFF2 asset 或 executable archive entry
一律 fail closed。enable/activate 还会从 content-addressed store 重读 exact bytes
并复核 size/hash，不能把安装时验证当成永久信任。release collector 与
`release-final` 都要求 `fsusblog.font.license.v1` machine evidence 为 `ok` 且
violations 为空。无需重启的回退是将 scope 切回 built-in selection；若持久 metadata
本身损坏，先原子恢复 last-known-good `registry.json` 再切换，不允许跳过验证或远程
补下载。完整合同见 [`.fsfont` package and registry](fonts/fsfont-package.md)。

主题 CSS 是不可信的声明式输入。安装和激活都通过
`ThemeCssSafetyScanner` fail closed：只允许 exact `data-theme` 稳定 scope，
拒绝 Element Plus internal selector、远程或未知资源、script-like URL、
full-viewport fixed overlay、超预算 z-index/filter、无限 motion、layout
transition，以及 CSS/asset/preview/selector/depth/`!important`/duration
超限。激活从内容寻址存储重开 archive 并重验 package hash，失败不会改变现有
activation。无需重启的回退是禁用受影响 scope 或切回仍能通过重扫的已安装主题，
不得绕过 scanner 或放宽 hard ceiling。详细合同与 release evidence 见
[Theme CSS safety and asset budgets](themes/css-safety.md)。

主题激活还是受 fencing 保护的安全状态转换。preview 只接受服务端声明的
`user-preview:{positiveUserId}`，不能把任意请求参数升级成 site-wide/public/admin/
console scope。共享 apply 必须把 activation UUID、package hash、config version、
mode 与 append-only history/evidence 原子持久化；浏览器 CSS failure 只有同时匹配
当前 scope、UUID、theme id 和 package hash 才能触发 rollback，晚到或伪造报告
fail closed。rollback 恢复上一完整版本，default reset 删除该 scope pointer；
两者均不要求重启，也不改变认证、PoW、notification stream 或 binary transport。
完整合同见 [Theme activation runtime](themes/runtime-lifecycle.md)。

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

文件系统路径和本地脚本执行必须先转换为 `Path.GetFullPath` 后再用 `Path.GetRelativePath` 确认仍位于预期根目录内，不能只依赖字符串 `StartsWith`。LocalAuth fixture 只能执行仓库 `tests/frontend/fixtures/prepare-auth-smoke-users.mjs`；Public AOT hydration sidecar 读写必须留在 web root；SSR worker script 必须留在 frontend client root；upload/image 和 integrity asset file 检查必须留在 `PublicAssetRoot`（公开图）或 instance-scoped `UploadSessionRoot`/`UploadCommitRoot` sandbox。任何越界、绝对路径覆盖、`..` segment 逃逸或控制字符日志输入都按固定类别拒绝或降级，不回显路径细节。
Unix 物理路径证据通过 canonical `Platform=Unix` 计划真实创建 root 外目录链接，要求 `CanonicalPathBoundary` 拒绝逃逸，同时以 root 内目录链接证明正常解析仍可用；Windows 计划将该 test ID 记录为 `not-selected`，不借此声称已验证 junction/reparse-point。

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

## Proof of Work (PoW) and rate limiting

PoW/challenge kinds, verification/cache windows, numeric bounds, rate policies and fail modes are owned by the generated security catalogs below. The prose claims beside those catalogs define the fail-closed and window/cache relationships; this section does not maintain a second policy table.

---

## PerceptionCharacterV3 资源安全边界

V3 allocation 只由 `IPerceptionCharacterV3ResourcePlanner` 决定。配置必须满足 representation/total 的 `0 <= critical < low < high`、正数 minute/rolling-hour lease 与 exact-byte egress budgets、正数 IP-prefix/server-device/subject/action quota，以及 comment/enrollment/account-recovery/admin-sensitive/public-read/other 的完整 exhaustion disposition；生产启动在 pool 接流量前验证这些不变量。缺配置、乱序 watermark、hour budget 小于 minute budget或 disposition 缺失均 fail closed。

pool manifest v1 只增加旧 runtime 可忽略的非秘密 additive `artifactBytes`，startup 仍完整认证 ciphertext、解密 record，并确认该值等于最终 PNG/Ogg bytes 且不超过 hard limit。Redis Lua 把 entry burn、ready/leased inventory、exact-byte budget、各身份维度 quota 与 operation retry fence 一次提交；ambiguous reply 后 retry 不会租第二项或重复计费。Redis key 只使用用途隔离的 IP prefix hash、server-device hash、subject hash、coarse action 与 operation hash，不写 raw IP、answer、token、media、challenge ID 或自由文本 reason。

运行时紧急停止使用 reload-capable `Security:PerceptionCharacterV3:Resources:AllocationsEnabled=false`，下一次 planner decision 即按 action table queue/fail closed，无需重启。恢复前必须确认 active generation 未 revoked/corrupted、inventory 和 rolling budget 健康；该开关不能重新激活 retired generation。公开 read、notification stream 和 binary frame contract 不变，既有 challenge 只允许 verify/cancel 到期 drain，不回退在线渲染。

启动级 `Security:PerceptionCharacterV3:Enabled=disabled` 不注册 v3 provider；由 legacy 配置派生的默认 RiskControl policy 因而把 v3 decision band 收敛为已注册的 canonical `sha256PowV1`，避免生成不可执行 assignment。显式导入仍引用 `perceptionCharacterV3` 的 policy 会 fail closed 拒绝，而不是静默改写管理员 policy；启用 v3 时，provider、pool/startup gate 与 v3 policy 必须同时成立。

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

## Authentication, MFA, Passkey, sessions and RBAC

Current authentication/session facts and directional relations are owned by [普通账号 Session 认证上下文](security/user-session-authentication-context.md). Admin permission sets are owned by the generated catalogs below. This document intentionally does not repeat exact methods, strengths, TTLs, cookie modes, credential limits, permission matrices, error tables or migration aliases.

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
- 前端主调用凭据是 HttpOnly Cookie session / AEDS auth frame；credentialed binary mutation 会在存在 `<meta name="fsus-csrf-token">` 或 `XSRF-TOKEN` cookie 时附带 `X-Fsus-Csrf-Token`。当前 binary mutation 没有 token issuance/expiry 契约；生效的 CSRF 边界是 `SameSite=Strict` Cookie 与 `UseFsusCsrfOriginGuard()`：携带浏览器凭据的 unsafe request 必须提供受信任的绝对 HTTP(S) `Origin`，或在 `Origin` 缺失时提供受信任的 `Referer`。服务端保留 `UseAntiforgery()`，供显式声明 antiforgery metadata 的端点使用，不得把尚未绑定该 metadata 的 endpoint 描述成已执行 token validation。匿名强隐私请求显式 `credentials=omit`，不得携带该 token 或 Cookie。高风险写操作还会叠加 PoW、admin step-up proof、RBAC 与 no-store metadata，避免只依赖自动携带 Cookie。

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
- 服务端草稿按 `ownerAdminPrincipalId + draftKey` 唯一保存，owner 来自 independent admin principal 的 `admin_id`，不复用普通匿名账号 id；它仍是长期、跨设备恢复的唯一权威。浏览器只在 IndexedDB `fsusblog-article-recovery-journal` 中保存服务端尚未确认的正文窗口，不再维护 `fsus:article-draft:*` localStorage metadata 恢复 owner，也禁止 localStorage 全文双写。`fsusblog.article-recovery-journal.v1` 记录以 admin identity 的单向 hash、create/edit article scope、tab ownership、base revision、server revision、client revision 与正文 source hash 绑定；正文使用 deterministic `gzip-v1` typed-byte payload，raw stored record 不含全文 `content` string。逻辑正文和压缩 payload 的单条上限分别为 1 MiB，TTL 为 12 小时，同一 identity/article 最多 8 个 tab 版本，浏览器合计最多 32 条/4 MiB compressed bytes。writer 同时只保留一个 in-flight 和一个最新待写 snapshot；rapid input 替换中间待写项，hidden/pagehide/beforeunload/periodic 仍请求同一个 latest owner。未知或旧 schema、unsupported codec、损坏、过期、解压后 hash/逻辑 byte 不匹配和 stored cap 超限记录读取时删除而不迁移；压缩或解压能力不可用时 journal fail soft 为 unavailable，绝不回退保存 raw 正文，现有服务端自动保存继续。服务端确认只删除 client revision 与 source hash 精确匹配的记录，不能删除同一 tab 更晚输入。发布、文章删除、明确丢弃、admin/account logout、账号切换、会话过期、隐私清理和 shared-device 清理会删除相应 journal。IndexedDB 不可用、private mode 拒绝或 quota/cap 超限时只给低噪声提示；不得回退为 localStorage 全文、延长为长期存储或静默覆盖较新的 server/current revision。压缩不是加密；journal 保存的 compressed bytes 与未发布 Markdown 明文具有同等本地隐私风险，设备或 profile 访问者可能恢复正文，不得把浏览器本地存储描述成绝对安全，也不得写入附件 bytes、上传 token、Cookie、proof 或其他凭据。跨设备恢复仍必须通过 admin cookie 读取 `/api/binary/author/drafts/{draftKey}`；正文不得落入公开 AOT、Service Worker shell cache 或搜索索引。
- 修订历史正文详情只允许 admin 在作者工作台读取；回滚必须走正式文章更新服务以写入新修订、审计记录和分发缓存失效，不允许通过 SQL/API 直接覆盖公开正文。
- `/api/binary/upload/**` 是唯一上传协议，分片会话只接受可规范化为 32 位 GUID `N` 格式的 `uploadId`。除 init 外每个操作都在 session lock 内以创建者 admin principal 和 `X-Fsus-Upload-Token` capability 联合授权，并只读取一次 v4 manifest；manifest 仅存 32-byte token 的 SHA-256，固定时间比较 hash，原 token 只出现在 init 成功响应。会话不存在、过期、旧/损坏、owner 不符和 token 缺失/错误全部返回同一个 `404 UPLOAD_SESSION_NOT_FOUND`，安全计数不得包含 token。旧会话、孤立 bitmap、旧 parts 目录和 `.incoming` 残留直接清理而不迁移。`FileService` 在 status、part map、part upload、complete、abort、cleanup 和 session lock 边界统一规范化为小写 canonical 值；`.upload-sessions` 使用 full path 作为目录沙箱，Unix 平台上 session root / session / parts 目录必须限制为 owner-only，manifest 和 part 文件以 owner read/write 创建。manifest 写入必须使用随机 sibling temp path + private file mode，并通过 replace/move 原子发布，不得使用固定 `manifest.aeds.tmp`。非法 `uploadId` 返回 validation error，不创建 session lock，不执行递归删除，也不向响应泄露物理路径。上传总大小上限为 20 MiB，Kestrel request body limit 必须覆盖该上限和协议开销；`/part` 必须携带明确 `Content-Length`，不接受 chunked transfer-encoding。上传图片只允许 jpg/jpeg/png/gif/webp；品牌图标生成允许上传 ICO favicon 成品，并通过 ICO 目录头签名校验；AVIF 和 SVG 在引入像素维度、decoder bomb 防护与 SVG 清洗前不得进入 upload allow-list。
- 未发布正文只允许出现在 admin-only AEDS 响应中；私有预览响应只含规范化标题、摘要、受控封面 URL、Markdown source、纯文本、发布前 issues 与绑定 raw request snapshot 的 SHA-256 `sourceIdentity`，不得包含 HTML。前端必须核对 identity、请求 generation 和当前表单 snapshot，随后仅通过 Vue 文本插值、受控图片 URL 与 FsusUI `MarkdownRenderer` 展示；不得恢复 iframe/srcdoc、本地 sanitizer、普通 string 到 TrustedHTML 的转换或服务端 Markdown HTML renderer。预览不得写入 PublicAOT cache、search index、feed、sitemap 或 related-reading。
- FsusBlog 生产前端 `src/frontend/src/**` 不得提交任意 HTML。`tools/security/html-sink-ast.mjs` 以 Vue SFC AST 与 TypeScript AST 为零白名单门禁，覆盖 `v-html`、HTML DOM 写入、iframe `srcdoc`、`document.write`、`DOMParser` text/html 及其简单别名、解构和常量拼接；解析失败 fail closed，不存在路径白名单或行级 suppress。唯一 HTML 提交边界位于依赖 FsusUI 内部。独立 mutation fixture 由 `npm --prefix src/frontend run test:html-sink-ast` 执行，并纳入 `test:unit:fast` 与 `check:security-consistency`。

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
- 资产库只在 admin-only 作者工作台可见；内部身份、引用、advisory lock 和清理队列均使用 canonical UUID `AssetId`。URL 只能在 `PublicAssetUrlCodec` 边界与安全的相对 `AssetStorageKey` 转换；删除 endpoint 不解析路径，`IAssetStore.DeleteAsync(AssetId)` 在同一 AssetId lock 内拒绝任何仍被 article、draft 或 revision 引用的资产。孤儿只进入延迟清理，宽限期恢复引用必须取消删除。该边界不得暴露匿名目录浏览能力。
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
- Production HTML、Public AOT 与 OpenResty 静态响应必须在现有 nonce CSP 上额外启用 `require-trusted-types-for 'script'; trusted-types vue fsusblog fsusblog-spa-entry fsusui-markdown-feature`。`vue` 是当前 Vue runtime 使用的固定 policy name；仓库前端只创建 module-private `fsusblog` policy，并只向 FsusUI 不透明 `MarkdownSafeHtml`、非可执行 data script text、固定同源 `/wasm/comment-privacy-prover.js`、固定同源 `/sw.js`（仅允许可选 immutable build id），以及同源、无 query/hash、构建 hash 命名的 Markdown/commentPrivacy/perception-v2/pospace/pow/wasmDecode Worker 暴露窄封装。普通 Markdown 或 feature-output 字符串不得进入该 policy；feature output 的校验、解析与 DOM 提交由 FsusUI 内部 gateway 独占。`fsusui-markdown-feature` 由 FsusUI 私有创建，FsusBlog 只在 CSP allowlist 中放行，不得创建同名 policy。Public AOT 的 nonce bootstrap 另在闭包内创建 `fsusblog-spa-entry`，其 `createScriptURL` 只接受服务端已解析的单一 SPA entry，并且 policy object 不对外暴露。构建关闭 Vite runtime modulepreload helper，由 Public AOT bootstrap 独占服务端审计后的 SPA entry 与 modulepreload 注入，避免浏览器端 raw string 进入 `TrustedScriptURL` sink；稳定 `fsus-spa-entry.js` 只 import hashed entry，保持单一 ESM identity，禁止复制入口或启用 `allow-duplicates`。导航进度条使用固定 DOM 节点与外部 CSS，不加载会写 `innerHTML`/inline style 的 NProgress runtime。禁止 `default`、`*`、`'allow-duplicates'`、第三方 script、任意外部/blob URL、任意 worker/prover query，以及 service worker 上除单一 immutable `build` 外的 query 或公开 policy object。普通 Development/Vite HMR 不启用 Trusted Types enforcement，但仍保持 nonce 与原有 CSP；本地 release acceptance 在保留 Development-only fixture endpoints 的同时显式设置 `Testing:EnforceProductionCsp=true`，使普通 HTML 与 PublicHotRead 共用 production CSP。非 Development 环境始终使用 production policy，该测试开关不能降低生产 CSP。production 必须用后端普通 HTML、PublicHotRead AOT、OpenResty 三条可执行断言防止 header 漂移。若评论 prover boundary 异常，先通过 reloadable policy 热关 ZK anonymous comments；Trusted Types 不能按功能热关闭，兼容性回滚必须把前端与 CSP 作为同一发布单元回滚，不能放宽 policy allowlist。凭证隔离、残余风险与 release evidence 见 [Comment privacy credential vault](security/comment-privacy-credential-vault.md)。
- AntiCrawler / public-read / challenge 相关正向风险分累加必须使用 Redis Lua 原子 `IncrementClampedWithExpiryAsync`，在同一 Redis 往返中完成当前分读取、增量、`MaxRiskScore` clamp 和 TTL 设置，避免并发 AddRisk 丢增量。`scoreDelta == 0` 的观察模式或禁用评分路径只记录事件，不读取或写入 Redis 分数；正分写入会清除 zero-risk cache，reset 仍显式删除 `SecurityPowRisk` key。若需要降级或纠错，只删除受影响 IP 的 risk key / zero-risk entry，让下一次安全请求重建状态，不得恢复应用层读-改-写。
- 结构化审计写入 `sys_audit_log`：保留 `source/type/action/outcome/severity/actor/target`、trace/path/method、原因码和低基数 context；IP、User-Agent、session id、设备指纹只保存 SHA-256 hash。Serilog 到审计表的 mapper 只接受显式 `AuditActorType` + `AuditActorId` 作为 actor，不得从裸 `UserId`、`AccountId`、`InternalUserId` 或 `AdminPrincipalId` 自动推断审计主体；这些身份平面字段也不得进入普通 context payload。高价值 admin/security/audit 事件通过 `IAuditEventService` 同步写库，失败时写入 `FSUSBLOG_DATA_ROOT/audit-fallback/critical-audit-*.jsonl`，避免关键审计静默丢失。每条新签发审计生成的 `record_hash` 同时绑定加密 `context_payload` 的 SHA-256；verifier 仍可校验迁移前未绑定 payload 的既有签名，但不会为它们重签或修补。配置 `Audit:TamperEvidenceKey` 或 `Security:AuditTamperEvidenceKey` 时额外生成 `record_mac`。同一 `chain_id` 内写入时必须把当前行 `prev_hash` 链接到前一行 `record_hash`，批内和跨批都不能断链。`/user/manage/audit` 可查询详情并校验单条 hash/mac 以及同链前驱 hash，前驱缺失或重排会使校验失败。审计查询默认 `pii-redacted`，普通 `audit.read` admin 只能看到 `pii-redacted` 占位；只有同时具备 `audit.investigate` 并显式请求 `piiMode=investigation` 时，列表/详情才返回完整 `IpHash`、`UserAgentHash`、`SessionIdHash`、`DeviceFingerprintHash`，且该读取必须写高价值审计并标记 `sensitiveFieldsRead=true`。
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
- **security-state fixture composition root**：`/__local/security-fixture/*` 只在 Development/Test 且显式启用 `fsus:allowLocalSecurityFixture` 时注册；调用者还必须同时通过 loopback、独立 secret、run、namespace、profile、auth identity prepare reference 和 semantic temporal binding。composition root 调用 production risk/blacklist/anonymous-credential/nullifier/issuance-audit/cache ports，禁止修改 runtime policy threshold；owner ledger 只用于精确恢复、独立观察和删除本轮拥有的实体/keys。Production startup 对启用 flag fail closed。
- **输入攻击**：XSS-like、SQL-like（登录用户名、admin keyword、数值查询 / 路由边界）、路径穿越、双重编码、method override、超长 payload、错误 content-type。
- **Binary / Notification Stream**：AEDS v2 challenge issue 保留完整 ordered assignments/provider payload 映射，verify frame 往返覆盖 envelopeId/progress/aggregate proof；另覆盖截断 frame、错误 frame type、错误版本。notification UI/headless 使用共享 runner，匿名 preflight 只接受 completed aggregate proof，WebSocket 非升级、错误子协议、缺 RiskControl / legacy PoW proof、incomplete/replayed envelope 均 fail closed。
- **真人计数**：无 proof 读取不增加浏览数，challenge 篡改、route/article 不匹配、停留不足、重放、直接 API、crawler/scanner 不写入计数事件。
- **浏览器安全面**：CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy、Permissions-Policy、CORS allow/deny/preflight、auth/PoW no-store。
- **生产 XSS 浏览器矩阵**：`production-xss-fast` / `production-xss-release` 直接消费本地 FsusUI test-only corpus，在真实 Release frontend、Kestrel 和数据库链路上检查 AOT hydration 前后、SPA、About、持久化评论与 admin 私有预览。所有 browser context 安装 dialog、execution sentinel、external request、popup/download/navigation、CSP、Trusted Types 与 DOM namespace/attribute/URL 探针；结果逐 case/surface/browser/phase 封存，kill-control 单测必须证明任一控制关闭都会失败。FsusBlog 不保存第二份 payload，不发布或要求 FsusUI package release。
- **DAST**：OWASP ZAP baseline 对本地运行目标执行 spider + passive scan；FAIL 级告警会阻断发布，报告保存在 `.tmp/security/zap/`。独立的 authenticated DAST 在同一个 fresh production runtime 中重新创建 lane 专属 user/admin 会话，随后通过 Playwright API request context 对 anonymous、user、admin、author-console 执行真实主动变异请求，覆盖身份分离、越权、SQL-like、XSS-like、template-like、malformed binary 与 hostile Origin。执行器只接受 loopback origin，不允许扫描生产/预发布目标；它不读取历史通过状态，也不接受环境变量把未执行扫描标成成功。权威 summary 必须为 `status=ok`、`executionSource=fresh-current-lane`、`activeScan.executed=true`，且四类 context 都有实际请求、零失败。
- **本机 fresh 暴露面**：production local profile 每次都运行 `tools/security/check-local-runtime-exposure.mjs`，对当前 namespace 的 backend/frontend/release-preview 做真实 HTTP 与安全头探针，读取主机 TCP listener，并用 Docker inspect 校验 PostgreSQL/Redis 只绑定动态 loopback host port。bootstrap 自身同样把 Vite、preview、PostgreSQL、Redis 绑定到 `127.0.0.1`。证据 `.tmp/security/local-runtime-exposure.json` 固定声明 `loopbackRuntimeOnly=true`、`externalProductionDnsChecked=false`、`externalFirewallEvidenceChecked=false`、`countsAsProductionCloseout=false`；它消除本地门禁内部 skip，但绝不冒充外部生产 DNS/firewall/HSTS closeout。
- **安全域 ownership**：`security/catalog/security-domain.json` 将安全声明拆分到 `security/matrices/`、`security/policies/`、`security/zk/contracts/`、`security/zk/provenance/` 与 `security/evidence-contracts/`。`tools/security/check-security-domain-layout.mjs` 聚合拒绝 flat root files、旧路径、schema/owner/scope 缺失、ZK contract/provenance 混用、hash 漂移与静态 evidence 冒充 fresh evidence；详见 [`docs/security/security-domain-layout.md`](security/security-domain-layout.md)。
- **ASVS / WSTG / WebAuthn 追踪**：`security/matrices/standards/asvs-v5.0.0.yml`、`security/matrices/standards/wstg-v4.2.yml` 与 `security/matrices/authentication/webauthn.yml` 将安全控制映射到代码、测试、证据与 owner；`security/matrices/catalog.json` 声明 family/schema/version/owner/checker，`tools/security/check-security-matrices.mjs` 会在 `security` / `production` 门禁中聚合校验矩阵结构、版本化 ID 和本地路径。
- **ZAP WARN 策略**：`security/policies/zap-warn-policy.yml` 为每个 ZAP WARN 规则登记 owner、接受理由、修复期限、状态和升级为 FAIL 的条件；`tools/security/check-zap-warn-policy.mjs` 在 ZAP baseline 前校验清单，并保持关键规则为 FAIL。
- **供应链审计**：`tools/security/check-supply-chain-audit.sh` 执行 `dotnet list package --vulnerable --include-transitive --format json` 与 `npm audit --omit=dev --audit-level=high --json`，并要求 `src/frontend/package-lock.json` 以及每个 audited `.csproj` 旁的 `packages.lock.json` 存在；高危或严重漏洞会阻断 `security` / `production` 门禁，结果保存在 `.tmp/security/supply-chain/`。
- **依赖变更审查**：仓库侧只为官方 Mend Renovate GitHub App 提供根 `renovate.json5` 与 `config/dependencies/update-surface.json`，不配置自托管 Renovate、PAT、第二个更新机器人或 `.github/dependabot.yml`，并要求持续启用 Dependabot alerts 与 security updates。App 安装、权限、live Dashboard 与真实更新 PR 当前均为 `external-unverified`；官方 validator、full dry-run 和 `local-controlled-simulation` 只证明本地候选配置，不冒充外部 App 已执行。所有自动或人工依赖变更仍由 `.github/workflows/dependency-review.yml` 在 PR 上阻断 high/critical advisory，并对 AGPL/GPL/LGPL license 风险 fail closed。
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
## Plugin Admin authorization and disclosure

插件管理 UI 和 API 不构成新的授权平面。读取和写入均要求独立 admin principal 的
`system.config`，固定 IP 限流与 `no-store`；安装、授权、撤销、启停、重载、隔离、
恢复、卸载和配置写入还必须消费一次性 admin step-up。安装另需
`X-Fsus-Plugin-Confirm: install`，隔离/恢复/卸载另需 request 内
`confirmed=true`。浏览器只呈现服务端生成的 `PluginPermissionPlan`，Dangerous/
Trusted 不自动授权；未知 capability、raw database/filesystem/network、manifest
未声明 capability 和未确认 Sensitive 申请均 fail closed。

插件日志与错误按 plugin/node/hook/trace 隔离，并受每插件固定条数与执行期 log byte
budget 双重限制。控制面不返回 package bytes、签名、unredacted manifest、credential、
Cookie/JWT/Passkey、raw header 或异常 message。权限撤销在下一次 Host API demand
生效；隔离会卸载 Hook、清 grant 并取消后续 runtime 调用，不需重启或放宽 PoW、
`X-Fsus-*`、notification stream 与统一 AEDS error 边界。

## Current generated security catalogs

<!-- fsus-doc-claim
claimId: authentication-session-permission.admin-permissions
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.admin.permissions
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.admin.permissions -->
- `admin.manage`
- `anonymous.comment.configure`
- `anonymous.credential.revoke`
- `anonymous.nullifier.block`
- `article.publish`
- `article.write`
- `audit.investigate`
- `audit.read`
- `comment.moderate`
- `system.config`
<!-- FSUSBLOG-GENERATED:END auth.admin.permissions -->

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.challenge-kinds
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: security.challenge.kinds
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN security.challenge.kinds -->
- `adminPasskeyStepUpV1`
- `anonymousCredentialProofV1`
- `argon2idPoSpaceV1`
- `humanReadProofV1`
- `passkeyStepUpV1`
- `perceptionCharacterV3`
- `perceptionLocalizationV2`
- `perceptionMicroInteractionV2`
- `recoveryKeyProofV1`
- `sha256PowV1`
- `zkAnonymousCommentProofV1`
<!-- FSUSBLOG-GENERATED:END security.challenge.kinds -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.admin-permissions-read-only
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.admin.permissions-read-only
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.admin.permissions-read-only -->
- `audit.read`
<!-- FSUSBLOG-GENERATED:END auth.admin.permissions-read-only -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.admin-permissions-partial-policy
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.admin.permissions-partial-policy
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.admin.permissions-partial-policy -->
| Key | Value |
| --- | --- |
| authorization | require-exact-claim-at-endpoint |
| catalogAuthority | AdminPermissions.All |
| claimType | admin_permission |
| rootBootstrap | full-catalog |
| storage | newline-separated-subset-of-catalog |
| unknownCatalogPermission | no-endpoint-grant |
<!-- FSUSBLOG-GENERATED:END auth.admin.permissions-partial-policy -->

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.challenge-retired-kinds
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: security.challenge.retired-kinds
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN security.challenge.retired-kinds -->
_empty set_
<!-- FSUSBLOG-GENERATED:END security.challenge.retired-kinds -->

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.challenge-verification-window
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: security.challenge.verification-window
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN security.challenge.verification-window -->
| Key | Value |
| --- | --- |
| boundary | count-less-than-or-equal-max-attempts |
| cacheExpiry | 2 minutes |
| cacheExpiryFactId | security.challenge.verify-attempt-cache-expiry |
| cacheExpiryMilliseconds | 120000 |
| challengeKinds | ["adminPasskeyStepUpV1","anonymousCredentialProofV1","argon2idPoSpaceV1","humanReadProofV1","passkeyStepUpV1","perceptionCharacterV3","perceptionLocalizationV2","perceptionMicroInteractionV2","recoveryKeyProofV1","sha256PowV1","zkAnonymousCommentProofV1"] |
| challengeManifestVersion | 2026.07.22.1 |
| closed | true |
| duration | 2 minutes |
| durationMilliseconds | 120000 |
| factId | security.challenge.verify-attempt-window |
| failMode | fail-closed |
| failModeFactId | security.challenge.verify-fail-mode |
| maxAttempts | 3 attempts |
| maxAttemptsFactId | security.challenge.verify-max-attempts |
| proofTests | ["SecurityChallengeVerifyRateLimiterTests"] |
| relation | window-duration-and-cache-expiry-are-distinct-facts-with-equal-current-duration |
| schema | fsusblog.security-challenge-verification-window.v1 |
| sourceOwner | src/backend/Services/Security/SecurityChallengeVerifyRateLimiter.cs |
| sourceRange | SecurityChallengeVerifyRateLimiter.TryAcquireAsync |
| startsAt | first-counter-increment |
| version | 1 |
| window-relation | {"condition":"current sliding-expiry-counter policy","direction":"subject-to-object","object":"security.challenge.verify-attempt-cache-expiry","predicate":"is-distinct-from","relationId":"security.challenge.verify-window-distinct-from-cache-expiry","subject":"security.challenge.verify-attempt-window","truthValue":"true"} |
| windowType | sliding-expiry-counter |
<!-- FSUSBLOG-GENERATED:END security.challenge.verification-window -->

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.challenge-rate-policies
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: security.challenge.rate-policies
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN security.challenge.rate-policies -->
| Key | Value |
| --- | --- |
| fixed_ip | {"codeDefaultPermitLimit":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"requests-per-window","value":100},"failMode":"fail-closed","permitLimitClamp":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"max":100000,"min":1,"unit":"requests-per-window"},"policyId":"fixed_ip","window":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"minutes","value":1}} |
| notification_stream | {"codeDefaultPermitLimit":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"requests-per-window","value":120},"failMode":"fail-closed","permitLimitClamp":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"max":100000,"min":1,"unit":"requests-per-window"},"policyId":"notification_stream","window":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"minutes","value":1}} |
| public_read | {"codeDefaultPermitLimit":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"requests-per-window","value":120},"failMode":"fail-closed","permitLimitClamp":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"max":100000,"min":1,"unit":"requests-per-window"},"policyId":"public_read","window":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"minutes","value":1}} |
| read_proof | {"codeDefaultPermitLimit":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"requests-per-window","value":30},"failMode":"fail-closed","permitLimitClamp":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"max":100000,"min":1,"unit":"requests-per-window"},"policyId":"read_proof","window":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"minutes","value":1}} |
| security_challenge_verify | {"cacheExpiry":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"minutes","value":2},"cachePolicyId":"SecurityChallengeVerifyRateLimit","failMode":"fail-closed","maxAttempts":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"attempts","value":3},"policyId":"security_challenge_verify"} |
<!-- FSUSBLOG-GENERATED:END security.challenge.rate-policies -->

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.challenge-fail-modes
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: security.challenge.fail-modes
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN security.challenge.fail-modes -->
| Key | Value |
| --- | --- |
| capability-manifest-mismatch | fail-closed |
| challenge-envelope-cas | fail-closed |
| plugin-hook-default | fail-closed |
| production-startup-validation | fail-closed |
| rate-limiter-rejection | fail-closed |
| security-challenge-verify | fail-closed |
| zk-production-gate | fail-closed |
<!-- FSUSBLOG-GENERATED:END security.challenge.fail-modes -->

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.challenge-numeric-boundaries
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: security.challenge.numeric-boundaries
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN security.challenge.numeric-boundaries -->
| Key | Value |
| --- | --- |
| moderation.comment-max-chars.default | 1000 characters |
| moderation.comment-max-utf8-bytes.default | 4096 bytes |
| security.challenge-verify.cache-expiry | 2 minutes |
| security.challenge-verify.max-attempts | 3 attempts |
| security.challenge.max-assignments-per-envelope | 8 assignments |
| security.rate-limit.permit-limit | {"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"max":100000,"min":1,"unit":"requests-per-window"} |
| security.rate-limit.queue-limit | {"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"max":10000,"min":0,"unit":"queued-requests"} |
| security.step-up.freshness-minutes | {"bound":"inclusive-inclusive","configurationKey":"Security:StepUp:FreshnessMinutes","default":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"minutes","value":5},"maximum":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"minutes","value":15},"minimum":{"bound":"inclusive-inclusive","inclusiveMax":true,"inclusiveMin":true,"unit":"minutes","value":1}} |
<!-- FSUSBLOG-GENERATED:END security.challenge.numeric-boundaries -->

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.challenge-window-cache-relation
behaviorId: configuration-error-security-policy
claimType: binary-relation
factPath: facts.securityPolicyClaims.windowCacheRelation
render: relation-subject-predicate-object
-->

`security.challenge.verify-window-distinct-from-cache-expiry`：`security.challenge.verify-attempt-window` `is-distinct-from` `security.challenge.verify-attempt-cache-expiry`，condition 为 `current sliding-expiry-counter policy`。

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.challenge-verify-fail-policy
behaviorId: configuration-error-security-policy
claimType: failure-mode
factPath: facts.securityPolicyClaims.challengeVerifyFailMode
render: failure-policy
-->

`security-challenge-verify` 使用 `fail-closed`。

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.rate-limiter-fail-policy
behaviorId: configuration-error-security-policy
claimType: failure-mode
factPath: facts.securityPolicyClaims.rateLimiterFailMode
render: failure-policy
-->

`rate-limiter-rejection` 使用 `fail-closed`。
