# 关于与站点政策

站点的四个固定页使用同一份部署内容生成首响应 HTML 和 AEDS。固定路径为 `/about`、`/privacy`、`/guidelines`、`/copyright`。同级的 `GET /api/binary/system/page/{slug}` 使用 v1 的 AEDS v2 PageContent 帧（14）。负载由 128 字节零填充 slug、Markdown offset/length、blob length 和 UTF-8 Markdown 构成。页面名称是固定界面文案。帧里没有独立的 title 或 updatedAt 字段。 [v1 入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.System.cs) · [v1 POD](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/shared/Contracts/Models/SystemPods.cs) · [固定协议向量](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/tests/fixtures/protocol/page-content-frame.hex)

部署者将真实的站点政策与关于页准备为四个 UTF-8 Markdown 文件，并将 `FSUSBLOG_SITE_PAGES` 设为包含 `about.md`、`privacy.md`、`guidelines.md`、`copyright.md` 的绝对路径。目录应由部署者控制，以只读挂载交给应用。该路径不能是 Web 静态资源目录。应用读取固定文件名，每页限制为 200,000 个 UTF-16 代码单元和 600,000 个 UTF-8 字节。缺件、链接、非普通输入、空白内容、非法 UTF-8 或超限使配置的发布包准入失败。服务启动后保留同一不可变版本，修改文件不会触发热更新。发布者先准备完整的新包并核对内容，再切换进程配置。回退重启到上一个已验证包。旧版本内容的 URL 和缓存策略仍是固定路径、no-store。

未配置目录时，合法路径显示 v1 的“页面内容正在准备中，请稍后再试。”状态，并发送 noindex。其他 slug 不会读取目录文件并返回 404。HTML 的 Markdown 渲染沿用公开文章的安全渲染器，禁用原始 HTML 并限制 URL 协议。SPA 在站内跳转时消费同源的已渲染页面片段。读者界面使用实际 FsusUI 公共布局和组件。

v1 管理端的页内容读取、保存及人工刷新仍未接入。保存与刷新需要独立的 system.config 管理员权限、PoW 和 admin-sensitive step-up。当前部署内容的变更入口是上面的发布包流程。 [v1 管理权限边界](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/api/contracts.md#pagecontentcontract)
