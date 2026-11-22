# Web 验证

前端使用 `src/Web/pnpm-lock.yaml` 的精确版本和相邻 FsusUI 源码。使用 Node 24.16.0、pnpm 10.33.0 和本机既有 pnpm store 执行以下命令。V2 Web 锁最终包含 Playwright 1.59.1，恢复没有下载。

```sh
pnpm --dir src/Web install --offline --frozen-lockfile --ignore-scripts
pnpm --dir src/Web typecheck
pnpm --dir src/Web build
```

Vite 和 vue-tsc 都将 `@ozwasyd/element-plus` 和消费到的子路径指向相邻 FsusUI 源码。Vite 将官方 `dist/fsus.css` 入口解析到 `theme-chalk/src/fsus.scss`，由 Sass 编译完整主题。类型检查覆盖所有 V2 Web 源、契约 TypeScript 和真实 FsusUI 组件类型，启用 Vue 严格模板检查。原生 Markdown 需要 FsusUI 的六个 Wasm 资源，已准备的离线资源可通过 `FSUSBLOG_FSUSUI_WASM_DIST` 指定。Vite 用 FsusUI 自己的工具重新计算 native 源指纹，和资源目录的 `.native-artifact-fingerprint` 比对。缺文件、指纹不匹配会拒绝显式指定的目录。没有准备资源且本地 checkout 未生成资源时，写作区域显示原始 Markdown 编辑状态，公开详情显示转义后的原始正文；界面明确标注格式化和富编辑不可用。

已验证以下路径：

| 证据 | 验证内容 | 限制 |
| --- | --- | --- |
| V2 Vite 构建和 strict vue-tsc | 真实本地 FsusUI 与 AEDS TypeScript 客户端编译。ES module Worker 生成成功。带匹配预构建资源时六个资源都进入构建。 | 缓存资源的指纹确认源码匹配，和本轮从源码构建是两项独立证据。 |
| Chrome + Playwright，1280×800 和 375×850 | 访问 V2 登录页、输入控制、切换暗色，从登录返回首页，观察实际服务器未提供时的错误及重试；无横向溢出、框架覆盖层或意外 JavaScript 异常。 | Vite preview 没有数据库或 API；其请求失败是本次验证的预期条件。 |
| Chrome + Playwright，独立 FsusUI 源 alias，1280×800 和 375×850 | 使用与 `f2d929a5d045439c35e93b4771f912ce50ec2337` 源码指纹匹配的现有资源。真实 MarkdownRenderer 输出标题，在真实 MarkdownEditor 修改正文后标题同步更新。主题切换、按钮交互、两种尺寸都通过。 | 这是组件和资源验证。没有数据库事务，因此不构成 V2 登录发布撤回验收。 |

对照 v1 截图，保留左对齐的专注登录区、公开导航与单列文章流、文章阅读列和编辑页的顶部命令。公开搜索当前在浏览器按已发布索引的标题和摘要筛选，全文检索路径未接入浏览器。待后续验收的差异包含 Passkey/恢复、完整管理导航、首页精选排序与封面、多语言、政策/关于页、评论和移动编辑工作区。

完整浏览器脚本 `tests/EndToEnd/blog-flow.mjs` 需要一个隔离的、包含当前 V2 schema 的 PostgreSQL、运行中的 V2 Web 生产构建，以及由离线工具发出的作者票据。使用新建的测试数据库，票据通过 `FSUSBLOG_TEST_TICKET` 环境变量传递。脚本覆盖登录、未授权写作、草稿保存、关闭确认、发布后的 HTML/AEDS、浏览器按标题或摘要筛选静态索引及索引代次、另一个浏览器标签内的 CAS 冲突、撤回及登出。需要同时验收富编辑时，以 `FSUSBLOG_TEST_REQUIRE_NATIVE=1` 运行。脚本会保存截图及结果 JSON，并关闭自己的浏览器。数据库、服务、票据和残留测试稿的清理由创建该隔离环境的调用者负责。

```sh
FSUSBLOG_TEST_URL=http://127.0.0.1:5080 \
FSUSBLOG_TEST_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
FSUSBLOG_TEST_REQUIRE_NATIVE=1 \
node tests/EndToEnd/blog-flow.mjs
```

真实闭环已在本机 PostgreSQL 18.7、.NET 10.0.302、Chrome 157.0.8103.51、Playwright 1.59.1 和重新构建的 FsusUI Wasm 上通过。

最近一轮完整证据位于 `artifacts/native-e2e-fsusv2-e2e.kbjzwL/`。`run.txt` 记录 `exit=0` 和 `cleanup=1`，`browser-result.json` 记录原生 Markdown 必需、零额外诊断、CAS 返回 409、服务端登出返回 200 以及原浏览器会话随后的拒绝。真实浏览器也验证了首页游标前进和后退、发布后的旧游标恢复、分类数据和空状态，以及旧标签名称跳转到数字地址。此轮关联开发中的文件状态与具体构建摘要，提交后可用同一入口复跑。

