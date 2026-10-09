# FsusBlog Motion Guidelines

FsusBlog motion is functional feedback, not decoration. Design ownership and surface classification come from [`../design/governance.md`](../design/governance.md) and [`../design/surface-profiles.md`](../design/surface-profiles.md). Preset motion must enter the app through `src/frontend/src/fsusui/motion.ts`, which re-exports FsusUI motion components, directives and composables from `@ozwasyd/element-plus`. Application-owned `--blog-motion-*` aliases and semantic classes remain only for product state feedback that the current FsusUI baseline does not expose as a preset.

## FsusUI Preset Adoption

Use FsusUI motion primitives for page and interaction presets:

- Home hero: `v-motion` with `fsusBlogMotionPresets.homeHero` (`fade-up`).
- Article cards: no `v-motion` on public reading surfaces; keep `data-fsus-motion-surface="article-card"` and explicit list indexes only for static governance.
- Search panel/dialog surfaces: public filter/search reading panels render statically; admin/dialog contexts may still use `fsusBlogMotionPresets.searchDialog` when the panel is not reading content.
- Mobile drawer/menu surfaces: FsusUI `el-drawer` public `motion` prop with `fsusBlogMotionPresets.mobileDrawer`.
- Tag chips: FsusUI `el-tag` public `motion` prop with `fsusBlogMotionPresets.tagChip`.
- Toast surfaces: FsusUI `ElMessage`, tagged by `fsusBlogMotionPresets.toast` (`slide-up`).
- Article title: public article detail titles render statically; do not use `v-motion` on `[data-fsus-surface='reading']`.
- Article body images and code blocks: render statically; do not call `useScrollReveal()`; expose only the metadata required for reading governance and interaction enhancement.
- Article image overlay: public ImageViewer owns its motion lifecycle. Back-to-top uses `backToTop` (`scale-fade`).
- Route transitions: the active app host consumes the FsusUI route preset and cleans up through `useMotionRouteCleanup()`. Account-specific route policy is defined only in [Account motion](account-motion.md).

Do not import `@element-plus/motion`, `motion-dom`, or `gsap` directly from FsusBlog business code. If a new surface needs preset motion, add a named mapping to `fsusBlogMotionPresets` and use the FsusUI adapter.

## Allowed And Forbidden

Allowed motion explains state: route settle, panel enter, pending to success or error, row update highlight, copy/save feedback, active reading targets, and reduced-motion-safe overlay settle.

Forbidden motion adds noise: long decorative loops, generic loading sweeps, hover scale, icon or row nudges, large scale or rotate, complex stagger, scroll reveal, high-saturation trails, nonessential blur, page shake, and layout-moving animation on reading content.

## Tokens

- `--blog-motion-fast`: compact control feedback.
- `--blog-motion-control`: ordinary state changes.
- `--blog-motion-panel`: page, drawer and panel settling.
- `--blog-motion-overlay`: overlay enter/leave.
- `--blog-motion-ease`: default easing.
- `--blog-motion-ease-emphasized`: reserved for rare emphasized state changes.

Do not add bare `160ms`, `300ms`, `ease` or `cubic-bezier(...)` in business components. Use the alias or an existing FsusUI token.

## Semantic Classes

- `blog-motion-page-enter`: page-level settle.
- `blog-motion-panel-enter`: panel/drawer settle.
- `blog-motion-state-change`: color, border and opacity feedback.
- `blog-motion-task-region`: pending/settled task region feedback.
- `blog-motion-reading-control`: article reading controls, copy buttons and TOC state.
- `blog-motion-mobile-bar`: mobile reading action bar opacity/4px translate settle.
- `blog-motion-reading-target`: hash or TOC target highlight.
- `blog-motion-row-state`: high-density row/list item state wrapper.
- `blog-motion-row-pending`: row-level mutation is running.
- `blog-motion-row-updated`: short visible-row update highlight.
- `blog-motion-row-error`: row-level mutation failed.
- `blog-motion-summary-enter`: summary-only feedback for bulk operations.
- `blog-motion-highlight`: short row or region update highlight.
- `blog-motion-safe-transform`: transform transition wrapper.

Scale, nudge and sweep helpers are not semantic motion classes. New work must use FsusUI presets through `src/frontend/src/fsusui/motion.ts` or add a narrow whitelist entry to `tests/frontend/checks/static/check-motion-governance.mjs` with the state it explains.

