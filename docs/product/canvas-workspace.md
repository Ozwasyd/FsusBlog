# Canvas 图形工作区

作者可从文章工作区进入 `/user/manage/canvas`，也可打开已保存文档的直接链接。文档标题、缩放、视口与节点移动保存到 PostgreSQL。空间视图最多挂载 100 个节点和 200 条边，大纲每页最多列出各 50 条已加载节点和边。首次进入只读取首批。可选择按修订加载更多或一次遍历全部记录，大纲使用已加载数据查找并定位节点和边。拖动在松开时写一次，Escape 取消；选中节点可用方向键移动，视口聚焦时方向键平移。

可以创建和编辑五种节点，连接两种边，筛选已加载的节点、调整分组成员，并切换图形及大纲。应用使用检出的 FsusUI 组件呈现确认和编辑对话框。选中文章、标题或块引用后，可以在检查区请求预览。同作者的当前草稿或固定修订显示标题，唯一锚点同时显示纯文本上下文。含歧义或缺失的锚点显示状态。视图、所选节点或文档修订改变后会清除预览。跨工作区导航仍待接入。桌面标题、重复锚点处理和 375px 固定块预览已在真实应用验证。 [引用浏览器结果](../../artifacts/canvas-reference-browser/browser-result.json)

显式引用边的两端都是未固定修订的普通文章时，可以预览服务端生成的 Markdown。取消保留文章原文，明确确认通过同一数据库事务写入一个新的私有文章修订。图形编辑和链接确认使用同一文档修订号。旧标签收到冲突后可重新加载，网络结果不明时同一请求可重试。视觉边、固定引用和标题／块节点没有链接确认入口。

真实桌面与 375px Chrome 使用 PostgreSQL 18.7 验证五种节点、两种边、鼠标和键盘移动、视口持久化、过期修订冲突、匿名拒绝及显式链接的取消和确认。删除 Canvas 后文章仍完整。 [浏览器结果](../../artifacts/canvas-workspace-runtime/run-2/browser-result.json) · [运行记录](../../artifacts/canvas-workspace-runtime/run-2/run.txt)

工具栏的撤销与重做绑定当前修订，并在 PostgreSQL 持久保存。刷新后仍可继续操作。图形或大纲中的 Ctrl／Cmd+Z 撤销，Shift+Ctrl／Cmd+Z 重做。新的编辑清除旧重做分支。浏览器回归覆盖键盘操作、刷新后重做、过期标签冲突、焦点归位和 375px。 [历史浏览器结果](../../artifacts/canvas-history-browser/retry-1/browser-result.json)

可以下载当前精确修订的可移植包，再显式映射到本地文章后导入为新 Canvas。 [Canvas 可移植包](canvas-bundles.md)

固定语料包含 10,000 个节点、10,000 条边和 6,000 个显式文章引用映射。安装包 `08d7040`（SHA-256 `04944cbde35a759feb7695c33b6c1144c8044b288a879e595b039fccb2224fee`）在真实 PostgreSQL 18.7 和 Chrome 上运行桌面、375px、桌面三轮。首屏分别为 110.4、69.1 和 65.4 ms。每轮访问 470 页才读完同一修订，耗时分别为 3.319、2.328 和 2.332 秒。三轮均验证了最远的节点与边、空间定位、缩放、拖动视口和键盘焦点，桌面首轮额外验证固定标题解析、移动、撤销和重做。浏览器分别最多挂载 100 个节点、200 条边和 100 个大纲条目。最终修订 16 的 20,000 条记录都与确定语料及唯一一次持久化节点移动相符，重复导出字节一致，两个文章修订保持原样。授权外的会话不可读取。首次重复测试发现同一视口定位的焦点丢失，修复后复测通过。数字为同机回环单次三轮观测，未约定吞吐或延迟目标。 [浏览器测量](../../artifacts/canvas-scale-evidence/run-4/canvas-scale-trials.json) · [数据库复核](../../artifacts/canvas-scale-evidence/run-4/canvas-scale-database.txt)

图形工作区仍缺导入覆盖既有文档、有数据的旧开发数据库转换、把交互和所有关联域行为合并的一万节点矩阵，以及 CPU、RSS 和完整无障碍审计。 [事务与原生 API](canvas-transaction.md) · [#2488](https://github.com/Ozwasyd/FsusBlog/issues/2488) · [#2489](https://github.com/Ozwasyd/FsusBlog/issues/2489) · [#3736](https://github.com/Ozwasyd/FsusBlog/issues/3736)
