# 创作模块实现与验收边界

`WorkspaceRegistry` 记录文章与编辑会话的一对一关系。重复打开会激活原所属组，失败的加载不会产生标签。首次保存新建草稿时沿用原会话，服务器返回的文章 ID 成为正式身份。保存结果不覆盖请求发出后的编辑。请求结果不确定时，重试沿用原正文、期望修订和幂等键。身份切换、到期或会话撤销后，旧请求不能回写当前会话。桌面标签、窄屏切换和最近关闭入口接入同一 registry；可见分组、完整快捷切换入口和 FsusUI 会话快照仍待交付。 [文章工作区](article-workspace.md) · [#2293](https://github.com/Ozwasyd/FsusBlog/issues/2293) · [#2294](https://github.com/Ozwasyd/FsusBlog/issues/2294) · [#2295](https://github.com/Ozwasyd/FsusBlog/issues/2295) · [#2296](https://github.com/Ozwasyd/FsusBlog/issues/2296) · [#4234](https://github.com/Ozwasyd/FsusBlog/issues/4234)

`DraftJournal` 已接入编辑页。服务端通过仅作者可读的 `/api/v2/authoring/recovery-scope.aeds` 确认稳定的账户 UUID 与数据库站点 UUID。站点 UUID 随离线安装生成，重启和完整数据库备份恢复后保留。浏览器 IndexedDB 以明文保存尚未确认的标题及正文，最长 168 小时。能访问同源浏览器资料的主体可以读取存储。各标签写入独立记录，账户范围的清理会原子推进代次，阻止旧标签复写。已保存文章按文章 ID 查找，尚未保存的新文章使用独立草稿 UUID。恢复前显示服务器和本机版本，作者可以恢复或丢弃。确认保存后清理对应编辑序号，后来的编辑继续保留。存储不可用时可直接保存到服务器。 [#1813](https://github.com/Ozwasyd/FsusBlog/issues/1813)

真实 Chrome 已验证在已登录编辑器关闭页面后重新打开、显式恢复、保存并确认对应 journal 已清理。独立浏览器测试验证有序退出及重启、过期边界和跨标签注销隔离。崩溃终止和操作系统重启仍待完整验收。 [编辑器浏览器证据](../../artifacts/native-e2e-fsusv2-e2e.ZDTHdh/browser-result.json)

`EditorInspector` 在桌面非模态侧栏和 1023px 以下的实际 FsusUI Drawer 之间移动同一棵内容树。分类和属性表单保持原组件与原输入。一个焦点所有者处理宿主切换与关闭，旧宿主的回调失效，Escape 关闭后优先恢复可用的原触发按钮，否则聚焦当前外部按钮。真实 Chrome 与 PostgreSQL 验证覆盖双向断点切换、同一输入保留、Escape 焦点回归、桌面按钮关闭、日期保存与重新加载。修订历史在同一侧栏显示，确认后通过现有工作区命令生成新的私有草稿，保留公开修订。 [浏览器证据](../../artifacts/native-inspector-revision/run-3/browser-result.json) · [修订历史](article-revision-history.md) · [#4537](https://github.com/Ozwasyd/FsusBlog/issues/4537)

八种封闭属性类型已接入数据库、授权 API 和编辑页。服务端校验稳定字段与选项 ID、schema 及定义版本、引用和约束。完整属性管理界面、查询投影及 v1 导入仍待交付。 [文章属性](properties.md) · [#2322](https://github.com/Ozwasyd/FsusBlog/issues/2322)

Canvas 的创建、分页读取、顺序编辑、CAS、删除和显式文章链接确认共用同一份 PostgreSQL 文档及修订号。真实 HTTP 验证覆盖权限、同请求重试、老修订分页、边与成员清理、故障回滚和链接转换。作者可在真实图形工作区与大纲间切换，使用五种节点和两种边。撤销与重做由同一数据库事务提交，支持刷新后继续、新编辑关闭旧重做分支。文章、标题和块引用解析绑定作者及确切目标修订，关系查询和精确坐标跳转仍待交付。 [Canvas 工作区](canvas-workspace.md) · [Canvas 事务](canvas-transaction.md) · [原生测试](../../artifacts/canvas-graph-20261114/verification.log) · [#3738](https://github.com/Ozwasyd/FsusBlog/issues/3738)

```sh
node --test tests/Authoring/*.test.ts
node --test tests/Authoring/draftJournal.browser.mjs
dotnet test tests/Core/FsusBlog.V2.Core.Tests.csproj --no-restore
```

草稿存储测试使用旁边 FsusUI 已安装的 Playwright 和本机 Chrome。可用 `FSUSBLOG_CHROME` 指定浏览器路径。测试启动独立临时浏览器资料和本地 HTTP 端口，并清理本次创建的资料。
