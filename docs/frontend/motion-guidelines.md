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
- `blog-motion-task-region`: pending/settled task region feedback.
- `blog-motion-reading-control`: article reading controls, copy buttons and TOC state.
- `blog-motion-mobile-bar`: mobile reading action bar opacity/4px translate settle.
- `blog-motion-reading-target`: hash or TOC target highlight.
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

## Admin Task Feedback

Admin mutations use `useAdminTaskFeedback()` plus `AdminTaskFeedbackBar` for a consistent lifecycle:

```text
idle -> pending -> success | error | partial -> settled
```

Use it for save, publish, audit, reload, rollback, sync, repair, import, export and admin message actions. The visible feedback bar is paired with `aria-live="polite"`; destructive or failed operations also publish an assertive live message. Buttons still use their local loading state, but loading must not be the only signal.

Use `blog-motion-task-region` on the affected form, row, panel or summary. Use `blog-motion-task-region--pending` while the mutation is running and `blog-motion-task-region--settled` for a short success or partial highlight. Batch actions should highlight only the summary area, not every row in a large list.

## Public Reading Aids

Article reading aids must not move the article body layout. Reading progress uses `transform: scaleX(...)`, never width animation. TOC active state uses color/border/background changes with `aria-current`; it must not translate, scale or stagger entries.

Copy controls use text feedback plus toast feedback. Runtime code block copy buttons use `blog-motion-reading-control` and a copied state class, so the label change remains visible on touch devices and screen readers.

Lightbox overlay enter/leave uses `--blog-motion-overlay`; the figure uses `--blog-motion-panel`. Reduced motion disables transitions and must not introduce zoom or scale. Mobile reading actions use `blog-motion-mobile-bar`, respect `safe-area-inset-bottom`, and limit translate to 4px. Hash and comments navigation should call the shared reading target helper so smooth scroll becomes auto under reduced motion and the destination gets a short `blog-motion-reading-target` highlight.

## Budget

- Route transitions should finish within `--blog-motion-panel`.
- Panel and drawer transitions use `--blog-motion-panel`.
- Copy/save/success feedback uses `--blog-motion-fast`.
- Do not animate width, height, top or left on large lists, tables or scroll containers.
- Public reading pages must not move article body layout during routine interactions.
- Batch list updates should highlight only visible rows.

## FsusUI Boundary

Application pages may wrap FsusUI components with layout classes, but they must not rewrite internal `.el-*` motion through page-level `:deep(.el-*)`. If a component needs different motion, add a semantic wrapper or request the token in FsusUI.
