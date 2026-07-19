# Public Layout Rules

本文档记录 FsusBlog 作为 FsusUI consumer 的公开阅读面决策。它只约束本仓 public site，不替代 FsusUI `docs/design.md`。

## 1. Token 命名空间策略

FsusBlog consumer token 使用 `--fsusblog-*` 命名空间。公开布局不得伪造未注册的 `--fsus-*` 中转别名；需要承接 FsusUI 或 Element Plus 稳定变量时，直接引用公开 token，例如 `--fsus-scholarly-blue`、`--el-fill-color-light` 或 `--el-a11y-focus-color`。

## 2. Mobile navigation 模式

PublicBlogLayoutShell 显式选择 FsusUI `mobileNavMode="menu"` 语义。移动端主导航使用 header 内原生 `details/summary`：无 JavaScript 时仍可展开，当前页链接使用 `aria-current="page"`，Escape 关闭后把焦点交还给 summary。Blog consumer 不渲染全局 BottomTabBar，也不为不存在的 fixed dock 在根节点预留底部空间；窄屏 safe area 只由自然文档流末尾的 footer 吸收。

FsusUI 的 `inline | menu | bottom | none` 四种模式是组件库契约，`bottom` 仅供明确采用 app-like navigation 的 consumer opt-in。FsusBlog 若未来启用页面级 reading dock，装配层仍必须确保它与任何全局 bottom navigation 互斥。

桌面 header 采用编辑出版式 text-link 导航。品牌和首页/归档/关于是唯一持续可见的识别与主导航；搜索是带 `/search` fallback 的低噪音 trigger，增强后才展开输入层，必须同步 `aria-expanded`，打开后聚焦输入，Escape 关闭并把焦点还给 trigger。主题入口固定使用 FsusUI `menu-button`，不得常驻展示浅色/深色/系统三段控件。登录入口保持低噪音 text action。

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

Reading surface 禁用 glass、motion trail、glow 与 accent shimmer。公开阅读面的 skeleton 使用中性 document placeholder，不使用 `animated` prop。

## 4. Dialog 宽度变体白名单

公开布局只允许以下 dialog 宽度变体：

- 默认：`50%`
- 紧凑：`min(92vw, 28rem)`
- 超紧凑：`min(92vw, 24rem)`
- long-form：`min(92vw, 48rem)`

新增宽度必须先写入本文档，再进入组件实现。

## 5. Glass material 启用 surface 白名单

Glass material 只允许用于以下 surface：

- article image lightbox

其他 public/read surface 默认使用 paper/document material。新增 glass surface 必须携带 `[data-fsus-material="glass"]` 并说明浮层语义。

## 6. 暗色 Scholarly Blue 决策

暗色 Scholarly Blue 锁定为 `#4B79CC`。本仓不得把公开阅读面的 focus、active、link 反馈漂移到高饱和蓝或其他装饰色。

导航进度与管理面交互反馈使用同一条 Scholarly Blue 降级链：优先消费已注册 token，最终静态 fallback 为 `#2A599C`。文章阅读进度条的已读段固定使用 `--fsusblog-color-primary` 58% 透明混合，未读轨道继续使用 `--fsusblog-panel-border` 72% 透明混合；不得用 `--fsusblog-text-primary` 代替功能反馈色。`src/frontend/src` 不得重新引入 Element Plus `#409EFF` 或暖棕 `#4A453C` 作为交互反馈兜底；`check:foundation-token-governance` 与 `check:public-reading-motion` 共同守住该契约。

## 7. 字号标度规则

公开布局字号使用 12/14/16/18/20px 步进。`src/frontend/src` 的 public、account 与 admin surface 中，CSS `font-size` 小字号只写 `12px`、`14px` 或 `16px`；禁止 `11px`、`13px`，也禁止 `0.6` 到 `0.9` 区间的任意 `rem`/`em` 小数字号。需要紧凑信息时优先使用 12px、14px 与清晰行高；20/24/30px display 标题仍按下方响应式契约表达。

