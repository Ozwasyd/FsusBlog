# Public Layout Rules

本文档只拥有 FsusBlog 的公共与编辑式页面构图。设计基线、所有权和规则优先级见 [`design/governance.md`](design/governance.md)，页面分类见 [`design/surface-profiles.md`](design/surface-profiles.md)；本文不替代 FsusUI `docs/design.md`，也不拥有通用组件几何或 token 数值。

## 1. Token 命名空间策略

FsusBlog consumer token 使用 `--fsusblog-*` 命名空间，并且必须表达公共布局、阅读列、内容层级或其他 Blog 产品语义。公开布局不得定义、覆盖或伪造 `--fsus-*` 中转别名，也不得把当前 FsusUI 数值复制为本仓权威值；需要承接上游设计语义时，映射当前基线公开的 FsusUI 或 Element Plus token。

## 2. Public shell 边界

公开顶栏、移动导航、搜索增强、鉴权入口、footer、AOT/emergency CSS 和 sticky geometry 的权威契约见 [`frontend/public-shell-ownership.md`](frontend/public-shell-ownership.md)。本文只决定内容如何进入壳层：顶栏是唯一站点品牌面，页面正文不复制 Hero；全局 BottomTabBar 与页面 reading dock 互斥。文章详情通过 FsusUI `content-flow="content-driven"` 使用自然文档流，其他公开路由使用 `viewport-stable`；consumer 禁止用 deep/internal selector 改写 shell 主内容 flex 或 padding。

其他生产页面的跨组件 selector 必须遵循
[`frontend/internal-selector-governance.md`](frontend/internal-selector-governance.md)：
先归类 FsusUI/FsusBlog/third-party owner，再登记有限 expiry 与 replacement，预算只能
下降。将 `:deep()` 改成全局 `.el-*` 不算迁移。

## 3. Reading surface 契约

以下组件必须声明 `data-fsus-surface="reading"`：

- `PublicArticleDetailPageContent.vue` 根 `<article>` 与 `#fsus-comments-island`
- `ArticleTocPanel.vue` desktop TOC 与 mobile drawer
- `MarkdownRenderer.vue`
- `ArticleReadingProgress.vue`
- `ArticleReadingNotice.vue`
- `ArticleDetailHeader.vue`
- `ArticleCommentsVirtualList.vue`
- `ArticleCommentComposer.vue`
- `PublicArticleList.vue`
- `FeaturedArticlesSection.vue`

Reading surface 禁用 glass、motion trail、glow、accent shimmer 和 scroll reveal。正文、标题、图片与代码块静态出现；复制反馈、focus/target 定位、阅读进度状态和媒体 overlay 仍可使用功能动效。公开阅读面的 skeleton 使用中性 document placeholder，不使用 `animated` prop。

ArticleDetail 评论 section 与正文末尾间距固定为 mobile 40px / desktop 56px；
section title 到 divider 为 12px，divider 到首个评论状态为 24px。Empty 与
populated 共用同一 heading 和左右基线，但 Empty 不继承列表分页、加载区或 shell
viewport 填充预算。空态 CTA 保持 44px 高、6px 圆角与 16px 水平 padding；最后一个
真实状态区块到 footer 只保留 mobile 48px / desktop 64px。不得用 `min-height`,
flex spacer、插画或装饰卡片填补短内容。

## 4. Dialog 宽度变体白名单

Dialog、Drawer 与 Popover 的几何由当前 FsusUI 公共契约拥有。公开布局只选择 documented variant，并拥有标题、内容顺序和 action priority；不得在本文复制宽度值，也不得用 consumer CSS 新增变体。宿主关系、材料与响应式验收见 [`design/surface-profiles.md`](design/surface-profiles.md) 的 `overlay` 档案。

## 5. Glass material 启用 surface 白名单

Glass material 只允许用于以下 surface：

- article image lightbox

其他 public/read surface 默认使用 paper/document material。新增 glass surface 必须携带 `[data-fsus-material="glass"]` 并说明浮层语义。

## 6. 暗色 Scholarly Blue 决策

Scholarly Blue 的 canonical value 和主题映射由当前 FsusUI 基线拥有。本仓不得把公开阅读面的 focus、active、link 反馈漂移到高饱和蓝或其他装饰色，也不得在本文或组件旁路登记第二套数值。

