# 关于与站点政策

站点的四个固定页使用同一份已发布内容生成首响应 HTML 和 AEDS。固定路径为 `/about`、`/privacy`、`/guidelines`、`/copyright`。同级的 `GET /api/binary/system/page/{slug}` 使用 v1 的 AEDS v2 PageContent 帧（14）。负载由 128 字节零填充 slug、Markdown offset/length、blob length 和 UTF-8 Markdown 构成。页面名称是固定界面文案。帧里没有独立的 title 或 updatedAt 字段。 [v1 入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.System.cs) · [v1 POD](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/shared/Contracts/Models/SystemPods.cs) · [固定协议向量](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/tests/fixtures/protocol/page-content-frame.hex)

部署者将真实的站点政策与关于页准备为四个 UTF-8 Markdown 文件，并将 `FSUSBLOG_SITE_PAGES` 设为包含 `about.md`、`privacy.md`、`guidelines.md`、`copyright.md` 的绝对路径。目录应由部署者控制，以只读挂载交给应用。该路径不能是 Web 静态资源目录。应用读取固定文件名，每页限制为 200,000 个 UTF-16 代码单元和 600,000 个 UTF-8 字节。缺件、链接、非普通输入、空白内容、非法 UTF-8 或超限使配置的发布包准入失败。服务启动后保留同一不可变版本，修改文件不会触发热更新。发布者先准备完整的新包并核对内容，再切换进程配置。回退重启到上一个已验证包。旧版本内容的 URL 和缓存策略仍是固定路径、no-store。

未配置目录时，合法路径显示 v1 的“页面内容正在准备中，请稍后再试。”状态，并发送 noindex。其他 slug 不会读取目录文件并返回 404。HTML 的 Markdown 渲染沿用公开文章的安全渲染器，禁用原始 HTML 并限制 URL 协议。SPA 在站内跳转时消费同源的已渲染页面片段。读者界面使用实际 FsusUI 公共布局和组件。

独立管理员页面的 **Site pages** 区域提供配置概览和 Markdown 查看。站点页面所需的表由统一的 CLI `plan` 和 `apply` 初始化。读取要求当前有效的管理员会话。读者会话无法读取这些管理接口。使用 `admin-identity revoke-all HANDLE` 撤销旧管理员会话后，管理员须重新通过 Passkey 登录。

管理员专用域的 `GET /api/binary/system/admin/page/{slug}` 与 v1 一样返回 `PageContent` AEDS 帧。`GET /api/v2/admin/identity/site-pages/{slug}.aeds` 供管理员工作区读取同一内容，包括本机 HTTP 的窄 cookie 路径。公开域访问这两个管理员读取路由返回 404，未配置的页也返回 404。`GET /api/v2/admin/identity/site-pages.aeds` 返回 v2 `AdminSitePages` 单个四位掩码，顺序固定为关于、隐私政策、用户守则、版权声明。管理员读取均为 `no-store`。

在线发布默认在配置了安全管理员源（HTTPS 公开+管理员源，或本机 Loopback 管理员源）后自动启用，不再强制要求磁盘先存在四页基线文件（也可通过 `FSUSBLOG_SITE_PAGE_EDITOR=false` 静默关闭）。当配置了 `FSUSBLOG_SITE_PAGES`（或数据目录下 `site-pages/`）四页文件时，首次编辑以部署文件的版本 0 和正文 SHA-256 为基线；未配置磁盘文件时，四页以空内容（版本 0、对外显示未配置占位并发送 `noindex`）作为基线，管理员在后台直接创建并发布后该页立即切换为已配置公开页并纳入 `/sitemap.xml`。关闭开关并重启即恢复磁盘基线或未配置占位；数据库版本和审计保留，重新启用时恢复。页面仍沿用同一安全 Markdown 渲染器与固定 URL。页面内容可为空，超出字符或字节上限的请求直接拒绝。

已登录的管理员可以在启用在线编辑时点击 **Edit**，确认替换公开页后使用其管理员 Passkey 发布。更新精确绑定 slug、当前版本、当前正文摘要和新 Markdown。旧版本请求返回 409，界面保留操作员输入供复制。Passkey 和 PoW 都限定为本次发布操作。事务内写入下一版本和审计行，审计记录管理员 ID、版本、正文修改前后摘要和时间。成功返回 AEDS `EmptySuccess`。公开 HTML 和 v1 AEDS GET 从同一已提交版本提供，分别发送强 ETag 和 `no-store`。相同 ETag 的条件读返回 304，仅带日期的请求重新返回当前内容。v2 发布接口使用带 CAS 的 `/api/v2/admin/identity/site-pages/*` 路由。

启用在线编辑时，管理员 HTTPS 源也接收 `PUT /api/binary/system/page` 的 v1 AEDS `PageContentUpdateRequest` 帧（36）。客户端从对应管理员 GET 取得强 ETag，再用同一页名、修订、摘要和新 Markdown 完成 v2 Passkey 与 PoW 流程。PUT 带原样的 `If-Match` 和这两个证明，复用同一个发布事务。缺少 `If-Match` 返回 428，修订或摘要已变化返回 412。旧客户端需更新验证流程。公开读取在事务提交后自动切换到新修订，历史人工刷新入口仍未映射。 [固定 v1 路由](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.System.cs#L205-L267)