旧值统一归档到相邻标度：11px 与 `0.6875rem` 归入 12px，13px 与 `0.8125rem` 归入 14px。Markdown blockquote 继承 16px / 1.8 的正文基线，不单独缩小字号；AOT emergency、首屏 CSS 与 hydration 后样式使用相同的 12/14px metadata 数值。

### 字重白名单

公开布局与管理端共用同一字重契约：只允许真实加载的 `400`、`500`、`700`。CSS `font-weight` 必须使用这三个数值；utility class 只允许对应的 `font-normal`、`font-medium`、`font-bold`。不得使用 `100`/`200`/`300`/`600`/`800`/`900`、对应的 `font-thin`/`font-extralight`/`font-light`/`font-semibold`/`font-extrabold`/`font-black`，也不得依赖浏览器合成缺失的粗体或细体。

弱层级通过 `muted`、`tertiary`、`--fsusblog-text-decorative` 等颜色角色表达，不用未加载的轻字重模拟；标题需要强调时使用 `700`，metadata 与操作强调使用 `500`，正文默认为 `400`。AOT 首帧、hydration 与 SPA takeover 必须消费相同白名单，避免阶段切换时出现合成字形跳变。

### 等宽字体栈

Markdown 代码块与管理面审计详情统一使用 `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`。`JetBrains Mono` 的 `400`/`500`/`700` 由 `src/frontend/src/bootstrap/nonCriticalResources.ts` 加载；consumer 不得消费未注册的 `--fsus-font-family-mono`，也不得为同页审计内容维护第二套 system mono fallback。`check:foundation-token-governance` 同时校验全局禁用 token 与两处字体栈逐字一致。

### 公开排版角色

- `display`：文章列表卡片标题使用 18/20/24px 档位和 1.25/1.2 行高；public、account、auth、error 页面级 H1 统一使用 24/30px（`text-2xl sm:text-3xl`），包括文章详情且不扩张到 36/48px。H1 为 700 字重、正常字距，移动端/桌面行高分别不低于 1.25/1.2，说明文字在其下方保持 16px 间距，首个控件再保持 24px 间距。
- `src/frontend/src/ui-tokens/` 与 `src/frontend/src/components/public/` 禁止使用 `text-4xl`、`text-5xl`，防止详情标题或公共页面 H1 重新越出 display 档位。
- `reading`：文章列表摘要使用 14/16px、400 字重和 1.7 行高；正文和引用使用 16px 或 18px 档位，Markdown 段落只保留一条权威规则。
- `metadata`：日期、分类、状态、阅读量和操作文案使用 12px 或 14px 档位，不能以装饰性微缩文字承载信息。
- `--text-decorative` 与 `--fsusblog-text-decorative` 只用于分隔点、列表 marker 等无语义装饰；日期、分类、状态和操作必须使用达到 AA 的 `muted` 或 `tertiary` token。
- article list 的 metadata 与 CTA 不使用 `uppercase`；CTA 静态态使用 `muted`，hover 时才使用 Scholarly Blue。
- emergency AOT 与 hydration 后的文章列表标题、摘要、metadata 和 CTA 必须使用相同的响应式排版与颜色角色契约。
- Reading surface 的正文基线为 16px / 1.8 行高；附录链接、标签和空态操作在窄视口与 150% 缩放下仍保持至少 44px 点击高度。

### 长文提示层级

文章顶部的长文提示只保留两层视觉焦点：字数与预计分钟使用 `700` 和 primary text，成为唯一深色答案；“长文”标签使用 `500` 和 secondary text，连接词使用 `400` 和 secondary text。竖条、间距、分隔点及其圆角 token 保持布局职责，不以额外字重或 primary text 制造第三个焦点。

### 评论阅读层级

评论区用稳定的语义角色区分“身份、内容、元信息、操作”：实名作者使用 `700` 与 primary text，匿名作者保持 `400` 与 quiet text；匿名徽章使用 muted text 和 strong border。时间继续使用 quiet text 与 `400`，可操作文字使用 muted text 与 `500`，删除只在 hover 时切换到 `--el-color-danger`，不得复用链接主色。回复区以 2px strong border 表达嵌套边界；评论操作及 focus ring 继续消费 `--fsusblog-reading-radius-control`，不得为层级调整引入新的圆角字面值。

