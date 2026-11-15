# 独立管理员身份

管理员从 `/admin/identity` 注册和使用 Passkey。运行时配置 `FSUSBLOG_ADMIN_ORIGIN` 和 `FSUSBLOG_ADMIN_RP_ID`。管理员域名必须和公开站点 `FSUSBLOG_PUBLIC_ORIGIN` 及站点账号的 Passkey RP 区分。线上使用 HTTPS。原生验收在环回地址使用 `https://localhost` 作为管理端，并通过 `https://127.0.0.1` 访问站点。反向代理保留原始 Host，仅转发管理员页面、身份 AEDS API 和静态资源，应用也会拒绝在该域名访问公开站点及站点账号入口。 [双主机部署配置](../../deploy/README.md#独立管理域名)

通过受控的数据库操作员运行 `admin-identity bootstrap HANDLE admin.manage`。命令建立独立主体，提交后输出一枚十分钟内有效的一次性引导密钥。浏览器在管理域完成要求用户验证的可发现 Passkey 注册，引导密钥和挑战随后失效。注册本身不签发会话。重新用 Passkey 登录后，当前浏览器获得独立的 HttpOnly、SameSite=Strict 凭据。线上使用 Secure 和 `__Host-` 前缀将凭据限定在管理主机，环回验收使用限路径的独立 Cookie。每个管理员只有一个两小时有效的会话，完成新的 Passkey 验证会原子地撤销旧会话。

`admin-identity rotate-passkey HANDLE` 撤销旧凭据和会话并签发替代引导密钥，`admin-identity revoke-all HANDLE` 撤销会话和未完成的引导或登录挑战，`admin-identity disable HANDLE` 禁用主体并移除凭据。使用数据库会话真实操作员身份 `session_user` 写入同事务的离线审计。会话查询每次复核管理员状态、代次、会话到期时间、凭据和 `admin.manage`。站点作者标志和站点 cookie 无法取得管理员身份。

新库通过 `plan` 和 `apply` 建立管理员组件版本 8。旧库先停止 v2 进程、备份并运行 `admin-identity schema`。命令取得数据库启动锁、实例所有权检查和交接锁，将结构符合原版定义的管理员组件版本 1 至 7 原子升级到版本 8。升级保留已有授权及仍有效的管理员会话，为从 v5 或更旧组件升级的库设置初始评论审核版本。数据库若使用旧版 Canvas，先运行管理员升级，再执行 `canvas-graph check` 并按检查报告处理 Canvas。启动缺少或不匹配当前组件时拒绝接入请求。

数据库操作员可用 `admin-identity grant HANDLE <权限>` 或 `admin-identity revoke HANDLE <权限>` 调整单项授权，支持 `audit.read`、`comment.moderate`、`article.write` 和 `system.config`。实际权限变化会推进该管理员的代次、撤销旧会话与待处理引导，并以数据库 `session_user` 记录授权动作。`admin.manage` 由管理员建号命令授予。 [管理员分类与标签目录](admin-taxonomy.md) · [站点页面](site-pages.md)

管理员会话页面显示当前主体的实际授权，仅加载匹配授权且由部署启用的管理区域。 `GET /api/v2/admin/identity/permissions.aeds`（AEDS 帧 32948）在独立管理来源读取当前 PostgreSQL 授权。响应中的会话代次和不透明匹配标记须与当前会话一致。每个业务端点仍自行复核权限。固定 v1 的 `/api/binary/auth/admin/me` 帧 188 包含其他身份字段，v2 沿用自己的会话与权限帧。 [v1 管理员自己的能力快照](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs#L403-L414)

管理员可查看自己最近 50 次成功的管理员登录。`GET /api/v2/admin/identity/sessions/history.aeds`（AEDS 帧 32963）只接受独立管理来源的当前管理员会话，响应绑定该会话和权限代次。记录按数据库签发顺序排列，包含登录时间、预计到期时间和状态。替换、退出或撤权会在同一事务结束旧会话及其记录。到期记录使用原有效期，新登录时清理最旧超限记录。升级前会话和旧库隔离候选缺少可信的登录时间，历史从新组件首次成功登录开始。v1 帧 170 另含会话 ID、设备指纹、User-Agent、最后活动时间和空闲到期；当前 v2 历史仅呈现上述时间和状态。 [v1 管理员会话管理](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs#L436-L496)

持有 `audit.read` 的管理员可在管理页面手动查询运行状态，或读取 `GET /api/v2/admin/identity/operations/status.aeds`（AEDS 帧 32850）。接口返回当前公开投影是否就绪、投影水位、待处理发布事件数，以及最旧待处理事件时间。数值来自当前服务进程和 PostgreSQL 账本。无当前管理员会话返回 401，当前会话缺少 `audit.read` 返回 403。v1 的 `/api/binary/author/ops/health` 同样要求 `audit.read`，另含更多依赖检查、固定来源限流和在线查看审计，当前 v2 接口仅覆盖公开投影与待处理事件。 [v1 运维端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/AuthoringEndpoints.OperationsRoutes.cs)

HTTPS 管理域上持有 `system.config` 的管理员可在管理页面手动查询已安装的风险控制。 `GET /api/v2/admin/identity/operations/risk-readiness.aeds` 返回 AEDS 帧 32851，响应使用 `no-store` 并绑定当前权限会话。公共域拒绝此路径。无效管理员会话返回 401，当前会话缺少 `system.config` 返回 403。

该读接口按启动时实际注册的端点显示公开评论的固定查询并发控制、顶层登录投稿的 Classic PoW 路由及登录回复的 Classic PoW 路由。回复路由已注册时，接口在同一个授权事务中报告 PostgreSQL 的回复通知表是否存在。账号、文章、出版物及目标评论的资格由实际提交入口检查。代理字段表示应用实际使用可信环回代理的转发地址，或使用连接对端地址。“Dynamic risk policy”对应完整风险评分运行时。强匿名运行时有独立范围。 [固定 v1 风险与强匿名范围](../issues/risk-strong-anonymous.md)

安装根评论证明策略且启用顶层登录投稿后，同一管理区域可查看当前代次和配置摘要。管理员通过专用于这项变更的 Passkey 证明，将现行 12 位 Classic PoW 的有效期设为 60 至 120 秒。初值是 120 秒。策略更新按读取的代次和摘要进行 CAS，更新与审计在一个 PostgreSQL 事务内提交。回滚从持久审计恢复上一设置，并分配新代次。签发和消费均锁定当前策略，因此已签发未使用的旧代证明在恢复旧时限之后仍无效。回复和其他动作继续使用各自的现行证明约束。升级现有库可在服务停止后运行 `root-comment-pow schema`。 [策略实现](../../src/Server/Security/RootCommentPowPolicy.cs) · [验收入口](../../tests/EndToEnd/admin-risk-readiness-flow.mjs)

候选树 `f27800a4cf80c86f37f728f4ea06441de9a5e15b` 通过 Server、Migrate 和前端构建。首次恢复因系统默认 SDK 版本不符退出，改用仓库固定的 .NET 10.0.404 后通过。同一候选经 Caddy 2.11.9、Chrome 157 和 PostgreSQL 18 分别验收了投稿关闭、仅打开回复开关、仅注册顶层投稿、回复通知表缺失和回复通知表存在五种场景。均验证公共域拒绝、管理员授权、帧类型和会话绑定，以及撤权后丢弃延迟响应。五次均正常清理。 [构建与验收记录](../../artifacts/admin-risk-readiness-validation-f27800a/)

持有 `comment.moderate` 的管理员可在管理页面审核待处理的站点账号投稿。 `GET /api/v2/admin/identity/comments/queue.aeds`（AEDS 帧 32862）按评论 ID 和文章 ID 正序返回投稿，每页最多 24 条。已删除的评论和文章不进入队列，撤回公开发布的文章保留未完成审核。正文只按文本显示。

领取、续期和释放请求位于 `/api/v2/admin/identity/comments/claim.aeds`、`claim/renew.aeds` 和 `claim/release.aeds`，使用帧 32867 和 32868。系统保存两分钟的领取、领取代次与版本和评论版本。领取绑定当前管理员会话，逾期或会话失效后可由其他有权管理员领取。续期推进领取版本，重新领取推进领取代次和版本。旧收据或评论状态变化返回 409。

在管理页面填写审核理由后，可用 Passkey 批准或拒绝一条待审评论。`comments/step-up/begin.aeds` 检查当前领取，并为帧 32869 的完整决定签发挑战。`step-up/passkey/complete.aeds` 验证已登记的凭据和用户后签发 45 秒一次性证明。客户端在同源请求 `comments/decision.aeds` 中提交证明及原决定。服务端在同个事务内校验权限、领取、评论版本，消费证明，写入决定并记录真实管理员主体及理由。缺失、过期、内容不符或已用过的证明返回 428。原 `step-up/passkey/begin.aeds` 签发的意向证明与领取绑定证明分开验证。 [v1 评论审核端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/AuthoringEndpoints.ModerationRoutes.cs) [v1 管理员二次验证](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs#L338-L401)

批量审核默认关闭。旧部署停机执行 `comment bulk-schema` 后，设 `FSUSBLOG_ADMIN_COMMENT_BATCH=true`。持有 `comment.moderate` 的管理员可在当前页明确选择 2–20 条待审评论，一次领取后逐条复核，再用一个理由和管理员 Passkey 批准或驳回。取消会尝试释放每条领取，暂时不可释放的领取会在两分钟内到期。凭据绑定当前管理员主体、会话及完整批量请求，单条审核和申诉的证明不能提交批次。

领取和决定分别以事务执行。每条决定须匹配原待审状态、评论版本、领取密钥、领取代数、领取版本及有效期。批量批准拒绝含当前地区屏蔽记录的评论。任一目标失配时，409 响应按原请求顺序标出冲突项，整个批次保持原状。成功的批次汇总关联所有逐条审核记录，并和相应的私密回复提醒一并提交。同一证明再次提交返回 428。当前范围为待审到批准或驳回。v1 的 90/115 帧、其他历史状态迁移和封禁联动仍待接入。 [固定 v1 批量服务](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Authoring/AuthoringModerationWorkflowService.cs#L307-L471)

PostgreSQL 回归覆盖逐条冲突、独立证明、两名收件账号的通知与审核共同回滚，以及收件顺序相反的并发批次。Chrome 经 Caddy HTTPS 验证 390px 管理页面的选择、领取、取消、重新领取和 Passkey 批准与驳回。停机迁移可重复执行，并拒绝用途约束被移除的结构。 [验证记录](../../artifacts/admin-comment-batch/)

认证接口位于 `/api/v2/admin/identity/`。WebAuthn 复用 AEDS 帧 63、64、66、67，当前管理员会话查询使用 v2 帧 32830。v1 还有 JWT 轮换、长时会话、敏感动作的独立验证与其他业务权限。现有内容接口继续使用各自的权限判断。 [v1 管理认证契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/api/contracts.md#independent-admin-principal-aeds-endpoints)
