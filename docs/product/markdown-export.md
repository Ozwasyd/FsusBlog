# 保存修订的 Markdown 导出

编辑页 Inspector 的 **Download saved Markdown** 导出当前服务器保存的文章。对照旧修订时，**Download revision Markdown** 导出所选的历史修订。文件下载使用本地 FsusUI 按钮。切换文章、修订和登录身份会取消待完成的下载。

`GET /api/v2/authoring/draft/{id}/export.md?revision={current}&sourceRevision={selected}` 接受两个正整数修订号，所选修订须小于或等于期望当前修订。服务器在同一事务中核验作者会话、文章所有权与当前修订，并从保留的 `article_revision` 读取所选版本。当前修订变化返回 409。未登录或撤销的会话返回 401。只读账号返回 403。另一作者的文章和已删除文章返回 404。错误沿用 AEDS 单一错误契约。

成功响应是 UTF-8 `text/markdown`，固定下载名 `article.md`，附带 `Cache-Control: private, no-store` 和 `X-Content-Type-Options: nosniff`。UTF-8 frontmatter 的字段为 `fsusFormat: fsusblog-markdown-v2`、JSON 引号转义的 `title` 和十进制 `revision`。结束分隔符之后是原始正文，包括 CRLF 和尾随换行。不包含用户标识、存储路径、分类标签、资产内容或许可字段。

空白 **New draft** 中的 **Import Markdown** 可以选择 UTF-8 `.md` 或粘贴 Markdown。粘贴纯 Markdown 时输入标题。v2 下载文件使用上面的固定头部取得标题，并保留分隔符后的正文和换行。旧版备份头按不支持的输入拒绝。**Load into draft** 只将文本载入当前新稿，普通 **Save draft** 才创建有新身份的私有草稿，适用现有作者权限、恢复和关闭确认。v1 管理员批量恢复、修订恢复和带资产的文章包仍有独立的导入契约与验收。 [375px 导入回归](../../artifacts/authoring-edits-import-8794a67/browser.log) · [固定 v1 内容工具](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/views/admin/ContentTools.vue)

