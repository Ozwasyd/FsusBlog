# 独立管理员身份

管理员与普通用户默认共用统一登录入口 `/login`（单域名模式下访问未登录的 `/admin/*` 会自动跳转到 `/login?redirect=...`，首次设置也支持直接粘贴管理员一次性引导密钥；拆分独立管理域名或关闭站点 Passkey 时保留 `/admin/identity` 独立登录回退）。在 `/login` 使用管理员 Passkey 登录后，仅签发管理员会话 Cookie 并自动跳转至管理后台 `/admin/site`（或原请求 `/admin/*` 路径）；使用普通用户 Passkey 登录后，仅签发读者会话 Cookie 并自动跳转至个人账户后台 `/user/identity/mfa`。运行时未显式设置 `FSUSBLOG_ADMIN_ORIGIN` 时自动复用 `FSUSBLOG_PUBLIC_ORIGIN`（未指定 `FSUSBLOG_ADMIN_RP_ID` 时自动取对应规范化主机名）；显式设置 `FSUSBLOG_ADMIN_ORIGIN=""` 可彻底关闭在线管理入口；也可按需显式指定不同的 `FSUSBLOG_ADMIN_ORIGIN`。线上必须使用 HTTPS，且所有管理与创作路径仅接受与配置来源完全匹配的 scheme、Host 与端口，其余来源一律 fail-closed 返回 404。反向代理保留原始 Host 并重建单跳转发头。 [单域名 TLS 反代部署（Nginx / Caddy）](../../deploy/README.md)

通过受控的数据库操作员运行 `admin-identity bootstrap HANDLE`。命令建立唯一统一类型的管理员主体（集成原创作与站点管理全部能力，`article.owner_id` 及所有创作表直接外键关联 `admin_principal(id)`），提交后输出一枚十分钟内有效的一次性引导密钥。浏览器在规范来源完成要求用户验证的可发现 Passkey 注册（使用独立随机 `admin_principal.user_handle` 与 `admin_passkey_credential` 表，与读者 `blog_user` / `passkey_credential` 互不冲突），引导密钥和挑战随后失效。注册本身不签发会话。重新用 Passkey 登录后，当前浏览器获得独立的 HttpOnly、SameSite=Strict 凭据。线上使用 Secure 和 `__Host-` 前缀（`__Host-FsusAdminSession`），本机回环开发使用 `fsus-v2-admin-session`。每个管理员只有一个两小时有效的会话，完成新的 Passkey 验证会原子地撤销旧会话。

`admin-identity rotate-passkey HANDLE` 撤销旧凭据和会话并签发替代引导密钥，`admin-identity revoke-all HANDLE` 撤销会话和未完成的引导或登录挑战，`admin-identity disable HANDLE` 禁用主体并移除凭据。使用数据库会话真实操作员身份 `session_user` 写入同事务的离线审计。会话查询每次复核管理员启用状态、代次、会话到期时间与有效 Passkey 凭据；站点普通用户（`blog_user`，无 `can_author` 列）和读者 Cookie（`fsus-v2-session`）无法取得任何管理员或创作权限（访问管理/创作会话与业务端点均返回 401；读者接口 `GET /api/v2/identity/session.aeds` 只读读者 Cookie，创作接口 `GET /api/v2/authoring/session.aeds` 与管理接口 `GET /api/v2/admin/identity/session.aeds` 只读管理员 Cookie；非规范来源调用管理路径返回 404）。

新库通过 `plan` 和 `apply` 建立管理员组件版本 8。启动缺少或不匹配当前组件时拒绝接入请求。

统一管理员不再按子权限拆分：已彻底移除 `public.admin_permission` 表、`admin-identity grant|revoke` 命令及旧 `permissions.aeds`（帧 32948）接口。任意启用且完成 Passkey 登记的管理员均拥有完整创作、评论审核、站内信与站点/系统配置能力，同时完整保留来源隔离、会话代次失效、`X-Fsus-Admin-Permission-Session` 会话绑定防串响应头、敏感操作 Passkey 二次验证（Step-Up）以及申诉复核的双人隔离（原审核人不可复核自己驳回的评论）。 [管理员分类与标签目录](admin-taxonomy.md) · [站点页面](site-pages.md)

