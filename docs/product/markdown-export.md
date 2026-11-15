# 保存修订的 Markdown 导出

编辑页 Inspector 的 **Download saved Markdown** 导出当前服务器保存的文章。对照旧修订时，**Download revision Markdown** 导出所选的历史修订。文件下载使用本地 FsusUI 按钮。切换文章、修订和登录身份会取消待完成的下载。

`GET /api/v2/authoring/draft/{id}/export.md?revision={current}&sourceRevision={selected}` 接受两个正整数修订号，所选修订须小于或等于期望当前修订。服务器在同一事务中核验作者会话、文章所有权与当前修订，并从保留的 `article_revision` 读取所选版本。当前修订变化返回 409。未登录或撤销的会话返回 401。只读账号返回 403。另一作者的文章和已删除文章返回 404。错误沿用 AEDS 单一错误契约。

成功响应是 UTF-8 `text/markdown`，固定下载名 `article.md`，附带 `Cache-Control: private, no-store` 和 `X-Content-Type-Options: nosniff`。UTF-8 frontmatter 的字段为 `fsusFormat: fsusblog-markdown-v2`、JSON 引号转义的 `title` 和十进制 `revision`。结束分隔符之后是原始正文，包括 CRLF 和尾随换行。不包含用户标识、存储路径、分类标签、资产内容或许可字段。

`GET /api/v2/authoring/draft/{id}/export.docx` 使用相同的修订参数与授权。Inspector 中的 **Download saved Word** 和历史对照中的 **Download revision Word** 下载 `article.docx`，响应 MIME 类型为 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`。Word 专用格式将可识别的纯文本标题转换为 Word 标题样式，将围栏或缩进代码转换为等宽段落，其余块保留文字和 Markdown 符号。普通换行和制表符使用 Word 对应元素。Word 的 1 MiB 输入、16,384 个换行或制表符和 2 MiB 附件限制以及 XML 可表示字符规则由服务端检查。不符合限制时仍可下载原始 Markdown。

Word 文件只含正文、固定样式和指向这两个内部部件的关系。链接和图片描述以文字输出，不加载附件、不嵌入资源，也不创建超链接、宏或外部关系。服务端只在内存生成 Open XML，无渲染进程、临时文件及网络读取。字形显示取决于阅读器可用字体。LibreOffice 仅用于打开测试生成的实际下载样本。 [WordprocessingML 文档结构](https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document)

`GET /api/v2/authoring/draft/{id}/export.html` 使用同一授权和修订参数。Inspector 的 **Download saved HTML** 和历史对照的 **Download revision HTML** 导出单个 UTF-8 离线附件 `article.html`。基础文本档支持标题、段落、强调、列表、引用和代码等标准 Markdown 结构，原始 HTML 按文本转义。遇到 Markdown 链接、图片、引用式链接定义，或 Mermaid、KaTeX、LaTeX 和 math 围栏会返回 400。其他扩展按基础 Markdown 文本语义处理。需要原始语法字节时，可以下载保存的 Markdown。

HTML 附件无脚本、外链、样式、字体或其他资源引用，HTTP 响应和离线文档均带禁止资源加载的内容安全策略。输入接受现有修订的标题和正文上限，输出最多 2 MiB。附件由服务端即时生成，沿用 `private, no-store`。此入口的范围为单篇已保存修订。文档任务、四格式隔离渲染、权利与资源清单、文章包往返及完整导入仍有各自的验收条件。

v1 的 `ContentExport` 是带完整恢复元数据的 AEDS 帧，另有完整站点备份。固定 v1 的文档导出源码包含 HTML 提供方、下载处理器和注册方法，常规二进制路由入口没有调用该注册方法。提供方目录将 DOCX 标记为未实现。 [v1 文档提供方目录](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/DocumentExport/DocumentExportContracts.cs#L261-L320) · [v1 路由入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs#L60-L80)
