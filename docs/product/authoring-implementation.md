# 创作模块实现与验收边界

`WorkspaceRegistry` 记录文章与编辑会话的一对一关系。重复打开会激活原所属组，失败的加载不会产生标签。首次保存新建草稿时沿用原会话，服务器返回的文章 ID 成为正式身份。保存结果不覆盖请求发出后的编辑。请求结果不确定时，重试沿用原正文、期望修订和幂等键。身份切换、到期或会话撤销后，旧请求不能回写当前会话。编辑页使用该 registry 管理草稿，现阶段需要独立验收完整标签栏、分组、所有打开入口、真实编辑器挂起与恢复，以及崩溃后恢复界面。 [#2293](https://github.com/Ozwasyd/FsusBlog/issues/2293) · [#2294](https://github.com/Ozwasyd/FsusBlog/issues/2294) · [#2295](https://github.com/Ozwasyd/FsusBlog/issues/2295) · [#2296](https://github.com/Ozwasyd/FsusBlog/issues/2296) · [#4234](https://github.com/Ozwasyd/FsusBlog/issues/4234)

`DraftJournal` 使用明文 IndexedDB 暂存未确认的标题与正文。仅限本机同源浏览器，最长 168 小时。同源脚本和能访问该浏览器资料的主体可以读取存储。字节摘要用于判断是否与已保存源相同。各标签写入独立记录，账户范围的清理会原子推进代次，已打开的旧标签随后无法写入。浏览器存储不可用时由调用方继续提供服务器保存。该模块目前没有接入编辑页。接入前需要服务端提供可跨重载复用的稳定账户和站点标识，并完成恢复、比较、清理入口。真实 Chrome 已验证有序退出后重启，崩溃、强制终止或操作系统重启仍待验收。 [#1813](https://github.com/Ozwasyd/FsusBlog/issues/1813)

`createInspectorFocus` 让单个焦点所有者跨断点接收抽屉关闭事件。旧宿主的回调失效，关闭后优先回到仍可用的原触发按钮，再使用当前宿主的外部按钮。生命周期单元测试和真实 DOM 焦点冒烟已验证。响应式 Inspector 页面和真实 FsusUI Drawer 的组合仍待实现和验收。 [#4537](https://github.com/Ozwasyd/FsusBlog/issues/4537)

服务端 Core 的属性定义领域规则接受八种封闭类型，校验稳定字段和选项 ID、schema 及定义版本、引用与约束。文本属性已接入数据库、授权 API 和编辑页，其他七种类型的生产持久化、查询投影及属性管理界面仍待交付。 [文本属性](properties.md) · [#2322](https://github.com/Ozwasyd/FsusBlog/issues/2322)

Canvas 的显式文章链接确认已通过原生 PostgreSQL 验证。该路径支持同作者的公开目标、文末插入和保留边。完整 Canvas 界面、关系查询、标题及块引用和编辑器撤销仍待交付。 [Canvas 事务](canvas-transaction.md) · [#3738](https://github.com/Ozwasyd/FsusBlog/issues/3738)

```sh
node --test tests/Authoring/*.test.ts
node --test tests/Authoring/draftJournal.browser.mjs
dotnet test tests/Core/FsusBlog.V2.Core.Tests.csproj --no-restore
```

草稿存储测试使用旁边 FsusUI 已安装的 Playwright 和本机 Chrome。可用 `FSUSBLOG_CHROME` 指定浏览器路径。测试启动独立临时浏览器资料和本地 HTTP 端口，并清理本次创建的资料。
