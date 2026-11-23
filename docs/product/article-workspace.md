# 文章工作区与本地草稿恢复

> **角色**：功能契约
> **适用对象**：创作者、前端/后端维护者
> **权威依据**：工作区注册表、草稿日志与布局持久化以 `src/Web/` 与 `src/Server/Authoring/` 源码为准。

## 1. 工作区会话与标签管理（`WorkspaceRegistry`）

- 打开、激活、固定、关闭与恢复共用统一的 `WorkspaceRegistry`，标签栏由 registry 投影，路由负责导航。同一篇文章在工作区内仅保留一个会话；新浏览器标签页使用独立路由，不向原工作区注册。
- 重复打开已有文章会激活原所属组；加载失败不创建空标签。首次保存新建草稿时沿用原会话，服务端返回的文章 ID 成为正式身份。
- 预览标签仅替换同组内已有的干净预览；发生编辑或显式固定即转为固定标签。切回已有标签时重新校验授权与持久化修订，远端存在新修订时保护本机未保存输入并提示冲突。
- 关闭含未确认修改的标签需二次确认；有在途写入请求时禁止直接关闭；身份切换、到期或会话撤销后，迟到的旧请求不得回写当前会话。
- 桌面端按活动标签位置投影最多 24 个标签（溢出每页最多 12 个），窄屏（375px）使用当前文章切换器；registry 最多容纳 100 个会话，界面最多同时挂载 2 个选中的 FsusUI 编辑器实例。
- 「最近关闭」保留最多 12 条同账号的文章 ID 与固定模式；服务器确认稿件不存在或不可再编辑时自动移除条目并保留当前编辑器。

## 2. 双组布局与服务端持久化

- 管理员通过统一 CLI `plan` / `apply` 初始化完整工作区表结构后，可从文章管理「工作区」或编辑页「Open saved workspace」恢复服务端保存的默认布局（两组共最多保存 100 篇已保存文章的组内顺序、固定/预览状态、各组当前文章与焦点组），写入采用乐观并发 CAS。
- 通过「Article ID」→「Open in other group」或组操作菜单可将文章放入另一编辑组或合并两组；宽屏并排显示两组 Markdown 源码（每组最小宽度 29 rem），支持拖拽与键盘方向键/Home/End 调节分隔条及「Equalize group widths」恢复 50/50；窄屏自动折叠并通过「Article groups」切换。
- `EditorInspector` 在宽屏非模态侧栏与 1023px 以下 FsusUI Drawer 之间迁移同一内容树，保留分类、属性输入与修订历史面板，关闭或按 Escape 时恢复原触发控件焦点。

## 3. 快速切换、文章库、最近打开与文档导航

- **Quick switch articles（`Ctrl/Cmd+O`）**：默认列出最近打开文章，输入标题查询授权结果，支持方向键/Home/End/PageUp/PageDown 导航、`Enter` 激活、`Ctrl/Cmd+Enter` 新标签页打开及「Open in other group」。
- **Article library**：复用作者文章管理权限查询（每页 20 条），支持标题、发布状态、分类与标签合取筛选；当前活动文章单独高亮标识。
- **Recent opens**：记录通过工作区主动打开且持有服务端已见证修订的已保存文章，按提交序号倒序每篇保留最新 1 条（上限 1,000 篇及 1,000 条幂等回执），翻页校验历史修订。
- **Outline 与 Find in body**：基于本地 FsusUI 公开投影展示标题大纲与结构诊断（双组往返各自保留大纲与光标，支持 LF 与统一 CRLF 保存格式），正文旁提供查找替换栏并与保存状态联动。

## 4. 本地草稿恢复（`DraftJournal`）

- 编辑页通过仅授权作者可读的 `/api/v2/authoring/recovery-scope.aeds` 获取稳定的账户 UUID 与数据库站点 UUID（站点 UUID 随初始化生成，在重启与完整备份恢复后保持不变）。
- 浏览器在同源 IndexedDB 中以明文暂存尚未提交确认的标题与正文，最长保留 168 小时（能访问同源浏览器资料的主体可读）；各标签写入独立记录，注销或账户级清理会原子推进代次，阻止旧标签复写。
- 已保存文章按文章 ID 索引，新建草稿使用独立草稿 UUID；重新打开时对照服务器修订与本机草稿，由作者显式选择恢复或丢弃。确认保存后清理对应序号并保留后续新编辑；IndexedDB 不可用时仍可直接保存到服务器。

## 5. 验证入口

```sh
node --test tests/Authoring/*.test.ts
node --test tests/Authoring/draftJournal.browser.mjs
dotnet test tests/Core/FsusBlog.V2.Core.Tests.csproj -c Release --no-build
FSUSBLOG_TEST_FLOW=article-library bash tests/EndToEnd/run-native.sh
```

说明：未交付的扩展项（如标签拖放、双组富预览、离线布局同步与完整跨组编辑器挂起快照）见 [发布就绪矩阵](../releases/readiness.md)。