运行 `bash tests/EndToEnd/run-native.sh` 会用独立的 Unix socket 建立临时数据库、运行迁移、导入固定公开文章与分类标签夹具、启动 V2 服务和浏览器，再核验清理。写作通过当前管理员入口和浏览器虚拟 Passkey 登录。验收覆盖公开页与 AEDS 使用同一发布坐标，私有修订不会替换已发布正文，撤回后详情和本地索引均不可见，旧修订冲突保留本地编辑。取消离开也经过真实 FsusUI 对话框验证。证据目录含桌面登录/编辑、375px 暗色首页/文章/搜索截图、浏览器结果、服务日志和构建摘要。

`FSUSBLOG_TEST_FLOW=article-library bash tests/EndToEnd/run-native.sh` 在当前编辑器验证文章库和快速切换，包括桌面与窄屏入口、分页、焦点恢复和会话切换。同一入口使用 `FSUSBLOG_TEST_FLOW=property-history` 验证编辑器中的历史属性对比。作者全文检索及属性索引使用 `tests/Integration/AuthorText*PostgresTests.cs` 验证。属性查询、保存视图执行及权限使用 `PropertyQueryPostgresTests` 验证。作者列表、软删除与恢复分别由 `AuthorArticleInventoryPostgresTests` 和 `ArticleTrashPostgresTests` 使用真实 PostgreSQL 接口验收。

媒体验收同样使用 `run-native.sh` 和独立管理员 Passkey。将 `FSUSBLOG_TEST_FLOW` 分别设为 `private-media`、`article-media` 和 `public-article-media`，验证资产库、编辑器附件与公开图片。对应的附加检查分别使用 `FSUSBLOG_TEST_RESUMABLE_MEDIA=1`、`FSUSBLOG_DOCUMENT_EXPORT_TASKS=true` 和 `FSUSBLOG_TEST_MEDIA_WEBP=1`。

`FSUSBLOG_TEST_FLOW=property-inspector-scale bash tests/EndToEnd/run-native.sh` 使用当前编辑器遍历 1,000 个属性定义。附加 `FSUSBLOG_TEST_PROPERTY_ACCESSIBILITY=1` 可复验明暗主题在 100%、150%、200% 浏览器缩放下的键盘焦点和 Chromium 无障碍树。

`FSUSBLOG_TEST_FLOW=canvas-scale bash tests/EndToEnd/run-native.sh` 经当前管理入口和两个独立的管理员 Passkey 验证 10,000 个节点、10,000 条边、匿名与跨账号隔离、原有挂载上限和断连重试。浏览器结束后由 PostgreSQL 独立核对图、文章修订和命令回执。

`FSUSBLOG_TEST_FLOW=public-route-transition FSUSBLOG_TEST_AUTH_TRANSITIONS=1 bash tests/EndToEnd/run-native.sh` 启用读者注册入口，验证公开页、登录和注册之间的客户端导航、浏览器后退、共享页头及减少动态效果设置。默认关闭该开关时仍运行公开导航验证。

`FSUSBLOG_TEST_FLOW=reader-registration bash tests/EndToEnd/run-native.sh` 在隔离 PostgreSQL 中验证读者勾选准则、完成 PoW 与 Passkey 注册、注册后仍需登录，以及读者会话访问当前管理端和创作接口时返回 401。浏览器同时验证当前写作页拒绝读者进入。

`FSUSBLOG_TEST_FLOW=comment-author-delete bash tests/EndToEnd/run-native.sh` 使用统一登录页、管理员 Passkey 和实际注册的读者 Passkey，验证同一读者的两个独立会话、跨账号拒绝、取消与删除确认，以及撤回文章后读者仍能删除自己发表的评论。

管理员工作区的双站点 HTTPS 浏览器检查已验证桌面四个导航入口共用同一管理工作区。320px 下，站点设置页的复选框长标签在打开菜单之前就产生横向滚动。窄屏无溢出断言保留，等待上游修复。 [FsusUI #1126 及复现](https://github.com/Ozwasyd/FsusUI/issues/1126)

后续在当前 FsusUI checkout 用 Emscripten 5.0.4 重建原生资源，清除 `FSUSBLOG_FSUSUI_WASM_DIST` 后重新运行 V2 的严格检查和构建；六个新生成的本地资源都进入成品。在 1280×800 和 375×850 重跑真实 Chrome Markdown 编辑/预览探针，两种视口均通过且无诊断。见 [构建和摘要](fsusui.md)。