`GET /api/v2/authoring/draft/{id}/export.docx` 使用相同的修订参数与授权。Inspector 中的 **Download saved Word** 和历史对照中的 **Download revision Word** 下载 `article.docx`，响应 MIME 类型为 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`。Word 专用格式将可识别的纯文本标题转换为 Word 标题样式，将围栏或缩进代码转换为等宽段落，其余块保留文字和 Markdown 符号。普通换行和制表符使用 Word 对应元素。Word 的 1 MiB 输入、16,384 个换行或制表符和 2 MiB 附件限制以及 XML 可表示字符规则由服务端检查。不符合限制时仍可下载原始 Markdown。

基础 Word 文件只含正文、固定样式和指向这两个内部部件的关系。正文中的链接和图片标记以文字输出。文件不创建超链接、宏或外部关系。服务端只在内存生成 Open XML，无渲染进程、临时文件及网络读取。字形显示取决于阅读器可用字体。LibreOffice 仅用于打开测试生成的实际下载样本。 [WordprocessingML 文档结构](https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document)

在 **Private attachments** 的 PNG 或 JPEG 预览中，**Download saved Word with this image** 使用当前会话和所选已保存修订的图片核验，将一张最多 512 KiB 的图片嵌入 DOCX。图片字节保存在包内，按比例缩放至页面可打印区域。

`GET /api/v2/authoring/draft/{id}/export.html` 使用同一授权和修订参数。Inspector 的 **Download saved HTML** 和历史对照的 **Download revision HTML** 导出单个 UTF-8 离线附件 `article.html`。基础文本档支持标题、段落、强调、列表、引用和代码等标准 Markdown 结构，原始 HTML 按文本转义。遇到 Markdown 链接、图片、引用式链接定义，或 Mermaid、KaTeX、LaTeX 和 math 围栏会返回 400。其他扩展按基础 Markdown 文本语义处理。需要原始语法字节时，可以下载保存的 Markdown。

基础 HTML 附件无脚本、外链、样式、字体或其他资源引用，HTTP 响应和离线文档均带禁止资源加载的内容安全策略。输入接受现有修订的标题和正文上限，输出最多 2 MiB。附件由服务端即时生成，沿用 `private, no-store`。此入口的范围为单篇已保存修订。文档任务、四格式隔离渲染、权利与资源清单、文章包往返及完整导入仍有各自的验收条件。

在已保存草稿的 **Private attachments** 中预览图片后，**Download saved HTML with this image** 会将这张图片放在正文末尾。图片须是该修订关联的已归一化 PNG、JPEG 或 WebP，最多 512 KiB，整个 HTML 仍最多 2 MiB。服务通过 `X-Fsus-Export-Attachment` 选择单张图片，并以当前会话及修订参数核验文章和附件归属、大小与内容摘要。图片作为唯一允许的内嵌数据资源交付，离线打开时无需联网或重新登录。此操作使用即时 HTML 下载入口。

在私有附件列表勾选 1 至 4 张已保存图片后，可以按列表顺序即时导出或创建任务。附有两至四张图片的修订默认勾选全部图片。API 在同一请求头中接受按顺序逗号分隔的附件 ID。服务按同一所选修订核验整组图片，图片合计最多 512 KiB。任意图片不可用时，下载整组失败。

`GET /api/v2/authoring/draft/{id}/export.epub` 使用相同授权和两个修订参数。Inspector 的 **Download saved EPUB** 和历史对照的 **Download revision EPUB** 下载 `article.epub`，响应为 `application/epub+zip` 和 `private, no-store`。文件使用可重排的单章 XHTML、目录和正文导航，语言未记录时标为 `und`，正文方向由阅读器按文本确定。包标识根据章节内容生成，修改时间来自所选修订，文件顺序和 ZIP 时间固定。 [EPUB 3.3](https://www.w3.org/TR/epub-33/)

EPUB 使用与 HTML 相同的基础 Markdown，并检查章节的 XHTML 结构。Markdown 内的链接、图片、指定渲染围栏、XML 无法表示的字符、空标题和超出 2 MiB 的章节或文件返回 400。基础文件只含文本和包内导航，字体由阅读器选择。 [EPUB 可访问性元数据](https://www.w3.org/TR/epub-a11y-11/#sec-discov-meta)

在 **Private attachments** 的图片预览中，**Download saved EPUB with this image** 将经授权的单张 PNG、JPEG 或 WebP 保存在包内。与即时 HTML 共用当前会话、所选修订、归属和内容摘要核验。图片最多 512 KiB，章节使用固定包内相对路径，manifest 声明媒体类型，包标识绑定图片字节。多图、多章和导出任务的资产清单仍待验收。 [EPUB 3.3 图片资源](https://www.w3.org/TR/epub-33/#sec-core-media-types)

启用本机 PDF 提供方后，`GET /api/v2/authoring/draft/{id}/export.pdf` 使用相同授权和两个修订参数。Inspector 的 **Download saved PDF** 和历史对照的 **Download revision PDF** 下载 `article.pdf`，响应为 `application/pdf` 和 `private, no-store`。服务读取所选修订，释放数据库锁后用 WeasyPrint 66.0 生成可打印的 A4 页面。服务在发送附件前再次核验会话、文章归属和当前修订。

PDF 读取与 HTML 相同的基础 Markdown。可用字形由离线 Noto Sans CJK SC 2.004 提供。Markdown 内的链接、图片语法、渲染围栏、缺失字形和超出限制的修订返回 400。Markdown 正文最多 256 KiB，正文 HTML 最多 384 KiB，产物最多 4 MiB 和 48 页。每个服务进程只允许一个 PDF 请求，额外请求返回 429。渲染子进程的 CPU 时间上限为 8 秒，服务最多等待 12 秒。请求取消和超时都会结束子进程并清理私有临时目录。

随 PDF 内嵌的 1 至 4 张 PNG、JPEG 或 WebP 必须来自同一所选的已保存修订，合计最多 512 KiB、4,194,304 像素。PDF 子进程只从本次输入中读取已校验图片的内存字节。即时下载在渲染后再次核验会话和该组图片的摘要。

PDF 默认关闭。当 `FSUSBLOG_PDF_TOOL_ROOT` 为本机工具链的绝对路径，且 `FSUSBLOG_PDF_TOOL_SHA256` 匹配该目录内 `toolchain.json` 的 SHA-256 时，macOS 服务才提供此下载。启动时验证清单列出的工具文件，部署时应将验证过的工具链目录保持为服务只读。Seatbelt 子进程以固定参数启动，资源读取仅限工具、字体和私有临时目录，网络与额外资源加载均被阻止。渲染器在接收正文前检查实际沙箱。配置不完整或工具校验失败会阻止启动。 [WeasyPrint 安全说明](https://doc.courtbouillon.org/weasyprint/v66.0/first_steps.html#security)

Debian 13 ARM64 已通过原生渲染和 PostgreSQL 保存修订下载验证。该部署使用固定 `/opt/fsusblog-pdf-arm64` 和该目录下 `payload.sha256` 的 SHA-256 作为上述配置。安装目录由 root 持有，含固定启动器和用于 Bubblewrap 的只读文件系统。安装包逐文件核验，必须包含与服务程序内嵌源码一致的渲染脚本与字体配置，以及固定 Noto 字体。Linux 启动器将入口限定为该包内 Python，隔离网络和文件系统，清除额外文件描述符，初始化后拒绝再次执行程序。服务核对实际 systemd 单元、进程组、256 MiB 内存和零交换空间限额，再交付输入。原生验证需要非 root 服务账号、systemd 用户管理器、cgroup v2 和可用的 Bubblewrap。 [现有 Linux 宿主及前置条件](platform-plugin-offline.md#离线-linux-arm64-工作进程) · [原生 PDF 证据](../../artifacts/original-delivery-next/linux-pdf/)

v1 的 `ContentExport` 是带完整恢复元数据的 AEDS 帧，另有完整站点备份。固定 v1 的文档导出源码包含 HTML 提供方、下载处理器和注册方法，常规二进制路由入口没有调用该注册方法。提供方目录将 DOCX 标记为未实现。 [v1 文档提供方目录](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/DocumentExport/DocumentExportContracts.cs#L261-L320) · [v1 路由入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs#L60-L80)

## 作者导出任务

停服执行 `document-exports` 安装任务表，再设置 `FSUSBLOG_DOCUMENT_EXPORT_TASKS=true`。作者可从 Inspector 或历史对照的 **Document export tasks** 选择 HTML、PDF、DOCX 或 EPUB。任务绑定提交时检查过的当前修订及选中的原文修订，后续保存可继续进行。关掉面板或重载后可按文章恢复状态。

PostgreSQL 保留任务 ID、源摘要、格式与提供方版本、开始和结束时间、结果摘要与字节数。源摘要绑定文章、选中修订、保存时间、原始标题和 Markdown，PDF 同时绑定已验证的工具链摘要。任务使用现有格式提供方及其正文、字形、页数和输出预算。排队中可立即取消，执行中由工作进程收到取消后终止。服务重启会保留排队和终态回执，并将中断的执行标为失败。每个作者最多保留四项，每个站点最多十六项，保留期三十分钟。

下载提交绑定当前会话的任务 ID，服务重新检查文章所有权、授权代次、过期时间和文件摘要。结果只保存在私有数据库，通过禁止缓存的附件响应交付。已保存修订在文章继续编辑后仍可获授权下载。格式扩展、资产和元数据清单、一次性下载授权与更大任务负载仍待验收。 [PostgreSQL 执行记录](../../artifacts/document-export-tasks-13bf4fc/postgres/integration.txt) · [375px HTML 和 PDF 下载](../../artifacts/document-export-tasks-13bf4fc/browser/browser-result.json)

停服执行 `document-exports` 可安装第二版文档提供方。新任务支持 Markdown 管道表格。HTML、EPUB 和 PDF 共用离线表格解析，DOCX 生成带重复表头的原生表格。旧任务继续使用第一版提供方和原源摘要，已有附件字节不变。实际升级连续执行两次，并核对升级前后的完整旧行和附件。 [停服升级](../../artifacts/document-export-profiles-749b9ba/stopped-upgrade.log) · [旧版和新版任务回归](../../artifacts/document-export-profiles-749b9ba/native/integration.txt)

停服执行 `document-exports` 后，私有附件预览可以将当前选中的一张图片加入 HTML 任务。任务 API 也接受 EPUB 的 PNG、JPEG、WebP，以及 Word 的 PNG、JPEG。第 3 版任务持久化附件标识，并将所选修订和核验过的图片字节、格式、名称及尺寸绑定到输入摘要。重启后按同一摘要渲染，下载时复核归属和摘要。未选择附件的任务继续用现有提供方版本。

再次停服运行 `document-exports` 后，HTML、EPUB、Word 和 PDF 任务能导出包含当前修订所选已保存图片的文档。第 4 版任务按请求顺序记录 2 至 4 张图片，共用 512 KiB 上限。在执行和下载时重新核验每张图片。Word 支持 PNG 和 JPEG，HTML、EPUB 和 PDF 也支持 WebP。旧任务保持原版本和摘要。Debian 的服务程序与配套渲染包需一起升级。部署前处理仍在排队的旧 PDF 任务。工具摘要改变后，本次升级前生成的无图 PDF 仍可按原授权下载。相应旧工具不可用时，其回执会拒绝交付。

下载就绪任务时可另存导出回执。回执记录所选修订的标题、保存时间与正文摘要、按顺序核验的图片清单、提供方版本和布局、产物的 MIME、长度和 SHA-256，以及执行时间和到期时间。PDF 回执还绑定创建任务时固定的工具摘要。服务复核当前授权、原输入承诺和实际产物字节后才交付回执。回执不含正文或图片原始字节。

就绪 Word 任务可通过 **Review Word formatting** 查看所选修订的格式提示。Word 回执以 `application/vnd.fsus.document-export-receipt.v2+json` 交付机器可读的提示类别、出现次数和首次出现范围。范围使用从零开始的 UTF-16 正文索引。提示涵盖保留为文本的列表、引用、链接、图片、强调、行内代码、分隔线和标题标记，也标记降低的标题层级、保留为代码的渲染指令和没有语法高亮的语言代码块。回执沿用同一份文档产物和输入摘要。

真实 macOS PDF 工作进程已验证运行中取消后退出和临时目录清理。数据库租约丢失时会清理运行中的渲染进程，重启后被中断的 PDF 保留失败回执，排队 HTML 继续。初次 SIGTERM 演练暂停了子进程，macOS 将该状态报告给 .NET 的退出等待，导致信号处理延迟，原失败保留。用自然运行的真实 PDF 重试，观察到 828 毫秒内回收渲染进程和临时目录并关闭服务。重启后运行中的任务保留中断回执，排队任务继续。暂停子进程的 HTTP 取消和租约丢失也有独立通过结果。 [真实 SIGTERM 演练](../../artifacts/document-export-sigterm-2ec1b97/graceful-and-cancellation.log) · [首次失败](../../artifacts/document-export-pdf-749b9ba/restart-2.log) · [macOS 等待结果](../../artifacts/document-export-sigterm-2ec1b97/darwin-child-wait.log)
