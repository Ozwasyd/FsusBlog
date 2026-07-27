# Public shell ownership

本文档是 FsusBlog 公开壳层的唯一长期事实源。它描述 FsusUI `PublicShell`、Blog consumer、AOT/emergency CSS 与运行时 sticky geometry 的边界；产品级内容编排见 [`../public-layout-rules.md`](../public-layout-rules.md)，组件库内部规范仍由 FsusUI 维护。

全站其他 `:deep()` 与直接 `.el-*` override 的预算、owner、expiry 和 replacement
规则见 [`internal-selector-governance.md`](internal-selector-governance.md)；
PublicShell 在该治理中仍是零豁免边界。

## 文档级 viewport

FsusBlog 只负责 **document-level viewport**：`src/frontend/index.html` 是唯一 authoring source，内容固定为

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

Vite dist、public AOT 与 SPA fallback 均消费该模板产物；`App.vue` / bootstrap / router 不得通过 `useHead` 或 DOM 补丁改写 viewport；后端不得合成第二份最小 HTML。组件内部 safe-area 几何（Dialog、Lightbox、PublicShell 控件贴边等）由 FsusUI contract 所有，不在 Blog 文档 viewport 契约内。

Blog runtime 作为 consumer 只消费 FsusUI 暴露的：

- `--fsus-safe-area-inset-top/right/bottom/left`
- `--fsus-viewport-block-size`

不得再直接读取 `env(safe-area-inset-*)`、声明 `--fsusblog-safe-*` 等同义变量，或保留 `100vh`/`100dvh` 双写兼容。业务 surface 只组合业务间距与上述 token。

静态门禁：`check:document-viewport-source`、`check:canonical-viewport-safe-area`。

## 组件与交互所有权

`PublicBlogLayoutShell.vue` 通过 alias 使用真实的 FsusUI `ElPublicShell`，并显式选择 `mobileNavMode="menu"` 与 `desktop-search-mode="trigger"`。FsusUI 拥有 header/main/footer DOM 布局、desktop 40px 与 mobile 44px 控件几何、原生 `details/summary` 菜单、search/auth/theme 的 open/closed、focus、Escape、outside-pointer、reduced-motion 与 safe-area 行为；Blog 只传入导航文案、鉴权目标、搜索 query/action 与 SPA 路由选择。

Desktop 搜索 trigger 保留 `/search` 原生链接。普通点击增强为邻近输入层，修饰键和 no-JS 继续走浏览器导航；关闭后焦点回到 trigger。Mobile 第一行只保留菜单与搜索 trigger，核心导航、主题和鉴权动作进入 disclosure。Blog 不选择 `bottom` 模式，不渲染全局 BottomTabBar，也不为不存在的 fixed dock 预留 ghost padding。

`PublicComplianceFooter.vue` 是产品 colophon：第一行只含品牌/版权与 RSS，许可、政策、备案和回到顶部位于次级行。AOT、hydration 与 SPA takeover 必须维持同一信息层级和 native fallback，不得在 consumer 中复制 FsusUI 状态机。

## CSS 分层

| 层 / 文件 | 权威职责 | 禁止事项 |
| --- | --- | --- |
| FsusUI critical/runtime CSS | `PublicShell` 布局、控件尺寸、Search/Auth/Theme/Menu 状态、focus、motion、reduced-motion 与 safe-area | Consumer 用 `.el-public-shell__*` 或 `.el-theme-mode-toggle__*` 修补内部实现 |
| `public-shell-foundation.css` | palette 与注册过的 Consumer token、`#fsus-aot-shell` 首帧背景/字体/最小高度、`[data-public-shell-header]` 测量占位、Blog 品牌、`public-colophon`、reading fallback 和 emergency 源块 | FsusUI 内部 class、通用控件/overlay/Dialog 几何和组件状态 |
| `public-shell-emergency.css` | 由 foundation 的 `emergency:keep` 块生成；资源失败时的 palette、根壳和 reading fallback | 手工编辑、复制 runtime/critical 组件 CSS 或成为 hydration 后第二视觉来源 |
| `PublicBlogLayoutShell.vue` scoped style | `.fsusblog-public-main-target` 内容溢出边界与 `.fsusblog-public-mobile-menu-utilities` slot 编排 | FsusUI BEM、主内容 flex/padding、品牌/页脚基础外观、Search/Theme/Menu 内部状态 |
| `public-page.css` | article/list/filter reading surface、编辑内容和溢出边界 | public chrome、colophon、FsusUI internals 或 Markdown heading/paragraph 的完整重定义 |

