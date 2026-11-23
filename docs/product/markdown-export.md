# 保存修订的 Markdown 导入与多格式导出

> **角色**：功能契约
> **适用对象**：站点部署者、创作者与后端维护者
> **权威依据**：默认开关以 [`SiteCapabilities.cs`](../../src/Server/Operations/SiteCapabilities.cs) 为准；导出端点与工作进程以 `src/Server/Authoring/DocumentExport*.cs` 与 `PdfDocumentExport.cs` 为准。

## 1. 通用授权与修订绑定

所有导出入口均接收两个正整数修订参数 `?revision={current}&sourceRevision={selected}`（`selected ≤ current`），在同事务内校验当前作者会话、文章所有权与期望当前修订：

- 当前修订已变化返回 `409`，未登录/已撤销返回 `401`，无权返回 `403`，跨作者或已删除文章返回 `404`（统一 AEDS 错误帧）。
- 全部成功附件响应统一发送 `Cache-Control: private, no-store` 与 `X-Content-Type-Options: nosniff`。

## 2. 即时导出与 Markdown 导入

| 格式 | 端点与下载文件名 | 能力范围与限制 |
| --- | --- | --- |
| **Markdown** | `GET /api/v2/authoring/draft/{id}/export.md` (`article.md`) | UTF-8 frontmatter（`fsusFormat: fsusblog-markdown-v2`、`title`、`revision`）后接原样正文（含 CRLF/尾随换行），不含用户标识、路径或资产字节 |
| **Word (DOCX)** | `GET /api/v2/authoring/draft/{id}/export.docx` (`article.docx`) | 纯内存生成 Open XML（无外部渲染进程或宏），支持标题、代码块与原生表格；输入上限 1 MiB / 16,384 换行制表符，输出上限 2 MiB；可按序内嵌同修订 1–4 张已授权 PNG/JPEG（合计 ≤ 512 KiB） |
| **离线 HTML** | `GET /api/v2/authoring/draft/{id}/export.html` (`article.html`) | 单文件离线 UTF-8 文档，带严格禁止外部资源加载的 CSP，转义原始 HTML，支持基础 Markdown 与管道表格；输出上限 2 MiB；可经 `X-Fsus-Export-Attachment` 按序内嵌同修订 1–4 张授权 PNG/JPEG/WebP（合计 ≤ 512 KiB） |
| **EPUB 3.3** | `GET /api/v2/authoring/draft/{id}/export.epub` (`article.epub`) | 单章可重排 XHTML + 目录导航，固定 ZIP 时间戳与顺序；内容/输出上限 2 MiB；支持内嵌同修订 1–4 张授权 PNG/JPEG/WebP（合计 ≤ 512 KiB） |
| **PDF (A4)** | `GET /api/v2/authoring/draft/{id}/export.pdf` (`article.pdf`) | **显式 opt-in**（需配置受检的 `FSUSBLOG_PDF_TOOL_ROOT` 与 `FSUSBLOG_PDF_TOOL_SHA256`）；隔离沙箱子进程（macOS Seatbelt / Linux Bubblewrap + cgroup 256 MiB 内存零交换）调用 WeasyPrint 66.0 与离线 Noto Sans CJK SC 字体渲染；正文 ≤ 256 KiB、HTML ≤ 384 KiB、产物 ≤ 4 MiB / 48 页、单进程并发 1 路（超限 `429`）、CPU 上限 8 s / 总等待 12 s；支持内嵌 1–4 张授权 PNG/JPEG/WebP（合计 ≤ 512 KiB / 4,194,304 像素） |

> 基础文档格式（HTML / EPUB / PDF）不支持外部链接、Markdown 远程图片语法与 Mermaid/KaTeX 渲染围栏（遇此类输入返回 `400`，请改用原始 Markdown 导出）。

- **Markdown 导入**：空白新建草稿页提供 **Import Markdown**（上传 UTF-8 `.md` 或粘贴文本），识别 `fsusblog-markdown-v2` frontmatter 提取标题并保留正文换行，拒绝不兼容旧备份头；仅载入当前草稿，需显式保存才生成服务端文章身份。

## 3. 异步导出任务与导出回执

- **默认启用**：`FSUSBLOG_DOCUMENT_EXPORT_TASKS` **默认开启**（可显式设为 `false` 关闭）；所需任务表结构随 `FsusBlog.V2.Cli` 统一的 `plan` / `apply` 初始化。
- **任务冻结与生命周期**：任务创建时将选中修订的标题、保存时间、正文摘要、按序选中的 1–4 张授权图片摘要及（PDF 的）工具链摘要共同冻结至输入摘要；后续继续编辑不影响已排队任务。每作者最多保留 4 项、全站最多 16 项，产物与回执保留 30 分钟；排队中可即时取消，执行中取消、服务收到 `SIGTERM` 或数据库租约丢失均即时回收子进程与临时目录。
- **导出回执（Receipt）**：就绪任务可下载包含源修订摘要、图片清单、提供方版本、产物 MIME/长度/SHA-256 及（Word/EPUB 的）格式降级提示（`application/vnd.fsus.document-export-receipt.v2+json`，UTF-16 精确偏移范围）的回执；回执不含正文或图片原始字节，交付前实时复核授权与产物摘要。

## 4. 验证入口

```bash
FSUSBLOG_TEST_FLOW=article-media FSUSBLOG_DOCUMENT_EXPORT_TASKS=true bash tests/EndToEnd/run-native.sh
```
