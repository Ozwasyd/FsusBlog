# Browser geometry、motion 与 focus 分层

## Ownership

Geometry/motion/focus 的普通 correctness 与真实浏览器诊断分开维护：

- sticky offset、motion preference、组件 ARIA/state 和 FsusUI ownership 由 unit/static contract 持续阻断普通 correctness；
- `getBoundingClientRect()`、computed transition、media emulation 与真实 focus restoration 只属于 nightly/manual diagnostics；
- Blog 不复制 FsusUI 的 public-shell 状态机或通过 `:deep(.el-public-shell__*)` 添加兼容层。

FsusUI 的组件源码和主题源码仍由 FsusUI 仓库单一拥有。FsusBlog 本地与 diagnostics workflow 通过 `FSUSBLOG_LOCAL_FSUSUI_ROOT` alias 消费 checkout/source 和其本地 `build:theme` 产物；不得发布 FsusUI、修改 package version/registry，或把尚未发布的修复复制进 FsusBlog。

## Isolated public-shell harness

`tests/browser-diagnostics/harness/` 是最小 Vite 页面，直接挂载本地 FsusUI `ElPublicShell`，并加载本地 `public-shell-critical.css` 与 theme CSS。它不启动 FsusBlog app，也不依赖 backend、PostgreSQL、Redis、fixture schema 或 release preview。

`tests/frontend/e2e/diagnostics/public-mobile-menu-harness.spec.ts` 只保留真实浏览器才能证明的 contract：

- normal motion 的 enter/leave computed duration、property、easing、opacity 与 transform；
- `prefers-reduced-motion: reduce` 下 transition 无正时长且位移消失；
- Escape 进入 closing 状态时 `aria-expanded=false`、panel `inert`/`aria-hidden`；
- leave 完成后 `<details>` 关闭并把 focus 恢复到 summary trigger；
- harness console 与 pageerror 保持为空。

这不是复制组件 markup/behavior 的假 harness：页面导入 FsusUI source component，并由 FsusBlog 的 local alias 解析到同一 checkout；CSS 也来自该 checkout 的本地构建产物。

## Archive integration

Archive sticky/hash geometry 不能脱离真实页面、header、hydration 与滚动容器，因此 `tests/frontend/e2e/acceptance/archive-sticky-geometry.spec.ts` 保留为 release-preview integration。它与 isolated menu harness 在同一 diagnostics category 中顺序执行，但 evidence 必须分别标记：

| Probe | Scope | Runtime dependencies |
|---|---|---|
| public mobile menu | `isolated-component-harness` | local FsusUI source/dist、managed Chromium |
| archive sticky/hash | `release-preview-integration` | FsusBlog release preview/archive runtime、managed Chromium |

不得用 isolated menu 通过证明 archive geometry，也不得为了测 menu motion启动完整 Blog stack。

## Runner contract

权威入口：

```bash
bash tools/test/lanes/browser-diagnostics.sh \
  manual --category geometry-motion-focus --workers 1
```

`browser-geometry-motion-diagnostics.sh` 固定 diagnostics config、一个 browser worker 和 0 retry；isolated harness 与 archive integration 顺序执行，不创建 dynamic inner pool。canonical summary 为：

```text
.tmp/browser-diagnostics-runtime/geometry-motion-focus/geometry-motion-focus-summary.json
```

summary 的 `evidenceClass` 为 `diagnostic`、`affectsCorrectness=false`，并分别记录两个 probe 的 status、exit code、scope 与 dependencies。catalog runner 在启动 probe 前删除这份 canonical summary，成功后要求本轮重新生成并把它复制到当前 `run/category/probe/artifacts/`；harness log 与 Playwright output 则直接留在该 probe 的 scoped output。浏览器未安装、isolated harness 无法启动或 release preview 不可用时明确输出 `infra-failure`，不得复用旧 artifact 或把未执行写成成功。

## 回退

本地 FsusUI source 与 dist 不一致时停止 harness，回到 FsusUI checkout 执行 `corepack pnpm run build:theme`；不要在 FsusBlog 增加 CSS/markup workaround。diagnostics 暂时不可运行时，普通 unit/static replacement 继续给出自己的 correctness 结论，但不得宣称真实 geometry/motion/focus 已验证。
