# P0 · v1 功能、路由与界面样本

参考源冻结为 [FsusBlog `2605b438eed8f16d12ddddf033d08a6fa18fcd12`](https://github.com/Ozwasyd/FsusBlog/tree/2605b438eed8f16d12ddddf033d08a6fa18fcd12)，Git tree `ae47acb5a24a336546abf4756bfdd93e57c9f740`。2026-11-14 通过 `git ls-remote` 对照 `master`，仅在独立 bare 库读取固定提交，未检出、安装、构建或运行 v1。v1 的 `AGENTS.md`、设计 Skill、README 和 ROADMAP 在这里用于提取产品、约束和证据边界；不继承旧仓库的权限、流水线或发布流程。

本表是 **v1 静态存在性与 v2 验收范围**，不是 v2 实现或测试报告。运行状态、独立浏览器验收和 GitHub issue 增量另行核对。源位置使用上述提交中的路径。原始路由以 [`appRouteRecords.ts`](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/router/appRouteRecords.ts)、[`publicRouteRegistry.ts`](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/public-renderers/publicRouteRegistry.ts) 和 [`publicPageManifest.ts`](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/public-renderers/generated/publicPageManifest.ts) 为准。

| 验收标识 | 路由 / 入口 | 身份与产品语义 | 归属 |
| --- | --- | --- | --- |
| UI-01 | `/`、`/archive` | 匿名可读；首页推荐与连续文章流，归档与分页，首屏 HTML 与水合一致。 | Content · P2/P3 |
| UI-02 | `/article/:id` | 匿名只读已公开版本；正文、封面、作者/修订/版权、阅读目录、代码与图片、相关推荐、评论。缺失、撤回或私密内容不生成成功 SEO 页面。 | Content · P2/P3 |
| UI-03 | `/category/:id`、`/tag/:id`、`/tag/:name` | 匿名；分类/标签元数据和分页；当前及旧标签名一次 301 到数字 ID；缺失为 404。 | Content · P3 |
| UI-04 | `/about`、`/privacy`、`/guidelines`、`/copyright` | 匿名；共用 Markdown 文档模板与主题；About 和政策内容来自配置。 | Content · P3 |
| UI-05 | `/search?q=&sort=&page=` | 匿名，首响应 noindex；URL 规范化、浏览器加载静态索引并评分；业务排序 `relevance`、`latest`、`hot`；离线、无结果和错误有明确状态。直接 AEDS 搜索端点是另一调用方边界，见差异 #2。 | Content · P2/P3 |
| UI-06 | `/login`、`/register`、`/recover` | 访客进入聚焦身份流程；PoW/风险检查、Passkey、MFA 和恢复凭据按实际挑战分步；已确认身份回账户或管理页。 | Identity · P2/P3 |
| UI-07 | `/user`、`/user/profile`、`/user/identity` | 根路径根据实际账户和 admin principal 分流；`profile` 为 Identity 入口跳转，不能把自助账户权限等同管理权限。 | Identity · P3 |
| UI-08 | `/user/identity/{passkeys,recovery-key,anonymous,public-profile,sessions,mfa,comment-records}`；`/user/comments`、`/user/preferences/language` | 账户会话；凭据、恢复密钥、MFA 和会话的操作具有敏感边界；匿名和公开身份的选择、评论记录及语言偏好互不代替。 | Identity/Content · P3 |
| UI-09 | `/user/messagebox`、`/user/manage/messages`；壳中的通知入口 | 账户收件箱与管理员消息中心分开；对话、草稿、广播和阅读状态；推送游标重连与权限收回。管理员路由需 `admin.manage`。 | Communication · P3 |
| UI-10 | `/user/manage`、`/user/manage/{analytics,users}` | 活跃管理会话加 `admin.manage`；工作台可执行待办、站点统计、用户治理；空态不能伪造成正常统计。 | Identity/Operations · P3 |
| UI-11 | `/user/manage/article/{write,edit/:id,list,trash}` | `article.write`；文章列表、作废箱、新建/编辑、草稿恢复、发布状态、资源和历史；编辑地址为 `memory-only`，确认会话后激活，禁止用 route 参数代替授权。 | Content/Authoring · P2/P4 |
| UI-12 | `/user/manage/{category,tag,assets,content-tools}` | 分类、标签、资产库需 `article.write`；内容运维工具另需 `system.config`。处理引用、失联资源、媒体权限和错误恢复。 | Content/Operations · P3/P5 |
| UI-13 | `/user/manage/moderation`、`/user/manage/moderation/{comments,dictionaries,policies,regions,region-groups,policy-templates,replay,model,audit}`；`/user/manage/comments` 跳审核队列 | `comment.moderate`；待审、筛选、认领、批量审查、地区、模板、模型、回放和审计。公开评论的看见/管理权限与后台审查状态分离。 | Content · P3 |
| UI-14 | `/user/manage/moderation/{anonymous-policy,anonymous-risk,anonymous-credentials,nullifiers,zk-anonymous}` | 分别检查 `anonymous.comment.configure`、`comment.moderate`、`anonymous.credential.revoke`、`anonymous.nullifier.block`、`anonymous.comment.configure`；附加功能/政策门控和服务端 step-up。 | Content/Identity · P3/P5 |
| UI-15 | `/user/manage/security`、`/user/manage/security/{risk-control,simulator,challenges,policies,events,pospace,perception-v2,crawler,pow}` | `system.config`；状态、异常、策略、事件和防护配置。`challenges` 路由为 `session-sensitive`；历史路由名本身不规定使用哪代挑战协议。 | Identity/Operations · P3/P5 |
| UI-16 | `/user/manage/audit`、`/user/manage/{settings,ops,cluster,cache,integrity,integrity-proof}` | 审计需 `audit.read`；其余需 `system.config`，高风险写操作仍检查额外授权；集群和完整性证明为 `session-sensitive`。 | Operations · P5 |
| UI-17 | `/user/manage/{plugins,themes,fonts}`；文章/编辑器中的导出入口 | `system.config` 管理扩展，插件/字体路由为 `session-sensitive`；导出受文章与提供方能力约束。应用实际主题可更改外观，不能越过资源权限。 | Extensions · P5 |
| UI-18 | `/403`、未知路由、首屏 400/404/503 | 紧凑的状态与恢复动作；未知、私密或撤回不得返回带公开元数据的 200。权限探测失败不猜测用户已经授权。 | Operations/各域 · P2/P3 |

管理叶路由的权限是前端可见性要求；测试还必须用相同及缺少权限的凭据直接调用服务器。账户区的 `private-recoverable` 可以携带经过筛选的恢复地址；`session-sensitive` 和 `memory-only` 不输出敏感查询、片段或恢复材料。账户和独立管理会话有不同来源和生命周期。管理导航按叶权限再生成六个一级模块（工作台、内容、互动、安全、系统、运维），隐藏没有可用叶的模块，回退到第一个有权入口。移动端两级导航用一个 Drawer，支持同样的当前状态、键盘和焦点返回。依据：`docs/frontend/admin-information-architecture.md`、`docs/security/frontend-navigation-privacy.md` 与路由守卫。

非页面能力包括 RSS/Atom 等开放分发、站点地图、公开完整性 sidecar、服务端资产票据、WebSocket `fsus-aeds.v2`、公开搜索 API、导入与备份恢复、主题及字体资产、插件 sandbox/broker、Article Vault 与运维控制。详见 [业务域静态证据](v1-domain-evidence.md)；这些能力虽未各占一个页面，也保留在最终范围。ROADMAP 的 i18n、集群及扩展阶段描述的是成熟度，不能用来否认固定提交已存在的路由或能力，也不能证明多节点已经可用。

## 可用图像和还缺什么

[`docs/assets/screenshots/manifest.json`](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/assets/screenshots/manifest.json) 管理 9 张示例图，记录的截图来源为 `08568ad4fc006eab91155fd5ce5c684dc1b72faa`，对应 FsusUI `83da83362091a7ee5bffc561ea1ef2953338f216`。独立质量清单关联另一个提交 `b3832ed5d336ca8f7d420b91b60911de9152416d`。这些均是历史参考；文件在参考提交中可读取不等于在参考提交时实际重拍。`tests/frontend/e2e/visual` 另有 43 张 tracked PNG，包含测试截图而非完整全路由图库。`tests/frontend/fixtures/layout-archetype-matrix.json` 给出代表路由和证据目标；例如部分控制台测试图只覆盖页面标题区域，不能当作完整页面的设计依据。

| 页面族 | 图像 / 静态依据 | 重做时保留 | 缺口 |
| --- | --- | --- | --- |
| 首页 | 已查看 `public-home-light.png`、`public-dark.png`；`public-home-*` 有桌面/移动 × 明暗测试图。 | 单一站点页头、窄内容列、图文推荐、横线与正文流、安静页尾；移动保留同序的内容。 | 历史图重复推荐，按当前设计去重；无封面、无推荐和分页用 v2 验证。 |
| 文章 | `article-detail-light.png`、已查看 `article-detail-mobile.png`；`public-article-*` 有桌面/移动 × 明暗。 | 16:9 封面在首段之前，标题/元信息/正文/评论顺序；正文有阅读重心，TOC 及代码各守边界，只有图片查看允许玻璃材质。 | 历史移动图正文偏右且中英文混合，不作为应复制的表现；缺互动图包括评论权限、长代码、焦点和完整性失败。 |
| 归档、分类、标签、检索、政策 | 公开路由、`Archive.vue`、`FilterView.vue`、`PublicDynamicPage.vue`、AOT 路由规范及 Playwright 测试定义。 | 保留公开编辑式页框，标题 → 说明 → 内容；归档粘性目录、搜索筛选、文档模式不首行缩进。 | 没有逐页同版本图；视觉以语义规范和静态层次为参考，验证 v2 后仍不能宣称历史像素一致。 |
| 身份入口 | `public-login-*` 有桌面/移动 × 明暗测试图；`views/auth/` 可读。 | 单栏、一个 H1/主动作、按步展示挑战与反馈，保留密码管理器、Passkey 与键盘路径。 | 无注册、恢复、Passkey 设备差异、MFA 与权限切换的完整历史截图序列。 |
| 账户与收件箱 | `user-profile-*`、`user-messagebox-*` 有桌面/移动 × 明暗代表快照；`AccountLayout.vue`、`AccountIdentityFrame.vue`。 | 账户页与管理区共用稳定顶栏；收件箱 takeover 保留模块上下文，收窄时保留动作与焦点。 | 无逐一的 passkeys、恢复密钥、匿名、MFA、会话、评论及错误图；不要据身份首页外推。 |
| 管理工作台与列表 | `admin-dashboard.png`、`manage-dashboard-*`、`manage-users-*`、`manage-settings-*`、dashboard workbench 和空态测试图。 | 一级模块和本地目的地层次、紧凑 actionable 工作台、安静任务面、必要边界。 | 不同角色、禁用功能、桌面最小高度、窄屏 Drawer 和异常状态需验证。 |
| 写作与 Inspector | 已查看 `article-editor.png`；`manage-write-*`；`Write.vue`、`docs/frontend/layout-visual-governance.md` 与编辑器测试定义。 | 状态/草稿/发布命令栏，稳定居中正文列，编辑/分屏/预览，桌面非模态 Inspector 与窄屏 FsusUI Drawer，同一个内容和焦点职责。 | 旧截图不能代表 issue 增量，尤其 registry、Canvas、属性、并发冲突、exact opener 回焦和跨 host 动态行为；缺图部分需要以实际 v2 流程核对。 |
| 评论审核、安全及运维 | `comment-moderation.png`、`security-console.png`、`operations-status.png`，另有各视图及测试定义。 | 单一内层安全导航，概览强调状态和异常；审查操作、系统健康和配置具备不同权限与状态。 | 大部分子页仅有源码，无全矩阵截图；备份迁移、集群、扩展、导出、权限变化和故障路径均需专门核对。 |
| 错误与临时界面 | `views/error/`、设计 `status`/`overlay` Profile、组件和 route audit 定义。 | 403/404 把恢复指向与解释放在同一阅读路径；Dialog/Drawer/Popover 不改写共享几何和焦点语义。 | 无完整错误、载入、空态、禁用与所有叠层截图。 |

视觉裁决依据是 [`surface-profiles.md`](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/design/surface-profiles.md)、[`public-layout-rules.md`](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/public-layout-rules.md)、`docs/design/reading-typography.md`、`docs/design/page-title-scale.md` 与 `docs/frontend/layout-visual-governance.md`，再核对当前真正接入的 FsusUI 公共组件、tokens 与样式。工作区兄弟 FsusUI 源码 2026-11-14 初查 `f2d929a5d045439c35e93b4771f912ce50ec2337`，tree `93d1cc407fc461196db4e11c4dac7de8c5b0cbed`，`git status --short` 为空。v2 继续通过 checkout alias 消费源文件及可用的 test-only contracts；实际构建和浏览器证据重新绑定 FsusUI 身份，不把历史图的 FsusUI 提交当作当前依赖。公共交互不得依靠 FsusUI 私有选择器或复制 token 值。

## 差异和待决事项

1. **首页去重**：历史首页图片的主推荐在最新流重复；参考提交的 `src/frontend/src/view-contracts/homeSpotlight.ts` 也直接复制 `feedItems`。当前布局规范明确要求同页文章 ID 不重复。v2 验收按规范，保证主推荐、最多五条次推荐与当前流互斥，同时保留各自输入顺序与无封面文本路径。
2. **检索是两个入口**：README 称无在线服务器检索；固定提交的 `src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs` 注册独立匿名 `GET /api/binary/article/search/query.aeds`，API quick reference 也记录此入口。浏览器本地排序与静态投影是 UI 的默认路径；直接 AEDS API 是否维持何种稳定级别须在协议清单记录，不能按 README 静默删除或让 UI 切换到服务器 fallback。
3. **身份材料优先级**：README 简述登录与 Passkeys，但不能据此推断一般账号密码等价。以固定提交的账户/管理注册、登录和恢复 contracts 及实现为准；用临时身份设施做最初集成时必须保留尚未提供 Passkey、TOTP、恢复密钥和独立 admin principal 的缺口。
4. **扩展和集群成熟度**：已设管理路由与后端部分能力，ROADMAP 同时保留阶段限制。以独立验收用例标明现有运行形态、可选组件、独立风险和未完成增量，不把静态类的存在视为生产承诺。
5. **快照与安全规定**：移动正文布局、历史组件样式、政策名称、旧 JSON 或旧认证/结构的实现仅供参考。已定义的外部标准/运维例外单列；计划禁止恢复 JSON 业务 fallback。公开未发布/已撤回内容、无效认证和敏感失败的输出以安全语义为准。

v2 验收以场景而非截图数量计量。用 `UI-01…18` 作为需求来源标签，在各阶段记录输入、身份、前置状态、操作、可见结果、持久化结果和失败结果；适用于主题、缩放、键盘、长内容、空/错/加载与权限变化的，须涵盖这些状态。P2 不得以静态模板、快照像素或 fixture 登录证明端到端可用，P3–P5 未完成页面也不得因没有样本图从台账移除。