`public-shell-foundation.css` 与 `public-page.css` 对 FsusUI 内部选择器均为零豁免。所有未来差异必须使用公开 token、slot 或稳定 `data-*` hook；组件库通用 harmonization 进入 FsusUI，Blog 品牌、footer、editorial composition 与 emergency fallback 留在 consumer。

ArticleDetail 是内容高度驱动的长文面：Blog 向 FsusUI PublicShell 传入
`content-flow="content-driven"`，由组件库拥有的 full/critical CSS 使语义 `main`
不参与 viewport 填充，也不保留 shell 通用列表页底部预算。其他 public route
显式使用 `viewport-stable`。Blog slot 根节点的
`data-public-content-flow="content-driven"` 只负责 AOT 首帧最小高度，不得通过
`:deep()`、`:has()` 或 `.el-public-shell__main` 改写组件库内部布局。footer 起点由
文章最后一个真实区块及文章自身的 48px mobile / 64px desktop section gap 决定。

## Header 与 sticky geometry

`[data-public-shell-header]` 是唯一测量锚点。SSR/AOT 在 `#fsus-aot-shell` 发布静态 fallback：

| token | fallback |
| --- | --- |
| `--fsusblog-public-header-height-current` | `var(--fsusblog-public-header-height, 4rem)` |
| `--fsusblog-public-sticky-top` | `var(--fsusblog-public-header-height-current)` |
| `--fsusblog-public-anchor-offset` | `calc(var(--fsusblog-public-sticky-top) + 0.75rem)` |

hydration 后，`usePublicStickyGeometry` 在 mount/`nextTick` 测量真实 header，将正高度向上取整后发布三个 token。`ResizeObserver` 处理 header reflow，viewport resize 重新解析测量元素；元素变化先断开旧 observer，相同高度不重复写入，卸载时断开 observer 并移除准确注册的 listener。JavaScript、header、observer 或有效测量缺失时，静态 4rem 链仍可用。

Archive 年份 section 以 `--fsusblog-public-anchor-offset` 提供 hash clearance，sticky 年份标题以 `--fsusblog-public-sticky-top` 对齐 header。它们不得复制固定像素、查询 `.el-*` 内部选择器或隐藏当前年份。SPA 与 public AOT assembly 必须消费同一 archive component。

## 触控目标档位

触控目标按 surface 归属：FsusUI public header 的 desktop 控件至少 40px、mobile 控件至少 44px；identity 用户操作至少 44px；admin 紧凑操作至少 40px。移动横屏或窄高布局只能缩小外部间距，不能恢复 36px / `2.25rem` tier。header 控件高度变化由上述测量链吸收，Archive 不复制差值。

## 验收与降级

- `check:document-viewport-source` 验证唯一 document viewport 来源、`viewport-fit=cover`、无 runtime/后端副本，并对 reintroduce 路径做 mutation 拒绝。
- `check:canonical-viewport-safe-area` 验证 Blog runtime 只消费 FsusUI canonical safe-area / viewport 变量，拒绝直接 `env()`、同义 token、`100vh`/`100dvh` 双写与裸 viewport 单位，并覆盖 toast / account drawer / editor action bar / TOC drawer 公式与 mutation。
- `check:public-shell-css-ownership` 验证 CSS 分层、delegated search/auth 与 emergency 生成来源。
- `check:visual-density-governance` 拒绝旧触控高度、固定 archive offset 和内部选择器。
- `usePublicStickyGeometry.test.ts` 覆盖初始测量、observer 更新、viewport resize、元素替换与卸载清理。
- archive unit/browser contract 验证稳定 year id/hash link、AOT/SPA 共用组件，以及目标在真实 header 下方并与 sticky heading 对齐。
- PublicShell 的 no-JS、hydration、keyboard、Desktop/Mobile、Light/Dark 与窄屏行为由 public header 和 visual suites 覆盖。

发生增强层故障时可停用 SPA takeover：native search、`details/summary` menu、static geometry token 与自然文档流 footer 仍工作，无需重启。不得以恢复 consumer 内部选择器、固定 offset 或第二套 shell CSS 作为回退。
