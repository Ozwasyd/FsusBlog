# 独立管理员身份

管理员从 `/admin/identity` 注册和使用 Passkey。运行时配置 `FSUSBLOG_ADMIN_ORIGIN` 和 `FSUSBLOG_ADMIN_RP_ID`。管理员域名必须和公开站点 `FSUSBLOG_PUBLIC_ORIGIN` 及站点账号的 Passkey RP 区分。线上使用 HTTPS。原生验收在环回地址使用 `https://localhost` 作为管理端，并通过 `https://127.0.0.1` 访问站点。反向代理保留原始 Host，仅转发管理员页面、身份 AEDS API 和静态资源，应用也会拒绝在该域名访问公开站点及站点账号入口。 [双主机部署配置](../../deploy/README.md#独立管理域名)

通过受控的数据库操作员运行 `admin-identity bootstrap HANDLE admin.manage`。命令建立独立主体，提交后输出一枚十分钟内有效的一次性引导密钥。浏览器在管理域完成要求用户验证的可发现 Passkey 注册，引导密钥和挑战随后失效。注册本身不签发会话。重新用 Passkey 登录后，当前浏览器获得独立的 HttpOnly、SameSite=Strict 凭据。线上使用 Secure 和 `__Host-` 前缀将凭据限定在管理主机，环回验收使用限路径的独立 Cookie。每个管理员只有一个两小时有效的会话，完成新的 Passkey 验证会原子地撤销旧会话。

`admin-identity rotate-passkey HANDLE` 撤销旧凭据和会话并签发替代引导密钥，`admin-identity revoke-all HANDLE` 撤销会话和未完成的引导或登录挑战，`admin-identity disable HANDLE` 禁用主体并移除凭据。使用数据库会话真实操作员身份 `session_user` 写入同事务的离线审计。会话查询每次复核管理员状态、代次、会话到期时间、凭据和 `admin.manage`。站点作者标志和站点 cookie 无法取得管理员身份。

新库通过 `plan` 和 `apply` 建立管理员组件版本 7。旧库先停止 v2 进程、备份并运行 `admin-identity schema`。命令取得数据库启动锁、实例所有权检查和交接锁，将结构符合原版定义的管理员组件版本 1 至 6 原子升级到版本 7，保留已有授权记录，为从 v5 或更旧组件升级的库设置初始评论审核版本。数据库若使用旧版 Canvas，先运行管理员升级，再执行 `canvas-graph check` 并按检查报告处理 Canvas。启动缺少或不匹配当前组件时拒绝接入请求。

数据库操作员可用 `admin-identity grant HANDLE <权限>` 或 `admin-identity revoke HANDLE <权限>` 调整单项授权，支持 `audit.read`、`comment.moderate`、`article.write` 和 `system.config`。实际权限变化会推进该管理员的代次、撤销旧会话与待处理引导，并以数据库 `session_user` 记录授权动作。`admin.manage` 由管理员建号命令授予。 [管理员分类与标签目录](admin-taxonomy.md) · [站点页面](site-pages.md)

管理员会话页面显示当前主体的实际授权，仅加载匹配授权且由部署启用的管理区域。 `GET /api/v2/admin/identity/permissions.aeds`（AEDS 帧 32948）在独立管理来源读取当前 PostgreSQL 授权。响应中的会话代次和不透明匹配标记须与当前会话一致。每个业务端点仍自行复核权限。固定 v1 的 `/api/binary/auth/admin/me` 帧 188 包含其他身份字段，v2 沿用自己的会话与权限帧。 [v1 管理员自己的能力快照](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs#L403-L414)

持有 `audit.read` 的管理员可在管理页面手动查询运行状态，或读取 `GET /api/v2/admin/identity/operations/status.aeds`（AEDS 帧 32850）。接口返回当前公开投影是否就绪、投影水位、待处理发布事件数，以及最旧待处理事件时间。数值来自当前服务进程和 PostgreSQL 账本。无当前管理员会话返回 401，当前会话缺少 `audit.read` 返回 403。v1 的 `/api/binary/author/ops/health` 同样要求 `audit.read`，另含更多依赖检查、固定来源限流和在线查看审计，当前 v2 接口仅覆盖公开投影与待处理事件。 [v1 运维端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/AuthoringEndpoints.OperationsRoutes.cs)

持有 `comment.moderate` 的管理员可在管理页面审核待处理的站点账号投稿。 `GET /api/v2/admin/identity/comments/queue.aeds`（AEDS 帧 32862）按评论 ID 和文章 ID 正序返回投稿，每页最多 24 条。已删除的评论和文章不进入队列，撤回公开发布的文章保留未完成审核。正文只按文本显示。

领取、续期和释放请求位于 `/api/v2/admin/identity/comments/claim.aeds`、`claim/renew.aeds` 和 `claim/release.aeds`，使用帧 32867 和 32868。系统保存两分钟的领取、领取代次与版本和评论版本。领取绑定当前管理员会话，逾期或会话失效后可由其他有权管理员领取。续期推进领取版本，重新领取推进领取代次和版本。旧收据或评论状态变化返回 409。

在管理页面填写审核理由后，可用 Passkey 批准或拒绝一条待审评论。`comments/step-up/begin.aeds` 检查当前领取，并为帧 32869 的完整决定签发挑战。`step-up/passkey/complete.aeds` 验证已登记的凭据和用户后签发 45 秒一次性证明。客户端在同源请求 `comments/decision.aeds` 中提交证明及原决定。服务端在同个事务内校验权限、领取、评论版本，消费证明，写入决定并记录真实管理员主体及理由。缺失、过期、内容不符或已用过的证明返回 428。原 `step-up/passkey/begin.aeds` 签发的意向证明与领取绑定证明分开验证。当前接口覆盖单条批准和拒绝。v1 另有历史状态、批量审核、风险治理和消息投递。 [v1 评论审核端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/AuthoringEndpoints.ModerationRoutes.cs) [v1 管理员二次验证](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs#L338-L401)

认证接口位于 `/api/v2/admin/identity/`。WebAuthn 复用 AEDS 帧 63、64、66、67，管理员会话查询使用 v2 帧 32830。v1 还有独立管理员会话列表、JWT 轮换、长时会话、敏感动作的独立验证与其他业务权限。现有内容接口继续使用各自的权限判断。 [v1 管理认证契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/api/contracts.md#independent-admin-principal-aeds-endpoints)
