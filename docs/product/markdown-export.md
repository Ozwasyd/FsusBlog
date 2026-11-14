# 保存修订的 Markdown 导出

编辑页 Inspector 的 **Download saved Markdown** 导出当前服务器保存的文章。对照旧修订时，**Download revision Markdown** 导出所选的历史修订。文件下载使用本地 FsusUI 按钮。切换文章、修订和登录身份会取消待完成的下载。

`GET /api/v2/authoring/draft/{id}/export.md?revision={current}&sourceRevision={selected}` 接受两个正整数修订号，所选修订须小于或等于期望当前修订。服务器在同一事务中核验作者会话、文章所有权与当前修订，并从保留的 `article_revision` 读取所选版本。当前修订变化返回 409。未登录或撤销的会话返回 401。只读账号返回 403。另一作者的文章和已删除文章返回 404。错误沿用 AEDS 单一错误契约。

成功响应是 UTF-8 `text/markdown`，固定下载名 `article.md`，附带 `Cache-Control: private, no-store` 和 `X-Content-Type-Options: nosniff`。UTF-8 frontmatter 的字段为 `fsusFormat: fsusblog-markdown-v2`、JSON 引号转义的 `title` 和十进制 `revision`。结束分隔符之后是原始正文，包括 CRLF 和尾随换行。不包含用户标识、存储路径、分类标签、资产内容或许可字段。

v1 的 `ContentExport` 是带完整恢复元数据的 AEDS 帧，另有完整站点内容备份与 PDF 或自包含 HTML 的独立文档导出。v2 路径专用于单篇保存修订的内容提取。权利和资产迁移、完整备份与导入、PDF 或 HTML 的隔离渲染仍待交付。规格参照固定 v1 的 `docs/api/contracts.md` 中 `ContentExportResponse` 与 `src/backend/Modules/Endpoints/AuthoringEndpoints.OperationsRoutes.cs`。
