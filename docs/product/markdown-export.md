# 保存修订的 Markdown 导出

编辑页 Inspector 的 **Download saved Markdown** 导出当前服务器保存的文章。对照旧修订时，**Download revision Markdown** 导出所选的历史修订。文件下载使用本地 FsusUI 按钮。切换文章、修订和登录身份会取消待完成的下载。

`GET /api/v2/authoring/draft/{id}/export.md?revision={current}&sourceRevision={selected}` 接受两个正整数修订号，所选修订须小于或等于期望当前修订。服务器在同一事务中核验作者会话、文章所有权与当前修订，并从保留的 `article_revision` 读取所选版本。当前修订变化返回 409。未登录或撤销的会话返回 401。只读账号返回 403。另一作者的文章和已删除文章返回 404。错误沿用 AEDS 单一错误契约。

成功响应是 UTF-8 `text/markdown`，固定下载名 `article.md`，附带 `Cache-Control: private, no-store` 和 `X-Content-Type-Options: nosniff`。UTF-8 frontmatter 的字段为 `fsusFormat: fsusblog-markdown-v2`、JSON 引号转义的 `title` 和十进制 `revision`。结束分隔符之后是原始正文，包括 CRLF 和尾随换行。不包含用户标识、存储路径、分类标签、资产内容或许可字段。

空白 **New draft** 中的 **Import Markdown** 可以选择 UTF-8 `.md` 或粘贴 Markdown。粘贴纯 Markdown 时输入标题。v2 下载文件使用上面的固定头部取得标题，并保留分隔符后的正文和换行。旧版备份头按不支持的输入拒绝。**Load into draft** 只将文本载入当前新稿，普通 **Save draft** 才创建有新身份的私有草稿，适用现有作者权限、恢复和关闭确认。v1 管理员批量恢复、修订恢复和带资产的文章包仍有独立的导入契约与验收。 [375px 导入回归](../../artifacts/authoring-edits-import-8794a67/browser.log) · [固定 v1 内容工具](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/views/admin/ContentTools.vue)

