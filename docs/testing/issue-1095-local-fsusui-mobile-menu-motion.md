# Issue #1095：本地 FsusUI 移动菜单动效验收

本 issue 按本地 consumer 集成执行，不发布 FsusUI、不修改 registry、不修改 `@ozwasyd/element-plus` 的版本或 lockfile。FsusBlog 的 Vite/Vitest 默认 local alias 指向相邻的 `../FsusUI/vue` 源码；完整 CSS 与 Critical CSS 指向该仓库的 `vue/packages/theme-chalk/dist`。

## 本地产物前提

FsusUI `#182` 同时修改组件源码、完整主题 CSS 和 Critical CSS。只更新组件源码会形成“新状态机 + 旧 CSS”的混合运行时，因此先在 FsusUI 仓库执行：

```bash
corepack pnpm run build:theme
```

该命令只重建本地 `vue/packages/theme-chalk/dist`，不得执行 publish、版本变更或 registry 修改。

`src/frontend/scripts/fsusui-local.ts` 对以下契约 fail closed：

- closing 阶段禁用面板交互；
- enter/leave active 与 edge class；
- full/critical 两份 CSS 都包含 reduced-motion 分支。

任一契约缺失时，本地 alias 直接提示重建 FsusUI theme，而不是回退到旧的 published CSS。可独立核验：

```bash
node tests/frontend/checks/static/check-local-fsusui-public-shell-motion.mjs
cd src/frontend
npm run check:fsusui-typecheck-modes
npm run typecheck:local-fsusui
```

## Consumer E2E

`tests/frontend/e2e/acceptance/public-mobile-menu-motion.spec.ts` 使用真实 `PublicBlogLayoutShell → FsusUiPublicShell → ElPublicShell` 链路，覆盖：

- SSR HTML 保留原生 `<details>/<summary>` 与 menu panel，hydration 后初始状态保持关闭；
- normal motion 的 enter/leave 使用非零 token duration、标准 easing、`opacity + translateY(-4px)`，最终状态稳定；
- leave 期间保留 `details.open`，同时设置 closing、`inert` 与 `aria-hidden`，结束后才关闭；
- reduced motion 下 transition/位移禁用，但打开、Escape 关闭与焦点恢复立即完成；
- 快速 open/close/open 反转不会遗留 closing 或 `aria-expanded` 失配；
- summary 再次点击、Escape、导航链接都收敛到关闭态；
- 菜单内主题与账户入口可见、可操作；
- light/dark、横向 overflow 和运行时 console health；
- 同一 spec 可由 Chromium、Firefox、WebKit projects 执行。

聚焦命令：

```bash
cd src/frontend
FSUSBLOG_USE_LOCAL_FSUSUI=1 \
FSUSBLOG_PLAYWRIGHT_BROWSERS=chromium,firefox,webkit \
npx playwright test acceptance/public-mobile-menu-motion.spec.ts
```

视觉截图只在菜单动画完成后采集。动效最终关闭态没有改变页面静态构图时，不应机械更新既有基线；若最终渲染发生像素变化，再更新对应 mobile light/dark snapshots。

## 回退

若本地 FsusUI source 与 dist 不一致，先停止 consumer 构建并重新运行 `build:theme`。不要在 Blog 的 `PublicBlogLayoutShell.vue`、`public-shell-critical.css` 或页面组件中添加 `:deep(.el-public-shell__*)` 动效覆写；组件状态机和 motion CSS 始终由 FsusUI 单一拥有。
