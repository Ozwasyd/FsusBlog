# FsusBlog TODO

## 进度索引

- FsusUI shim 拔除：`6/7`

## Wave 7 - FsusUI shim 拔除

- [x] `NB-P2-005` `P2` `fsusui-inline-legal-action-shim-removal`
  Scope: 删除注册页协议入口的本地触控区补丁：`src/frontend/src/views/auth/Register.vue` 中 `agreement-policy-button` 与对应 `FsusBlog touch-target shim` 注释。
  Dependencies: FsusUI 上游 issue `https://github.com/Ozwasyd/FsusUI/issues/1` 提供 text-like inline legal/action primitive，且移动端触控目标不低于当前可用性。
  Done when: 注册页使用 FsusUI 原生 primitive/prop 后不再需要本地 button padding/min-height 覆盖，亮色/暗色、桌面/移动截图无文字截断或触控区坍缩。
  Gates: `npm --prefix src/frontend run capture:manual-layout-screenshots`（人工专用，不进入发布门禁）；逐张复核 `anonymous/register` 相关截图。
  Comment: Done with FsusUI `ElButton` `inline-action` in `@ozwasyd/element-plus@1.4.1`; removed `agreement-policy-button` and local touch-target CSS.

- [x] `NB-P2-006` `P2` `fsusui-public-shell-nav-shim-removal`
  Scope: 删除 public shell 移动导航/AOT 首屏响应式补丁：`src/frontend/src/components/public/PublicBlogLayoutShell.vue`、`src/frontend/src/assets/public-page.css`、`src/frontend/src/assets/public-shell-critical.css`、`src/frontend/src/bootstrap/publicShell.ts` 中的 public mobile shell/AOT shim。
  Dependencies: FsusUI 上游 issue `https://github.com/Ozwasyd/FsusUI/issues/1` 提供 public header/nav primitive，覆盖桌面 nav/search/actions、移动端 `ElScrollbar` 横向 nav、SSR/AOT first-paint 稳定 visibility。
  Done when: public shell 只保留业务结构和语义样式，不再维护移动端 nav overflow、desktop/mobile visibility 或 critical CSS 同步规则；首页、归档、分类、标签、搜索、文章详情在明暗和移动端均无重复导航、挤压或横向页面溢出。
  Gates: `npm --prefix src/frontend run capture:manual-layout-screenshots`；逐张复核 `anonymous/*` 与 `edge/*` public 路由。
  Comment: Done with FsusUI `ElPublicShell`; removed local public mobile nav/AOT selectors from Vue, public CSS, critical CSS, and emergency fallback CSS.

- [x] `NB-P2-007` `P2` `fsusui-theme-toggle-visibility-shim-removal`
  Scope: 删除 `src/frontend/src/components/ui/ThemeModeToggle.vue` 中基于 `data-fsusblog-theme-visibility` 的 CSS-only visibility compatibility shim。
  Dependencies: FsusUI 上游 issue `https://github.com/Ozwasyd/FsusUI/issues/1` 提供 hydration-stable theme control visibility API，避免 SSR/AOT 壳层与 Vue hydrate 初始 DOM 不一致。
  Done when: ThemeModeToggle 只调用 FsusUI theme mode/toggle 接口，不再自管 desktop/mobile visibility class 或 data attribute；明暗切换、AOT 首屏和 hydrated Vue 不出现闪烁、重复按钮或缺失按钮。
  Gates: `npm --prefix src/frontend run capture:manual-layout-screenshots`；逐张复核 public header 明暗/桌面/移动截图。
  Comment: Done with FsusUI `ElThemeModeToggle` `visibility`; removed `data-fsusblog-theme-visibility` and local CSS-only wrapper.

