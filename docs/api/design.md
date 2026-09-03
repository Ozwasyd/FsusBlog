# API 设计哲学

本文件说明 FsusBlog API 层的设计原则与约定，是所有 API 变更的**必读前提文件**。

> 最近更新：2026-07-19 — RiskControl 组合 challenge 收敛为 UUIDv7 envelope、ordered member progress 与单次 aggregate proof。

## 强匿名资格最小披露

`fsus.anonymous.comment.v5` / layout `6` 的公开 statement 只允许 root/version/hash 绑定、scope-bound nullifier，以及 `is_eligible`、`may_comment`、`rate_class`（仅 `common|unknown`）和 `requires_moderation`。精确凭据 epoch、凭据级别、声誉桶和账号年龄只能作为签名约束下的私有 witness，不得进入请求响应、ticket、评论投影、审核、provider、统计或 admin DTO。Production 的公开谓词组合必须有至少 20 个成员；不足时只能合并到 common/unknown 后重新证明，无法合并则 fail closed。

---

## 核心原则

### 1. 契约稳定性优先

- 一旦端点路径发布，非 breaking 语义变更在原路径叠加；breaking 变更须通过新 frame type、payload layout、显式 route segment 或新端点表达，不能随意复用旧路径语义。
- 所有请求/响应字段用 `src/shared/Contracts/Outputs/ServerResponseContracts.cs` 作为唯一来源，任何业务逻辑层不得自行定义与之并行的 DTO。
- Notification stream 的 transport 不得自行猜测事件重要性。所有 active event 必须由共享 delivery policy catalog 显式声明 ordering、durability、loss/coalescing、priority、maximum useful age 与 replay/resync；未知类型 fail closed。可替换事件只允许在 live shallow lane 合并，durable backlog、cursor 与 AEDS payload 保持不变；lossless 无法入队时必须向客户端发送明确 replay/full-resync 指令。
- 跨语言安全协议的手写 machine-readable source 归入 `src/shared/Contracts/Validation/Security/`，并只由 `tools/contracts/` 的跨栈生成器派生 C# 与 TypeScript consumer；根目录 `contracts/security/` 和单侧 `tools/frontend/` 不得形成第二入口。
- 请求期网络身份只能在同步入口生成用途隔离、短 epoch 的限流/去重材料；任何 AEDS response、异步消息、retry/fallback、日志、trace 或 metric contract 都不得携带 raw IP。依赖不可用时允许返回现有响应 frame 的固定低基数状态并丢弃统计，不能把请求上下文转入后台补偿。

### 2. AEDS Binary-only 运行时协议

运行时主业务 API 只暴露 AEDS 二进制链路：

| 链路 | Content-Type | 解码方 | 路径前缀 |
| ------ | ------------- | ------- | --------- |
| **AEDS Binary** | `application/octet-stream` | TypeScript adapter / C++23 Wasm Worker | `/api/binary/...` |
| **Public AOT hydration sidecar** | `application/vnd.fsus.aeds` | public hydration bootstrap / shell navigation | `/aot-cache/payloads/.../*.aeds` |

旧文本业务 API 不再注册；`/api/**` 非 binary 业务路径统一返回 `ApiError` AEDS frame。客户端不得把解码失败回退为文本 API 请求。例外只限 [AEDS-only policy](aeds-only-policy.md) 登记的标准协议、健康探针和工具入口。通知 preflight 失败返回 AEDS `ApiError` frame，不再返回 JSON error envelope；`/api/read-proof/**`、`/api/public/articles/{id}/related`、`/api/telemetry/rum`、`/api/subscriptions`、`/api/author/**` 与 `/api/admin/security/**` 旧 JSON 入口已移除。

前端的文章读取与登录后私有 API 固定消费当前 AEDS binary contract，不提供用户可切换的 transport 状态，也不把 transport 选择写入 `localStorage` 或 `sessionStorage`。排障能力只能作为 `import.meta.env.DEV` 明确守卫的开发构建内存态观测，不得改变 API 路径、请求 frame、凭据策略或生产 bundle 行为。

前端 binary request/response、worker frame metadata 与 decode result 的共享类型只定义在 `src/frontend/src/contracts/`；这些 contract 不导入运行时模块。业务 API、request codec 与 response adapter 都只能朝 contract 方向依赖，response adapter 不得反向导入 API 实现。`services/binaryTransport.ts` 只消费注入的 `BinaryFramePayloadDecoder`，具体 frame mapper 由 `composition/binaryDecoderRegistry.ts` 显式登记，并在 `composition/binaryTransport.ts` 或 decode worker 入口完成组合。该依赖方向不得改变 AEDS frame 编号、POD 字段顺序、`ApiError` 映射或 binary-only 语义，也不得引入 JSON fallback、第二 transport 或兼容 adapter。

Integrity verification sidecars under `/integrity/**` are public JSON manifests, not runtime business APIs and not `/api/binary/**` fallback. Publish proof and Rights V3 proof routes only read persisted proof rows, signing metadata, and transparency log pointers; they do not generate proofs on request and must not expose admin principal id, IP address, user agent, session id, device id, private drafts, comments, private messages, tokens, private keys, or failure details.

HTTP shell 契约由 `src/shared/Contracts/Validation/fsusblog.openapi.json` 提供，包含 method/path/status/content-type/security 与 `x-fsus-*` 扩展；AEDS payload、frame 编号、POD schema 和 golden fixture 仍由 `aeds-protocol.json`、POD 契约和 fixture 负责。

本地/测试辅助端点不得成为生产身份 fallback。任何会写入登录、admin 或安全态 cookie 的 fixture 入口都必须限定到 Development 映射，并使用独立 `X-Fsus-*` shared-secret header 做固定时间比较；未配置 secret 时 fail closed。浏览器 fixture 激活还必须同时满足 localhost、`import.meta.env.DEV`、development mode 与非 PROD；激活标记写入当前 tab 的 SessionStorage 后立即用 `history.replaceState` 删除 fixture query，服务端 redirect 不得把该 query 加回。

### 3. 统一响应包装

所有运行时主业务响应体均为 AEDS v2 frame。成功写操作使用 `EmptySuccess` 或 `MutationId`；会被前端立即选中、关联或跳转到新资源的创建操作必须返回 `MutationId`，例如分类、标签和文章创建，不能让前端只靠刷新列表后按名称猜测。分类、标签等通用 mutation 仍返回 8B `MutationIdPod`；文章 create/update/rollback 在同一 frame type 下返回 48B `ArticleMutationResultPod`，同时给出 article、revision、release、status、rights snapshot、幂等重放标记、`applied/no_change` outcome 和显式错误码，调用方不得从随后读取的“最新状态”猜测本次绑定结果。失败、鉴权拒绝、限流和异常兜底统一使用 `ApiError` frame。AEDS v1 frame 不再兼容，也不保留旧 frame fallback。

### 4. 原生 AEDS 内部 API 原则

作者工作台 `/api/binary/author/**` 与管理端 security `/api/binary/admin/security/**` 的生产入口必须直接实现 AEDS v2 frame：endpoint 自己读取 route-specific request frame，成功响应直接写 route-specific response frame，错误统一写 `ApiError` frame。RiskControl 控制面读取与运行态写入（`risk-control/overview`、`risk-control/options`、`risk-control/options/rollback`、`challenges/overview`、`policies/overview`）也只允许通过原生 binary endpoint 暴露，不能恢复 `/api/admin/security/**` JSON fallback。

管理端安全配置写入必须 fail closed：外部 URL、回调地址、provider endpoint 等可触发服务端出站请求的字段必须在写入入口和使用入口同时校验 allowlist / scheme / port，非法值返回 `ApiError`，不得静默回退到旧配置或默认配置。Crawler range 远程 URL 只允许 HTTPS `developers.google.com` / `www.bing.com`，用于防止通过 admin 配置把后台 worker 变成 SSRF 出站通道。