导航进度与管理面交互反馈消费同一条上游语义映射。文章阅读进度条的已读段使用 `--fsusblog-color-primary`，未读轨道使用 `--fsusblog-panel-border`；不得用文本色代替功能反馈色，也不得在 consumer 中添加品牌色 fallback。Scholarly Blue 仅用于 link hover、focus 与 active。

## 7. 排版边界

正文、摘要、metadata、Markdown document mode、代码字体和加载字重的唯一权威见 [`design/reading-typography.md`](design/reading-typography.md)；页面级 H1 比例和文章标题唯一性见 [`design/page-title-scale.md`](design/page-title-scale.md)。布局只消费这些角色，不复制字号、字重或 heading 规则。

## 8. 圆角标度规则

公开布局只消费当前 FsusUI 基线的语义圆角。行内标记、control、panel、popover、expressive 和 pill 必须选择对应的 public token；普通 public/reading surface 不得为取得更大圆角而标注为 expressive。Blog 可以提供 `--fsusblog-*` 产品语义映射，但不得复制上游数值、使用局部字面值或以 `rem` 重算同一标度。

## 9. 动效标度规则

动效时长、easing 和 preset 由当前 FsusUI 基线拥有。Reading surface 只保留颜色、边框、复制、focus/target、进度和 overlay 等功能反馈；正文、标题、图片与代码块不使用 translate、scale、stagger、scroll reveal 或 motion trail。`prefers-reduced-motion: reduce` 下移除非必要位移，同时保留状态机完成语义。

## 10. Commit 评审 checklist

- 先按 [`design/governance.md`](design/governance.md) 记录实际 FsusUI 基线、owner 和设计档案。
- 改 FsusUI token、组件 API、内部几何或跨项目设计规范时，归类为 FsusUI 改动。
- 改 public shell slot、reading layout、AOT/hydration markup 或 SEO/archive/filter/article 构图时，归类为 FsusBlog `public-editorial` 或 `reading` 改动。
- Consumer 改动不得伪造 `--fsus-*` token、复制上游数值或依赖内部 selector。
- Reading surface 新组件必须声明 `data-fsus-surface="reading"`；新 glass surface 必须在本文档白名单中登记。
- 新 public motion 必须说明状态语义，并提供实际 rendered evidence。

## 11. 首页单一编辑主线 recipe

首页把内容本身作为第一视觉锚点，按以下固定顺序构图：

1. 顶栏独占品牌识别，首页正文不再重复站点名或站点 Hero。
2. 主推荐最多一篇。存在有效封面时采用单个媒体入口；封面为空时保留同一标题、分类和日期层级并退化为纯文字，不补占位图。
3. 主推荐之后最多展示五篇紧凑文本推荐，不复制第二个大卡片、右侧热门栏或独立 CTA。
4. 当前页文章流承接剩余文章；普通文章项以标题链接作为唯一主入口，不再重复“阅读”链接。
5. `selectHomeEditorialComposition` 是主推荐、文本推荐和当前页文章流的唯一选择入口。它保持各后端来源原始顺序，并按主推荐 → 文本推荐 → 当前页文章流建立 article ID 互斥集合。AOT/SSR、hydration 和 SPA takeover 必须调用同一函数，不得在组件或 island 内再次独立筛选。
6. 分页只替换当前页文章流输入，推荐源保持原始顺序并重新参与同一选择过程；空推荐时直接从文章流开始，三类输入均为空时显示首页空态。
7. Desktop/Mobile 与 Light/Dark 共用同一 DOM 层级。`prefers-reduced-motion: reduce` 只缩短非必要颜色过渡，不隐藏标题、metadata、封面或分页控件。

首页评审必须同时核对：单主推荐数量、页面内 article ID 唯一性、无封面纯文字退化、空推荐、分页前后、四组 Desktop/Mobile × Light/Dark 截图以及 reduced-motion 层级完整性。

首页的“主命题”由单篇主推荐承担，不重新引入站点名 Hero。无论移除颜色或切到
Dark，编辑层级固定为主推荐标题 → 18/20px section title → 18/20px 普通文章标题
→ 12px/500 metadata 与 14px/400 摘要。主推荐内容区使用 48px mobile / 64px
desktop 的 block padding；各 section 使用 32–48px 组距，并只在 section heading
下保留一条 1px editorial rule，不再叠加 card border、section top rule 或装饰背景。
Scholarly Blue 仅用于 link hover、focus 与 active。首页句点 motif 只承担普通文章
metadata 分隔，不得在主推荐、section heading、loading 与推荐序号中重复铺陈。