- [x] `NB-P2-008` `P2` `fsusui-empty-boundary-state-shim-removal`
  Scope: 删除文章详情错误/未找到态的 description 包装：`src/frontend/src/components/article/ArticleDetailErrorState.vue` 与 `ArticleDetailNotFoundState.vue` 中 `article-detail-state-description` 和 `FsusBlog boundary-state shim`。
  Dependencies: FsusUI 上游 issue `https://github.com/Ozwasyd/FsusUI/issues/1` 让 `ElEmpty` 支持宽/窄容器下的安全 description wrapping 和 action spacing。
  Done when: 文章缺失、加载异常、深层 404 相关状态使用 FsusUI 原生 `ElEmpty` 布局即可保持文本可读、按钮不挤压、暗色对比正常。
  Gates: `npm --prefix src/frontend run capture:manual-layout-screenshots`；逐张复核 `edge-article-missing`、`edge-not-found-deep`。
  Comment: Done with FsusUI `ElEmpty` `description-layout` and `description-width`; removed local description wrapper CSS.

- [x] `NB-P2-009` `P2` `fsusui-responsive-data-list-shim-removal`
  Scope: 删除 admin 文章管理移动端 card fallback：`src/frontend/src/views/admin/article/List.vue` 中 `isCompact` mobile list、`article-mobile-card` 和 `FsusBlog mobile-list shim`。
  Dependencies: FsusUI 上游 issue `https://github.com/Ozwasyd/FsusUI/issues/1` 提供 responsive collection primitive，可在桌面使用 table，在 compact viewport 使用 FsusUI token 化 card/list。
  Done when: admin 文章列表由 FsusUI 原生 responsive collection 承担移动端布局，不再需要 FsusBlog 维护桌面 table 与移动 card 双结构；移动端无表格裁切、操作按钮遮挡或分页溢出。
  Gates: `npm --prefix src/frontend run capture:manual-layout-screenshots`；逐张复核 `admin/manage-list` 明暗/移动截图。
  Comment: Done with FsusUI `ElResponsiveCollection`; extracted the compact article card content and removed local mobile-list switching shim from the list view.

- [x] `NB-P2-010` `P2` `fsusui-responsive-media-upload-shim-removal`
  Scope: 删除设置页 OgImage 上传区本地尺寸补丁：`src/frontend/src/views/admin/Settings.vue` 中 `site-og-image-*` responsive sizing 和 `FsusBlog settings shim`。
  Dependencies: FsusUI 上游 issue `https://github.com/Ozwasyd/FsusUI/issues/1` 提供 full-width/aspect-ratio media upload primitive，覆盖预览、空状态、loading、hover 和移动端宽度。
  Done when: 设置页 OgImage 上传目标使用 FsusUI 原生 upload/media primitive 后仍在移动端可测量、无遮挡、无压缩到不可点击区域。
  Gates: `npm --prefix src/frontend run capture:manual-layout-screenshots`；逐张复核 `admin/manage-settings` 明暗/移动截图。
  Comment: Done with FsusUI `ElUpload` `media-field` and `media-aspect-ratio`; removed local `site-og-image-*` sizing CSS.

- [ ] `NB-P2-011` `P2` `fsusui-manual-route-screenshot-harness-removal`
  Scope: 评估删除或收敛人工截图采集脚本：`tests/frontend/e2e/manual/manual-layout-screenshots.spec.ts` 与 `src/frontend/package.json` 的 `capture:manual-layout-screenshots`，前提是 FsusUI 提供下游 app 可复用的 route/theme/viewport screenshot helper。
  Dependencies: FsusUI 上游 issue `https://github.com/Ozwasyd/FsusUI/issues/1` 提供 dev-only screenshot harness；该工具必须支持明暗模式、桌面/移动/窄屏、登录态 fixture、console warning/error 拦截和人工截图产物目录。
  Done when: FsusBlog 不再维护自写截图路由矩阵包装，或仅保留薄 fixture adapter；人工截图仍不进入最终发布测试链路。
  Gates: FsusUI harness dry run; `npm --prefix src/frontend run capture:manual-layout-screenshots` 等价迁移后生成完整截图集并完成逐张人工复核。
  Comment: Still pending after `@ozwasyd/element-plus@1.4.1`: package inspection found no reusable route/theme/viewport screenshot helper, so the FsusBlog manual harness remains as the dev-only acceptance adapter.
