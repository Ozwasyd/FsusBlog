# Canvas 图形工作区

作者可从文章工作区进入 `/user/manage/canvas`，也可打开已保存文档的直接链接。文档标题、缩放、视口与节点移动保存到 PostgreSQL。空间视图最多挂载 100 个节点和 200 条边，大纲每页最多列出各 50 条已加载节点和边。首次进入只读取首批。可选择按修订加载更多或一次遍历全部记录，大纲使用已加载数据查找并定位节点和边。拖动在松开时写一次，Escape 取消；选中节点可用方向键移动，视口聚焦时方向键平移。

可以创建和编辑五种节点，连接两种边，筛选已加载的节点、调整分组成员，并切换图形及大纲。应用使用检出的 FsusUI 组件呈现确认和编辑对话框。选中文章、标题或块引用后，可以在检查区请求预览。同作者的当前草稿或固定修订显示标题，唯一锚点同时显示纯文本上下文。含歧义或缺失的锚点显示状态。视图、所选节点或文档修订改变后会清除预览。 [引用浏览器结果](../../artifacts/canvas-reference-browser/browser-result.json)

在 Canvas 预览中选择 `Open in editor` 会以当前登录凭证重查 Canvas、节点、文章修订和坐标。只有文章工作区 registry 确认同一已保存修订后才挂载编辑器。对于唯一标题或块锚点，服务保留原始 Markdown 中 `^` 的 UTF-16 坐标。LF 和统一 CRLF 稿件可通过本地 FsusUI 公开定位接口打开。统一 CRLF 稿件在编辑器中映射为 LF，确认全文和坐标边界后再定位，保存时保留 CRLF 及其他原始字符。混用 LF 与 CRLF 或含独立回车的锚点继续使用 Canvas 预览。历史固定修订使用 Canvas 的不可变预览。跳转凭据在当前标签页短期有效，浏览器历史仅暂存不透明标记。固定 v1 源使用同一类 FsusUI `revealSourceRange` 接口定位大纲诊断，未找到固定 v1 前端的 Canvas 跳转实现。

原生 PostgreSQL 与 Chrome 覆盖普通文章、桌面标题和 375px 固定块的准确跳转。带汉字和代理对的语料区分 UTF-16、字符和字节索引。浏览器在预检完成后并发保存新修订时，旧跳转没有挂载编辑器。固定历史修订保留原预览，重复锚点没有打开入口。 [浏览器结果](../../artifacts/canvas-reference-handoff/run-2/browser-result.json) · [运行记录](../../artifacts/canvas-reference-handoff/run-2/run.txt)

统一 CRLF 的浏览器回归核对了原始与编辑器坐标、分解态 Unicode、只改标题、撤销，以及跨行编辑后的保存。PostgreSQL 与 Kestrel 回归同时验证混合换行和单独回车仍能按原始坐标预览。 [浏览器结果](../../artifacts/canvas-crlf-browser/run-1/browser-result.json) · [运行记录](../../artifacts/canvas-crlf-browser/run-1/run.txt)

显式引用边的两端都是未固定修订的普通文章时，可以预览服务端生成的 Markdown。取消保留文章原文，明确确认通过同一数据库事务写入一个新的私有文章修订。图形编辑和链接确认使用同一文档修订号。旧标签收到冲突后可重新加载，网络结果不明时同一请求可重试。视觉边、固定引用和标题／块节点没有链接确认入口。

真实桌面与 375px Chrome 使用 PostgreSQL 18.7 验证五种节点、两种边、鼠标和键盘移动、视口持久化、过期修订冲突、匿名拒绝及显式链接的取消和确认。删除 Canvas 后文章仍完整。 [浏览器结果](../../artifacts/canvas-workspace-runtime/run-2/browser-result.json) · [运行记录](../../artifacts/canvas-workspace-runtime/run-2/run.txt)