## 12. 内容驱动的封面规范

封面是文章内容证据，不是卡片背景。是否存在封面不得改变标题、分类、日期、摘要和正文入口的完整性。素材优先级固定为：

1. 与正文直接相关的界面截图、图表、代码或命令输出、设备或现场摄影；
2. 能说明文章中一个具体概念、且每篇构图不同的编辑插图；
3. 没有合适素材时不显示封面，直接使用文本优先布局。

### 内容与文字

Do：

- 截取正文实际讨论的界面状态，并清除真实账号、域名、IP、邮件、token 和日志内容。
- 使用能被正文解释的测量图、调用路径、协议帧、焦点顺序或实物细节。
- 让不同文章使用不同证据和构图；颜色不是区分文章的唯一变量。
- 为图片提供描述其证据类型的 `alt`，文章标题仍由页面 H1 或标题链接承担。

Don't：

- 不在图片中写入文章标题、分类、站点名、“阅读全文”或其他页面 UI 文案。
- 不把同一柔和彩色曲线、抽象波浪、圆球或几何模板换色复刻。
- 不使用与正文无关的渐变、氛围光、glow、装饰阴影或统一滤镜制造“系列感”。
- 不用空白、默认插画或破图占位卡暗示文章必须有封面。

仓库正例由 `src/frontend/public/fixtures/cover-art-manifest.json` 登记：公开路由审计界面、键盘焦点路径、热读性能曲线、公开路由图和 AEDS 帧检查分别对应 interface evidence、interaction diagram、performance chart、architecture diagram 与 binary output。manifest 中的 negative examples 是审核反例，不应作为页面素材落地。

### 构图、裁切与安全区

- fixture 主画布使用 960×640（3:2）；真实摄影或截图可使用更高分辨率，但关键证据必须位于中心 80% 安全区：左/上 10% 到右/下 90%。
- 首页主推荐按 4:3 `object-cover` 居中裁切，正文页按 16:9 `object-cover` 居中裁切。两处都使用 `object-position: 50% 50%` 和 `data-cover-safe-area="center-80"`。
- 不把唯一关键标记、图例、代码行或人物主体放在画布最外侧 10%；不得依赖只在其中一个比例可见的角落文字。
- 容器只允许 reading radius 与 1px `--fsusblog-panel-border` 中性边界；背景、渐变、滤镜、彩色衬底、氛围光和装饰阴影保持关闭。
- 无可用 URL（`null`、空字符串或纯空白）时不输出 cover DOM。首页保留分类、日期和标题的纯文字主推荐，正文页直接从完整文章 header 开始。

### Light/Dark 审核清单

- 在 Light 与 Dark 下分别检查图片边界能否与页面分离，且容器没有额外彩色背景或 glow。
- 检查大面积纯白、荧光色或高饱和色是否在 Dark 下形成亮度冲击；不得用运行时暗化滤镜掩盖素材问题，应回到源素材修正。
- 同时查看首页 4:3、正文 desktop 16:9 与正文 mobile 16:9，确认中心 80% 的关键证据未被裁掉。
- 确认相邻标题、分类、日期和正文在两种主题下可读，图片不承担这些文字的唯一表达。
- 检查页面内没有重复文章标题、分类、CTA 或同一抽象构图换色；无封面路径没有空白 media box。
- public-preview 截图必须通过 manual route capture 重新生成；Home desktop Light/Dark、ArticleDetail desktop Light 与 ArticleDetail mobile Light 是文档别名的最低覆盖面。

## 14. 非公共页面边界

Account、admin、auth、status 和普通 overlay 不属于本文事实源。它们先由 [`design/surface-profiles.md`](design/surface-profiles.md) 分类；account/admin 再按顺序进入 [Account layout ownership](frontend/account-layout-ownership.md)、[Account navigation](frontend/account-navigation.md)、[Account style ownership](frontend/account-style-ownership.md) 与 [Account motion](frontend/account-motion.md)，auth/status 则读取最近的领域文档。代表页面和 baseline movement 只由 [Layout visual governance](frontend/layout-visual-governance.md) 及其 ledger 管理。
