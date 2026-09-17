# Browser Geometry, Motion, and Focus Layers

This is the canonical geometry/motion/focus boundary. The [#1148 browser diagnostics handoff](issue-1148-browser-diagnostics.md) owns scheduled/manual evidence; the [Release Browser Contract](browser-contract.md) owns release correctness.

## Ownership

Ordinary correctness and real-browser diagnostics remain separate:
- Unit/static contracts continuously block sticky offsets, motion preference, component ARIA/state, and FsusUI ownership regressions.
- getBoundingClientRect(), computed transitions, media emulation, and real focus restoration belong only to nightly/manual diagnostics.
- Blog does not copy the FsusUI public-shell state machine or add a compatibility layer through :deep(.el-public-shell__*).

FsusUI component and theme source remain solely owned by the FsusUI repository. FsusBlog local runs and the diagnostics workflow consume the checkout/source and its local build:theme output through the FSUSBLOG_LOCAL_FSUSUI_ROOT alias. They must not publish FsusUI, change package versions/registry, or copy an unpublished fix into FsusBlog.

## Isolated public-shell harness

tests/browser-diagnostics/harness/ is a minimal Vite page that directly mounts local FsusUI ElPublicShell and loads local public-shell-critical.css plus theme CSS. It does not start the FsusBlog app and has no backend, PostgreSQL, Redis, fixture-schema, or release-preview dependency.

tests/frontend/e2e/diagnostics/public-mobile-menu-harness.spec.ts retains only contracts that require a real browser:
- Normal-motion enter/leave computed duration, property, easing, opacity, and transform.
- With prefers-reduced-motion: reduce, transitions have no positive duration and displacement disappears.
- When Escape enters closing state, aria-expanded=false and the panel is inert/aria-hidden.
- After leave completes, `<details>` closes and focus returns to the summary trigger.
- Harness console and pageerror remain empty.

This is not a fake harness that copies markup or behavior: the page imports the FsusUI source component, FsusBlog's local alias resolves to that same checkout, and CSS comes from its local build output.

## Archive integration

Archive sticky/hash geometry requires the real page, header, hydration, and scroll container, so tests/frontend/e2e/acceptance/archive-sticky-geometry.spec.ts remains a release-preview integration. It runs sequentially with the isolated menu harness in the same diagnostics category, but evidence marks the scopes separately:

| Probe | Scope | Runtime dependencies |
| --- | --- | --- |
| public mobile menu | isolated-component-harness | local FsusUI source/dist, managed Chromium |
| archive sticky/hash | release-preview-integration | FsusBlog release-preview/archive runtime, managed Chromium |

An isolated-menu pass cannot prove archive geometry, and measuring menu motion must not start the full Blog stack.

## Runner contract

Authoritative entry point:

~~~bash
bash tools/test/lanes/browser-diagnostics.sh \
  manual --category geometry-motion-focus --workers 1
~~~

browser-geometry-motion-diagnostics.sh fixes the diagnostics config, one browser worker, and zero retry. It runs the isolated harness and archive integration sequentially without a dynamic inner pool. The canonical summary is .tmp/browser-diagnostics-runtime/geometry-motion-focus/geometry-motion-focus-summary.json.

The summary has evidenceClass=diagnostic and affectsCorrectness=false, and records each probe's status, exit code, scope, and dependencies. The catalog runner deletes this canonical summary before starting probes; on success it requires a newly generated summary and copies it to the current run/category/probe/artifacts/. Harness logs and Playwright output stay in that probe's scoped output. Missing browser installation, an unstartable isolated harness, or unavailable release preview is explicit infra-failure; stale artifacts cannot be reused and an unexecuted probe cannot be written as success.

## Fallback

When local FsusUI source and dist disagree, stop the harness and run corepack pnpm run build:theme from the FsusUI checkout; do not add a CSS or markup workaround in FsusBlog. If diagnostics are temporarily unavailable, ordinary unit/static replacements continue to provide their own correctness conclusions, but must not claim that real geometry, motion, or focus has been verified.
