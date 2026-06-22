# Public Layout Rules

本文档记录 FsusBlog 作为 FsusUI consumer 的公开阅读面决策。它只约束本仓 public site，不替代 FsusUI `docs/design.md`。

## 1. Token 命名空间策略

FsusBlog consumer token 使用 `--fsusblog-*` 命名空间。公开布局不得伪造未注册的 `--fsus-*` 中转别名；需要承接 FsusUI 或 Element Plus 稳定变量时，直接引用公开 token，例如 `--fsus-scholarly-blue`、`--el-fill-color-light` 或 `--el-a11y-focus-color`。

## 2. Mobile navigation 模式

PublicBlogLayoutShell 在移动端使用 bottom tab bar 作为主导航，固定 3 项：首页、归档、关于。高度保持在 56-64px 范围内，并包含 `safe-area-inset-bottom`。bottom tab bar 是 opt-in glass surface，必须携带 `data-fsus-material="glass"`，仅保留轻量 blur/saturate 与 1px 顶部分隔线。

桌面 header 采用 text-link 导航风格。搜索、主题切换和登录入口不得作为同一 primary nav 行里的 bordered action button 与 text-link 并排；登录入口使用 nav-link 视觉，当前页状态通过 `aria-current="page"` 表达。

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

- mobile bottom tab bar
- article image lightbox

其他 public/read surface 默认使用 paper/document material。新增 glass surface 必须携带 `[data-fsus-material="glass"]` 并说明浮层语义。

## 6. 暗色 Scholarly Blue 决策

暗色 Scholarly Blue 锁定为 `#4B79CC`。本仓不得把公开阅读面的 focus、active、link 反馈漂移到高饱和蓝或其他装饰色。

## 7. 字号标度规则

公开布局字号使用 12/14/16/18/20px 步进。禁止新增 `0.62rem` 到 `0.95rem` 的任意小数字号；需要紧凑信息时优先使用 12px、14px 与清晰行高。

## 8. 圆角标度规则

公开布局圆角使用 4/6/10/12/24/999px 步进。普通阅读卡片、面板和控件默认不超过 12px；24px 只用于明确的 opt-in expressive surface。

## 9. 动效标度规则

动效时长只使用 140/220/300/360ms 步进。Reading surface 不使用 translate、scale、stagger、scroll reveal 或 motion trail。`prefers-reduced-motion: reduce` 下非必要动画移除 transform，保留状态机所需过渡时使用 `1ms`，不使用 `0ms` 或 `transition: none` 破坏钩子。

## 10. Commit 评审 checklist

- 改 FsusUI token、组件 API 或跨项目设计规范时，归类为 FsusUI 改动。
- 改 `--fsusblog-*`、public shell slot、reading surface、AOT/hydration markup 或 SEO/archive/filter/article 页面时，归类为 Consumer 改动。
- Consumer 改动不得伪造未注册 `--fsus-*` token。
- Reading surface 新组件必须声明 `data-fsus-surface="reading"`。
- 新 glass surface 必须在本文档白名单中登记。
- 新 public motion 必须说明状态语义，并通过 static governance 检查。

## 11. Account shell mobile navigation

AccountLayout 移动端使用 FsusUI §8 scrollable tab strip 模式承载账号主导航。

- Primary group tabs 渲染为横向可滚动 tab strip。
- 每个 tab 与 account route link 保持 44px 最小点击目标。
- 当账号分组超过 5 个时，前 5 个保持可见，其余分组收纳到 “更多” tab strip expansion。
- AccountLayout 的主移动端账号菜单不得退回 drawer navigation。