## 8. 圆角标度规则

公开布局圆角使用 4/6/10/12/24/999px 步进。普通阅读卡片、面板和控件默认不超过 12px；24px 只用于明确的 opt-in expressive surface。

行内高亮与紧凑标记使用 `--fsus-radius-control-small`（4px）；按钮、输入框及其 focus ring 使用 `--fsusblog-reading-radius-control`（6px），保证 2px outline 与 offset 外沿曲率连续。横向滚动条 thumb 是真实胶囊几何，只使用 `--fsus-radius-pill`（999px）。`border-radius` 禁止重新引入 2/3/8px 字面值；评论 composer 的控件圆角必须消费 token，不以 `rem` 重复换算标度。

## 9. 动效标度规则

动效时长只使用 140/220/300/360ms 步进。Reading surface 的颜色与边框反馈消费 `--blog-motion-control` 和 `--blog-motion-ease`，不在组件内复制 easing；同时不使用 translate、scale、stagger、scroll reveal 或 motion trail。`prefers-reduced-motion: reduce` 下非必要动画移除 transform，保留状态机所需过渡时使用 `1ms`，不使用 `0ms` 或 `transition: none` 破坏钩子。

## 10. Commit 评审 checklist

- 改 FsusUI token、组件 API 或跨项目设计规范时，归类为 FsusUI 改动。
- 改 `--fsusblog-*`、public shell slot、reading surface、AOT/hydration markup 或 SEO/archive/filter/article 页面时，归类为 Consumer 改动。
- Consumer 改动不得伪造未注册 `--fsus-*` token。
- Reading surface 新组件必须声明 `data-fsus-surface="reading"`。
- 新 glass surface 必须在本文档白名单中登记。
- 新 public motion 必须说明状态语义，并通过 static governance 检查。

### 触控目标档位

触控目标档位按表面语义收口：desktop public header 控件最小命中区为 `40px`，mobile header 控件最小命中区为 `44px`；identity 用户操作使用 44px 档；admin 紧凑操作不得低于 40px。移动横屏与窄高视口只能减少外部间距，不能把命中区域降回 36px / `2.25rem`。`check:visual-density-governance` 必须扫描 `src/frontend/src` 并阻止这两个旧 `min-height` 孤值回流。

`AccountLayout` 顶栏的主站、主题、账号菜单和移动导航动作使用同一密度链：desktop 消费 `--fsus-control-height-compact`（40px），mobile 与窄高布局消费 `--fsus-control-height`（44px）。持久主题入口使用 FsusUI `ThemeModeToggle` 的 `menu-button` 变体；所有动作保留常驻 1px 边界以避免 open/closed 状态切换引发布局位移，并通过 `aria-expanded`、2px inset focus ring 与 forced-colors outline 区分键盘焦点和打开态。

### 公共壳层 CSS 所有权

公共壳层的三层职责固定如下，AOT、hydration 和 SPA takeover 不得通过后加载覆盖切换视觉真值：

- Foundation 层（`public-shell-foundation.css`）拥有首帧 palette、页面背景、壳层最小高度、Header/Footer 基础布局、品牌几何、40/44px 控件高度链，以及 emergency fallback 源块。它只对 FsusUI Search/Theme/Menu 应用共享几何 token，不复制组件的完整交互外观。
- Component/Runtime 层（`PublicBlogLayoutShell.vue` 与 FsusUI）拥有 Search open/closed、menu open/closed、`aria-expanded`、`focus-visible`、Escape 与焦点归还。Blog 自有 Search panel 的外观只在该组件定义一次；Theme Menu 与 mobile details menu 的完整外观由 FsusUI 提供。
- Public page 层（`public-page.css`）只拥有 reading surface、article/list/filter 页面结构与溢出边界；不得定义 `.el-public-shell__*`、`.public-chrome-*`、`.public-colophon*`，也不得重新定义 Markdown heading/paragraph 的完整排版。