管理后台在会话激活后直接开放所有工作区（并按 HTTPS 与能力开关渐进展示高风险与签名外观面板）。固定 v1 的 `/api/binary/auth/admin/me` 帧 188 包含其他身份字段，v2 使用简洁的 `GET /api/v2/admin/identity/session.aeds`（AEDS 帧 32830）。 [v1 管理员自己的能力快照](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs#L403-L414)

管理员可查看自己最近 50 次成功的管理员登录。`GET /api/v2/admin/identity/sessions/history.aeds`（AEDS 帧 32963）只接受独立管理来源的当前管理员会话，响应绑定该会话和权限代次。记录按数据库签发顺序排列，包含登录时间、预计到期时间和状态。替换、退出或撤权会在同一事务结束旧会话及其记录。到期记录使用原有效期，新登录时清理最旧超限记录。升级前会话和旧库隔离候选缺少可信的登录时间，历史从新组件首次成功登录开始。v1 帧 170 另含会话 ID、设备指纹、User-Agent、最后活动时间和空闲到期；当前 v2 历史仅呈现上述时间和状态。 [v1 管理员会话管理](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs#L436-L496)

管理员进入站点页面（`/admin/site`）底部的「服务与版本」区域时自动查询运行与进程诊断状态（也可手动重新检查），或直接读取 `GET /api/v2/admin/identity/operations/status.aeds`（AEDS 帧 32850）与 `GET /api/v2/admin/identity/operations/cluster.aeds`（AEDS 帧 32962）。页面首层呈现服务健康、公开快照就绪、内容同步、当前版本与启动时间，并将已同步事件序号、主库租约确认及完整构建版本/实例 ID 收纳在默认折叠的「底层进程与发布诊断」中；原独立一级路由 `/admin/system` 已精简移除。无当前管理员会话返回 401。v1 的 `/api/binary/author/ops/health` 另含更多依赖检查、固定来源限流和在线查看审计，当前 v2 接口仅覆盖公开投影与待处理事件。 [v1 运维端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/AuthoringEndpoints.OperationsRoutes.cs)

HTTPS 管理域上的管理员在互动页面（`/admin/interaction`）的「评论防护」页签可查看已安装的风险控制并调整顶层评论 PoW 策略（也可手动重新检查）。 `GET /api/v2/admin/identity/operations/risk-readiness.aeds` 返回 AEDS 帧 32851，响应使用 `no-store` 并绑定当前权限会话。公共域拒绝此路径。无效管理员会话返回 401。

该读接口按启动时实际注册的端点显示公开评论的固定查询并发控制、顶层登录投稿的 Classic PoW 路由及登录回复的 Classic PoW 路由。回复路由已注册时，接口在同一个授权事务中报告 PostgreSQL 的回复通知表是否存在。账号、文章、出版物及目标评论的资格由实际提交入口检查。代理字段表示应用实际使用可信环回代理的转发地址，或使用连接对端地址。“Dynamic risk policy”对应完整风险评分运行时。强匿名运行时有独立范围。 [固定 v1 风险与强匿名范围](../issues/risk-strong-anonymous.md)

安装根评论证明策略且启用顶层登录投稿后，同一管理区域可查看当前代次和配置摘要。管理员通过专用于这项变更的 Passkey 证明，将现行 12 位 Classic PoW 的有效期设为 60 至 120 秒。初值是 120 秒。策略更新按读取的代次和摘要进行 CAS，更新与审计在一个 PostgreSQL 事务内提交。回滚从持久审计恢复上一设置，并分配新代次。签发和消费均锁定当前策略，因此已签发未使用的旧代证明在恢复旧时限之后仍无效。回复和其他动作继续使用各自的现行证明约束。统一的 CLI `plan` 和 `apply` 初始化策略及审计表。 [策略实现](../../src/Server/Security/RootCommentPowPolicy.cs) · [验收入口](../../tests/EndToEnd/admin-risk-readiness-flow.mjs)

候选树 `f27800a4cf80c86f37f728f4ea06441de9a5e15b` 通过 Server、Migrate 和前端构建。首次恢复因系统默认 SDK 版本不符退出，改用仓库固定的 .NET 10.0.404 后通过。同一候选经 Caddy 2.11.9、Chrome 157 和 PostgreSQL 18 分别验收了投稿关闭、仅打开回复开关、仅注册顶层投稿、回复通知表缺失和回复通知表存在五种场景。均验证公共域拒绝、管理员授权、帧类型和会话绑定，以及撤权后丢弃延迟响应。五次均正常清理。 [构建与验收记录](../../artifacts/admin-risk-readiness-validation-f27800a/)

持有当前有效会话的管理员可在管理页面审核待处理的站点账号投稿。 `GET /api/v2/admin/identity/comments/queue.aeds`（AEDS 帧 32862）按评论 ID 和文章 ID 正序返回投稿，每页最多 24 条。已删除的评论和文章不进入队列，撤回公开发布的文章保留未完成审核。正文只按文本显示。

领取、续期和释放请求位于 `/api/v2/admin/identity/comments/claim.aeds`、`claim/renew.aeds` 和 `claim/release.aeds`，使用帧 32867 和 32868。系统保存两分钟的领取、领取代次与版本和评论版本。领取绑定当前管理员会话，逾期或会话失效后可由其他有权管理员领取。续期推进领取版本，重新领取推进领取代次和版本。旧收据或评论状态变化返回 409。

在管理页面填写审核理由后，可用 Passkey 批准或拒绝一条待审评论。`comments/step-up/begin.aeds` 检查当前领取，并为帧 32869 的完整决定签发挑战。`step-up/passkey/complete.aeds` 验证已登记的凭据和用户后签发 45 秒一次性证明。客户端在同源请求 `comments/decision.aeds` 中提交证明及原决定。服务端在同个事务内校验权限、领取、评论版本，消费证明，写入决定并记录真实管理员主体及理由。缺失、过期、内容不符或已用过的证明返回 428。原 `step-up/passkey/begin.aeds` 签发的意向证明与领取绑定证明分开验证。 [v1 评论审核端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/AuthoringEndpoints.ModerationRoutes.cs) [v1 管理员二次验证](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs#L338-L401)

配置管理员来源后默认启用批量审核，可设 `FSUSBLOG_ADMIN_COMMENT_BATCH=false` 关闭。统一的 CLI `plan` 和 `apply` 初始化所需的表。管理员可在当前页明确选择 2–20 条待审评论，一次领取后逐条复核，再用一个理由和管理员 Passkey 批准或驳回。取消会尝试释放每条领取，暂时不可释放的领取会在两分钟内到期。凭据绑定当前管理员主体、会话及完整批量请求，单条审核和申诉的证明不能提交批次。

领取和决定分别以事务执行。每条决定须匹配原待审状态、评论版本、领取密钥、领取代数、领取版本及有效期。批量批准拒绝含当前地区屏蔽记录的评论。任一目标失配时，409 响应按原请求顺序标出冲突项，整个批次保持原状。成功的批次汇总关联所有逐条审核记录，并和相应的私密回复提醒一并提交。同一证明再次提交返回 428。当前范围为待审到批准或驳回。v1 的 90/115 帧、其他历史状态迁移和封禁联动仍待接入。 [固定 v1 批量服务](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Authoring/AuthoringModerationWorkflowService.cs#L307-L471)

PostgreSQL 回归覆盖逐条冲突、独立证明、两名收件账号的通知与审核共同回滚，以及收件顺序相反的并发批次。Chrome 经 Caddy HTTPS 验证 390px 管理页面的选择、领取、取消、重新领取和 Passkey 批准与驳回。停机迁移可重复执行，并拒绝用途约束被移除的结构。 [验证记录](../../artifacts/admin-comment-batch/)

认证接口位于 `/api/v2/admin/identity/`。WebAuthn 复用 AEDS 帧 63、64、66、67，当前管理员会话查询使用 v2 帧 32830。v1 还有 JWT 轮换、长时会话、敏感动作的独立验证与其他业务权限。现有内容接口继续使用各自的权限判断。 [v1 管理认证契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/api/contracts.md#independent-admin-principal-aeds-endpoints)

## 在线读者账号治理

管理员可在管理后台 `/admin/interaction` 的「读者账号」页签在线检索、封禁与解封站点普通读者账号（`blog_user`），所有接口均受独立管理来源校验、实时管理员会话校验与 `X-Fsus-Admin-Permission-Session` 响应头绑定保护：

- **分页检索与状态筛选**：`GET /api/v2/admin/readers.aeds`（AEDS 帧 `AdminReaderAccountPage` 33072，`Cache-Control: no-store`）支持 `status=all|enabled|disabled`、`keyword`（匹配账号名、公开评论昵称，或 `#accountId` 精确账号编号匹配，已转义 LIKE 通配符）及 `(afterAccountId, afterUserId)` 键集分页（每页最多 24 条）。响应仅返回账号状态、代次、安全能力计数（Passkey 数量、恢复密钥/TOTP 开启状态、当前有效代次会话数、评论数）及最近一条治理审计摘要，不暴露任何凭据或密钥字节。
- **Passkey 二次验证（Step-Up）与原子执行**：状态变更使用 `POST /api/v2/admin/readers/status/step-up/begin.aeds`、`complete.aeds`（动作码 12，独立表 `public.admin_reader_governance_step_up`，签发 45 秒一次性证明）及 `POST /api/v2/admin/readers/status.aeds`（请求帧 `AdminReaderStatusCommand` 33073，回执帧 `AdminReaderStatusReceipt` 33074）。所有写请求强制要求同源 `Origin` 与 `X-Fsus-Idempotency-Key`；缺失、过期或命令指纹不匹配的证明返回 HTTP 428。
- **实时吊销、幂等与不可变审计**：同一 PostgreSQL 事务内按 `ExpectedGeneration` 与目标状态执行 CAS 校验，递增 `blog_user.generation` 并更新 `enabled`；封禁时立即清空该读者全部 `user_session`（级联清理 `site_session_refresh`）以及 `login_ticket`、`passkey_challenge`、`mfa_setup`、`mfa_flow`、`site_recovery_flow`、`site_recovery_rebind`，使读者在线会话瞬时失效（返回 401）；同时写入 `public.admin_reader_governance_audit` 不可变审计记录（含 `revoked_session_count` 与 1–500 字治理理由），相同 `(principal_id, command_id)` 与相同命令指纹重试时无需重复验证证明即可安全回放原回执，参数冲突返回 409。

## 在线账号更名（读者公开昵称与管理员标识）

- **读者公开昵称（`/user/identity/mfa`）**：已登录读者可通过 `GET` / `POST /api/v2/identity/display-name.aeds`（AEDS 帧 `SiteDisplayNameState` 33077 / `SiteDisplayNameCommand` 33078，`Cache-Control: private, no-store`，绑定 `X-Fsus-Current-Session` 及同源 `Origin` 校验）读写 `public.comment_public_handle.display_name`（1–64 个不含控制字符的有效字符，≤ 384 字节）。该操作不改动底层 `blog_user.name`、Passkey 绑定或活跃会话；新自助注册的读者设置昵称后即可参与开启评论的文章讨论。
- **管理员标识更名（`/admin/identity`）**：已登录管理员可通过 `POST /api/v2/admin/identity/handle/step-up/{begin,complete}.aeds`（动作码 14，独立表 `public.admin_handle_step_up`，签发 45 秒一次性证明）及 `POST /api/v2/admin/identity/handle/execute.aeds`（帧 `AdminHandleCommand` 33079 / `AdminHandleReceipt` 33080，`Cache-Control: no-store`，绑定同源 `Origin`、`X-Fsus-Idempotency-Key` 与 `X-Fsus-Admin-Permission-Session`）在线修改 `public.admin_principal.handle`（校验 `^[a-z][a-z0-9_.-]{0,63}$`、`ExpectedHandle` CAS 与全局唯一性，冲突返回 409，缺失/失效证明返回 428）。同一事务内写入 `public.admin_handle_rename_audit`（支持原幂等键安全回放）与 `public.admin_identity_audit`（`action='rename-handle'`），并保持当前管理员会话与既有 Passkey 凭据有效。

## 服务端职责与依赖边界

管理后台在 `src/Server/Identity/` 内按身份边界与业务域显式拆分并按能力前提构造：

- **会话与事务门禁**（[`AdminSessionGate`](../../src/Server/Identity/AdminSessionGate.cs)）：唯一在线管理员会话/事务门禁，每次调用均开启受 `InstanceLease.BeginProtected` / `CommitProtected` 保护的 PostgreSQL 事务并在事务内实时核验启用状态、代次、会话到期与有效凭据，生成 `X-Fsus-Admin-Permission-Session` 绑定摘要并处理登出撤权。无状态令牌与 SQL 辅助位于 [`AdminSql`](../../src/Server/Identity/AdminSql.cs)。
- **认证仪式与 Fido2 边界**（[`AdminPasskeyStore`](../../src/Server/Identity/AdminPasskeyStore.cs)）：独占管理员引导注册、独立登录、`PasskeyStore` 统一登录委派及 Step-Up WebAuthn 挑战与断言核验细节；显式设置 `FSUSBLOG_ADMIN_ORIGIN=""` 关闭管理端时不构造该服务，也不强制解析管理端 Passkey 配置。
- **二次验证服务**（[`AdminStepUpService`](../../src/Server/Identity/AdminStepUpService.cs)）：基于 `AdminSessionGate`（与按需注入的 `AdminPasskeyStore`）管理 Step-Up 挑战签发及同事务一次性 proof 消费（`ConsumeProofAsync`），保留各动作表隔离与 401/403/428 错误分类语义。
- **独立业务域 Store**：登录历史（`AdminSignInHistoryStore`）、在线读者账号治理（`AdminReaderGovernanceStore`）、运行与风险就绪（`AdminOperationsStore`）、根评论风险策略（`AdminCommentRiskStore`）、分类标签目录与共享元数据（`AdminTaxonomyStore`、`AdminTagMetadataStore`）、评论队列/历史/审核/批量审核/申诉（`AdminCommentQueueStore`、`AdminCommentHistoryStore`、`AdminModerationStore`、`AdminModerationBatchStore`、`AdminCommentAppealStore`）、管理员站内信读写与动作（`AdminInboxStore`、`AdminInboxReadStore`、`AdminInboxActivityStore`、`AdminInboxReplyStore`、`AdminInboxStatusStore`、`AdminInboxNoticeStore`）、站点页与签名外观（`AdminSitePageStore`、`AdminAppearanceStore`）以及文章回滚/归档/回收站恢复（`AdminArticleRollbackStore`、`AdminArticleArchiveStore`、`AdminArticleTrashRestoreStore`、`AdminArticleTrashPublicationStore`）均通过显式构造函数依赖复用 `AdminSessionGate`（及需要二次验证时的 `AdminStepUpService`），并在 [`AdminIdentityEndpoints`](../../src/Server/Identity/AdminIdentityEndpoints.cs) 及各域端点按对应 `SiteCapabilities` 开关按需构造与挂载。
