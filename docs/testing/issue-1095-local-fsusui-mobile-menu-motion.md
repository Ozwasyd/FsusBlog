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

## Isolated browser diagnostics

`tests/frontend/e2e/diagnostics/public-mobile-menu-harness.spec.ts` 在免 backend、PostgreSQL、Redis 与 release preview 的 Vite harness 中直接挂载本地 `ElPublicShell`，覆盖浏览器才可观察的 computed transition、reduced-motion、Escape 与 focus restoration。普通 correctness 由 unit/static contract 承担；旧的 full-app mobile-menu acceptance spec 已退役，避免重复验证 layout、路由和后端规则。

- normal motion 的 enter/leave 使用非零 token duration、标准 easing、`opacity + translateY(-4px)`，最终状态稳定；
- leave 期间保留 `details.open`，同时设置 closing、`inert` 与 `aria-hidden`，结束后才关闭；
- reduced motion 下 transition/位移禁用，但打开、Escape 关闭与焦点恢复立即完成；
- harness console/pageerror 保持为空。

该 diagnostics 类的完整命令如下；它会先执行 isolated harness，再执行需要已启动 release preview 的 archive integration：

```bash
FSUSBLOG_BROWSER_DIAGNOSTICS=1 \
FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS=1 \
FSUSBLOG_PLAYWRIGHT_WORKERS=1 \
bash tools/test/lanes/browser-geometry-motion-diagnostics.sh
```

视觉截图只在菜单动画完成后采集。动效最终关闭态没有改变页面静态构图时，不应机械更新既有基线；若最终渲染发生像素变化，再更新对应 mobile light/dark snapshots。

## 回退

若本地 FsusUI source 与 dist 不一致，先停止 consumer 构建并重新运行 `build:theme`。不要在 Blog 的 `PublicBlogLayoutShell.vue`、`public-shell-critical.css` 或页面组件中添加 `:deep(.el-public-shell__*)` 动效覆写；组件状态机和 motion CSS 始终由 FsusUI 单一拥有。
