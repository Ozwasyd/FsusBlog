# Public shell ownership

This is the sole current authority for the FsusBlog public shell. It defines the FsusUI `PublicShell`/Blog consumer boundary, AOT/emergency CSS, and runtime sticky geometry. Product composition is in [`../public-layout-rules.md`](../public-layout-rules.md); FsusUI owns library internals.

Other `:deep()` and direct `.el-*` override budgets, owners, expiries, and replacements are governed by [`internal-selector-governance.md`](internal-selector-governance.md); PublicShell remains a zero-exemption boundary.

## Document-level viewport

FsusBlog owns only the **document-level viewport**. `src/frontend/index.html` is the sole authoring source and must contain:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

Vite dist, public AOT, and SPA fallback consume this template. `App.vue`, bootstrap, and router must not rewrite the viewport with `useHead` or DOM patches, and the backend must not synthesize a second minimal HTML document. FsusUI owns component safe-area geometry (Dialog, Lightbox, and shell edge controls), not this Blog viewport contract.

As a consumer, Blog runtime may consume only these FsusUI variables:

- `--fsus-safe-area-inset-top/right/bottom/left`
- `--fsus-viewport-block-size`

It must not read `env(safe-area-inset-*)`, declare synonymous `--fsusblog-safe-*` variables, or retain a `100vh`/`100dvh` double-write fallback. Business surfaces combine their own spacing with these tokens.

Static gates: `check:document-viewport-source` and `check:canonical-viewport-safe-area`.

## Component and interaction ownership

`PublicBlogLayoutShell.vue` uses the real aliased FsusUI `ElPublicShell` and explicitly selects `mobileNavMode="menu"` and `desktop-search-mode="trigger"`. FsusUI owns header/main/footer DOM, desktop 40px and mobile 44px control geometry, native `details/summary` menu, search / auth / theme open/closed, focus, Escape, outside-pointer, reduced-motion, and safe-area behavior. Blog supplies navigation copy, auth target, search query/action, and SPA route selection.

The desktop search trigger remains the native `/search` link. A plain click may enhance to the adjacent input; modified clicks and no-JS use browser navigation, and close returns focus to the trigger. Mobile's first row contains only menu and search triggers; navigation, theme, and auth actions are in the disclosure. Blog never selects `bottom`, renders a global BottomTabBar, or reserves ghost padding for a nonexistent fixed dock.

`PublicComplianceFooter.vue` is the product colophon: row one contains only brand/copyright and RSS; licensing, policy, filing, and back-to-top occupy row two. AOT, hydration, and SPA takeover retain this hierarchy and native fallback; the consumer does not copy the FsusUI state machine.

## CSS layers

| Layer / file | Owns | Must not |
| --- | --- | --- |
| FsusUI critical/runtime CSS | `PublicShell` layout, control sizes, Search/Auth/Theme/Menu states, focus, motion, reduced-motion, and safe-area | Consumer patches internals with `.el-public-shell__*` or `.el-theme-mode-toggle__*` |
| `public-shell-foundation.css` | palette, registered consumer tokens, `#fsus-aot-shell` first-paint background/font/min-height, `[data-public-shell-header]` measurement placeholder, Blog brand, `public-colophon`, reading fallback, and emergency source blocks | FsusUI internals, generic control/overlay/Dialog geometry, or component state |
| `public-shell-emergency.css` | generated from foundation `emergency:keep` blocks: failure palette, root shell, and reading fallback | manual edits, copied runtime/critical CSS, or a second post-hydration visual source |
| `PublicBlogLayoutShell.vue` scoped style | `.fsusblog-public-main-target` overflow boundary and `.fsusblog-public-mobile-menu-utilities` slot composition | FsusUI BEM, main flex/padding, brand/footer base appearance, or Search/Theme/Menu internals |
| `public-page.css` | article/list/filter reading surfaces, editor content, and overflow boundaries | public chrome, colophon, FsusUI internals, or full Markdown heading/paragraph redefinition |

Both Blog CSS files have zero exemption for FsusUI internal selectors. Future differences use public tokens, slots, or stable `data-*` hooks. Generic harmonization goes to FsusUI; Blog brand, footer, editorial composition, and emergency fallback stay in the consumer.

ArticleDetail is a content-driven long-form surface. Blog passes `content-flow="content-driven"`; FsusUI full/critical CSS keeps semantic `main` out of viewport fill and removes the shell's generic list-page bottom budget. Other public routes explicitly use `viewport-stable`. The Blog slot root's `data-public-content-flow="content-driven"` supplies only AOT first-paint min-height; it must not rewrite internals through `:deep()`, `:has()`, or `.el-public-shell__main`. Footer starts after the final real article block plus the article's `48px` mobile / `64px` desktop section gap.

## Header and sticky geometry

`[data-public-shell-header]` is the only measurement anchor. SSR/AOT publishes this static fallback in `#fsus-aot-shell`:

| token | fallback |
| --- | --- |
| `--fsusblog-public-header-height-current` | `var(--fsusblog-public-header-height, 4rem)` |
| `--fsusblog-public-sticky-top` | `var(--fsusblog-public-header-height-current)` |
| `--fsusblog-public-anchor-offset` | `calc(var(--fsusblog-public-sticky-top) + 0.75rem)` |

After hydration, `usePublicStickyGeometry` measures the real header at mount/`nextTick`, rounds positive height upward, and publishes the three tokens. `ResizeObserver` handles header reflow; viewport resize re-resolves the element. Disconnect the old observer before replacement, skip same-height writes, and disconnect it plus the exact listener on unmount. If JavaScript, header, observer, or a valid measurement is missing, the static `4rem` chain remains usable.

Archive year sections use `--fsusblog-public-anchor-offset` for hash clearance; sticky year headings use `--fsusblog-public-sticky-top` to align with the header. Do not copy fixed pixels, query `.el-*` internals, or hide the current year. SPA and public AOT assembly must use the same archive component.

## Touch-target tiers

Targets follow the surface owner: FsusUI public-header controls are at least 40px desktop and 44px mobile; identity actions are at least 44px; compact admin actions are at least 40px. Landscape/narrow-height layouts may reduce outer spacing only, never restore the 36px/`2.25rem` tier. Header-height changes flow through the measurement chain; Archive does not copy a delta.

## Verification and fallback

- `check:document-viewport-source` verifies the sole viewport source, `viewport-fit=cover`, no runtime/backend copy, and rejects reintroduction.
- `check:canonical-viewport-safe-area` verifies only canonical FsusUI variables; rejects direct `env()`, aliases, `100vh`/`100dvh` double writes, bare viewport units, and covers toast/account Drawer/editor action bar/TOC Drawer formulas and mutations.
- `check:public-shell-css-ownership` verifies CSS layers, delegated search/auth, and emergency generation; `check:visual-density-governance` rejects old target heights, fixed archive offsets, and internals.
- `usePublicStickyGeometry.test.ts` covers initial measure, observer update, viewport resize, element replacement, and unmount cleanup. Archive unit/browser contracts cover stable year IDs/hash links, shared AOT/SPA component, and target/header alignment. Public suites cover no-JS, hydration, keyboard, Desktop/Mobile, Light/Dark, and narrow screens.

If the enhancement layer fails, disable SPA takeover without a restart; native search, `details/summary` menu, static geometry tokens, and natural-flow footer still work. Do not restore consumer internals, fixed offsets, or a second shell CSS path as fallback.
