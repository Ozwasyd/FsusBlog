# Canvas 图形工作区

作者可从文章工作区进入 `/user/manage/canvas`，也可打开已保存文档的直接链接。文档标题、缩放、视口与节点移动保存到 PostgreSQL。空间视图最多挂载 100 个节点和 200 条边，大纲每页最多列出各 50 条已加载节点和边。更多服务器记录按锁定修订号分批加载。拖动在松开时写一次，Escape 取消；选中节点可用方向键移动，视口聚焦时方向键平移。

可以创建和编辑五种节点，连接两种边，筛选已加载的节点、调整分组成员，并切换图形及大纲。应用使用检出的 FsusUI 组件呈现确认和编辑对话框。选中文章、标题或块引用后，可以在检查区请求预览。同作者的当前草稿或固定修订显示标题，唯一锚点同时显示纯文本上下文。含歧义或缺失的锚点显示状态。视图、所选节点或文档修订改变后会清除预览。跨工作区导航仍待接入。桌面标题、重复锚点处理和 375px 固定块预览已在真实应用验证。 [引用浏览器结果](../../artifacts/canvas-reference-browser/browser-result.json)

显式引用边的两端都是未固定修订的普通文章时，可以预览服务端生成的 Markdown。取消保留文章原文，明确确认通过同一数据库事务写入一个新的私有文章修订。图形编辑和链接确认使用同一文档修订号。旧标签收到冲突后可重新加载，网络结果不明时同一请求可重试。视觉边、固定引用和标题／块节点没有链接确认入口。

真实桌面与 375px Chrome 使用 PostgreSQL 18.7 验证五种节点、两种边、鼠标和键盘移动、视口持久化、过期修订冲突、匿名拒绝及显式链接的取消和确认。删除 Canvas 后文章仍完整。 [浏览器结果](../../artifacts/canvas-workspace-runtime/run-2/browser-result.json) · [运行记录](../../artifacts/canvas-workspace-runtime/run-2/run.txt)

工具栏的撤销与重做绑定当前修订，并在 PostgreSQL 持久保存。刷新后仍可继续操作。图形或大纲中的 Ctrl／Cmd+Z 撤销，Shift+Ctrl／Cmd+Z 重做。新的编辑清除旧重做分支。浏览器回归覆盖键盘操作、刷新后重做、过期标签冲突、焦点归位和 375px。 [历史浏览器结果](../../artifacts/canvas-history-browser/retry-1/browser-result.json)

可以下载当前精确修订的可移植包，再显式映射到本地文章后导入为新 Canvas。 [Canvas 可移植包](canvas-bundles.md)

图形工作区仍缺导入覆盖既有文档、有数据的旧开发数据库转换和 10,000 节点整条浏览器链路的验收。当前 10,000 节点浏览器检查使用内存输入验证挂载上限。 [事务与原生 API](canvas-transaction.md) · [#2488](https://github.com/Ozwasyd/FsusBlog/issues/2488) · [#2489](https://github.com/Ozwasyd/FsusBlog/issues/2489) · [#3736](https://github.com/Ozwasyd/FsusBlog/issues/3736)
