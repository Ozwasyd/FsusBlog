# FsusBlog Motion Guidelines

FsusBlog motion is functional feedback, not decoration. Application pages use `--blog-motion-*` aliases and semantic classes from `src/frontend/src/assets/motion.css`; FsusUI and Element Plus keep ownership of low-level component motion.

## Allowed And Forbidden

Allowed motion explains state: route settle, panel enter, pending to success or error, row update highlight, copy/save feedback, and restrained navigable-row affordances.

Forbidden motion adds noise: long decorative loops, large scale or rotate, complex stagger, high-saturation trails, nonessential blur, page shake, and layout-moving animation on reading content.

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
- `blog-motion-highlight`: short row or region update highlight.
- `blog-motion-safe-transform`: transform transition wrapper.
- `blog-motion-media-hover`: restrained media hover scale.
- `blog-motion-icon-nudge`: small icon nudge in link affordances.
- `blog-motion-row-nudge`: small list-row nudge for navigable rows.
- `blog-motion-loading-bar`: loading indicator sweep.

## Reduced Motion

All semantic classes are disabled under `prefers-reduced-motion: reduce`. Runtime code must use `useMotionPreference()` or `getPrefersReducedMotion()` from `src/frontend/src/composables/useMotionPreference.ts`; components should not call `matchMedia('(prefers-reduced-motion: reduce)')` directly.

Reduced motion keeps state meaning through color, border, opacity or text. It disables translate, scale, blur, smooth scroll and looping animation.

## Page Examples

Use semantic classes directly on app-owned surfaces:

```vue
<section class="blog-motion-page-enter">
  ...
</section>

<article class="blog-motion-row-nudge">
  ...
</article>
```

Use the shared preference helper for runtime scrolling:

```ts
import { resolveMotionScrollBehavior } from '@/composables/useMotionPreference'

window.scrollTo({ top: 0, behavior: resolveMotionScrollBehavior() })
```

## Budget

- Route transitions should finish within `--blog-motion-panel`.
- Panel and drawer transitions use `--blog-motion-panel`.
- Copy/save/success feedback uses `--blog-motion-fast`.
- Do not animate width, height, top or left on large lists, tables or scroll containers.
- Public reading pages must not move article body layout during routine interactions.
- Batch list updates should highlight only visible rows.

## FsusUI Boundary

Application pages may wrap FsusUI components with layout classes, but they must not rewrite internal `.el-*` motion through page-level `:deep(.el-*)`. If a component needs different motion, add a semantic wrapper or request the token in FsusUI.