图形节点采用单个 Tab 入口。Page Up／Page Down 在当前可见节点间逐个移动焦点，Home／End 定位首尾；Enter／Space 选择节点后，方向键仍按原规则移动节点，Shift 加速。焦点遍历不改变选择、视口或 Canvas 修订；Tab 可离开节点组。视口与节点通过 `aria-describedby` 关联同一可见键盘说明，视口之外的节点和连接继续通过 Outline 查找。`FSUSBLOG_TEST_FLOW=canvas-keyboard tests/EndToEnd/run-native.sh` 定向验证桌面和 375px 的真实持久化、键盘边界、reduced motion 与 forced colors；这不替代完整屏幕阅读器及无障碍审计。对应采用要求 R-3736-01、R-2488-01。

工具栏的撤销与重做绑定当前修订，并在 PostgreSQL 持久保存。刷新后仍可继续操作。图形或大纲中的 Ctrl／Cmd+Z 撤销，Shift+Ctrl／Cmd+Z 重做。新的编辑清除旧重做分支。浏览器回归覆盖键盘操作、刷新后重做、过期标签冲突、焦点归位和 375px。 [历史浏览器结果](../../artifacts/canvas-history-browser/retry-1/browser-result.json)

可以下载当前精确修订的可移植包，再显式映射到本地文章后导入为新 Canvas。 [Canvas 可移植包](canvas-bundles.md)

固定语料包含 10,000 个节点、10,000 条边和 6,000 个显式文章引用映射。安装包 `08d7040`（SHA-256 `04944cbde35a759feb7695c33b6c1144c8044b288a879e595b039fccb2224fee`）在真实 PostgreSQL 18.7 和 Chrome 上运行桌面、375px、桌面三轮。首屏分别为 110.4、69.1 和 65.4 ms。每轮访问 470 页才读完同一修订，耗时分别为 3.319、2.328 和 2.332 秒。三轮均验证了最远的节点与边、空间定位、缩放、拖动视口和键盘焦点，桌面首轮额外验证固定标题解析、移动、撤销和重做。浏览器分别最多挂载 100 个节点、200 条边和 100 个大纲条目。最终修订 16 的 20,000 条记录都与确定语料及唯一一次持久化节点移动相符，重复导出字节一致，两个文章修订保持原样。授权外的会话不可读取。首次重复测试发现同一视口定位的焦点丢失，修复后复测通过。数字为同机回环单次三轮观测，未约定吞吐或延迟目标。 [浏览器测量](../../artifacts/canvas-scale-evidence/run-4/canvas-scale-trials.json) · [数据库复核](../../artifacts/canvas-scale-evidence/run-4/canvas-scale-database.txt)

使用 `db53a07` 解包产物补验万级显式文章链接。作者在完整加载的 10,000 节点和 10,000 边上先取消预览，再确认一个新计划。真实服务提交后，测试丢弃首次网络响应。浏览器以完全相同的请求字节重试并取得原始回执。独立 PostgreSQL 复核只增加一次草稿和 Canvas 修订、一次命令及一次 outbox，两个公开版本与 Canvas 两种边全部保留。 [浏览器结果](../../artifacts/canvas-scale-link-db53a07/canvas-scale-result.json) · [数据库复核](../../artifacts/canvas-scale-link-db53a07/canvas-scale-database.txt)

图形工作区仍缺导入覆盖既有文档、有数据的旧开发数据库转换、更广的标题与块转换、CPU、RSS 和完整无障碍审计。 [事务与原生 API](canvas-transaction.md) · [#2488](https://github.com/Ozwasyd/FsusBlog/issues/2488) · [#2489](https://github.com/Ozwasyd/FsusBlog/issues/2489) · [#3736](https://github.com/Ozwasyd/FsusBlog/issues/3736)

## 待验收的公开片段定位

标题和块链接的候选转换会用当前公开修订生成标准 Markdown 片段。服务端实库回归已覆盖私有修订隔离、发布漂移和精确追加。该候选保留在独立分支。375px 匿名 Chrome 复验中，固定 FsusUI 渲染出的标题、段落和代码块均无对应规范片段目标。正文定位待上游修复后复验。 [FsusUI #1082 的复现评论](https://github.com/Ozwasyd/FsusUI/issues/1082#issuecomment-6898820348) · [匿名 Chrome](../../artifacts/targeted-delivery-82d0180/public-fragment/public-fragment-result.json) · [实库回归](../../artifacts/canvas-public-anchor-749b9ba/native/integration.txt)
