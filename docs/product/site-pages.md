# 关于与站点政策

站点的四个固定页使用同一份部署内容生成首响应 HTML 和 AEDS。固定路径为 `/about`、`/privacy`、`/guidelines`、`/copyright`。同级的 `GET /api/binary/system/page/{slug}` 使用 v1 的 AEDS v2 PageContent 帧（14）。负载由 128 字节零填充 slug、Markdown offset/length、blob length 和 UTF-8 Markdown 构成。页面名称是固定界面文案。帧里没有独立的 title 或 updatedAt 字段。 [v1 入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.System.cs) · [v1 POD](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/shared/Contracts/Models/SystemPods.cs) · [固定协议向量](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/tests/fixtures/protocol/page-content-frame.hex)

部署者将真实的站点政策与关于页准备为四个 UTF-8 Markdown 文件，并将 `FSUSBLOG_SITE_PAGES` 设为包含 `about.md`、`privacy.md`、`guidelines.md`、`copyright.md` 的绝对路径。目录应由部署者控制，以只读挂载交给应用。该路径不能是 Web 静态资源目录。应用读取固定文件名，每页限制为 200,000 个 UTF-16 代码单元和 600,000 个 UTF-8 字节。缺件、链接、非普通输入、空白内容、非法 UTF-8 或超限使配置的发布包准入失败。服务启动后保留同一不可变版本，修改文件不会触发热更新。发布者先准备完整的新包并核对内容，再切换进程配置。回退重启到上一个已验证包。旧版本内容的 URL 和缓存策略仍是固定路径、no-store。

未配置目录时，合法路径显示 v1 的“页面内容正在准备中，请稍后再试。”状态，并发送 noindex。其他 slug 不会读取目录文件并返回 404。HTML 的 Markdown 渲染沿用公开文章的安全渲染器，禁用原始 HTML 并限制 URL 协议。SPA 在站内跳转时消费同源的已渲染页面片段。读者界面使用实际 FsusUI 公共布局和组件。

独立管理员页面的 **Site pages** 区域提供只读配置概览和 Markdown 查看。先停止服务并运行 `admin-identity schema` 将管理员组件从 v6 升到 v7。数据库操作员通过 `admin-identity grant HANDLE system.config` 和 `admin-identity revoke HANDLE system.config` 管理该权限。权限变更撤销旧会话并记录数据库操作者。网站作者、仅有 `admin.manage` 的管理员以及 `audit.read`、`article.write` 和 `comment.moderate` 角色不会因此得到读取能力。

管理员专用域的 `GET /api/binary/system/admin/page/{slug}` 与 v1 一样返回 `PageContent` AEDS 帧，直接复用服务启动核验后的发布页字节。`GET /api/v2/admin/identity/site-pages/{slug}.aeds` 供管理员工作区读取同一内容，包括本机 HTTP 的窄 cookie 路径。公开域访问这两个管理员读取路由返回 404，未配置的页也返回 404。`GET /api/v2/admin/identity/site-pages.aeds` 返回 v2 `AdminSitePages` 单个四位掩码，顺序固定为关于、隐私政策、用户守则、版权声明。它只反映当前实例从启动配置读取的页面，不返回源目录、主机配置或认证数据。管理员读取均为 `no-store`。

页面保存与人工刷新在 v1 要求 `system.config`、PoW 与 admin-sensitive step-up。v2 的页面变更通过部署流程生效，在线写端点仍待交付。 [v1 管理权限边界](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.System.cs)