Search panel、Theme Menu、mobile details panel 和公共 Dialog 统一消费 `--fsusblog-public-overlay-padding`、`--fsusblog-public-overlay-radius`、`--fsusblog-public-overlay-shadow`。公开控件从 `--fsusblog-public-control-height-current` 读取当前 40/44px 档位；任何 viewport 适配只能切换该 token，不在选择器中复制高度字面值。

### Header 与 sticky 几何契约

公开壳层以应用自有的 `[data-public-shell-header]` 为唯一测量锚点。`usePublicStickyGeometry` 将实际 header 高度发布为 `--fsusblog-public-header-height-current`，并由此派生 sticky top 与 anchor scroll margin；viewport resize、横屏断点或控件触控高度变化必须重新测量，组件卸载必须断开 observer 与 listener。Archive 年份标题和 hash target 只能消费这些 token，不得复制固定像素偏移，也不得依赖 FsusUI 内部 class selector。Footer 只在自身自然文档流内吸收 safe area，根 shell 不为不存在的 bottom navigation 预留空间。

SSR/AOT 无 JavaScript 首帧保留静态 token fallback，hydration 后再以实际测量值覆盖。排版或触控面积调整不能改变这一所有权：标题、摘要和 metadata 可按公开排版角色变化，但 header selector、sticky token 和锚点间距仍由同一几何链路管理。实现与验收映射见 `docs/issue-1016-public-shell-sticky-geometry-handoff.md`、`docs/issue-1017-archive-sticky-offset-handoff.md` 和 `docs/issue-1285-touch-target-floor.md`。

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

## 13. 顶栏与页脚的编辑出版语法

公开壳层在 AOT/SSR、hydration 和 SPA takeover 三种阶段保持同一信息层级：

1. 顶栏第一层只包含品牌、核心导航与低噪音搜索/主题/账号动作；不常驻搜索输入，不并排堆叠带边框按钮。
2. Desktop 搜索 trigger 保留 `/search` 原生链接作为无脚本回退。JavaScript 接管普通主键点击后在 trigger 邻近打开搜索层；修饰键、新窗口与复制链接行为仍由浏览器处理。
3. Mobile 第一行只显示搜索和菜单 trigger。菜单内部依次放核心导航、主题与账号；使用原生 `details/summary` 保证 no-JS 与键盘路径。
4. 页脚是紧凑 colophon。第一行只放品牌/版权摘要和 RSS；许可、政策、备案与回到顶部进入次级行，不能与品牌形成第二个站点 Hero。
5. Light/Dark 共用同一 DOM，不以主题切换改变顺序；窄屏只允许换行和纵向排列。footer 保留 `safe-area-inset-bottom`，根 shell 不保留 BottomTabBar ghost padding。
6. 页面不能同时出现全局 BottomTabBar 与 reading dock。Blog 默认 `menu` 模式，组件库默认也不得隐式输出 fixed bottom navigation。

评审需覆盖：未增强 AOT 链接与原生菜单、hydration 前后 DOM 层级、Desktop/Mobile、Light/Dark、键盘 Tab/Enter/Escape、窄屏与横屏，以及搜索 trigger 的 accessible name、`aria-expanded` 和焦点归还。

## 14. Account shell module navigation

AccountLayout 将持久导航限制为一级模块，并只展开当前模块的局部导航。完整后台固定为工作台、内容、互动、安全、系统、运维六个模块；permission、feature 和 policy gate 在模块生成前过滤叶子，空模块不渲染。

- 桌面侧栏不再因全部叶子页面产生内部滚动；一级模块与当前模块局部导航使用不同的 ARIA label 和 current 状态。
- 移动端仍只使用一个 Drawer，同时承载一级模块和当前模块局部导航，不新增顶部 Tabs 或第二个抽屉。
- Drawer 内一级模块和局部导航链接保持 44px 最小点击目标，active 状态沿用桌面侧栏的主色左侧标记。
- Drawer 标题和触发器同时说明当前模块上下文，并使用站点 motion preset。
- 顶栏只保留品牌、主站、主题与账号菜单；使用规范、隐私政策和登出统一进入账号菜单。
- URL、刷新与深链接保持原路由；浏览器后退时根据恢复后的 path 重新计算模块和叶子 current 状态。