`JsonApiResponse<T>`、`Results.Ok(JsonApiResponse<...>)` 与 `/_fsus/internal/binary-bridge/**` 不得用于运行时内部业务 API。浏览器可达的 `/api/binary/**` 端点不得直接暴露 JSON envelope；新增业务端点默认按 [aeds-only-policy.md#内部应用-api-定义](aeds-only-policy.md#内部应用-api-定义) 设计，不新增 runtime compatibility bridge。装载点见 `src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs`，allowlist 见 [aeds-only-policy.md#允许豁免](aeds-only-policy.md#允许豁免)。

### 5. 认证一致性

鉴权要求以 `/api/binary/**` 端点声明为准。公开、登录、admin、PoW、MFA、Passkey 等边界必须在 binary 端点内直接校验；不存在文本端点作为权限参照。

普通账号 bearer token 的签名有效不等于会话仍有效。所有需要普通账号 principal 的 binary 端点在 JWT `OnTokenValidated` 阶段统一校验 `sid`：默认读跨实例共享的短 TTL Redis L2 版本快照，miss、Redis 异常或损坏 payload 时只按 session 主键做一次 PostgreSQL 权威回源；数据库失败一律 fail closed。回源受独立并发预算与故障熔断保护，并以单调 `xmin` CAS best-effort 修复 Redis，旧 active snapshot 不能覆盖较新的 restricted/revoked snapshot。`session_mode=normal|restricted|revoked` 由数据库状态决定，JWT claim 只是输入提示；两者不一致时使用更严格模式。restricted principal 只允许 endpoint 显式声明的账号状态/封禁原因读取、logout、自有 session 查看与撤销、账号删除及必要 step-up，其他评论、消息、内容、身份、公开与 admin 能力默认拒绝；notification stream 不接受 restricted principal。单会话撤销、撤销其他会话和 refresh replay 的 DB 更新必须与 revoked snapshot 发布成对出现，使旧 access token 无需等待 JWT `exp` 即失效；公开 hot-read 没有认证 principal，不进入 session cache/DB 链路。admin principal 保持独立的 admin session validator，不复用普通 `sys_user_session`。实现与回退约束见 [user-session-revocation.md](../user-session-revocation.md)。

Refresh Token 是服务端有状态的 opaque credential，不是 JWT，也不能由客户端 `SessionId` 决定其归属。每条 user session 固定一个 `RefreshFamilyId`，正常轮换只递增 generation；当前 hash 与已使用 hash tombstone 共同构成定位证据。原子 CAS 的 loser 与已提交后再次提交的 replay 是不同状态：前者只返回冲突，后者精确 compromise token 所属 family。任何兼容或降级路径都不得恢复旧 generation、按 device fingerprint 扩大撤销，或把 token/hash 全值写入日志。详见 [Refresh Token lineage](../security/refresh-token-lineage.md)。

普通账号的安全 subject 是 `sys_user.account_subject_hash` 物理投影。迁移用与应用相同的 C# canonical hasher 分批回填，新账号在返回 bootstrap 响应前写入该字段；JWT、MFA、binary auth、notification stream、blacklist 和 account-state cache 只能读取投影值。缺失或格式错误时必须 fail closed，不能从 account id、public handle、Passkey handle 或旧 cache payload 重新派生。滚动发布通过 nullable Expand 列兼容旧二进制，但候选接流量前必须通过永久启动不变量门禁。

高价值认证动作可以在既有 binary 路径上叠加 RiskControl proof，而不是新增平行登录 API。生产用户登录入口只保留 Passkey、Recovery Key 与必要 step-up；`auth.passkey.begin`、`auth.passkey.complete`、`recovery-key.verify` 必须通过 endpoint metadata 声明 action，并统一用 `RequiresRiskControlFilter` 返回 AEDS `ApiError`；缺 challenge proof 返回 428，block/throttle 返回 429。叠加 RiskControl 不删除 legacy PoW、admin step-up 或 MFA proof 边界；需要两个 proof 的端点必须明确登记到 [contracts.md](contracts.md#安全挑战契约) 与本文件头部表。`auth.login` 只作为 legacy 风控 action 名保留，不对应生产用户侧 password endpoint。

浏览器只允许通过通用 binary transport 接受已验证 proof 的 typed lease；transport 从 lease 写入三项 `X-Fsus-Challenge-*` header，并负责发送前取消、in-flight、服务端响应和未知网络结果的单次结算。评论、Recovery Key 和 Passkey 页面不得手写 header 或复制 proof glue。428 只在 transport 层按 AEDS 错误码与低基数 outcome 归一化，业务页面不解析自由文本；自动继续仅允许幂等命令或保留固定 mutation identity 的同一命令，可能已经发送的非幂等操作不得自动重放。

账号安全凭据变更的 step-up 证明必须是 action 绑定的一次性 proof token，经 `X-Fsus-Mfa-Proof` 传递。普通账号可通过 `/api/binary/auth/step-up/passkey/begin|complete` 用当前账号 Passkey 断言换取对应 action 的一次性 proof；该 proof 与 TOTP challenge 完成后签发的 proof 使用同一消费边界。该 Passkey step-up 通道受 `Auth:PasskeyStepUp:Enabled` 独立开关保护，默认开启；关闭时 begin/complete 都返回 503 + `PASSKEY_STEP_UP_DISABLED`，不得生成 challenge 或 mint proof。匿名身份模式下，Recovery Key create/rotate、Passkey register/delete/rename、account delete 等生产敏感操作不得把旧 `MfaPasswordProofRequest` 或 request body 内 proof 当作 proof；非匿名 legacy password fallback 如保留，必须隔离到兼容路径，不能进入匿名生产 endpoint。Recovery Key passkey bind 不得在 WebAuthn 校验和数据库提交前消费 recovery session；服务端必须先用原子 compare-and-set 把会话从 `pending` 认领为带短租约的 `completing`，失败时恢复 `pending`，并以 recovery token hash + 规范化完成请求 hash 的数据库唯一标记提供并发单次提交和响应丢失后的同请求幂等重放。完整状态、事务与回退约束见 [recovery-passkey-completion.md](../recovery-passkey-completion.md)。

WebAuthn Level 3 Signal API 只用于在服务端账号状态提交后 best-effort 同步浏览器/provider，不得进入认证、注册、删除或公开称呼事务的成功判定。完整凭证列表必须来自带单调账号 revision 的服务端权威快照；前端通过 capability cache、超时/取消边界、BroadcastChannel revision 与 Web Locks 协调跨标签页，拒绝已观察为过期的列表。缺失 API/provider 是正常 no-op，唯一允许的未登录态 unknown-credential signal 必须来自服务端固定错误分类，不能按自由文本、签名错误或风险拒绝推断。Signal 失败的无重启降级路径是直接停止调用（capability false 或客户端 no-op），服务端业务链路保持不变。

Recovery Key verify 的 AEDS request 只携带 Recovery Key 明文本体与撤销选项，不接受用户输入 account id。新 Recovery Key 明文格式为 `frk_<lookupId>_<secret>`，其中 `lookupId` 是 128-bit hex 随机值；服务端只用 peppered `lookup_id_hash` 定位候选记录，再校验完整 key 的 peppered PBKDF2 hash。旧无 lookup id 的 key 不扫描全表兼容，会按通用失败和限流处理，用户需重新生成新格式 Recovery Key。

匿名账号容器边界：`sys_user` 不承载登录 IP/time、TOTP secret、TOTP pending secret 或 TOTP recovery-code hash。登录观测只进入 session/security event 维度，TOTP material 只进入 `user_mfa_profile`；`LegacyPasswordHash` / `LegacyProjectRole` 只能作为 tombstone 兼容字段存在，生产端点不得读取它们完成登录或授权。

强匿名凭证签发是登录态到匿名态的单向盲签边界：唯一签发入口是 `POST /api/binary/anonymous-credential/blind-issue`。浏览器按 RFC 9474 `RSABSSA-SHA384-PSS-Randomized` 在本地执行 Prepare/Randomize/Blind/Finalize；服务端只验证账号领取资格、epoch 配额与固定宽度 blinded representative，不能看到或重算最终 RSA-PSS signature、credential commitment、revocation handle、nullifier、proof witness 或 credential secret。`GET /api/binary/anonymous-credential/blind-issuer` 公开返回绑定 root 的 3072-bit RSA SPKI、SHA-256 与 scheme id。签发响应必须 `no-store`；配额表只保存 epoch-scoped HMAC subject、epoch、状态与小时桶，不保存 trace/path/identity kind。成功、资格拒绝、配额拒绝与签名失败使用同一错误和受控延迟桶。运行时 `BlindRsa:Enabled=false` 可通过配置 reload 在不重启进程的情况下同时关闭 metadata 与私钥操作；已取得的匿名材料不因此建立服务端反查路径。

强匿名 root/circuit metadata 是公开读取边界：`GET /api/binary/anonymous-credential/root` 和 `/circuit` 只返回公开的 credential root、epoch、expiry、circuit id、verifying key hash、public input layout version 与 ZK/verifier 配置位。`verifierConfigured` 只来自生产 `IZkProofVerifier.IsConfigured`，用于告诉 prover 当前服务端是否有完整 verifier adapter，不在该读取路径验证 proof。该读取路径必须匿名、`public_read` 限流、AEDS-only，不读取 Cookie、session、Authorization 或当前账号；root 不可用时 fail closed 为 AEDS `anonymous_root_unavailable`。服务端缓存对象必须按 root version/TTL 失效，negative cache 只短暂吸收 miss，不承担 root rotation worker 职责。

强匿名撤销采用公共离线分发边界。所有客户端仅按 root metadata 固定的 content-addressed URL 读取同一份 epoch/version full snapshot 或 delta；请求固定为无 body、`credentials: omit` 的 GET，响应使用 `public, max-age=31536000, immutable`。credential-specific `POST /api/binary/anonymous-credential/revocation-witness` 永久返回 `410`，不读取 body，frame 186/187 仅保留 retired 编号且不得复用。浏览器在既有 privacy worker 内验证 epoch/version/root/content hash/hash-binding/expiry 后本地生成 non-membership witness；revocation handle 不进入 URL、body、header、日志或 telemetry。

强匿名评论 ticket 是匿名评论写入前的无登录态准入边界：`POST /api/binary/comment/anonymous-ticket` 只接受 `AnonymousCommentTicketRequest` AEDS frame，必须 `AllowAnonymous`、`public_read` 限流并拒绝任何 Cookie/session/Authorization 污染。服务端先做 article/scope/hash/reply context/frame 大小等廉价校验，再使用当前 root snapshot 和 `IZkAnonymousProofService` 预验证 proof；通过后只返回一次 opaque ticket，缓存层只保存 ticket hash 对应的短 TTL 二进制 payload，并以 consume-once 语义交给 `POST /api/binary/comment/anonymous`。匿名 submit 只接受 `AnonymousCommentCreateRequest`，同样拒绝登录态污染；成功后写入匿名治理字段和地区合规记录，初始状态由匿名凭证、地区人工复核/隐藏、风险队列及模型开关共同决定，不固定为 `Approved`。需要模型的评论先写 `Pending`，同步处置完成后通过 `CommentCreateResult` 返回最终状态，不把 ticket/proof/credential 原文写入评论。强匿名评论自身没有账号归因；回复公开评论时，通知收件人只由目标评论的有效 public `user_id` 投影，不能由回复者身份决定，也不能建立匿名回复者到账户的映射。公开评论读取只能从评论行作者快照生成展示名：匿名/强匿名使用 `anonymous_display_name` 或匿名兜底，public send 使用 `public_handle` 或未署名兜底，不能回退 `sys_user.username`。回复展示只能通过 `reply_to_comment_id` 指向的评论作者快照生成，不依赖 `reply_to_user_id` 或 `sys_user` join 还原匿名作者。ticket 端点不得写评论正文、不得建立 user id 到 nullifier/credential 的映射，也不得把 proof 失败细节返回给客户端。

匿名评论 scope 由服务端按 `comment:v1:article:{articleId}:top` 或 `comment:v1:article:{articleId}:thread:{rootId}` 生成并校验。顶层额度为每份匿名凭据周期、每篇文章 1 条；回复额度为每份匿名凭据周期、每个讨论串 3 条。删除、审核拒绝、隐藏或同版本策略调整均不返还已消费额度；凭据轮换产生新 nullifier 后按新周期计数，scope ownership 变化必须提升版本。scope 始终绑定 article，禁止跨文章稳定值；客户端值仅用于构造 proof，不能改变服务端推导的 article/root 关联。

评论策略 Decoder 是强匿名入口的前端安全边界。API wrapper、ArticleDetail、隐私 metadata adapter、mock 与 fixture 必须消费 contract 层同一个完整类型；业务层不得扩展 optional ZK-Prod 字段、强制 cast 或把缺失值解释为可用。Decoder 根据精确 POD layout 生成显式 client contract version，并把服务端受控 reason 与原始 readiness 位归一化为单一低基数状态。只有 `ready` 可以启用强匿名入口；任一 legacy/unknown/malformed/contradictory 状态都 fail closed，保留公开读取与用户显式选择的 public 评论能力，但绝不自动改写本次强匿名提交方式。

公开评论删除采用 viewer-region aware 墓碑链：当前 viewer 可见的 `Approved`、未删除节点是公开叶；服务端只补回这些公开叶的祖先。已删除、管理员隐藏或在当前地区不可展示的祖先统一投影为“该回复已删除 / 已删除评论”，不得携带原正文、删除原因、作者快照、账号或匿名治理身份；没有公开后代的删除叶不返回。地区屏蔽只影响命中地区，`UNKNOWN` viewer 保守应用全部 blocked-region 行；账户注销不回查账号状态，仍按评论写入时的公开作者快照展示，除非评论本身进入删除/隐藏链。notification stream 删除事件先做同样的本地安全占位，随后强制回源当前首屏，使实时状态最终与同地区冷读取一致。

线程计数与预览是两个独立语义：`ReplyCount` 表示同一 viewer-region 可见规则下完整线程回复投影的总数，`RepliesPreview.Count` 只表示当前内联预览数量，`HasMoreReplies` 只比较二者。计数必须和墓碑递归链共用一个批量窗口聚合，不能对每个根执行独立 count，也不能把“预览 + 更多哨兵”伪装成总数。文章没有有效 current publication 时，评论线程与计数一起不可公开读取。

递归评论树以服务端保存的 `parent_id/root_id/depth` 为唯一结构真源，客户端不得按返回顺序或固定两层重新推导。`GET /api/binary/comment/{articleId}` 只分页根节点并内联一小段直接子节点预览；`/children/{parentId}` 对单个父节点做独立 keyset 游标；`/context/{commentId}` 返回祖先路径、目标与相邻兄弟窗口，用于 `/article/{articleId}#comment-{commentId}` 精确定位。路径端点对不存在、删除、隐藏和地区不可见目标统一返回 `unavailable`，不得用状态或时序泄露其存在性。写入深度与单节点直接回复数由服务端配置约束，并在事务内锁定父节点配额；超限分别返回稳定错误 `comment_thread_depth_limit`、`comment_child_limit`。

---

### 评论创建幂等身份

评论创建是可安全重试的命令。登录态 public 请求必须携带规范小写 UUID `D` 格式（固定 36 字符）的 `X-Fsus-Client-Mutation-Id`，并以 `accountId + clientMutationId` 作为身份；强匿名提交以 opaque ticket 的 SHA-256 承诺作为身份。两条链路都在评论事务中保存规范请求摘要与幂等身份：同身份同摘要返回原 `CommentCreateResult` 且 `idempotencyReplay=true`，同身份不同摘要返回 `409 comment_mutation_content_conflict`，不得重复写地区记录、nullifier 消费、通知或缓存副作用。幂等窗口默认 24 小时，`Comments:MutationIdempotencyTtlHours` 仅允许 1..168 小时；窗口内响应丢失、双击、并发和页面恢复必须复用同一身份。

评论编辑与删除使用独立作者管理边界，不能复用创建 ticket、nullifier 或公开展示字段。public 作者以账号所有权授权；强匿名作者在首次创建成功响应中获得独立随机 capability，服务端只保存不可逆 commitment。每次 edit/delete/status/appeal 先签发绑定 comment + purpose 的短期一次性 challenge，再在事务内消费；编辑同时使用当前版本 CAS，冲突时回滚 challenge 消费。强匿名 capability 只在 no-store AEDS body 和页面内存中存在，既不能枚举评论，也不能通过账号恢复。运行时回退无需重启：将 `Comments:AuthorEditWindowMinutes` 收紧到最小窗口可停止新的历史编辑，公共读取、notification stream 与 admin 审核仍保持可用；数据库变更为 additive，旧客户端继续忽略 `isEdited` 保留位。

## URL 命名约定

| 规则 | 示例 |
| ------ | ------ |
| Binary 端点统一前缀 `/api/binary/` + 小写资源名；公开热点 article 使用无 query 的 artifact 路径 | `/api/binary/article/list/home/1/10.aeds`、`/api/binary/comment/{id}` |
| 消息系统使用 binary 消息路径 | `/api/binary/messages/conversations` |
| 管理端以 binary admin 资源路径区分 | `/api/binary/admin/users`、`/api/binary/stats` |
| 作者工作台生产前端使用原生 AEDS endpoint；不保留 legacy JSON runtime 兼容层 | `/api/binary/author/drafts`、`/api/binary/author/audit`、`/api/binary/author/moderation/overview` |
| 健康检查、发布控制与通知独立于业务路径 | `/health/live`、`/health/ready`、`/api/ops/health/ready-detail`、`/api/ops/deployment/status`、`/api/ops/deployment/activate`、`/api/ops/deployment/drain`、`/api/ops/deployment/fence/**`、`/api/ops/deployment/notification-stream/**`、`/api/notifications/stream` |

持续增长表的管理端列表不得依赖深分页 OFFSET。审计日志列表保留 `page/pageSize` 兼容字段，但服务端排序和翻页以 `occurredAtUtc + id` keyset cursor 为准：首屏不传 `cursor`，后续请求传上一页响应的 `nextCursor`。summary/facet 这类刷新频繁的聚合读取必须使用归一化过滤条件做短 TTL cache 或等价 rollup，不能让每次 UI 刷新都重新触发多路 GroupBy。

发布控制端点是宿主机 ops JSON 协议，不是业务 API 或 AEDS fallback。读取/写入都必须同时通过独立 admin principal 的 `system.config` 权限与 loopback source 限制；activate/drain body 固定携带运行实例的 `releaseId + slot + generation`，以 CAS 拒绝发往错误容器或旧 generation 的请求。Candidate readiness 只证明依赖/运行时门禁完成，不表示可接流量；网关必须显式激活。Draining 会让 readiness 立即失败，但公共 readiness body 仍只保留 `status/checkedAt`。这组端点不改变 `ApiResponse`、AEDS frame、`X-Fsus-*` release header、PoW 或 RiskControl 语义。

作者工作台 cache action 只暴露可重复执行的运行时维护动作，例如 rebuild、invalidate 和 recompute；一次性历史清理必须进入 `SchemaMigrationRunner` 并由 migration history 记录，不再作为 admin cache action 长期暴露。

### 消息会话列表快照与游标

账号和 admin 会话列表使用稳定的 `lastMessageAt DESC, conversationId DESC` keyset
排序。首屏不传 `cursor`；后续请求必须原样传回 `ConversationList.nextCursor`，不能在
浏览器按首屏数据做假分页。账号工作区每次请求 20 条，admin 工作区每次请求 30 条；
筛选条件变化时丢弃已有 cursor 和已加载行，从新筛选的首屏重新开始。

服务端 cursor 是 opaque base64url 值，内部绑定首屏的非 internal 最大 message id、
最后一项 `lastMessageAt` 与 `conversationId`。后续页只选择该 message-id 快照内的最新
可见消息，因此翻页期间插入的新消息不会把尚未读取的旧会话移出快照，也不会产生重复
或静默漏项。同一时间戳必须用 `conversationId` 作为确定性次序。前端收到 notification
stream 更新时按 conversation id upsert、去重并重排已经加载的行，但保留服务端 cursor；
重连的首屏刷新不得把已经加载的后续页截断。

无需重启的回退通过 reload-capable `Messages:CursorPaginationEnabled=false` 暂停账号与
admin 会话列表，统一返回 `503 message_cursor_pagination_disabled`；详情、消息写入和
notification stream 不受影响。不能回退到 `OFFSET`、旧 `page` 参数或浏览器本地切片。

### 消息读取快照与已读游标

管理员共享队列的已读事实独立保存在 `msg_admin_queue_state`，每个 conversation 只有一行，
包含 `lastReadMessageId`、`unreadCount`、`lastReadAt` 与单调 `version`。账号发送的非 internal
消息在同一写事务内增加管理队列未读；admin 和 system 消息不增加。admin 列表、详情和
`unread` 筛选只读取该投影，绝不聚合账号参与者的未读数。打开最新详情会以该响应的
`readSnapshotMessageId` 单调推进共享队列；读取历史页不会让游标后退。账号参与者状态与
管理队列状态互不回填。

旧会话由 `20260719-post-message-admin-queue-state` 保守回填：没有历史 admin 已读事实时，
所有账号消息视为管理队列未读。`IMessageAdminQueueMaintenance` 提供一致性检查和幂等重建，
会修复缺行、未读计数偏差及无效读取游标。reload-capable
`Messages:AdminQueueProjectionEnabled=false` 会让两个 admin 读取端点 fail closed 为
`503 message_admin_queue_projection_disabled`；账号读写和消息落库继续工作，修复/重建后
可直接重新启用，不需要重启，也不得回退到参与者未读聚合。

管理端列表和详情使用独立的 `AdminConversationList(206)` / `AdminConversationDetail(207)`
projection，只增加最小的 `counterpartyAccountId` 与账户状态（正常、受限、已注销、不可用）。
账户端仍使用原有 `ConversationList(56)` / `ConversationDetailV3(204)`，其 DTO 和 wire layout
均不包含对方账户字段。sender display 按 viewer 生成：账户端只见“你/管理员/系统”，管理端
见“账号 #ID/管理员/系统”。管理端实时 upsert 复用同一 projection，不返回 public handle、
处罚原因、管理员 principal 或 session id。

reload-capable `Messages:AdminAccountProjectionEnabled=false` 可在不重启进程的情况下让管理端
列表/详情返回 `503 message_admin_account_projection_disabled` 并停止生成管理端 projection
实时 upsert；账户消息协议与账号读写不受影响。修复账户投影数据后可直接重新启用，不得回退
为从 `senderName` 猜测账号或向账户 frame 增加身份字段。

账号与 admin 消息详情使用 `ConversationDetailV3`，默认只返回最新 50 条非 internal
消息。响应的 `previousCursor` 是本页最旧消息 ID；`hasOlder=true` 时，客户端把该值原样
作为 `beforeMessageId` 发起下一次向前读取。客户端必须按 message ID 去重并保持升序，
notification stream 新消息与历史页并发到达时不得互相覆盖。账号端任何页面都不得返回
internal note。

账号 inbox 在 notification stream 报告 replay miss 后，以当前详情最后已知 message ID 作为
`afterMessageId` 读取差量；差量分页沿响应游标继续，直到数据库权威快照追平。重连恢复同时
刷新会话列表和总未读。详情请求必须绑定 selection generation/AbortSignal，HTTP 返回时合并
比请求更新的实时消息、read cursor 和 status patch，不得整对象覆盖。message ID、read cursor、
事件 ID/时间和 `lastMessageAt` 分别作为对应投影的可比较版本，较旧 patch 只能被去重，不能使
状态回退。

消息内容不得依赖 HTML `maxlength` 或 UTF-16 `String.Length` 作为持久化门禁。共享策略同时
计算 Unicode scalar、grapheme 与 UTF-8 byte 长度，并在 AEDS 解码后再次验证；账户手工消息、
admin 回复和 system governance notice 走同一策略。超限必须以 `Validation` 明确失败并保留
调用方原文，禁止 substring/slice 后继续写入。只有列表 preview 可以按 grapheme 边界生成独立
截断投影，存储正文和详情响应不得受 preview 影响。

`ConversationDetailV3` 同时返回本次可见结果的 `readSnapshotMessageId`。账号侧 mark-read 必须提交 `ConversationReadRequest` 的
`readThroughMessageId`；账号回复必须提交 `AccountConversationReplyRequest`，同时携带
正文与该显式读取位置。服务端不得在 mark-read 或回复事务中用数据库当前
`MAX(message.id)` 替代客户端看到的快照。

已读推进在参与者行锁内验证目标消息属于当前会话、不是 internal note，并且不小于
已持久化游标。未读数只统计游标之后、账号可见且不是该账号自己发送的消息；internal
note 既不能作为读取目标，也不能推进或增加账号未读。旧 `ConversationReplyRequest`
仅供 admin 回复使用，账号端点不兼容 body-only fallback。

无需重启的安全降级通过 reload-capable
`Messages:PreciseReadCursorEnabled=false` 暂停账号 mark-read 与回复写入，返回固定
`503 message_read_cursor_disabled`；详情和列表继续可读。降级不得恢复无 body
mark-read、事务时点 `MAX(id)` 或“账号回复即读完当前数据库”的旧语义。

账号与 admin 回复共用一条 PostgreSQL 事务写内核。事务先以 `FOR UPDATE` 锁定会话并
重新校验状态；`closed` 会话固定拒绝回复，只有显式状态变更回到 `open/pending` 后才能
继续。消息插入、会话 activity、对侧 unread 投影和本次 delivery event 必须全部成功才
提交；delivery event 仅在事务提交后发布，回滚时不得向 notification stream 暴露幽灵消息。
回复不以 PostgreSQL `xmin` 作为前置条件；状态锁与预期状态更新冲突返回 `409`。

reload-capable `Messages:ReplyWritesEnabled=false` 可在不重启进程的情况下同时暂停账号与
admin 回复，固定返回 `503 message_reply_writes_disabled`。列表、详情、状态变更和显式重开
仍可用；恢复前应处理数据库故障并核验投影一致性，不得降级为非事务写入。

admin 状态写入采用显式状态机：`open -> pending/closed`、`pending -> open/closed`、
`closed -> open`。请求必须携带审计原因；同状态请求返回 `no_change` 且不产生审计或实时事件。
有效转换使用行版本 CAS，并在同一事务内追加不可变审计和账号/admin 两类 outbox delivery；
两端都消费 `InboxConversationStatusChanged`，delivery 保存本次精确状态，禁止 worker 回读最新行
导致事件失真。`Messages:StatusMutationsEnabled=false` 可热暂停该写入并返回固定 503，恢复时
直接重新启用，不能绕过审计、CAS 或 outbox。

### 消息写入幂等身份

消息实时事件只承担“有新事实可读取”的引用通知，不承担正文复制。`InboxMessageAppend`
保留 conversation/message ID、发送方类型、时间和未读计数，但 `body` 固定为空；
`InboxConversationUpsert.lastMessage` 固定为 `null`，不得携带正文预览。账号客户端收到引用事件后，
必须从当前最后已知 message ID 调用权威 delta 读取并合并；admin 客户端重新读取列表/详情。
这样 backlog、日志转储或指标采集不会形成第二份消息正文。暂停 notification outbox consumer
只延迟提示，HTTP binary 列表与详情仍是事实读取路径。

账号创建工单、账号回复和 admin 回复都必须携带 `X-Fsus-Client-Mutation-Id`。该值由客户端
在一次用户意图开始时生成，在双击合并、请求超时和响应丢失后的重试中保持不变；服务端按
`主体类型 + 主体 ID + ClientMutationId` 建立全局写入身份，而不是按端点或 conversation
局部去重。系统消息使用稳定的 `X-Fsus-Source-Event-Id`，并把
`msg_conversation.sourceMessageId` 作为唯一来源坐标。

服务端在现有消息事务中先取得主体级 PostgreSQL advisory transaction lock，再同时检查
conversation/message 幂等记录。相同身份与相同规范化请求摘要返回最初的 conversation/message
ID，并在响应的 `idempotencyReplay` 标记重放；相同身份但摘要不同固定返回 `409`，不得覆盖、
追加消息或增加 unread。消息、activity/unread、outbox 与幂等身份必须同事务提交。

reload-capable `Messages:MutationIdempotencyEnabled=false` 可在不重启进程的情况下 fail closed
创建、两类回复和系统消息写入，固定返回 `503 message_mutation_idempotency_disabled`；列表、
详情、已读和状态变更仍可用。修复 schema 或写入链路后直接重新启用，不得回退到无幂等身份
的写入路径。

系统消息不能把外键异常当作目标账户策略。新 source event 在消息事务内锁定目标账户：普通
admin/事务通知只接收 active，封禁/恢复治理通知通过强类型 policy 显式允许 restricted；两类
都拒绝 missing/deleted/未知状态。已提交的同摘要 replay 在锁目标前返回原结果，以保证目标
随后注销时重试语义不漂移。`Messages:SystemMessageTargetValidationEnabled=false` 可热暂停新系统
消息而保留 replay，修复后直接重新启用，禁止回退到无锁检查或只靠外键。

未读状态采用“消息事实 + 单调 read cursor → 可重建 count → 可丢弃 Redis total”的单向
投影。账号 count 排除本人消息与 internal note；admin count 只包含账号发送的可见消息。
数据库拒绝负 count、跨 conversation/internal cursor 和游标后退。维护操作可按 conversation、
account 或 admin queue 重算，并在受控事务内修复历史坏游标；`Messages:UnreadRepairEnabled=false`
可热暂停维护，不改变正常消息读写，也不得让 Redis 反向覆盖数据库。

详情分页可通过 reload-capable `Messages:ThreadPaginationEnabled=false` 在不重启进程的
情况下暂停账号与 admin 详情读取，并返回固定 `503 message_thread_pagination_disabled`。
该降级只阻止详情读取，不恢复全量查询、浏览器本地假分页或文本 API fallback。

---

## HTTP 方法语义

| 方法 | 用途 |
| ------ | ------ |
| `GET` | 读取资源，幂等，可缓存；AEDS read request frame 必须使用 `Flags = 0` |
| `HEAD` | 只读取 HTTP metadata；仅用于 L0 artifact / 静态分发探测，不返回 AEDS body |
| `POST` | 创建资源或执行动作（登录/挑战/发送） |
| `PUT` | 全量更新单个资源属性（重命名） |
| `DELETE` | 删除资源 |
| `OPTIONS` | 不作为业务 API；PublicHotRead classifier 只接纳 `GET`/`HEAD`，`OPTIONS` 与带 `Origin` 的 CORS 请求回到常规 CORS/endpoint 管线（未映射方法通常为 `405 Method Not Allowed`） |

浏览器 CSP 违规上报是标准 HTTP 安全遥测边界，不是业务 JSON API，也不产生 AEDS frame。`POST /api/security/csp-report` 只接受 CSP/Reporting API JSON media type，固定 16 KiB 上限、匿名 fixed-IP 限流和 `no-store`；成功返回空 body `204`。服务端只提取 directive、disposition 与 blocked-resource 类别，不保存或回显完整 URL、query、DOM sample、source sample、Cookie、Authorization 或账号信息。

Binary 端点按资源语义使用 `GET/POST/PUT/DELETE`；认证、MFA、Passkey、上传和管理端写入均不得退回旧文本路径。
公开 HTML 的 HTTP validator 按实体是否稳定分流：静态无 nonce artifact 可使用 variant-aware strong ETag/304；每请求 nonce 会改变实体，必须返回 `private,no-store` 且不发 ETag，`If-None-Match` 不得把 nonce 页面变成 304。两类响应的 `HEAD` 都计算与 GET 一致的 headers/Content-Length，但不写 body。nonce HTML 只接受 identity streaming；若客户端显式拒绝 identity，返回 406，不能复用静态 br/gzip bytes。

公开 HTML 还必须在第一个服务器响应中表达真实资源状态。动态 SEO 路径只接受完整单段匹配：`/article/{positive-int}`、`/category/{positive-int}`、`/tag/{positive-int|valid-slug}`；额外片段、零值和无效编码固定为 404。不存在、未发布、定时未到、归档或删除的内容不得回退为 200 SPA；明确永久删除时才可使用 410。provider/DB gate 等临时故障返回 503 + `Retry-After`，不得伪装为 404。404/410/503 HTML 固定 `noindex,follow`、`Cache-Control: no-store`，不带成功页 canonical、Open Graph URL、`BlogPosting` 或 SPA boot script，也不得调度/写入普通 Public AOT cache。GET 与 HEAD 的状态和关键头一致，HEAD 不写 body。

尾斜杠唯一策略是 canonical 无尾斜杠：除 `/` 外，任何以 `/` 结尾的 HTML path 先以单跳 301 跳转到去尾斜杠路径，并保留 query string。SPA-only 的 `/search`、认证入口和账户工作区继续返回应用壳层；其它未登记路径由服务器直接返回 404，不再依赖 Vue catch-all 才建立错误语义。

`/search` 是可抓取但永不索引的 SPA-only HTML 路由。GET 与 HEAD 的首个服务器响应固定带 `X-Robots-Tag: noindex, follow`，HTML head 同时带 `noindex,follow`；Vue 导航只能接管并维持该状态，不能在 hydration 后才首次创建。搜索 URL 只接受按 `q`、`sort`、`page` 排序的 query：`q` 使用 Unicode NFC、首尾去空白并把连续 Unicode 空白折叠为一个空格，最多 128 个 UTF-16 code units；`sort` 仅接受 `relevance|latest|hot`，其中默认 `relevance` 省略；`page` 为 `1..100`，默认 `1` 省略。空值、重复项、未知项、非法 sort/page 和非规范编码单跳 301 到唯一 URL；超过 2048 字符的原始 query、超长或含非空白控制字符的 `q` 返回 400 noindex HTML。无 `q` 时唯一 URL 是 `/search`，sort/page 一并移除。

搜索 HTML 不输出 canonical、JSON-LD 或 Public AOT entry，也不进入 sitemap；搜索结果只链接文章自身 `/article/{id}` canonical。`robots.txt` 允许抓取 `/search` 以读取 noindex，只阻止搜索索引二进制/patch 资产，不能用 `Disallow: /search` 隐藏索引指令。

标签公开 URL 的长期身份固定为稳定数据库 ID：只有 `/tag/{positive-int}` 可以返回 200 并 self-canonical。历史 `/tag/{name}`（包括大小写或 Unicode NFC 等价形式）只作为迁移入口，经当前标签名或持久化 `tag_url_alias` 解析后单跳 301 到 `/tag/{id}`；标签重命名在同一事务保存旧名称 alias，因此不会改变 canonical，也不会把旧外链变成另一条 200。名称无法唯一解析时返回 404，不得跳首页。sitemap、内部链接、JSON-LD/Open Graph、navigation snapshot 与 AOT manifest 都只输出 ID URL。
Binary 写入请求必须使用 `Content-Type: application/octet-stream` 和 AEDS v2 request frame；当前生产协议拒绝 request non-zero flags，`Flags = 64` 等 future flag 只能在 `aeds-protocol.json`、负向 contract matrix、TypeScript/Worker/Wasm decoder 与 [schemas-and-errors.md#flags-登记](schemas-and-errors.md#flags-登记) 同步登记后启用。
服务端读取非空 AEDS request payload 时使用请求级 pooled buffer lease。binder 在 header/payload/CRC 校验失败、取消或异常时必须在自身 `finally` 立即归还；校验成功后把 ownership 转交给 `/api/binary/**` 请求管线，并由管线 `finally` 在端点与结果执行结束后确定归还，不能依赖 `HttpResponse.OnCompleted` 才完成主回收。消费者可在完成同步解码后 `Dispose` 提前归还；所有回收入口必须幂等，归还时清零 buffer，且归还后的 payload view 不得继续读取。客户端断连、响应未完成和异常响应都遵守同一语义；`OnCompleted` 只允许作为兜底。运行时通过 `fsus.binary_request.pool.rent_count`、`return_count`、`rented_bytes`、`returned_bytes` 与 `outstanding` 观测租借平衡。
匿名身份模式下，新账号 onboarding 必须走 `POST /api/binary/auth/anonymous/bootstrap`，请求 frame 为 `AuthAnonymousBootstrapRequest`；该路径只初始化匿名账号容器和当前 session，不接受用户提供的登录密码，也不得复用旧 username/password 契约。旧 `/api/binary/auth/register` 与 `/api/binary/auth/login` password endpoints 不再是生产 API；旧 password-auth request 编号已经从 AEDS frame catalog 下线，不能作为 legacy/test frame 继续消费。AEDS 数值 `40` 已作为 legacy admin password reset slot 退休，`43`/`44`/`45`/`46` 已作为 legacy username/password auth slots 退休；这些数值不再生成 frame 名、POD、codec 或 OpenAPI 契约。
`GET /api/binary/auth/me` 只输出 `IdentityAccountSnapshot` 匿名账号容器：`accountId`、`identityKind`、`publicHandle`、Passkey/Recovery/TOTP 状态、anonymous credential 状态和账号封禁/注销状态。成功响应必须额外携带 `X-Fsus-Access-Expires-At-Utc`，其 ISO 8601 UTC 绝对时间直接来自已验证 access principal 的 `exp`；缺失、非法或已过期的 `exp` 必须返回 401，不能回退到前端固定 TTL。该响应不得暴露内部 `sys_user.username`、`sys_user.role`、旧兼容 `id` 或 `internalUserId`，客户端也不得从普通账号快照推断 admin 权限；后台权限只能来自 independent admin principal 与 admin session Cookie。
`GET /api/binary/auth/sessions` 只返回普通账号可操作的 session id、由 browser family / OS family / form factor 组成的粗粒度设备标签、创建/最近活跃时间、登录来源与强度、可选 Passkey 友好名称、Cookie 持久化策略和当前会话标记。不得把内部 credential row id、客户端设备指纹、raw user agent、JWT/refresh token、长期 MFA 状态、精确 IP 或内部风险 HMAC 透出给 IdentityCenter 或前端 adapter。`UserSession` 持久化层同样不保存这些原始值：device/network 只使用 account-scoped rotating HMAC + epoch，UA 只保存低基数三元组；signal 缺失不阻止 Passkey，signal 变化只可影响风险分，不能成为授权、账号绑定、step-up 豁免或跨 session 撤销依据。详见 [user-session metadata privacy](../security/user-session-metadata-privacy.md)。
认证成功响应不把 access/refresh token 放入 AEDS body；HTTP 层只通过 HttpOnly Cookie 承载。JWT 签发结果是 access token 字符串与绝对 `ExpiresAtUtc` 的原子结果，登录、MFA、Passkey、refresh rotation 和 admin session 写 Cookie 时必须使用该同一绝对时间；Cookie 层不得再次读取过期分钟配置或解析 JWT，以免配置 reload 边界产生两套生命周期。浏览器按 `/auth/me` 的真实绝对到期时间减固定安全余量调度刷新，并用 Web Locks 或 BroadcastChannel 选出单一 leader；follower 只在结算后重读 `/auth/me`。refresh POST 是非幂等动作，网络结果未知时不得自动重放，只允许有界退避地重试幂等 `/auth/me`。refresh rotation 还必须在 Cookie 追加前后验证新 hash/session 仍是唯一 active 真源；同一 session 在最近轮换后的短竞争窗口内提交旧 token 返回 409 且不清 Cookie、不撤销 family，超过窗口的 replay 继续撤销 family 并返回 401。这些边界不得描述为跨 PostgreSQL、标签页与 HTTP 的原子事务。
管理端账号定位只允许通过 accountId 查询 `/api/binary/auth/{id:int}` 或 `/api/binary/admin/users` 的匿名账号搜索维度完成；旧 `/api/binary/auth/find/{username}` 已下线，`sys_user.username` 不再作为常规管理 API 查询键。
TOTP 在匿名身份模式下只作为敏感操作 step-up。TOTP issuer account label 必须使用非识别 `FsusBlog:account:{accountId}`，`/mfa/setup/start`、`/mfa/disable` 和 `/mfa/recovery/regenerate` 必须通过 `X-Fsus-Mfa-Proof` 消费对应 action 的一次性 proof，不接收旧 username/password body proof；TOTP recovery code 不得混同账户 `Recovery Key`。
`PUT /api/binary/auth/public-handle` 是唯一用户侧公开称呼写入入口，使用 `AuthUpdatePublicHandleRequest` + `StringMutationRequestPod`；空字符串表示清空。评论 public send 只能读取已持久化的 `public_handle`，未设置时拒绝 public mode，不能回退内部 username 或合成 user id。
账号侧 `GET /api/binary/comment/me` 是可归因评论记录，只返回当前账号显式 public/公开发送的评论；强匿名评论不进入该记录，也不能通过账号 ID 自删。`comment.user_id` 在评论最终态中只允许服务 public attribution，必须同时绑定 `author_mode = public`，旧 generic `idx_comment_user_id_desc` 不得作为默认匿名评论查询入口恢复。强匿名撤回若需要支持，必须另走 receipt、capability token 或 nullifier proof 方案；在此之前只允许管理员按治理权限删除。

---

## 分页约定

系统使用两种分页模式：

### 基于页码的分页（`PageResponse<T>`）

适用于：文章列表、匿名账号治理列表等需要总数的场景。

```json
{
  "items": [...],
  "total": 100,
  "nextCursor": "AQAA...",
  "hasMore": true,
  "page": 1,
  "pageSize": 20
}
```

查询参数：`?page=1&pageSize=20`

文章列表分页不做静默修正：`page` 必须大于等于 `1`，`pageSize` / binary `size` 必须在 `1..100`。缺省值仍为 `page=1`、`size=10`；显式传入 `page<1`、`size<1` 或 `size>100` 返回 `400 Bad Request`，不得回退到第一页或截断到最大值。

首页、分类和标签的公开 HTML 使用独立的抓取分页契约：第一页 canonical 是不带 query 的基础路径，第 N 页是唯一的 `?page=N`；服务端必须在首个 HTML 中读取规范化页码、输出该页文章以及可用上一页/下一页的真实 `<a href>`。显式 `page=1`、非整数、负数、0、重复 page、非规范数字或夹带其它 query 参数统一 301 到规范 URL；超过总页数返回 404。该 HTML 规范化不改变 `/api/binary/**` 的 400 参数校验契约。
公共文章列表的 page URL 是兼容层；首屏省略 `cursor`，后续页优先原样回传响应中的 opaque `nextCursor`。游标 v1 同时绑定最后一项的 UTC `createtime`、`id` 和 category/tag/keyword 归一化筛选指纹，并带完整性校验；非法、篡改或跨筛选复用的游标返回 `400 Validation`。服务端按 `createtime DESC, id DESC` 和严格边界 `(createtime < cursorTime OR (createtime = cursorTime AND id < cursorId))` 查询；兼容 page URL 也只通过顺序 keyset walk 定位，不允许公共列表回退 `OFFSET`。因此首屏之后并发插入的更新记录不会造成边界前既有记录重复或漏读。管理端文章列表继续使用独立的页码/offset 契约。

公开列表 frame/cache identity 使用 `cursor:first` 或完整 opaque cursor；page 兼容请求使用独立 `legacy-page:{page}` identity，source cache 前缀为 `v2`。旧 page cache 不与新 cursor cache 混用，文章内容 mutation 仍通过 ArticleList version 失效。客户端需要紧急降级时可在不重启服务的情况下停止发送 `cursor` 并继续使用 page URL 兼容层；不得恢复公共 SQL `OFFSET`。

### 基于游标的分页（`CursorResponse<T>`）

适用于：评论线程、消息流等无限下拉场景。

```json
{
  "items": [...],
  "nextCursor": "eyJpZCI6MTIzfQ==",
  "hasMore": true
}
```

查询参数：`?cursor=<上一次返回的 nextCursor>&limit=20`

---

## 内容协商

### 请求头

| 场景 | 要求 |
| ------ | ------ |
| Binary 读取 | `Accept: application/octet-stream` |
| Binary 写入 | `Content-Type: application/octet-stream`，请求体为 AEDS frame |
| 通知连接 | WebSocket 子协议 `fsus-aeds.v2` |

### 自定义头

| 类别 | 头部 | 方向 | 说明 |
| ------ | ------ | ------ | ------ |
| 安全强制 | `X-Fsus-Mfa-Proof` | 请求 | admin-sensitive、高价值作者/安全写操作和普通用户敏感凭据操作的一次性 step-up proof；消费语义见 [contracts.md#user-mfa--totp-step-up](contracts.md#user-mfa--totp-step-up)、[contracts.md#admin-作者工作台](contracts.md#admin-作者工作台) 与 [contracts.md#admin-安全系统](contracts.md#admin-安全系统)。 |
| 安全强制 | `X-Fsus-Admin-Bootstrap-Token` | 请求 | 首次 root admin Passkey bootstrap 的显式环境守门 token；必须匹配 `FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN` / `Admin:BootstrapToken`，root admin 存在后不再生效。 |
| 安全强制 | `X-Fsus-Admin-Handle` | 请求 | 首次 root admin Passkey bootstrap 的后台 handle；只用于 admin principal，不写入普通匿名账号。 |
| 安全强制 | `X-Fsus-Pow-Proof` | 请求 | legacy PoW proof，用于匿名账号 bootstrap、Recovery Key verify、匿名 notification stream 或 `public_read` 风险升级后的动态公开 API；不用于 PublicHotRead L0 artifact 命中路径。 |
| 安全强制 | `X-Fsus-Challenge-Proof` | 请求 | RiskControl challenge verify 成功后签发的一次性 opaque proof；业务 endpoint 只能由 `RequiresRiskControlFilter` 消费。 |
| 安全强制 | `X-Fsus-Challenge-Id` | 请求 | 与 `X-Fsus-Challenge-Proof` 绑定的 challenge id；缺失、重放或 action / route / IP / device mismatch 返回 428。 |
| 安全强制 | `X-Fsus-Challenge-Kind` | 请求 | 与 `X-Fsus-Challenge-Proof` 绑定的 provider kind，例如 `sha256PowV1`；legacy alias `security.pow` 只作为兼容输入规范化。 |
| 安全强制 | `X-Fsus-Challenge-Proof-Outcome` | 响应 | proof 被拒绝时的安全分类：`expired`、`replayed_or_missing`、`binding_mismatch`、`revoked` 或 `rejected`；不得暴露 cache key、身份值或内部原因。 |
| 安全强制 | `X-Fsus-Risk-Decision` | 响应 | 服务端当前裁决：428 只允许 `challenge` / `stepUp`；429 使用 `throttle` / `block` / `reject`。客户端不得据此维护 action→kind 策略。 |
| 安全强制 | `X-Fsus-Challenge-Action` | 428 响应 | 当前挑战绑定的服务端权威 action；客户端只能与原业务请求 identity 做严格相等校验。 |
| 安全强制 | `X-Fsus-Challenge-Route-Key` | 428 响应 | 当前挑战绑定的服务端权威 routeKey；不得由页面按文章 id 或路由文本重新推导。 |
| 安全强制 | `X-Fsus-Challenge-Policy-Version` | 428/429 响应 | 产生本次裁决的 policy version；重试/重新 issue 必须使用当前响应版本，不能复用前端缓存策略。 |
| 安全强制 | `X-Fsus-Subscription-Proof` | 请求 | 公开站点订阅退订的一次性 opaque proof；必须由服务端 proof API 签发并绑定 `SHA256(normalizedEmail)` 与归一化 channel，`DELETE /api/binary/subscriptions` 消费，缺失、重放、过期或绑定不匹配返回 428。 |
| 安全强制 | `X-Fsus-Device-Fp` | 请求 | 认证、HumanReadProof、审计和风险信号使用的设备指纹；不得包含可逆身份信息。 |
| 安全强制 | `X-Fsus-Csrf-Token` | 请求 | ASP.NET antiforgery header 名；cookie 凭据的状态变更请求同时受同源 `Origin` / `Referer` guard 保护。 |
| 上传会话 | `X-Fsus-Upload-Token` | 请求 | 除 `/init` 外的所有 `/api/binary/upload/{uploadId}` 操作都必须提交的会话 capability token；它只由 `/init` 响应返回一次，并与创建该会话的 admin principal 共同授权。 |
| 通知通道 | `X-Fsus-Notification-Stream-Protocol` | 请求 | notification preflight fallback 协议头；正式 WebSocket 仍使用 `Sec-WebSocket-Protocol: fsus-aeds.v2`。 |
| 通知通道 | `X-Fsus-Notification-Stream-Error-Code` | 响应 | notification preflight / WebSocket 握手失败业务码，例如 `account_blocked`、`auth_failed`、`pow_failed`、`risk_challenge_required`。 |
| 通知通道 | `X-Fsus-Notification-Stream-Status-Code` | 响应 | notification preflight / WebSocket 握手失败映射的 HTTP status。 |
| 测试工具 | `X-Fsus-Notification-Drill-Secret` / `X-Fsus-Notification-Drill-Timestamp` / `X-Fsus-Notification-Drill-Nonce` / `X-Fsus-Notification-Drill-Signature` | 请求 | 仅 Development/Test 映射的 notification slow-consumer resilience drill 凭据；secret 必须匹配配置，signature 为 timestamp + nonce + body 的 HMAC，timestamp 窗口为 60 秒，nonce 一次性。 |
| AOT 运维 | `X-Fsus-Public-Aot-Token` | 请求 | `GET /internal/public-aot/manifest` 与 `GET /internal/public-aot/health` 在配置 `PublicAot:ManifestToken` 时要求的 tooling token。 |
| 可观测性 | `X-Fsus-Trace-Id` | 响应 | 与 `HttpContext.TraceIdentifier`、OpenTelemetry trace 和审计上下文对齐的排障 ID；不是认证凭据。 |
| 发布身份 | `X-Fsus-Release-Id` / `X-Fsus-Release-Slot` | 响应 | 所有应用响应携带的非敏感 immutable release identity；Blue/Green 控制面同时核对 loopback 与公网实际 upstream。它们不是认证、授权或缓存变体输入，不得包含 commit、digest、token、用户身份或完整配置。 |
| L0 artifact | `X-Fsus-Frame-Encoding` | 响应 | `.aeds` artifact 命中时标记 raw/br/gzip variant。 |
| L0 诊断 | `X-Fsus-HotRead-Version` / `X-Fsus-HotRead-Artifact` / `X-Fsus-HotRead-Key` | 响应 | PublicHotRead 诊断头，默认关闭；只能通过 `PublicHotRead:EnableDiagnosticHeaders=true` 打开。 |

不存在额外的 Shield 来源校验头或旧文本 PoW answer/challenge 头运行时契约；新增 `X-Fsus-*` 头必须先登记到本表、OpenAPI `x-fsus-*` 扩展或对应 contract 文档。

Admin security 控制面中的事件/快照列表属于高放大读取面：`limit` 这类 caller-controlled 数量参数必须在 endpoint 边界 clamp 到明确上限，并挂后台 `fixed_ip` rate limit。服务层不得直接接收未限制的列表数量参数。

### FPOW proof 信封

HTTP 动态公开 API 使用 `X-Fsus-Pow-Proof`，notification stream 匿名连接的 legacy 兼容路径使用 `pow` query 参数；两者都承载同一种 base64 文本形式的二进制 FPOW 信封。前端实现位于 `src/frontend/src/services/powProofCodec.ts`。

FPOW 信封字段顺序为：`magic[4] = "FPOW"`（字节 `46 50 4f 57`）、`version:uint8 = 1`、`difficulty:int32LE`、`timestamp:int64LE`，随后是若干 `uint16LE length + utf8 bytes` 字段。HTTP header proof 字段为 `salt, nonce, signature, browserFp`；notification stream proof 字段为 `salt, nonce, signature, fp`。legacy PoW 服务端按 proof 绑定的时间戳、nonce、签名、设备指纹和 `ForwardedHeadersMiddleware` 规范化后的客户端 IP 校验；RiskControl `sha256PowV1` provider 的 HMAC 还额外绑定 challengeId、action、routeKey、subjectHash、clientIpHash、deviceFpHash 和 policyVersion 的上下文 hash。不接受旧文本 PoW answer/challenge 头，也不在 PoW 验证层回退到 raw remote IP、localhost 或 Docker bridge IP。

RiskControl 新 challenge provider 不得自定义平行 assignment 结构。PoW、Perception、PoSpace、HumanReadProof、Passkey step-up、匿名凭证和 ZK 匿名评论 proof 都必须使用 `SecurityChallengeAssignment` / `SecurityChallengeEnvelope` AEDS frame，统一携带 challengeId、traceparent、tenantId、kind、action、routeKey、subject/client IP/device fingerprint hash、issued/expires 和 escalationLevel；provider 只扩展自己的 proof 验证载荷。

PoSpace capability 不属于客户端授权输入。客户端不能执行已签发 PoSpace 时，只能在下一次 binary challenge issue 的 bounded attributes 中引用原 assignment 并给出枚举原因；服务端必须重新核验原 assignment 绑定和当前 policy，撤销旧 proof 后决定剩余 challenge、服务端允许的 fallback 或拒绝。客户端不得提交目标 kind、参数降档或 allow 意图，且重签必须有严格次数上限，避免能力协商形成降级或循环 oracle。

协议已知不等于客户端可执行。服务端和浏览器必须随同一构建发布 `SecurityChallengeCapabilityCatalog` / `challenge-capability-registry`（manifest version `2026.07.22.1`），逐 kind 区分 `kind_known`、`provider_available`、`executor_available`、`host_available` 和 `policy_eligible`。PoSpace 使用同一 universal executor 同时服务 UI 与 `notification.subscribe` headless host；签发前仍必须按 action 对应 surface fail closed，缺 executor、缺 host 或 manifest 不兼容分别返回受控 capability reason，不能进入占位组件或永久 pending。该 manifest 只描述低信息量构建能力，不得包含设备指纹、身份、Token 或 Proof。

受 RiskControl 保护的业务请求不得把 provider proof 或多个独立 token 直接发给业务 endpoint。每次 `challenge|stepUp` 裁决建立一个 UUIDv7 `envelopeId`；服务端按 `credential -> cheap-proof -> memory-proof -> scarce-artifact` 稳定排序并保存完整 required plan。初次 issue 只物化并返回第一个 actionable assignment 与 payload，其余 member 以 `planned` 保存在权威状态中。客户端按该顺序提交 `/api/binary/security/challenge/verify`；当前项先以 envelope version CAS 从 `issued -> verifying` 预约，只有赢家可消费 provider proof；成功推进再把下一项从 `planned -> issuing -> issued`，verify response 才携带该 next assignment/payload。单 challenge 是 `memberCount=1` 的同一状态机，不维护第二套 mint/consume 逻辑。

`PerceptionCharacterV3` 不复用 dictionary/JSON provider payload，而在同一 envelope frame 中使用按 assignment kind 判别的 typed binary union。server 只交付最终 PNG/Ogg Opus 和 opaque state；客户端不能控制生成参数，也不能回传媒体、recipe 或 solve duration。artifact pool 尚未接管或当前 generation 未通过完整认证时 fail closed，不得签发任何 V3。登录/admin device authority 来自服务端签发的 `sid/admin_sid`；匿名 device authority 是 Redis 权威 UUIDv7 租约与 `__Host-Fsus-Perception-Device` HttpOnly/Secure cookie，缺 cookie 时同 IP 复用已有租约，伪造或任意轮换 identity 会 fail closed，client fingerprint 只可作为非权威风险信号。normal policy publication 不改写已签发 envelope 的 policy version，verify 读取并使用 issued version；需要立即停用时由热策略停止新签发，并对 active identity 显式 revoke，不要求重启。

浏览器 composition 在首次 issue 前只选择一种 representation（默认 visual），后续仅接受 verify
response 中严格顺序的单个 deferred member；不得同时预取 visual/audio，也不得在 ambiguous
send 后自动租用新 artifact。typed adapter 必须在 Blob 分配前完成 bounded final-media 校验。
final PNG 作为 `image/png` object URL 直接交给 FsusUI image-url primitive，Opus 作为
`audio/ogg; codecs=opus` object URL 交给 accessible audio control；不允许 canvas 重建、
PNG 安全决策或客户端 generator。替换、完成、取消、过期和 unmount 都必须停止媒体并 revoke
URL。proof、opaque state 与 media 只允许存在于内存状态机，不得写入任何 browser storage。

V3 是 scarce server resource，业务 endpoint、provider 与前端不得各自选择 capacity fallback。server-owned planner 先按 action、identity assurance、risk、pool watermark/health 与预算返回 allocation/disposition；Passkey/user-presence 已满足 assurance 时优先 credential step-up，public read 不为“前端能显示”而消费 V3。comment exhaustion 只有 policy 明示时才进入 moderation queue；enrollment、recovery 与 admin security exhaustion fail closed。planner 的内部 `throttle/block/queue/cheaper-proof/unavailable` 继续映射到既有 RiskControl/AEDS coarse error 或业务 queue 语义，不新增 JSON、文本 reason 或 `allow` response。

V3 的同表示 refresh 与 visual/audio switch 都必须走 issue 请求的 replacement contract；客户端不得先异步 cancel 再签发。active-index 使用从 server-authoritative device material 派生、与 answer/token key rotation 无关的 domain-separated stable digest；answer-key HMAC 只绑定具体 challenge，replacement 校验旧 challenge 时使用其记录的旧 answer key version。服务端在触碰旧状态前完成新 media、token 和 typed payload 校验，再用一个 Redis Lua 线性化点校验旧 binding/active-index、将旧状态置为 `revoked`、以 NX 写入完整新状态和绝对 TTL，并把 active-index 切到新 challenge。commit 前失败时旧 identity 保持 active；commit 后旧 identity 永不恢复。Redis 回包丢失只按本次 operation result readback，不重放 mutation；readback 仍不确定时该 identity 保持 ambiguous fence 并 fail closed。

representation replacement 必须同时提交旧 challenge ID、旧 envelope ID 和旧 opaque state token；provider 以当前权威 action/route/subject/server-device/IP 与旧 challenge 已签发的 policy version、token hash 构造旧 state binding，并由 Redis Lua 原子校验后 revoke；替换成功后新 challenge 再绑定当前发布的 policy version。仅知道 challenge ID、跨主体、伪造旧 policy 或替换任一 binding 都不能撤销旧 challenge；已经显式撤销或过期的旧 challenge 也不能再次授权 replacement。

refresh、显式 cancel、身份或 route generation 变化和组件卸载必须先 tombstone 本地 generation，并通过 binary-only `POST /api/binary/security/challenge/cancel` best-effort 撤销服务端 envelope；迟到 issue/verify 结果不得恢复本地状态。取消请求重新绑定 action、route、subject 与 client IP；普通 provider 继续绑定当前 device fingerprint/policyVersion。V3 cancel 必须先从当前请求解析 server-issued device authority，用旧 challenge 的 answer-key version 派生 device HMAC，再以 envelope/action/route/subject/device/IP/issued-policy/media/representation/token hash 的完整 Redis Lua binding 原子 revoke；不得用存储态 device 值替当前调用者授权。binding mismatch 对外保持 opaque success，V3 基础设施故障只返回 coarse `unavailable`，具体成功、终态、绑定失败或 Redis 原因仅写低基数 audit。无重启降级仍以热策略禁止新组合为主；cancel transport 不得变成 JSON fallback 或绕过 proof 一次性消费。

任一 member 验证成功只推进 envelope，不签发可用于业务的 proof；仅当全部 required members 均为 verified 时才能 mint 一个 aggregate `X-Fsus-Challenge-Proof`。最终业务 header 为兼容现有 transport 仍使用最后一个 ordered member 的 `challengeId` / `kind`，但 opaque proof claims 必须额外绑定 `envelopeId` 与 ordered `requiredKinds`，并继续绑定 action、routeKey、subject、client IP/device、policyVersion、expiry 和一次性 nonce；服务端消费时同时校验这些 claims，客户端不能通过选择最后一项或重排 kinds 声明完成。任一 required member 失败、过期、撤销、重放、顺序错乱或 envelope 被替换时都 fail closed，且不能进入 completed。

aggregate verify 成功响应返回服务端权威 `expiresAtUnixMs`，客户端不得固定推算五分钟。Proof Store 只允许内存态 `available -> reserved/in_flight -> consumed|expired|replayed|rejected`；只有确定请求尚未发送时才能恢复 reservation，一旦请求可能到达服务端，超时、连接重置与业务拒绝都必须终结 token 并重新 issue。旧客户端若不能执行 `memberCount>1`，必须收到明确版本/能力不兼容结果，不能只执行 `assignments[0]` 后继续业务。UI challenge host 与 notification headless flow 必须调用同一个 envelope runner；runner 允许顺序执行或 policy 明示的有界并行，但 expensive Worker 有固定并发上限，refresh、cancel、身份/route generation 变化和 unmount/dispose 会终止整个 envelope并丢弃迟到结果。

V3 artifact lease 只允许发生在赢得 `issuing` transition 的请求内；初次 issue 和任何尚未权威完成前置 member 的请求都不可到达 V3 provider。前置 proof 同样只有赢得 `verifying` transition 的请求可调用 provider，避免 consume-once proof 的并发 loser 破坏 winner。并发 loser、Redis CAS 不确定或进程中断均 fail closed，不得重试 provider issue 或租用第二个 artifact。visual/audio representation 在 admission 初始 issue 时写入权威 envelope，延迟 provider 不从后续 verify 请求重新推断；切换表示必须 revoke 原 envelope 并建立新 chain。

无需重启的回退只能热更新 RiskControl policy 禁用 multi-challenge band、把受影响 action 切到 `observe|disabled`，或回滚 last-known-good policy；已签发 envelope 保持 fail closed 直到 TTL 到期。回退不得拆分为多个 proof、恢复 `assignments[0]`、允许客户端自报 completed 或新增 JSON fallback，认证、admin step-up、notification stream、binary-only 与 legacy PoW 边界保持启用。

普通业务命令必须先提交给服务端；只有收到结构化 428，transport 才把 `X-Fsus-Risk-Decision`、action、routeKey、policyVersion 交给统一 challenge runtime。runtime 必须校验 action/routeKey 与原命令完全一致，再按服务端本次签发的 capability 选择 executor；前端不得预先 issue、维护 `securityBusinessChallengeGates` 或缓存 action→kind 映射。策略在流程中切换时，以最新 428/LKG 服务端裁决为准，旧 challenge 被重新签发或 fail closed；评论 mutation 保留同一 payload closure 与固定 mutation identity，未知网络结果不自动重放。

notification stream 匿名订阅的 `notification.subscribe` action 使用同一个 ordered envelope runner 和 aggregate proof 生命周期，但最终 proof 只进入 preflight 的 `X-Fsus-Challenge-*` headers。preflight 原子消费 aggregate proof 后设置 path-bound、HttpOnly、SameSite=Strict 的短效 opaque grant session cookie；正式 WebSocket 只消费该 grant，URL、日志和 reconnect 都不携带原 proof。grant 也是一次性的：断线重连必须重新 preflight；服务端返回 challenge required 时客户端显式 issue 新 envelope，同一 token 不得被并发连接保留。legacy FPOW 的 `pow` query 兼容路径不改变。Passkey assertion 失败只能写风险信号，不改变登录响应 frame；Passkey assertion 成功可写负分风险信号，并继续以 Passkey 作为 MFA 已满足的登录凭据。

`/api/binary/security/challenge/verify` 的尝试次数限制是服务端 hot-path 安全控制，不改变 AEDS request / response contract。端点只依赖 `ISecurityChallengeVerifyRateLimiter`；限流状态必须落在统一缓存 `SecurityChallengeVerifyRateLimit` policy 下，按 1 分钟窗口、客户端 IP hash、device fingerprint hash、规范化 action 和 challengeId hash 计数，超过 3 次时仍返回通用 `challenge_failed`，并写 `SecurityChallengeRejected` 风险信号。

---

## 状态码约定

| 状态码 | 含义 |
| -------- | ------ |
| `200 OK` | 操作成功 |
| `204 No Content` | 预检或无 body 操作成功，例如 notification preflight 成功 |
| `304 Not Modified` | L0 artifact 的 variant-aware `ETag` 命中当前 `Accept-Encoding` variant |
| `400 Bad Request` | 参数无效、业务校验失败 |
| `401 Unauthorized` | 未提供或无效的 Bearer Token |
| `403 Forbidden` | 权限不足（已登录但角色不满足） |
| `404 Not Found` | 资源不存在 |
| `405 Method Not Allowed` | 方法不允许；L0 artifact 只接受 `GET` / `HEAD` |
| `406 Not Acceptable` | `Accept` 与 artifact 类型不匹配 |
| `409 Conflict` | 资源冲突（如用户名已存在、状态变更并发冲突） |
| `416 Range Not Satisfiable` | L0 artifact 不支持 Range；`.aeds` 命中声明 `Accept-Ranges: none` |
| `423 Locked` | 登录用户处于封禁/受限状态，notification stream 使用 `account_blocked`，普通业务写入锁使用 Binary `ApiError.Details = ACCOUNT_BANNED_WRITE_LOCKED` |
| `429 Too Many Requests` | 速率限制触发，响应含 `Retry-After` 头 |
| `500 Internal Server Error` | 服务端异常，错误详情不暴露给客户端 |
| `503 Service Unavailable` | L0 快照未进入 `Ready` 状态，默认带 `Retry-After: 1`；除非显式启用 fail-open 到常规管线 |

L0 artifact 的 `400` / `404` / `405` / `406` / `416` / `503` 负响应固定 `Cache-Control: no-store`，避免中间层缓存未就绪或协商失败结果。

---

## 版本管理策略

当前运行时业务 API 不使用 `/api/v1/`、`/api/v2/` 这类统一 URL 版本前缀；新模块继续落在 `/api/binary/**`、`/api/notifications/stream` 或明确登记的标准协议路径下。常规业务 **Breaking Change** 优先通过新增 frame type、payload layout、显式 route segment 或新端点表达，并在 [aeds-only-policy.md](aeds-only-policy.md) 与 [quick-reference.md](quick-reference.md) 同步登记。

AEDS wire protocol 是传输层版本，不等同于 URL 版本。当前运行时只接受 AEDS v2 header；AEDS v1 frame、未知版本和错误 header length 直接拒绝，服务端和前端不保留 v1 fallback。未来 wire-level 破兼容必须先进入 `aeds-protocol.json`、`schemas-and-errors.md`、golden fixture、TypeScript/Worker/Wasm decoder 与负向 contract matrix。

匿名身份与评论作者模式扩展使用新增 AEDS frame，而不是改写已发布 payload layout。生产新评论只允许两种模式：登录态 `/api/binary/comment` 的显式 `public`，以及无身份态 ticket + `/api/binary/comment/anonymous` 的 `zk_anonymous`。`CommentCreateV2Request` 必须同时声明 `authorMode=public` 与 `publicSendExplicitlySelected=true`；旧 `authorMode=anonymous` 明确返回 `anonymous_author_mode_retired`，并在内容过滤、风险记录、地区判定和业务写入之前停止。ZK verifier、root、proof、ticket 任一不可用、过期或 invalid 时均 fail closed，不得降级为 public 或服务器可见伪匿名。评论 composer 只展示 public/ZK 两种选择，public 不得自动选中。AEDS byte `1` 仅用于把历史记录读成 `legacy_server_visible_pseudonymous`，不能重新启用写入；迁移保留历史数量、层级、可见性、审核状态、正文和展示名，同时清除旧 nullifier、moderation subject、credential/reputation 投影并从 active 治理聚合中隔离。Passkey 和 Recovery Key 仍复用现有 frame，匿名身份不得新增平行 Passkey 协议栈。

不视为 Breaking Change 的变更：

- 新增响应字段（客户端应忽略未知字段）
- 新增可选请求参数
- 新增端点

视为 Breaking Change 的变更：

- 移除或重命名现有字段
- 修改字段类型
- 移除端点
- 修改认证要求（降权除外）

---

## 通知通道设计约定

真相源：[`NotificationStreamHandshakeService.cs`](../../src/backend/Infrastructure/NotificationStream/NotificationStreamHandshakeService.cs)、[`NotificationStreamHandler.cs`](../../src/backend/Infrastructure/NotificationStream/NotificationStreamHandler.cs)、[`NotificationStreamSessionService.cs`](../../src/backend/Infrastructure/NotificationStream/NotificationStreamSessionService.cs)。

### 通道

- 正式通知端点：`GET /api/notifications/stream`，仅接受 WebSocket upgrade。
- 子协议：`Sec-WebSocket-Protocol: fsus-aeds.v2`；preflight fallback 可用 `X-Fsus-Notification-Stream-Protocol: fsus-aeds.v2`。
- 每条业务消息都是 AEDS binary frame；事件 frame 使用 `AedsFrameType.NotificationEvent = 69`，心跳 frame 使用 `AedsFrameType.NotificationHeartbeat = 70`，错误使用 `ApiError = 251`（见 [schemas-and-errors.md#aedsframetype-枚举](schemas-and-errors.md#aedsframetype-枚举)）。

### 握手预检

`GET /api/notifications/stream/preflight` 复用认证、匿名 RiskControl / legacy PoW、cursor 和协议校验，但不要求 WebSocket upgrade；成功返回 `204`，失败返回 AEDS `ApiError` frame，并写入 `X-Fsus-Notification-Stream-Error-Code` / `X-Fsus-Notification-Stream-Status-Code`。preflight 只通过 `X-Fsus-Challenge-*` header 接收并原子消费 `notification.subscribe` RiskControl proof，成功后设置短效一次性 HttpOnly grant；正式 WebSocket 只消费 grant，原 proof 不进入 URL。legacy `pow` query 参数继续兼容。公开事件不绕过匿名订阅准入。

### 匿名 vs 认证

匿名连接只接收公开事件（GlobalNotice、CacheControl 等），但匿名不等于零门槛：`NotificationStreamHandshakeService` 在 `!isAuthenticated` 时先接受有效 legacy `pow`，否则按 `notification.subscribe` RiskControl 裁决要求 proof、升级 PoSpaceV1 或阻断，失败映射为 `risk_challenge_required`、`risk_challenge_rejected`、`risk_control_blocked` 等握手失败码。已认证用户额外接收私人事件（MessageReceived、InboxConversationUpsert 等）；如果请求携带认证头但认证失败，握手返回 `auth_failed`。服务端确认 Passkey signature counter 回滚后会先撤销该账号全部普通会话，再向仍连接的账号通道发布 `SessionRevoked`。客户端收到该事件必须立即清除普通账号态并跨 tab 标记 `user-expired`，不得同时注销独立 admin principal。

### 错误码与持久化对照

| 失败码 | 持久化源 | 缓存层 | miss 回查 | HTTP status | AEDS frame |
| -------- | ---------- | -------- | ----------- | ------------- | ------------ |
| `websocket_required` | WebSocket upgrade 语义 | 无 | 无 | `426` | `ApiError` |
| `protocol_mismatch` | `fsus-aeds.v2` 子协议 | 无 | 无 | `409` | `ApiError` |
| `auth_failed` | JWT / cookie auth 结果 | 认证栈内部 | 认证栈处理 | `401` | `ApiError` |
| `pow_failed` | PoW challenge / replay proof | SecurityPowProof / risk cache | PoW service 校验 | `401` 或 `400` | `ApiError` |
| `risk_challenge_required` | RiskControl `notification.subscribe` 裁决 | SecurityChallengeProof / risk cache | RiskControl policy 校验 | `428` | `ApiError` |
| `risk_control_blocked` | RiskControl `notification.subscribe` 裁决 | SecurityRisk | RiskControl policy 校验 | `429` | `ApiError` |
| `account_blocked` | `sys_user.Status` / `BanReason` | Redis 黑名单快路径 | 必须回查 DB 并回填 | `423` | `ApiError` |
| `account_deleted` | `sys_user` 不存在、删除或停用 | admission cache | 必须回查 DB | `401` | `ApiError` |

封禁账号认证成功后可以持有受限会话完成安全收尾，但普通业务写入必须由服务端返回 `423 Locked` + `ACCOUNT_BANNED_WRITE_LOCKED`；客户端禁用控件只能作为体验优化，不能替代后端写锁。完整失败码表见 [schemas-and-errors.md#notification-stream-握手失败码](schemas-and-errors.md#notification-stream-握手失败码)。

### Heartbeat 与重连

服务端用 `AedsFrameType.NotificationHeartbeat = 70` 发送 `int64 timestampUnixMs` 心跳；连接 pump 通过发送锁串行写业务 frame 与 heartbeat，避免并发写 WebSocket。客户端应存储最后收到的 cursor 值，断线重连时通过 `cursor` query 参数传递；`Last-Event-ID` 只作为兼容读取，不是首选浏览器 API。

### 测试 drill 入口

`POST /_fsus/testing/notification-stream/publish` 只在 `Development` / `Test` 环境映射，且必须携带 `X-Fsus-Notification-Drill-Secret`。它通过真实 `INotificationStreamPublisher` 发布 `CacheControl` 测试事件，返回发布 event id 与 route key，用于 resilience lane 验证慢消费者关闭、心跳未饿死、正常连接业务帧投递和 cursor backlog replay。该路径不属于生产业务 API；生产环境不映射，未配置 secret 时返回 `404`。

### Test-only schema qualification bridge

### Development public-content security fixture

`POST /api/local/public-content-fixture/prepare` 的 `securityMatrix` 分支只在既有
Development + loopback + shared-secret 门控下可用。它直接消费 FsusUI 工作区的
test-only corpus 投影，通过 `IArticleCoreGateway`、`ICommentCommandService` 与
`ISystemService` 写入 run-owned 文章、评论和静态页，不增加生产业务路由，也不允许
Node 直写数据库。Production 启动继续拒绝启用该 fixture。

在线迁移资格的 HTTP bridge 不是生产业务 API，也不是第二个 migration 入口。
`MapReleaseSchemaQualificationEndpoints` 只有在 environment 精确为 `Test` 且
`SchemaMigration:QualificationEnabled=true` 时才注册：

- `POST /api/release-evidence/schema-bridge/write`：执行 source/target 双槽的有界、
  幂等 qualification write；
- `GET /api/release-evidence/schema-qualification/readiness`：把隔离 missing-Expand
  注入映射为明确的 503 `schema_incompatible`。

两条 route 即使已注册也必须通过 admin `system.config` 与 `fixed_ip`，并返回精确
`X-Fsus-Release-Id` / `X-Fsus-Release-Slot` 和 `Cache-Control: no-store`。生产环境不会
注册，配置开关不能把 Development 或 Production 变成 Test。请求/响应为窄 JSON
tooling contract，不进入 AEDS runtime API，也不能被公开客户端或正常发布脚本使用。
受保护的诊断对象必须把部署身份输出为 `releaseId`，把数据库 marker 输出为
`schemaCompatibilityCoordinate`；后者可以是 fence 或显式兼容的历史坐标，绝不能
被 UI、日志或运维调用方标注为当前应用版本。公开 readiness 仍只返回稳定的
`schema_incompatible`，不会暴露任一内部值。

### 审计与缓存清理

慢消费者（背压积压）自动断开连接，客户端需实现重连逻辑。写消息、连接中断、重连和封禁/删除状态变化必须保留可观测性；公开评论审核导致已公开评论新增、隐藏、拒绝或删除时，必须同步清理 comment cursor/frame 缓存，并通过 notification stream 推送 `CommentAdded` 或 `CommentRemoved`。

`SessionRevoked` 是会话撤销后的加速通知，不是安全真相源。即使 backlog/notification stream 暂时不可用，`sys_user_session.revokedat` 与跨实例 session validation snapshot 仍会立即拒绝旧 access/refresh session；客户端在下一次请求或 refresh 时进入重新认证。该降级无需重启，也不得为了恢复通知而重新启用已撤销 session。

---

## AOT 公开页约定

公开页（首页、文章详情、分类、标签、归档、关于、隐私政策、用户守则、版权声明）优先从 AOT 卷命中静态 HTML + AEDS payload。Bundle 格式遵循 [`PublicAotShellEntryContract`](contracts.md#aot-公开页契约)；SPA 接管后由 hydration 层用同一份 Bundle 数据初始化状态，无需二次网络请求。 无可用 public Filter seed 的 SPA 导航由 `useFilterView` 对当前目标发起一次 `TaxonomyExactMetadata` 精确读取（分类 id、标签 id、或标签名/alias），不再用 `CategoryList`/`TagList` 解析单个 Filter 目标；有效 seed 已含 taxonomy 元数据时不追加该请求。Search 不调用 taxonomy 元数据端点。文章列表仍走 `getArticles`/`searchIndex`。

每个公开 HTML 请求在 renderer、backfill 和 cache key 之前由纯 `ILocaleResolver` 一次解析：有效 `fsusblog.locale` cookie > `Accept-Language` 中 q 最高且受 catalog 支持的 range > `zh-CN`。resolver 只消费共享 locale catalog，不查询账户、数据库或网络画像。canonical locale 原子绑定 SSR bundle/visible copy、payload `renderLocale`、document lang/dir、`Content-Language`、OpenGraph/Intl 与 Public AOT/PublicHotRead key；缺失或任一不一致拒绝发布。缓存只允许十个 canonical locale 分区，原始 header 和用户 identity 不进入 key。成功 HTML 声明 `Vary: Accept-Language, Cookie`；携带其它 cookie 的请求仍退出 L0。

同一次 Public AOT render 在读取 snapshot 前捕获唯一权威 UTC instant，并以 canonical `renderTimestamp` 同时传入 Node/Vue renderer、bootstrap 与 hydration；backfill artifact 的 `GeneratedAtUtc` 必须复用该 instant。renderer request 缺失、空白、非法或非 canonical UTC timestamp 时，必须在 SSR、seed 写入和任何日期格式化之前失败，不得回退到进程时钟、Unix epoch、`generatedAt` 别名或默认 locale。

首页、分类和标签的规范页码同时进入 AOT `routeKey`（第 N 页后缀 `:page:N`）、document cache key、navigation snapshot `fullPath/canonicalPath`、hydration route seed、payload hash 与 ETag。`scope=all` manifest 枚举全部有效分页；文章可见性或 taxonomy 归属变化按 Home/Filter 页面前缀失效全部页码，再优先回填第一页，防止深分页继续返回旧列表。运行时紧急回退可禁用 Public AOT/SPA micro-navigation，让真实 `<a href>` 直接整页导航；不需要重启或恢复按钮分页。

代码证据：[`PublicAotDocumentComposer.cs`](../../src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs)、[`PublicHotReadFastPath.cs`](../../src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs)、[`PublicAotEndpoints.cs`](../../src/backend/Modules/Endpoints/PublicAotEndpoints.cs)。

### 页面输入与 SSR 真相源

公开 footer 合规信息来自 `SiteComplianceConfig` AEDS frame。空配置不得输出备案号占位；admin 保存合规配置后必须同时失效 system compliance cache、SEO/distribution cache 和 Public AOT 静态页，使 sitemap/RSS/footer 在无重启情况下收敛。

统一 SEO 与品牌资产来自同一个 `SeoConfig` AEDS frame，不新增 `/system/brand` 并行主端点。`/api/binary/system/seo` 同时承载基础 SEO、OpenGraph 预览图、favicon/browser icon、Apple Touch Icon、PWA manifest 名称/图标/theme/background、公开站点 logo/wordmark、后台 logo/折叠图标和登录 logo/icon。保存后必须通过 SEO 配置失效链路刷新 HTML head、动态 `manifest.webmanifest`、Public AOT shell、公开 shell hydration、后台与登录页品牌展示；旧配置缺失新增字段时按默认静态路径或空值补齐。资产 URL 只接受站内绝对路径或 `http/https` 绝对 URL，不接受 `javascript:`、`data:` 或协议相对 URL。设置页可以把上传结果按 `ogImage`、`brandLogo`、`faviconSet` 目标语义回填到字段；favicon/PWA 图标组从 PNG/JPG/WebP 源图生成 ICO 与多尺寸 PNG，不引入新的品牌配置端点，也不做栅格图到 SVG 的自动矢量化。

公开 head 不输出 `meta keywords`；历史 `keywords` wire/storage 字段仅用于旧配置兼容，不能作为发布门禁或排名优化信号。description 必须来自当前页面真实内容：文章优先摘要，无摘要时先把 Markdown 转为纯文本再按 Unicode、entity 与句子边界收敛；分类和标签若存在 taxonomy `filter.description`，则把该纯文本送入同一套 `Summarize` / 160 字符摘要路径并写入 meta、Open Graph、Twitter 与 JSON-LD，缺失时保留现有分类/标签生成回退，不新增 `SeoDescription` 或 `MetaDescription`；归档和固定静态页使用各自稳定且可见语义，不回退成同一段站点描述。JSON-LD 的全局实体只有一个 `WebSite`，普通页使用 `WebPage`，归档/分类/标签使用 `CollectionPage`，文章使用 `BlogPosting`。结构化数据用于帮助机器理解页面并取得展示资格，不是排名分数，也不保证富结果。

文章时间只使用内容投影：`datePublished` 是实际首次公开时间，`dateModified` 是 `article_body.updated_at` 的实质正文修改时间。可见文本、Microdata、JSON-LD、Feed 与 sitemap 必须共享这两个来源；正文时间不晚于发布时间时不重复展示“更新于”。评论、浏览量、模板和 footer 变化不得推进 `dateModified`。合法文章封面优先成为同一绝对 `og:image`、`twitter:image` 与 `BlogPosting.image`，缺失或协议/格式无效时回退站点社交图片。

社交图片有效性在上传/配置写入和构建产物验证边界完成，不允许公开 AOT 热路径逐请求探测外部 URL。发布 smoke 负责真实 HTTP 状态、`image/*` Content-Type 和浏览器 natural dimensions；composer 只负责规范化、格式 allow-list、同 URL 投影与确定性回退。

公开页结构的 SSR 入口是 [`src/frontend/src/public-renderers/renderPublicPage.ts`](../../src/frontend/src/public-renderers/renderPublicPage.ts)，该入口向 server SSR worker 暴露 `buildPublicEntry`、payload codec 与 renderer version；具体页面组合由 `publicEntryRegistry.ts`、`pageAssemblies.ts` 与 `scaffold.ts` 维护。文档和实现不得再引入额外 helper 作为公开页结构真相源。服务端 AOT provider 只提供数据型 options，不手写 hydration props、不渲染 Markdown、不拼页面内部 HTML；Node/Vue SSR worker 负责生成 `html / bootstrapPayload / hydrationPropsPayload`，服务端只做文档包装、hydration `.aeds` sidecar 写出、缓存与降级。hydration sidecar 是 content-hash URL，使用 `application/vnd.fsus.aeds` 与 immutable cache；运行时 `/api/binary/**` 仍使用 `application/octet-stream`。

`GET /api/public/navigation-snapshot.aeds?path={publicPath}` 是公开 SPA micro-navigation 的原子接管快照端点。它只接受长度不超过 512 字符的同站相对路径，并通过 Public AOT route registry fail closed 校验首页、归档、文章详情、分类、标签和固定静态页；账号、搜索、admin、协议相对 URL 和绝对外链不进入快照链路。该端点挂 `public_read` 限流，响应使用 `application/vnd.fsus.aeds`，AEDS frame 复用 `PublicAotBootstrap`，外层 envelope 的 `kind` 固定为 `public-navigation-snapshot`，内层 `bootstrapPayload` / `hydrationPropsPayload` 仍由同一个 Node/Vue SSR worker `buildEntry` 生成，避免 HTML、bootstrap 与 hydration 分裂为三套真相源。快照携带内容相关 ETag，并使用 `Cache-Control: no-cache` 要求每次导航重验证；不得使用 `max-age` 或 `stale-while-revalidate` 让文章更新后的旧快照继续可用。响应 `Content-Language` 与 payload `renderLocale` 一致，`Vary` 包含 `Accept`、`Accept-Language`、`Cookie` 与测试会话头，避免不同 locale 或隔离运行时 schema 共用代理缓存条目。

### feed / sitemap / robots 缓存约束

feed、sitemap 与 robots 等开放分发文本端点只负责生成标准格式正文、声明 `Cache-Control: public, max-age=60, stale-while-revalidate=300`、`Vary: Accept-Encoding, CF-IPCountry, X-Fsus-Region` 并挂载 OutputCache ArticleList/Seo tag；端点本身不得按响应正文手写 ETag、解析 `If-None-Match` 或绕过统一缓存失效链路。它们是通用 HTTPS response compression 的显式公开白名单，metadata 只授予这些无 secret、无请求反射的 GET/HEAD 响应；Cookie/Authorization/CSRF 请求、非 public cache 响应或错误状态会在 response start 时回落 identity。公开 integrity manifest 使用同一策略，失败/no-store manifest 不压缩。

Feed 与 sitemap 是两条独立投影：Feed 只读取按实际发布时间排序的最新 50 篇，sitemap 不得复用该限制，必须读取全部公开 canonical article identity。两者只联接 `article_body.updated_at` 获取实质正文更新时间，不读取正文；Feed 的 `date_published` 使用首次公开时间，`date_modified`/Atom `updated` 与 sitemap article `lastmod` 都使用正文更新时间，缺失正文时间时才回退发布时间。首页/归档使用公开文章集合的最近实质变化，分类/标签使用各自公开集合的最近实质变化，about/privacy/guidelines/copyright 只使用自身 `page_content.updated_at`；没有可靠时间就省略 `lastmod`，禁止使用当前时间填充。

单个 urlset 最多承载 45,000 条 URL；超过后 `/sitemap.xml` 输出 sitemap index，子文档由 `/sitemap/{page}.xml` 提供，给协议上限保留安全余量。诊断计数必须解析最终 RSS/sitemap XML（含 index 子文档），不能用独立数据库 COUNT 冒充产物覆盖。sitemap 不输出 `priority`，该字段不是排名信号。

公开 URL 的唯一权威 origin 是运行时 `Seo:BaseUrl` 与持久 SEO 配置经 `PublicOriginPolicy` 校验后的同一 origin。AOT canonical、Open Graph/JSON-LD、Feed、sitemap 和 robots Sitemap 声明必须使用同一结果；非占位持久值或 artifact 值与配置冲突时，生产启动及产物生成 fail closed，不得静默输出多套域名。

代码证据：[`DistributionEndpoints.cs`](../../src/backend/Modules/Endpoints/DistributionEndpoints.cs)、[`BlogDistributionService.cs`](../../src/backend/Services/Distribution/BlogDistributionService.cs)；JSON/feed 豁免见 [`aeds-only-policy.md#允许豁免`](aeds-only-policy.md#允许豁免)。

### 公开 AOT artifact 路径

公开 Binary 读模型与 HTML AOT 一样按 artifact 边界治理。匿名热点路径包括：

- `/api/binary/article/{id}.aeds`
- `/api/binary/article/list/home/{page}/{size}.aeds`
- `/api/binary/article/list/category/{categoryId}/{page}/{size}.aeds`
- `/api/binary/article/list/tag/{tagId}/{page}/{size}.aeds`
- `/api/binary/article/hot/{size}.aeds`
- `/api/binary/category.aeds`
- `/api/binary/tag.aeds`

这些路径由 `PublicHotReadFastPath` 在常规应用管线前读取内存快照并直接写出完整预编码 frame；hit 路径不查询 PostgreSQL、Redis、IMemoryCache、OutputCache 或文件系统。artifact miss 只返回可降级状态码，DB fallback 只能出现在后台 projector、修复任务或 admin/private 读取路径。L1/L2/OutputCache 仍是加速层，不等价于 CQRS read model。路由清单以 [`quick-reference.md#开放分发与作者工作台`](quick-reference.md#开放分发与作者工作台) 为人工速查真相源。

公开 GET 不默认要求 PoW，以免伤害 SEO、RSS、分享卡片和无 JS 阅读；但公开评论读取、公开 taxonomy、related-reading 等动态 API 会进入 `public_read` 限流和 `RiskAwarePublicReadFilter`。风险分由 Shield、RateLimiter、PoW 与 ReadProof 拒绝事件写入；达到阈值时动态 API 要求 `X-Fsus-Pow-Proof`，持续高风险返回 429。PublicHotRead artifact 命中保持零 DB/零 Redis/零 filter 快路径。

L0 classifier 是 deny-first + allowlist：`/api` 与 `/api/binary` 下 `auth`、`admin`、`author`、`manage`、`internal`、`billing`、`audit` 完整 namespace 一律不创建 fast-path feature；只有本文登记的 article/category/tag artifact 与 Public AOT HTML route 可进入 L0。只有无已认证 principal、无 Authorization/Cookie/CSRF header、无 anonymous gateway guard 会拒绝的 `X-Fsus-*` header、无 `Origin` 且 method 为 `GET`/`HEAD` 的匿名请求可以附加 feature；登录请求、CORS 请求、非安全方法、admin/author、notification stream 与未登记 dynamic binary 都回常规 authentication/authorization/CORS/audit 管线。敏感 namespace 继续走常规管线且不计入 L0 hit/miss/bytes/rejected 指标；独立 `fsus.hotread.classifier.sensitive_bypass` 仅作为 gateway/分类回归告警，不携带路径或身份 tag。

PublicHotRead 横切控制由 `PublicHotReadCrossCuttingControlCatalog` 声明为三类：`global-before-branch`（release/security headers、deployment tracking、Shield/exception/binary boundary、trace correlation）只在分叉前执行；`early-replayed`（`public_read` limiter 与轻量 request audit context）在 early branch 执行，并以 request execution state 阻止 artifact miss 后在 endpoint 管线重复取得 limiter lease或重复建立 audit context；authentication、banned-user、authorization、CORS、antiforgery/CSRF 和 anonymous gateway header guard 属于 `endpoint-only/not-applicable`，其不适用证据必须绑定上述匿名、安全方法、无 Origin 的可执行 classifier predicate。应用启动在注册任何 stage 前校验 required control 恰好一次覆盖、两端 stage、guard 唯一性、route policy、synthetic endpoint metadata 与每条 route 的实际 probe；缺项、重复或放宽即中止启动。`tools/check-public-hot-read-cross-cutting-controls.mjs --self-test` 在 CI 对同一两端来源执行漂移与负向自检；新增横切控制必须先进入 catalog，并同时补 global/early/endpoint 适用方式和行为测试。

### L0 artifact HTTP 语义

文章删除、永久删除、清空回收站或更新为不可公开状态时，写路径必须先在 Redis 建立带单调 `generation` 的 tombstone，并先发布未确认 marker 让 edge 立即 fail closed；CDN purge 成功且 receipt 状态持久化后，再发布 confirmed marker，允许各 edge 异步重建 artifact。任一 active tombstone 会让公开 artifact 路由立即返回 `410 Gone`，响应固定 `Cache-Control: no-store, no-cache, must-revalidate`、`X-Fsus-Generation` 与 `X-Fsus-Revoked`，不返回 body、`ETag` 或 `Content-Encoding`。每个 edge 的重建 worker 只有在本机新 snapshot 原子发布成功后，才按 generation compare-delete 共享 tombstone 并清除本机 marker；不得广播全局 clear，让尚未完成重建的 edge 提前恢复。CDN purge 或重建失败都保持 fail closed。未撤回的 artifact 响应携带当前 `X-Fsus-Generation`，便于 CDN/edge 对账。

撤回门禁是独立 pipeline stage，不依赖 `PublicHotRead:Enabled`。需要无重启降级 fast path 时可以把该开关热更新为 `false`，请求回到常规 endpoint，但 active tombstone 仍先返回 410，不能通过关闭 L0 绕过撤回。CDN provider 支持 `PublicArtifactRevocation:CdnProvider=Cloudflare` 直连 zone purge API，或用 `Generic` + `CdnPurgeEndpoint` 接入其它 HTTPS purge gateway；启用时配置会在启动阶段校验。bearer token 仅进入 Authorization header，不进入 marker、响应头、Pub/Sub payload 或日志。

L0 artifact 只接受匿名同源语义的 `GET`/`HEAD`；`OPTIONS`、其它 method 与带 `Origin` 的请求在分类期回常规 endpoint/CORS 管线，fast path 不注入 CORS。Binary artifact 接受空 `Accept`、`*/*` 或 `application/octet-stream`；HTML artifact 只接受空 `Accept`、`*/*` 或 `text/html`；不匹配时返回 `406`。快照未进入 `Ready` 状态时返回 `503` + `Retry-After: 1`，除非显式启用 `PublicHotRead:FailOpenWhenNotReady` 降级到常规管线。`400`/`404`/`406`/`416`/`503` 等 L0 负响应固定 `Cache-Control: no-store`，`Range` 请求返回 `416`。`.aeds` 命中声明 `Accept-Ranges: none`，并可按 artifact 预生成 raw/br/gzip variant 返回 `Content-Encoding`、`Vary: Accept-Encoding` 和 variant-aware `ETag`；`If-None-Match` 命中当前 variant 时返回 `304`。HTML artifact 在发布期编译 CSP nonce UTF-8 template；请求只写预计算 segment/slot，不保留原始 placeholder，也不重新扫描整页。

L0 snapshot 发布是受预算保护的原子操作。候选在可见前核算 raw/br/gzip、HTML/template、key/index、对象/数组/LOH 与当前 snapshot overlap；任一分项超过配置时汇总全部原因并保留旧 snapshot。`runtime.publicHotRead` 是受保护的诊断契约，匿名 readiness 不公开容量细节。article detail admission 使用访问热度与最近发布的分段 Top-K 并受 resident bytes 二次约束；未 admission 或 eviction 的文章仍走原 binary endpoint/cache 回退，不能变成文本 API 或语义降级。请求从 snapshot 的 `ReadOnlyMemory<byte>` slice 直接写出，不因统计或 eviction 增加 body copy。

publication sanity 还绑定 `visibilityPolicy=published-visible-at-cutoff-v1`、`sourceVisibility=public`、与 candidate 相同的 `sourceVersion`、`visibilityCutoffUtc` age、AEDS v2 schema/CRC/frame type、压缩表示可逆性和进程内 HMAC。仓库没有独立 `Private` 文章状态；private/non-public 边界由“只有 `Published` 可进入”证明，projector 的真实 frame materializer 必须在编码前排除 `Draft`、`Scheduled`、`Archived`、`Deleted`、`IsDeleted=true`、future `PublishedAt` 与 future `ScheduledPublishAt`/embargoed 输入。candidate 先做廉价的 publication evidence/age 检查，再做 resident budget 拒绝，最后校验全部 binary raw/br/gzip、HTML body 与实际 CSP nonce template bytes；HMAC context 包含 route/list key、artifact/frame/version、ETag/cache/encoding 及 HTML renderer/template metadata。成功后每个 binary 请求只校验将要写出的一个 variant，HTML 同时校验 body/template。超过 `PublicHotRead:MaxSnapshotAge`、future cutoff、schema 错误或 HMAC 不匹配时不发送 artifact bytes，恢复已有 request feature 后进入原 canonical endpoint；后台在 age 上限一半处排队刷新。focused 请求测试必须把 fast response 与 production mapped canonical endpoint response 做原始 byte-for-byte 比较。该检查保持 L0 零 PostgreSQL/零 Redis：DB mutation 在 commit 前先持有 runtime-scope/article owner advisory lock并建立 `TransitionPending` tombstone，durable outbox 在 commit 后 CAS-promote 同一 generation，且 `public-artifact-revocation` stage 固定先于 fast path；active tombstone 返回 410，直到新 snapshot 发布并完成对应 generation。writer 崩溃后的 recovery 必须先成功取得同一 PostgreSQL advisory lock，不能用超时猜测事务已结束。process-local HMAC 只保护发布后 backing array 的内存完整性，不声明跨实例签名或 WORM；Redis Pub/Sub 没有 subscriber ACK，因此跨节点传播线性化和 snapshot 收敛仍分别以 #399、#400 为权威验收。

状态码与 frame 目录见 [`schemas-and-errors.md#aedsframetype-枚举`](schemas-and-errors.md#aedsframetype-枚举)。

### AOT 路由 vs 真实公开 URL

`/api/binary/article/html/{pathKey}.html` 是 AOT shell 的诊断/预览 artifact 命中路径，不是 `/article/{id}`、`/category/{id}` 等真实公开 URL 的替代路由；真实页面仍由 public route + AOT shell/SPA 渲染。

### pathKey 与 routeKey 映射

`routeKey` 与 URL-safe `pathKey` 分离：`article:42` 映射为 `article-42`，`category:7`/`tag:9` 同理；`tag-name:*`、包含空白、斜杠或非 ASCII 的 routeKey 使用 `route-<sha256 前 8 字节 hex>` 稳定 hash pathKey。实现见 [`PublicHotReadFastPath.cs`](../../src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs) 的 `StableRouteHash`。

### 诊断头 `X-Fsus-HotRead-*`

可观测诊断头 `X-Fsus-HotRead-Version`、`X-Fsus-HotRead-Artifact` 与 `X-Fsus-HotRead-Key` 默认关闭，只能通过 `PublicHotRead:EnableDiagnosticHeaders=true` 打开；成功命中才写出诊断头，负响应不得泄露 artifact key。实现见 [`PublicHotReadFastPath.cs`](../../src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs)。

### AOT route manifest 与 `X-Fsus-Public-Aot-Token`

Public AOT 预热和内容变更驱动 backfill 必须消费后端权威 route manifest，而不是脚本猜测 URL。`GET /internal/public-aot/manifest` 只暴露公开 SEO route，支持 `scope=all`、`scope=hot` 与 `changedSince`，并通过 `dependencyKeys` 连接 `article:{id}`、`category:{id}`、`tag:{id}`、`article:list`、`seo`、`compliance` 等内容依赖。`GET /internal/public-aot/health` 暴露 SSR worker resource check、Node probe、`validateBundle` sample probe、队列计数、breaker 状态和 route quarantine 快照，供 release/ops 诊断；它不是浏览器运行时 API。生产环境必须配置长度至少 32 字符且独立于 JWT 的 `PublicAot:ManifestToken`，两个内部 tooling endpoint 都必须携带匹配的 `X-Fsus-Public-Aot-Token`；空 token 只允许非生产本地工具链。

代码证据：[`PublicAotEndpoints.cs`](../../src/backend/Modules/Endpoints/PublicAotEndpoints.cs)。

### AOT sentinel 与 `data-fsus-aot-head`

Public AOT document composer 只允许通过以下 5 个具名 sentinel 写入 AOT 管理区域；sentinel 是字符串相等匹配，不接受通配符。

| sentinel | 用途 |
| ---------- | ------ |
| `<!--fsus:aot:head-start-->` | SEO/head 注入起点 |
| `<!--fsus:aot:head-end-->` | SEO/head 注入终点 |
| `<!--fsus:aot:app-->` | SPA/AOT shell 挂载点 |
| `<!--fsus:aot:payloads-->` | bootstrap AEDS 注入点与 hydration `.aeds` sidecar marker 注入点 |
| `<!--fsus:aot:spa-boot-->` | PublicBootConfig 与外部 BootKernel 注入点 |

模板缺少任一 sentinel 必须失败而不是静默降级。AOT 负责维护的 `<title>`、description、robots、canonical、Open Graph、Twitter、feed、JSON-LD 和 head-model marker 必须统一带 `data-fsus-aot-head`。服务端 document composer 与 navigation snapshot 都消费 `PublicSeoHeadModel`；客户端只能在 contract schema/version、SHA-256 digest、同源 canonical、canonical path 和 page entity 全部校验后，将整组节点一次性替换。旧节点必须先作为同一历史 route 的回退模型保留，再整体移除，不允许逐字段叠加或让文章 canonical/JSON-LD 泄漏到非公开应用路由。

SPA 接管失败时采用 fail-closed：snapshot head 缺失、旧版本、digest 不符或 origin/path 不一致，当前路由不提交任何 seed/head，转为同 URL 整页导航；服务端 AOT 首屏仍可独立工作。运维可在不重启服务的情况下禁用公共 SPA 接管/让浏览器走整页导航，缓存中的旧 snapshot 因 `Cache-Control: no-cache` 必须重新验证，不能静默与新 contract 混用。CSP nonce、主题 bootstrap 和 Vite runtime 节点不属于 `data-fsus-aot-head` 替换集合。

新增 sentinel 或 head 字段必须同步更新 [`PublicAotDocumentComposer.cs`](../../src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs)、本节列表、[`contracts.md#aot-公开页契约`](contracts.md#aot-公开页契约) 与 [`tests/frontend/checks/public/check-public-aot-contracts.mjs`](../../tests/frontend/checks/public/check-public-aot-contracts.mjs) 的完整性断言。

## 单作者内容生命周期约定

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringUseCasePorts.cs`](../../src/backend/Services/Authoring/AuthoringUseCasePorts.cs)、[`useAdminArticleWrite.ts`](../../src/frontend/src/composables/useAdminArticleWrite.ts)。高价值审计定义见 [`../security.md#审计级别`](../security.md#审计级别)。

### 文章状态枚举

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringUseCasePorts.cs`](../../src/backend/Services/Authoring/AuthoringUseCasePorts.cs)。

文章状态集合由本文件的 `content.article.states` generated section 投影；公开与管理端
可见性则由删除生命周期文档中的独立 generated projections 拥有，避免在设计概述里
复制第二份状态/可见性表。

### 公开 / 管理读写分离

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AedsJsonResults.cs`](../../src/backend/Infrastructure/Results/AedsJsonResults.cs)。

公开 article Binary 端点不再按身份混合语义。匿名公开读只能使用 `/api/binary/article/**.aeds` artifact 路径，客户端必须省略 credentials；admin/private 读写统一使用 `/api/binary/admin/article/**`，可读取所有非删除状态，并可用 `status=0/1/2/3/4` 精确管理 draft、scheduled、published、archived、deleted。任何旧 query 公开路径或匿名管理查询都不得退回文本 API 或泄露未发布标题。

作者工作台生产 API 放在 `/api/binary/author/**`，全部使用 admin 授权和 AEDS frame；浏览器不可访问 JSON envelope，仓内不保留 runtime internal compatibility 层。预览、草稿、修订、管理端 taxonomy、资产、AI 辅助都属于作者私有能力。未发布正文不得进入 feed、search、sitemap、PublicAOT cache，也不得默认发送到外部 AI provider。

文章发布配置包含 Rights V3 策略。admin 创建/更新文章时，`ArticleWriteRequest V5` 必须明确表达三态 mutation：省略 rights 为 `preserve`，完整 rights payload 为 `replace`，独立 reset 标志为 `reset`；reset 不得与 replacement payload 并存。create 的 preserve/reset 绑定仓库默认策略，普通 update 的 preserve 沿用当前有效策略；revision rollback 不接受 rights mutation，而是精确复制源 revision 的不可变 rights snapshot，缺失时 fail closed。服务端只在有效策略变化时更新 `article_rights_policy`，但每个新内容 revision 都必须创建并绑定不可变 `article_rights_snapshot`。文章修订、snapshot、publication 和 mutation outbox 的 `rightsSnapshotId` 保持同一事务；计划发布只消费 revision 已绑定的 snapshot，不在 worker 中重新解析策略。

### 修订与发布坐标

`article.current_revision_id` 是作者侧当前可编辑修订；`article.current_publication_id` 是公开侧当前不可变发布记录。`article_publication` 固定关联 revision number、rights snapshot、可选 responsibility snapshot、publication number、转换类型和发布时间。公开 AOT、AEDS、搜索、缓存、feed 与 integrity 投影只能沿 `current_publication_id` 读取，不能在消费 outbox 时重新查询“最新修订”。公开列表与详情必须携带 `currentRevisionId/revisionNo/currentPublicationId/publicationNo`，且正文、标签、rights 与 responsibility 都要能回指同一发布记录。

立即发布、首次定时发布、已发布文章定时更新、归档、恢复与回滚统一经过 `ArticlePublicationTransitionWriter`。已发布文章安排未来更新时，文章继续保持 `Published` 并用 `pending_publication_at` 记录切换点；到点前旧 publication 保持可读，到点后 worker 在同一 PostgreSQL 事务内创建新 publication、切换指针并写出带精确坐标的 outbox。任一步失败都回滚，不能暴露半套新内容。完整模型与无重启回退见 [文章修订与发布坐标](article-publication-revisions.md)。

状态转换、scheduled boundary、rollback/restore 因果关系不在此处手写；分别由
[`contracts.md`](contracts.md) 的 generated transition sections 与
[`article-publication-revisions.md`](article-publication-revisions.md) 的受控 claims 拥有。

文章发布校验由 scoped `IArticlePublicationValidator` 单一拥有。`/api/binary/author/prepublish-check` 与 create/update、revision rollback、内容导入最终进入的真实文章写链必须提交同一份原始字段，不能在保存前截断后再校验。`Scheduled` / `Published` 要求完整标题、正文和有效分类；`Draft` / `Archived` 可保存未完成内容，但超长字段、危险 Markdown/HTML、内容安全拒绝、已提供但不存在的分类或标签仍阻断写入。分类存在、标签 ID 全为正数且全部存在、去重前标签数量不超过 32 的检查必须使用文章事务内同一个 scoped `ISqlSugarClient`；关系数据库约束仍是最终兜底。调用方可稳定区分 `title_invalid`、`summary_invalid`、`content_invalid`、`cover_url_invalid`、`category_not_found`、`tag_not_found` 和 `tag_limit_exceeded`。

### 预览

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringUseCasePorts.cs`](../../src/backend/Services/Authoring/AuthoringUseCasePorts.cs)。

私有预览走 `/api/binary/author/preview`。服务端只返回规范化标题、摘要、受控封面 URL、Markdown source、纯文本投影、发布前 issues 和绑定四个原始请求字段的 `sourceIdentity`；不返回 HTML。前端核对 identity 与当前表单 generation 后，以 Vue 文本插值、受控图片绑定和 FsusUI `MarkdownRenderer` 组合预览，不创建 iframe/srcdoc，也不进入公开路由或缓存。

### 草稿与本地缓存

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringUseCasePorts.cs`](../../src/backend/Services/Authoring/AuthoringUseCasePorts.cs)、[`useAdminArticleWrite.ts`](../../src/frontend/src/composables/useAdminArticleWrite.ts)。

服务端草稿以 `ownerAdminPrincipalId + draftKey` 隔离并持久化正文、分类标签、发布状态、定时发布时间、Rights V3 `rights` 策略、`clientRevision`、稳定 `serverRevision` 与编辑开始时的 `baseRevisionId`；该 owner 来自 independent admin principal 的 `admin_id`，不复用普通匿名账号 `sys_user.id`。首写必须提交 `expectedServerRevision=null` 并以 `serverRevision=1` create-only；后续自动保存提交读取到的 `expectedServerRevision`，服务端只在相等时原子更新并递增。相同 `clientRevision` 与规范化内容的重试返回当前版本但不重复递增；旧标签页或乱序保存返回 `409 draft_conflict` 且不覆盖。冲突 `ApiError.details` 只含当前版本、更新时间和截断标题摘要，客户端停止自动重试并重新读取服务端草稿供人工比较。丢弃通过 `expectedServerRevision` query 执行条件删除，不能删除已被其它标签页更新的草稿。延迟自动保存和跨设备恢复必须继续携带 `baseRevisionId`，不能在恢复时替换成随后读取到的新 article revision。

浏览器短期恢复使用有界 IndexedDB journal 保存最新未确认正文；记录按不可逆 admin identity hash、create/edit article key 与 tab owner 隔离，并携带原始 `baseRevisionId`、`serverRevision`、`clientRevision` 和正文 SHA-256。正文输入先请求 journal flush，再进入服务端自动保存 debounce；hidden `visibilitychange`、`pagehide`、`beforeunload` 与有界周期 retry 只请求同一个异步 IndexedDB owner，不发同步网络请求，也不承诺断电后事务必然完成。服务端成功只以记录 ID、`clientRevision`、正文 hash 精确确认对应记录，旧响应不得清除较新输入。journal 只提供 12 小时、单条/单 scope/全局容量受限的同浏览器恢复，不替代 admin-authenticated server draft；明文未发布正文具有本机 profile 可读风险，发布、删除、登出、换号和私有状态清理会删除适用记录。发现 journal 坐标落后于当前 article/server revision 时，自动保存保持暂停，作者必须先比较，再明确恢复或丢弃；恢复只替换正文并沿既有 revision conflict 流程继续。退休的 `fsus:article-draft:create` 与 `fsus:article-draft:edit:*` localStorage metadata 在编辑器初始化和私有存储清理时只删除 key，不解码或显示其值。

### 修订与回滚

文章 create 是 admin principal 作用域内可安全重试的命令。请求必须携带规范小写 UUID `D` 格式的 `X-Fsus-Client-Mutation-Id`；服务端以 `(adminPrincipalId, clientMutationId)` 建立唯一身份，在同一个 PostgreSQL 事务写入文章、revision/release、outbox 与请求 SHA-256/完整结果。相同身份和请求摘要返回原坐标并标记 `idempotencyReplay=true`，相同身份但不同内容返回 `409 article_mutation_content_conflict`，双击、并发、超时和响应丢失不得重复产生文章或通知。`Articles:MutationIdempotencyEnabled=false` 可热重载并仅将新 create fail closed 为 `503 article_mutation_idempotency_disabled`；读取、update、rollback、notification stream 与 binary 基础设施保持可用。表结构是 additive，回退代码时保留该表；重新启用前应确认迁移完成。48B 响应需要前后端协调部署，旧客户端只接受旧长度时不得用于新服务端写入。

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringUseCasePorts.cs`](../../src/backend/Services/Authoring/AuthoringUseCasePorts.cs)、[`useAdminArticleWrite.ts`](../../src/frontend/src/composables/useAdminArticleWrite.ts)。

文章修订历史必须通过 admin-only API 读取摘要和单条完整版本包：`GET /api/binary/author/articles/{articleId}/revisions` 与 `GET /api/binary/author/articles/{articleId}/revisions/{revisionId}`。详情同时返回正文 revision、rights snapshot、可选 responsibility snapshot、关联 release 与 `packageComplete`，并只暴露 `createdByAdminPrincipalId`，不暴露旧 `createdByUserId`。回滚使用 `POST /api/binary/author/articles/{articleId}/revisions/{revisionId}/rollback`，请求体是 `ArticleRevisionRollbackRequest(213)`，显式提交 base revision、目标状态与审计原因。服务层复用正式文章更新/失效链路，在同一事务复制源 revision 的正文、分类标签、rights 与 responsibility 到全新绑定，创建新 revision/release，记录源 revision、actor 和 reason，并让 outbox 只引用新坐标。历史行不得重新启用；历史包缺少必要 rights 时 fail closed，不能用当前策略或默认策略补齐。编辑器只在作者工作台内比较当前表单与历史版本，回滚不得直接写表。

修订正文采用不可变内容块而不是在每行 revision 重复保存 Markdown。`article_revision` 保存内容块引用与完整 metadata；内容块由规范化 Markdown 的 SHA-256 寻址，metadata-only 与 copyright-only 修订复用原块，正文改变才创建块。每个 revision 都通过自身引用直接重建，不引入差异链。完全相同的 update 在锁定并确认 base revision 后返回当前坐标和 `no_change`，不得生成 revision、publication、outbox 或 notification。旧 revision 迁移必须先回填并验证可达性，再清空内联副本；孤块清理必须带时间 cutoff 并再次以 `NOT EXISTS` 检查引用。

作者侧文章详情把 `currentRevisionId/revisionNo` 作为稳定编辑坐标。普通 update 的 `ArticleWriteRequest V5` 与 rollback 的 AEDS JSON request 都必须提交读取时取得的 `baseRevisionId`；rollback 不提供 force 绕过。服务端在同一事务的 article 行 CAS 中核对基线，失配统一返回 `409 article_revision_conflict`，其 `ApiError.details` 只含当前 `currentRevisionId/revisionNo/status/updatedAt`，且不得写正文、标签、rights、publication 或 outbox。PostgreSQL `xmin` 只保留为内部竞争检测，不进入业务请求或响应。冲突后前端保留未提交表单并要求重新载入比较，不自动重放；这同时覆盖双标签页、延迟提交和重试。内容导入固定为 create-new，不按导出 metadata 的 source article ID 覆盖现有文章，因此无需伪造 base revision。

每个 revision 可绑定 append-only 的 `article_responsibility_snapshot` 版本链。管理端以 `expectedVersion` 执行 CAS；保存只追加 `responsibilityVersion` 并保留 `previousSnapshotId`，冲突返回 `409 article_responsibility_version_conflict`，历史快照不得覆盖。已发布的当前 revision 更新责任信息时，事务内创建新的不可变 publication 并显式引用该 snapshot，同时写入携带 revision/responsibility/publication 精确坐标的 `responsibility-updated` outbox；AOT、AEDS、公开 sidecar 与 notification 只由 outbox 重放更新。管理端 `GET .../responsibility` 返回该 revision 的完整版本历史。公开 current/historical sidecar 必须沿对应 publication 的显式责任快照读取，不泄漏后台 actor。早于 revision 表的公开旧文章在 current sidecar 中返回确定性的站点作者继承，使用 `revisionNo=0`、`proofStatus=unavailable`；指定不存在或未发布的历史 revision 返回 404。预发布治理规则不变，不得转化为关键词密度或 SEO/GEO/E-E-A-T 分数门禁。

### 运维与危险操作

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AdminOperationsHealthReader.cs`](../../src/backend/Infrastructure/Operations/AdminOperationsHealthReader.cs)、[`AuthoringUseCasePorts.cs`](../../src/backend/Services/Authoring/AuthoringUseCasePorts.cs)。

DI lifetime graph 不属于公开读取面。组合根在 `builder.Build()` 前 fail closed 校验 captive dependency；仅既有 admin-only `/api/binary/author/ops/health` 在 `services` 中追加 `dependency-graph` 汇总计数，不新增公开端点、frame 或字段布局，也不向匿名/登录账号/notification stream 暴露类型名和依赖路径。候选版本若因新规则拒绝启动，保持当前 active slot 服务即可回退；不得热关闭 `ValidateScopes`，PublicHotRead、binary 与 notification stream 的运行契约不受影响。

单作者运维能力也归入 `/api/binary/author/**`，不得新增多作者协作或复杂 RBAC。`/api/binary/author/ops/**` 只返回运行时健康、备份 artifact 状态、结构化最近错误和危险操作策略；最近错误必须在审计行物化后做摘要、清理和分组，不得在 ORM projection 内拼接格式化字符串或向前端泄露 SQL 表达式片段。`/api/binary/author/cache/**` 暴露 AOT/PublicHotRead/search/sitemap/feed/comment cache 诊断、VisitLog 驱动 HotArticles/Stats 失效合并状态与手动重建入口；`/api/binary/author/integrity/**` 暴露数据一致性巡检、diff 预览和带 admin step-up 的 safe-fix 应用。所有写入型维护动作必须写高价值审计；不可逆或跨表修复必须先返回 diff，并通过统一危险操作策略要求强确认或 admin step-up proof。

### SEO 预览

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringUseCasePorts.cs`](../../src/backend/Services/Authoring/AuthoringUseCasePorts.cs)。

SEO 预览是作者工作台内的发布前质量门，不是新路由模型：当前公开 canonical 仍由 `SeoConfigContract.baseUrl + /article/{id}` 生成，新文章落库前使用 draft-preview 占位。编辑器必须展示搜索结果和分享卡片预览，并在发布/定时发布前调用 `/api/binary/author/prepublish-check`；错误项阻断，摘要/封面/标题长度、图片 alt、超大 Markdown 或未知站内链接等 warning 只能在作者填写跳过理由后继续提交，理由由服务端写入审计。

发布前检查返回的 `canPublish/issues` 是真实写入 validator 的预演结果，而不是独立提示器；即使客户端跳过该端点，真实文章事务仍执行相同 hard-error 与 taxonomy 校验。warning override 只允许覆盖 warning，不能覆盖任何 error。紧急降级无需重启：可先让作者保存 `Draft` / `Archived` 的不完整内容，或切回前一 active slot；不得关闭真实写入校验、恢复静默截断，或绕过数据库约束。

### Taxonomy

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`useAdminTaxonomyManage.ts`](../../src/frontend/src/composables/useAdminTaxonomyManage.ts)。

管理端分类/标签列表不得复用公开 `CategoryList` / `TagList` 的公开文章计数。作者工作台必须读取 `/api/binary/author/taxonomy/categories` 与 `/api/binary/author/taxonomy/tags`，用所有非删除状态或所有 `ArticleTag` 关联形成 `totalBlockingArticleCount` 与 `canDelete`，这样草稿、定时、归档和已删除关联不会被公开计数隐藏。标签删除采用严格锁定语义：只要仍有关联文章就拒绝删除，不静默移除文章上的标签关系。

分类与标签的创建/更新走同一套 `AdminTaxonomyManageView` / `useAdminTaxonomyManage` 对话框，发送 `TaxonomyMetadataMutationRequest`（`name` + 可选 `description`）。描述是可选纯文本：空白提交为 `null`，超过 500 个 Unicode 标量值由客户端与 #2851 服务端同时拒绝，不引入 Markdown/HTML 编辑器。编辑对话框打开时通过 #2852 的 exact Category/Tag metadata 读取当前描述，不得把 Description 放进管理端列表或公开 `CategoryList` / `TagList`；加载完成前该次编辑不可提交，加载失败保持不可提交并走现有管理端错误提示，避免把未解析描述静默写成 `null`。成功保存后再打开依赖 #2857 的 exact-metadata 失效，而不是列表缓存。

### 资产库

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringUseCasePorts.cs`](../../src/backend/Services/Authoring/AuthoringUseCasePorts.cs)、[`useImageUploadRuntime.ts`](../../src/frontend/src/composables/useImageUploadRuntime.ts)。

资产库是作者工作台内的复用索引，不是公开文件浏览 API。索引只记录 `/uploads/illustration/*` 的正文图片和文章封面、alt text、来源文章、hash 与引用计数；重建操作先把失去引用的行标成 `referenceCount=0`，作者确认后再通过孤儿清理删除资产库记录。孤儿清理不删除上传文件本体；物理删除必须通过独立的文件删除动作和二次确认完成。

分片上传是唯一的上传协议；`uploadId` 是服务端分配的会话 id，不是客户端可构造路径。`UploadInit` 只返回一次 `uploadToken`，而后 status、part map、part、complete 与 abort 都必须以 `X-Fsus-Upload-Token` 和创建者 admin principal 同时授权。所有 `/api/binary/upload/{uploadId}` 后续动作只接受可规范化为 32 位 GUID `N` 格式的值；服务层在 session lock 内只读取一次 v4 manifest，统一校验 owner 和 token hash，并用 `.upload-sessions` full path containment 作为最终文件系统边界。非法 `uploadId` 返回 validation error；不存在、过期、旧/损坏会话、owner 不符和缺失/错误 token 一律返回 `404 UPLOAD_SESSION_NOT_FOUND`，不得触发目录遍历、递归删除或物理路径泄露。manifest 仅存 token 的 SHA-256，比较使用固定时间字节比较；旧会话不迁移且首次发现即删除。上传 allow-list 只覆盖 jpg/jpeg/png/gif/webp 和 favicon ICO 成品；SVG 上传必须等独立 sanitizer 设计完成后才能加入。

### 评论治理

评论 ownership 使用独立认证 overlay，不进入 `CommentArticleCursor`、`CommentThreadReplyCursor`、公共 cache identity 或 notification stream payload。`GET /api/binary/comment/me?articleId={id}` 复用私有 `CommentUserCursor`，只返回当前账号在该文章的显式 public 评论记录；浏览器分页收集 comment ID 形成 `ownedCommentIds`，不接收或比较作者 account ID。实时新增后重新读取同一 overlay，登出/换账号立即清空本地集合。overlay 仅决定删除按钮展示，`DELETE /api/binary/comment/{id}` 始终重新校验数据库行的 `user_id + author_mode=public`；ZK anonymous 不进入该集合。

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringUseCasePorts.cs`](../../src/backend/Services/Authoring/AuthoringUseCasePorts.cs)、[`RegionLegalModerationService.cs`](../../src/backend/Services/Moderation/RegionLegalModerationService.cs)。

评论治理是公开讨论区前置安全门禁：新评论先完成长度、受限 Markdown、地区 `can_publish=false` 等硬拒绝校验；通过后由地区、匿名凭证、风险裁决、模型开关和处置模式计算 `Pending/Hidden/Approved` 初始状态，绝不先公开再异步撤回。需要模型的评论先写 `Pending`，只有最终 `Approved` 才进入公开评论线程；公开评论线程和回复游标仍只读取 `Approved` 且按 viewer region 过滤。模型默认 `FailOpen=false`；缺失、超时或异常保留 `Pending`，显式 fail-open 也必须通过地区与匿名策略门禁。模型与人工状态转换使用 CAS；只有 `Pending -> Approved` 才清理公开缓存并发布 `CommentAdded`，已公开评论转为 `Hidden/Rejected` 才发布 `CommentRemoved`。每次初始状态和状态变化由数据库 trigger 追加到 `comment_moderation_event`，该表拒绝 UPDATE/DELETE。作者工作台与 `/comment/me` 保留 `Pending/Approved/Rejected/Hidden` 区分，管理员权限与匿名治理权限边界不变。

举报只追加 `comment_report` 风险队列事实，不直接隐藏或拒绝评论。原因使用固定低基数分类；账号举报按 `(comment, account)` 去重，匿名举报只保存 comment-scoped HMAC，不产生可跨评论关联的身份。两类入口都执行 `fixed_ip` 限流并写结构化审计。申诉绑定触发当前 Hidden/Rejected 投影的 moderation event，每个决定最多一次；public 作者用账号所有权，强匿名作者用 management capability。复核人默认必须与原审核人不同，批准才通过既有状态转换恢复 Approved。

`comment_moderation_event` 是重建当前投影的 append-only 权威序列：事件包含 create/pending/approve/hide/reject/delete/restore/appeal、actor type、reason、policy/model version、前后状态，但禁止保存匿名证明、原始 IP 或可逆身份材料。admin timeline 读取同时返回重建状态与一致性结果；不一致必须进入修复流程，不能静默覆盖历史。

### 审核系统控制台

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`ModerationDictionaryService.cs`](../../src/backend/Services/Moderation/ModerationDictionaryService.cs)、[`RegionLegalModerationService.cs`](../../src/backend/Services/Moderation/RegionLegalModerationService.cs)。

审核系统控制台位于 `/user/manage/moderation`，后台一级导航只保留「审核系统」，评论审核是其子栏目。控制台端点使用 `/api/binary/author/moderation/**` 原生 AEDS endpoint；JSON envelope 不作为浏览器可达 runtime API 暴露。

### 审核端点契约表

| 端点 | 语义 |
| ------ | ------ |
| `overview` | 汇总队列、词库、地区策略和模型状态 |
| `dictionaries` | 只返回词库 metadata、checksum、term count 和聚合 `evidencePolicy`，不返回 raw terms |
| `policies` | 返回地区策略组合和 `CN-MAINLAND` 强制检查 |
| `regions` / `region-groups` | 返回地区 catalog 与大区成员 |
| `policy-templates` / `effective-policy/*` | 返回默认模板 presets 与 effective policy 继承预览 |
| `runtime/status` | 返回全局状态、地区 override、禁用词库集合和模型运行快照 |
| `replay/preview` | 只返回 diff 汇总，不执行变更 |
| `model/status` | 只展示模型配置和 latency/error 观测 |

### 地区 catalog 与策略继承

地区是具体匹配对象，大区只是策略复用工具，模板是工程预设而不是法律意见；默认模板必须带 `source/version/checksum/reviewed_by/reviewed_at_utc` 字段，内置模板必须标记 not legal advice，运营者必须按实际服务地区、部署地、业务类型和法律顾问意见复核。`GREATER_CHINA` 不是 `CN-MAINLAND`，`CN-HK/CN-MO/CN-TW` 不自动继承 `CN-MAINLAND` strict policy。

### 词库与策略 lifecycle

词库 reload/rollback、词库启停、地区状态、全局状态和模型 runtime/reload/rollback 都是高风险写操作，必须携带 `X-Fsus-Mfa-Proof` 并写高价值审计；会影响公开评论可见性的变更必须清理评论 cursor/frame 缓存。生产可用降级只允许 `disabled_to_pending`、`manual_review_only`、`no_public_display`、`read_only`、`emergency_lockdown` 等不会公开放行的状态，`disabled_pass_through` 在 production 下拒绝，除非显式本地开发配置打开。

### 运行时 reload / rollback

模型禁用不禁用词库，词库禁用不禁用地区策略，地区策略禁用必须回落到 `GLOBAL` baseline；`CN-MAINLAND` 严格策略变更和强制词库禁用需要 MFA、确认短语和高价值审计。`replay execute` 不得绕过 preview、MFA、确认短语和审计流程。

### 第三方模型 Provider 边界

第三方审核模型 Provider 只接入为风险信号层，契约由 FsusBlog 定义，不能返回最终发布、隐藏、地区屏蔽或地区合法性结论；Provider 开发入口见 [../moderation/third-party-model-development.md](../moderation/third-party-model-development.md)。

### 导入导出

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringUseCasePorts.cs`](../../src/backend/Services/Authoring/AuthoringUseCasePorts.cs)。

内容导入导出是作者工作台的恢复工具，不是匿名下载 API。单篇导出必须是 Markdown + frontmatter，frontmatter 同时保留可读字段和 `fsusMetadataJson` 机器元数据；全站内容包只是这些单篇导出的 JSON 聚合。导入默认按 metadata 恢复 draft/scheduled/published/archived 状态、分类、标签、封面和 revision 记录；只有作者显式传 `publish=true` 时才强制上线。

---

## 公共文章读取投影

`GET /api/binary/article/{id}.aeds` 的公开契约和安全链不变：请求仍先经过 `public_read`、RiskControl/PoW 与现有 L0 artifact 规则。文件/L0 article detail artifact miss 后，应用只允许执行 `public_article_projection(article_id PK)` 的单条 prepared 查询并直接返回已编码 AEDS frame；该读取不得 join article/category/tag/rights/proof，不得在请求时重新估算阅读时长或编码完整投影。投影 frame 必须同时通过 AEDS v2 header、受支持的 ArticleDetail payload（当前新写 `ARD5` V5，只读兼容 `ARD4` V4 与 `ARD3` V3）、CRC 与 strong ETag 校验，命中后只回填一次文件/L1 路径。

投影缺失或损坏是可恢复一致性故障：请求可进入旧 source query 兜底，但必须排队 repair；30 秒进程内 negative cache 抑制重复 DB miss，create/publish/restore/update/outbox replay 会同步清除该负缓存。`Database:PublicArticleProjection:Enabled=false` 是 reload-capable 的无需重启回退开关，只停止直接投影读取，不停止 outbox projector、旧查询、鉴权、`X-Fsus-*` headers、PoW 或统一 AEDS 错误语义。

category/tag 重命名、rights/proof、scheduled publish、revision/content 与文章全生命周期 mutation 必须在 primary write 的同一事务写入 `article_mutation_outbox`。事件列和 payload 都必须保存精确 revision/publication 坐标；replay 只允许加载该坐标，过期 publication 事件不得覆盖更新的公开投影。`article-detail-aeds` 仍是 required replay edge：DB projection、shadow parity 和 file artifact 任一步失败时不得把 edge/outbox 标记为完成。完整迁移、回填、门禁与回退说明见 [公共文章读取投影](../performance-public-article-projection.md) 与 [发布坐标一致性验证](../testing/article-publication-consistency.md)。

article mutation envelope v2 还必须携带 rights snapshot ID、responsibility snapshot/version、`occurredAt`、`publicUpdatedAt`，以及 category/tag/visibility 的 before/after scope；`releaseId` 是 `article_publication.id` 的事件字段别名。dispatcher 对列与 payload 的别名/坐标不一致 fail closed。superseded event 不发送旧通知也不重建旧 search/AEDS/AOT/HotRead，而是为每个未完成 edge 持久化相同的显式 skip reason。每个不可逆 consumer 在自己的读取/发布边界重验坐标：search 查询同时约束 `article.current_publication_id=event.releaseId`，HotRead 队列保留事件 release coordinate，notification 在发送前重验并在 `ArticleChangedPayload` 中携带 `revisionId/releaseId`。该 schema 不新增旧文本 API，也不改变 AEDS frame layout；notification stream JSON payload 的新增坐标为可空向后兼容字段，legacy v1 保持为空。

## Out of Scope

本文件只定义 API 设计哲学和跨模块约束，不重复维护以下真相源：

- `JsonApiResponse<T>` 豁免、AEDS-only gate 和原生 binary endpoint 约束：见 [`aeds-only-policy.md#允许豁免`](aeds-only-policy.md#允许豁免)、[`contracts.md#admin-作者工作台`](contracts.md#admin-作者工作台) 与 [`contracts.md#admin-安全系统`](contracts.md#admin-安全系统)。
- 错误码、AEDS frame 编号、POD 大小和 L0 负响应结构：见 [`schemas-and-errors.md`](schemas-and-errors.md)。
- 审计级别、高价值审计落库和 fallback 文件：见 [`../security.md#审计级别`](../security.md#审计级别)。
- 缓存分层、Public AOT 单一渲染链和请求路径：见 [`../architecture.md#public-aot-单一渲染链`](../architecture.md#public-aot-单一渲染链) 与 [`../architecture.md#缓存分层`](../architecture.md#缓存分层)。
- 路由速查表和端点列表：见 [`quick-reference.md#开放分发与作者工作台`](quick-reference.md#开放分发与作者工作台)。

Admin security dry-run 端点只能复用生产决策服务，不得直接复制阈值逻辑或绕过审计。`/api/binary/admin/security/risk-control/simulate` 是控制面预演入口：它可读取当前风险分或使用请求给定 riskScore，输出 `riskScore/decision/reasons/requiredChallenges/policyVersion`，但不得签发 `security_challenge`、不得修改 `SecurityRisk`、不得变更 active policy。该类 dry-run 仍要求 admin principal + `system.config`，并写入 admin security audit；若未来扩展为其他安全模拟器，也必须保持“真实决策链 + 无业务状态写入”的边界。

RiskControl 运行态写入只能使用 `/api/binary/admin/security/risk-control/options` 和 `/api/binary/admin/security/risk-control/options/rollback`。写入必须要求 admin principal、`system.config` 和一次性 `X-Fsus-Mfa-Proof`，并持久化 `security_policy_snapshot(policy_id=risk-control)`；active 损坏时启动加载只能回退 last-known-good，不得从请求路径临时拼装未审计策略。该写入只更新 RiskControl global mode、PoSpace / PublicReadChallenge / CommentRiskControl / AuthRiskControl 开关、strict multiplier 与当前 challenge policy，不改变 AntiCrawler mode 的语义。

### Authoring route capability slices

`AuthoringEndpoints.MapAuthoringEndpoints` 只创建一次 `/api/binary/author` group，再按 workflow、moderation、operations 三个 capability 注册 route。拆分不得在子方法内重新创建 group，也不得复制 prefix、tag、permission 或 rate-limit policy。最终 `EndpointDataSource` 的 58 条 method/path 必须全部能映射到同一 `TryResolveRoute` AEDS request/response frame；因此源码文件拆分不能成为新增 JSON fallback、重命名 route 或放宽 admin permission 的理由。行为 gate 见 [Runtime capability slices](../architecture/issue-1119-runtime-capability-slices.md)。

---

## 首枚 Passkey 原子 enrollment

新账号创建不是登录的同义词。`anonymous/bootstrap` 只建立显式 `provisional` 账号和短期单用途 enrollment authority；在首枚 Passkey 验证、账号 `active` 投影及正式 `UserSession` 同一事务成功前，系统不得暴露普通账号能力或长期 cookie。AEDS 继续复用 `AuthLoginFlow`，以 `enrollment_required` 明确表达客户端状态，而不是以 `passkeyEnabled=false` 猜测。

并发语义以服务端 enrollment state/request hash 为权威：同一请求可在响应丢失后幂等恢复，不同请求或双标签竞争得到 conflict；cleanup 只能删除过期 provisional，不能根据“无 Passkey”删除已迁移 active 账号。第二枚及以后 Passkey 属于已登录账号的安全凭据变更，继续要求正式 session 和 action-bound step-up。

## 参见

- [contracts.md#基础包装结构](contracts.md#基础包装结构) — 请求/响应 DTO、AOT 契约和 AEDS frame 边界
- [aeds-only-policy.md#允许豁免](aeds-only-policy.md#允许豁免) — 内部应用 API AEDS-only 治理、JSON 豁免与回归 gate
- [quick-reference.md#开放分发与作者工作台](quick-reference.md#开放分发与作者工作台) — 公开分发、Public AOT manifest 与作者工作台端点速查
- [schemas-and-errors.md#负响应](schemas-and-errors.md#负响应) / [#AedsFrameType 枚举](schemas-and-errors.md#aedsframetype-枚举) — 负响应、错误码、AEDS frame 编号与二进制结构
- [../security.md#proof-of-work-pow](../security.md#proof-of-work-pow) — PoW、JWT、MFA、审计和安全模型
- [../architecture.md#public-aot-单一渲染链](../architecture.md#public-aot-单一渲染链) — Public AOT 单一渲染链、缓存分层与 AEDS binary 架构

### 实现参考

- [`PublicAotDocumentComposer.cs`](../../src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs) — AOT 文档组装、5 个 sentinel 和 `data-fsus-aot-head` 注入
- [`PublicHotReadFastPath.cs`](../../src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs) — PublicHotRead fast path、pathKey hash、L0 诊断头和 artifact HTTP 语义
- [`PublicAotEndpoints.cs`](../../src/backend/Modules/Endpoints/PublicAotEndpoints.cs) — route manifest 与 `X-Fsus-Public-Aot-Token`
- [`DistributionEndpoints.cs`](../../src/backend/Modules/Endpoints/DistributionEndpoints.cs) — RSS / Atom / JSON Feed / sitemap / robots 缓存约束
- [`NotificationStreamHandshakeService.cs`](../../src/backend/Infrastructure/NotificationStream/NotificationStreamHandshakeService.cs) — notification stream protocol、匿名 RiskControl / legacy PoW、认证和 admission 校验
- [`NotificationStreamHandler.cs`](../../src/backend/Infrastructure/NotificationStream/NotificationStreamHandler.cs) — notification stream 握手失败头与 AEDS `ApiError` 写出
- [`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs) — 作者工作台原生 AEDS endpoint 边界
- [`SecurityEndpoints.cs`](../../src/backend/Modules/Endpoints/SecurityEndpoints.cs) — 管理端 security 原生 AEDS endpoint 边界
- [`AedsJsonResults.cs`](../../src/backend/Infrastructure/Results/AedsJsonResults.cs) — typed JSON DTO bytes 与 AEDS frame 编码边界
- [`renderPublicPage.ts`](../../src/frontend/src/public-renderers/renderPublicPage.ts) — server SSR worker 加载的公开页 renderer 入口
- [`publicEntryRegistry.ts`](../../src/frontend/src/public-renderers/publicEntryRegistry.ts) — 公开页 SSR entry registry 与页面 assembly 调度
## 发布文章正文健康门禁

公开文章详情只把非空 `article_body.markdown_content` 视为可发布正文。已发布文章缺少正文行或正文为空白时，读取链返回稳定的 `article_body_missing`，不得使用 `summary` 补正文，也不得把该结果写入 ArticleDetail cache、AEDS、Public AOT、public-hot 或搜索正文投影。草稿的空正文仍是合法的未完成内容，不复用公开损坏语义。

检测到损坏后，读取链只提交文章 ID 与低基数来源到本机有界修复队列。修复必须从 `current_publication_id` 对应且归属同一文章的 revision 恢复，并要求 `current_revision_id` 没有指向未发布草稿；成功后统一失效缓存与公开制品再重建。无法证明 revision/publication 坐标一致时保持 fail closed，不猜测正文。详细运行边界见 [`issue-1208-article-body-missing.md`](issue-1208-article-body-missing.md) 与 [`issue-1208-article-body-repair.md`](../architecture/issue-1208-article-body-repair.md)。

## 文章与线程评论策略

评论写入策略按 `site default -> article override -> thread state` 组合。公开 AEDS 端点 `GET /api/binary/comment/policy?articleId=&rootId=` 仍返回既有 `CommentPolicySnapshot` frame，但 author-mode 开关和 `snapshotHash` 是当前文章/线程的有效快照；关闭写入不影响评论读取。`POST /comment/anonymous-ticket` 与最终 public/strong-anonymous submit 必须分别重读有效策略，旧 ticket 不得绕过期间发生的关闭或线程锁定。

管理写入仅位于 authoring API：文章策略使用乐观 `expectedPolicyVersion`，线程锁只影响目标根树。慢速模式以现有 privacy-safe moderation subject hash 为键，在评论事务内原子推进；禁止使用稳定设备指纹。策略变更写 append-only audit event，并通过既有 comment-policy cache invalidation 广播使各节点及 composer 重新取快照。

## Cluster membership diagnostic boundary

`GET /api/ops/cluster/nodes` is an operational diagnostic route rather than a runtime business API. It returns the current membership, assignment, lease/checkpoint summary, lifecycle events, health and metric view as JSON and requires an independent admin principal with `system.config`, the `fixed_ip` rate-limit policy, and `no-store`. Anonymous users, normal signed-in accounts, and admin principals without that permission cannot read node identity, capabilities, load hints, active responsibilities, lease identity, or task progress.

The same response carries an additive `scheduler` object instead of adding another
operational route. It exposes the immutable assignment generation, observed time, mode,
enabled state, responsibility/replica-to-node edges, bounded placement score/reason,
optional fencing token, and unassigned causes. Lease diagnostics expose the opaque lease
ID, holder, fencing token, TTL and renew/expiry times. Checkpoint diagnostics expose only
version, byte count and SHA-256; they never return payload content. Redis key material,
network addresses, queue payloads, exception stack text and module request data remain
private. The complete graph has the same authorization, fixed-IP and no-store boundary.

The route does not add an AEDS frame, change `/api/binary/**`, or affect notification stream envelopes. `Runtime:Mode=single` returns a synthetic local healthy node and never registers the process in Redis. `static-role` and `adaptive` register the same stable capability catalog in Redis; business code cannot introduce arbitrary capability strings.

`POST /api/ops/cluster/nodes/{nodeId}/state`,
`POST /api/ops/cluster/scheduler` and
`POST /api/ops/cluster/leases/{leaseId}/release-expired` additionally require trusted
same-site origin/referer and a consumed `X-Fsus-Mfa-Proof` for `admin-sensitive`.
Operators can place a node in `Draining` or `Maintenance`, resume it as `Alive`, stop new
scheduling, or remove only an already-expired lease. They cannot force-release a live
lease, set `Suspect`/`Dead`, clear fencing counters, or expose checkpoint payloads.
Failure detection preserves operator states. Public reads, binary endpoints and
notification stream continue while scheduling is disabled. Returning to `single` is a
startup-mode rollback for the next process generation.

## Plugin Admin 控制面补充

插件控制面属于 admin authoring API，只能使用 `/api/binary/author/plugins/**`
的 AEDS v2 frame。浏览器不得自行判断 capability 风险等级，也不得把未上报的
远端节点推断成已加载；权限分类、隔离状态与 `not-reported` 节点状态均以服务端
快照为准。安装、权限、配置与生命周期写入必须叠加独立 admin principal、
`system.config`、固定 IP 限流和一次性 admin step-up。
## Current article lifecycle states

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.article-states
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.states
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.article.states -->
- `Archived`
- `Deleted`
- `Draft`
- `Published`
- `Scheduled`
<!-- FSUSBLOG-GENERATED:END content.article.states -->