`GET /api/v2/authoring/draft/{id}/export.docx` 使用相同的修订参数与授权。Inspector 中的 **Download saved Word** 和历史对照中的 **Download revision Word** 下载 `article.docx`，响应 MIME 类型为 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`。Word 专用格式将可识别的纯文本标题转换为 Word 标题样式，将围栏或缩进代码转换为等宽段落，其余块保留文字和 Markdown 符号。普通换行和制表符使用 Word 对应元素。Word 的 1 MiB 输入、16,384 个换行或制表符和 2 MiB 附件限制以及 XML 可表示字符规则由服务端检查。不符合限制时仍可下载原始 Markdown。

Word 文件只含正文、固定样式和指向这两个内部部件的关系。链接和图片描述以文字输出，不加载附件、不嵌入资源，也不创建超链接、宏或外部关系。服务端只在内存生成 Open XML，无渲染进程、临时文件及网络读取。字形显示取决于阅读器可用字体。LibreOffice 仅用于打开测试生成的实际下载样本。 [WordprocessingML 文档结构](https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document)

`GET /api/v2/authoring/draft/{id}/export.html` 使用同一授权和修订参数。Inspector 的 **Download saved HTML** 和历史对照的 **Download revision HTML** 导出单个 UTF-8 离线附件 `article.html`。基础文本档支持标题、段落、强调、列表、引用和代码等标准 Markdown 结构，原始 HTML 按文本转义。遇到 Markdown 链接、图片、引用式链接定义，或 Mermaid、KaTeX、LaTeX 和 math 围栏会返回 400。其他扩展按基础 Markdown 文本语义处理。需要原始语法字节时，可以下载保存的 Markdown。

HTML 附件无脚本、外链、样式、字体或其他资源引用，HTTP 响应和离线文档均带禁止资源加载的内容安全策略。输入接受现有修订的标题和正文上限，输出最多 2 MiB。附件由服务端即时生成，沿用 `private, no-store`。此入口的范围为单篇已保存修订。文档任务、四格式隔离渲染、权利与资源清单、文章包往返及完整导入仍有各自的验收条件。

`GET /api/v2/authoring/draft/{id}/export.epub` 使用相同授权和两个修订参数。Inspector 的 **Download saved EPUB** 和历史对照的 **Download revision EPUB** 下载 `article.epub`，响应为 `application/epub+zip` 和 `private, no-store`。文件使用可重排的单章 XHTML、目录和正文导航，语言未记录时标为 `und`，正文方向由阅读器按文本确定。包标识根据章节内容生成，修改时间来自所选修订，文件顺序和 ZIP 时间固定。 [EPUB 3.3](https://www.w3.org/TR/epub-33/)

EPUB 使用与 HTML 相同的基础 Markdown，并检查章节的 XHTML 结构。链接、图片、指定渲染围栏、XML 无法表示的字符、空标题和超出 2 MiB 的章节或文件返回 400。基础文件只含文本和包内导航，字体由阅读器选择。资源内嵌、多章及完整导出任务仍待验收。 [EPUB 可访问性元数据](https://www.w3.org/TR/epub-a11y-11/#sec-discov-meta)

启用本机 PDF 提供方后，`GET /api/v2/authoring/draft/{id}/export.pdf` 使用相同授权和两个修订参数。Inspector 的 **Download saved PDF** 和历史对照的 **Download revision PDF** 下载 `article.pdf`，响应为 `application/pdf` 和 `private, no-store`。服务读取所选修订，释放数据库锁后用 WeasyPrint 66.0 生成可打印的 A4 页面。服务在发送附件前再次核验会话、文章归属和当前修订。

PDF 读取与 HTML 相同的基础 Markdown。可用字形由离线 Noto Sans CJK SC 2.004 提供。链接、图片、渲染围栏、缺失的字形和超出限制的修订返回 400。Markdown 正文最多 256 KiB，传给渲染器的 HTML 最多 384 KiB，附件最多 4 MiB 和 48 页。每个服务进程只允许一个 PDF 请求，额外请求返回 429。渲染子进程的 CPU 时间上限为 8 秒，服务最多等待 12 秒。请求取消和超时都会结束子进程并清理私有临时目录。

PDF 默认关闭。当 `FSUSBLOG_PDF_TOOL_ROOT` 为本机工具链的绝对路径，且 `FSUSBLOG_PDF_TOOL_SHA256` 匹配该目录内 `toolchain.json` 的 SHA-256 时，macOS 服务才提供此下载。启动时验证清单列出的工具文件，部署时应将验证过的工具链目录保持为服务只读。Seatbelt 子进程以固定参数启动，资源读取仅限工具、字体和私有临时目录，网络与额外资源加载均被阻止。渲染器在接收正文前检查实际沙箱。配置不完整或工具校验失败会阻止启动。 [WeasyPrint 安全说明](https://doc.courtbouillon.org/weasyprint/v66.0/first_steps.html#security)

Debian 13 ARM64 已通过原生渲染和 PostgreSQL 保存修订下载验证。该部署使用固定 `/opt/fsusblog-pdf-arm64` 和该目录下 `payload.sha256` 的 SHA-256 作为上述配置。安装目录由 root 持有，含固定启动器和用于 Bubblewrap 的只读文件系统。安装包逐文件核验，必须包含与服务程序内嵌源码一致的渲染脚本与字体配置，以及固定 Noto 字体。Linux 启动器将入口限定为该包内 Python，隔离网络和文件系统，清除额外文件描述符，初始化后拒绝再次执行程序。服务核对实际 systemd 单元、进程组、256 MiB 内存和零交换空间限额，再交付输入。原生验证需要非 root 服务账号、systemd 用户管理器、cgroup v2 和可用的 Bubblewrap。 [现有 Linux 宿主及前置条件](platform-plugin-offline.md#离线-linux-arm64-工作进程) · [原生 PDF 证据](../../artifacts/original-delivery-next/linux-pdf/)

v1 的 `ContentExport` 是带完整恢复元数据的 AEDS 帧，另有完整站点备份。固定 v1 的文档导出源码包含 HTML 提供方、下载处理器和注册方法，常规二进制路由入口没有调用该注册方法。提供方目录将 DOCX 标记为未实现。 [v1 文档提供方目录](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/DocumentExport/DocumentExportContracts.cs#L261-L320) · [v1 路由入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs#L60-L80)