## Reduced Motion

All semantic classes are disabled under `prefers-reduced-motion: reduce`. Runtime code must use `useMotionPreference()` or `getPrefersReducedMotion()` from `src/frontend/src/composables/useMotionPreference.ts`; components should not call `matchMedia('(prefers-reduced-motion: reduce)')` directly.

Reduced motion keeps state meaning through color, border, opacity or text. It disables translate, scale, blur, smooth scroll and looping animation.

Account frames also disable their optional identity opacity handoff when reduced motion is active. Programmatic navigation or navigation from an outgoing account view restores focus to `#account-main`; keyboard focus already held by stable header/sidebar chrome is preserved rather than stolen.

## Page Examples

Use semantic classes directly on app-owned surfaces:

```vue
<section class="blog-motion-page-enter">
  ...
</section>

<article class="blog-motion-row-state blog-motion-row-updated">
  ...
</article>
```

Use the shared preference helper for runtime scrolling:

```ts
import { resolveMotionScrollBehavior } from '@/composables/useMotionPreference'

window.scrollTo({ top: 0, behavior: resolveMotionScrollBehavior() })
```

## Admin Task Feedback

Admin mutations use `useAdminTaskFeedback()` plus FsusUI toast feedback for a consistent lifecycle:

```text
idle -> pending -> success | error | partial -> settled
```

Use it for save, publish, audit, reload, rollback, sync, repair, import, export and admin message actions. The composable routes pending, success, partial and error states through `toast.info/success/partial/error`; the toast content carries `aria-live`, and destructive or failed operations use assertive live messaging. Buttons still use their local loading state, but loading must not be the only signal.

Use `blog-motion-task-region` on the affected form, row, panel or summary. Use `blog-motion-task-region--pending` while the mutation is running and `blog-motion-task-region--settled` for a short success or partial highlight. Batch actions should highlight only the summary area, not every row in a large list.

## Public Reading Aids

Article reading aids must not move the article body layout. Reading progress uses `transform: scaleX(...)`, never width animation. TOC active state uses color/border/background changes with `aria-current`; it must not translate, scale or stagger entries.

Article titles, body images and code blocks appear statically and never use scroll reveal. Copy controls use text feedback plus toast feedback. Runtime code block copy buttons use `blog-motion-reading-control` and a copied state class, so the label change remains visible on touch devices and screen readers.

ArticleImageLightbox composes the public FsusUI ImageViewer. ImageViewer owns overlay motion, focus, background inert, scroll locking and safe-area controls; the article adapter retains localized text, caption, image data and navigation intent. The adapter disables the toolbar so zoom, rotation and dragging are not new article features. Reduced motion follows the viewer’s public contract. Mobile reading actions use `blog-motion-mobile-bar`, respect `var(--fsus-safe-area-inset-bottom)`, and limit translate to 4px. Toast viewport-bottom placement also consumes the same FsusUI inset token rather than a direct `env()` read. Hash and comments navigation should call the shared reading target helper so smooth scroll becomes auto under reduced motion and the destination gets a short `blog-motion-reading-target` highlight.

## Row State Motion

Dense lists and tables use `useRowStateMotion()` with `blog-motion-row-*` classes. Single-row mutations may mark one visible row as pending, updated or error. Bulk changes over 20 rows must publish a summary bar or container state instead of animating every row.

Do not use row height, width, top, left, transform nudge, filter or blur transitions. Do not stagger table rows. Element Plus table internals remain untouched; app code may only provide `row-class-name` or classes on app-owned card/list wrappers.

## Budget

- Route transitions should finish within `--blog-motion-panel`.
- Panel and drawer transitions use `--blog-motion-panel`.
- Copy/save/success feedback uses `--blog-motion-fast`.
- Do not animate width, height, top or left on large lists, tables or scroll containers.
- Public reading pages must not move article body layout during routine interactions.
- Batch list updates should highlight only visible rows.

## FsusUI Boundary

Application pages may wrap FsusUI components with layout classes, but they must not rewrite internal `.el-*` motion through page-level `:deep(.el-*)`. If a component needs different motion, add a semantic wrapper or request the token in FsusUI. FsusBlog must not add local GSAP timelines or duplicate FsusUI preset definitions.
