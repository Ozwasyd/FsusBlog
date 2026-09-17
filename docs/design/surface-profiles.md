# FsusBlog Surface Profiles

> **Role:** Normative route-level and cross-page overlay composition.
> **Authority:** Defines Blog composition within
> [`governance.md`](governance.md); FsusUI owns component geometry and generic
> tokens.

Every visual task selects one primary profile. A route keeps that profile; `MarkdownRenderer` may locally consume `reading`, empty/error regions may consume `status`, and `overlay` may cross-cut the host profile. These local semantics cannot change host hierarchy or be switched for visual effect.

## Profile map

| Profile | Typical scope | Primary focus |
| --- | --- | --- |
| `public-editorial` | home, archive, category, tag, search, About, policy | topic or content set |
| `reading` | article, comments, Markdown, article preview | body and reading position |
| `task` | identity, admin, forms, collections, settings, console, messages | task, status, or next action |
| `focused-auth` | login, registration, recovery, verification | one identity goal |
| `status` | 403, 404, empty, unrecoverable error | state and recovery path |
| `overlay` | Dialog, Drawer, Popover, Lightbox | temporary task or enlarged content |

Classify an unknown route by information goal and shell, never by existing CSS or the component one hopes to use.

## `public-editorial`

- Use the public shell; its header is the only site-brand surface and the body does not repeat a site hero.
- Keep one content line: home has one primary recommendation and a continuous article stream; index, filter, and document pages order title, description, then the content set.
- Use Blog public container/content-column semantics, not admin KPI or task-card density. Default to paper/document surfaces without glass, glow, gradient, or decorative shadow.
- Page H1 follows [`page-title-scale.md`](page-title-scale.md); article title, summary, and metadata follow [`reading-typography.md`](reading-typography.md). Content links are the primary entry; avoid duplicate CTAs.
- Keep content static except FsusUI-approved, non-blocking route settle, focus, and state feedback. Desktop/Mobile and Light/Dark preserve order and focus; breakpoints must not hide key information.
- Verify short/long content, no cover, empty/loading/error/pagination, locale expansion, AOT/hydration/SPA parity, themes, narrow/wide viewports, zoom, and reduced motion. Detailed home and cover composition is in [`../public-layout-rules.md`](../public-layout-rules.md).

## `reading`

- Public articles/comments use the public shell; admin preview may use task shell, but its body remains `reading`.
- Body is the only visual focus. TOC, metadata, comments, and reading aids are secondary, never a competing card or page title.
- Use Blog reading-layout semantics for body, wide media, and full-bleed areas; long code scrolls only inside its own container. Use document surfaces and neutral boundaries; ordinary images, code, quotes, comments, and TOC use no glass, glow, or decorative shadow.
- Typography belongs to [`reading-typography.md`](reading-typography.md). Copy, TOC jumps, comments, and media viewing retain clear text/state feedback.
- Body, headings, images, and code are static: no scroll reveal, stagger, translate, or scale. Functional copy, focus/target, progress, and media overlay settle are allowed; reduced motion removes nonessential movement.
- Preserve DOM reading order. Mobile TOC/controls must not cover the body or overflow horizontally. Verify short/long articles, long titles, no/wide images, long code, no/many comments, preview/document modes, keyboard, focus, zoom, themes, narrow/wide viewports, and reduced motion.

## `task`

- Identity/admin use account/admin shell, stable chrome, and one page header; inbox takeover retains module context. Prioritize task, state, and next action; supporting text/statistics/actions must not outrank the primary.
- Use FsusUI task primitives and [`task-surface-geometry.md`](task-surface-geometry.md); dashboards are actionable summaries, not KPI walls. Prefer quiet surfaces, clear groups, and necessary boundaries; forms, collections, settings, and consoles do not use editorial heroes or expressive glass.
- Page titles follow [`page-title-scale.md`](page-title-scale.md); dangerous, batch, pending, partial, success, and error states use FsusUI semantic primitives.
- Motion explains route settle, pending/settled, row update, focus, and overlay states; batch feedback is one summary, not per-row stagger. Desktop rail and mobile Drawer express the same navigation and permission filtering.
- Verify anonymous/unauthorized/authorized, permission trimming, empty/loading/error/success/partial/disabled, long forms/tables, mobile Drawer, keyboard/focus return, zoom, themes, and reduced motion.

## `focused-auth`

- Use a single-column identity flow with only the necessary return path; do not introduce marketing layout. Keep one semantic H1, identity goal, and primary action; recovery, Passkey, MFA, and help are secondary by step.
- Let content and FsusUI controls define form width. Use neutral page + one task region, no multi-card grid, sales sidebar, hero, glass, gradient, glow, or large decorative image. Title follows [`page-title-scale.md`](page-title-scale.md); control, validation, loading, and disabled geometry stays in FsusUI.
- Only step, validation, pending, and focus feedback may move. Preserve label, description, error, action DOM order and keyboard/password-manager paths.
- Verify empty/invalid/pending/server-error/disabled, Passkey/MFA capability differences, long locales, keyboard, focus, zoom, themes, and reduced motion.

## `status`

- Keep public or account context as appropriate; an unrecoverable state must not look like a normal task page. Use one status H1, required explanation, and clear recovery path; an error code is supporting text.
- Keep content compact and near recovery. Do not fill short content with `min-height`, empty cards, illustrations, glass, gradient, or warning glow. Use at most one primary recovery action and make other paths secondary.
- State is static except focus, pending action, and route-navigation feedback; preserve state/explanation/action order at every viewport. Verify 403, 404, business empty, retryable/unretryable errors, no history, long error copy, keyboard, focus, zoom, themes, and reduced motion.

## `overlay`

- An overlay inherits the host's content priority and carries one temporary task or enlarged content. FsusUI owns Dialog/Drawer/Popover geometry, focus trap, keyboard, scrim, and motion; Blog selects documented variants and owns title, content order, and action priority.
- Use FsusUI default material. The article-image lightbox is the sole current glass consumer surface; register any new exception in [`governance.md`](governance.md). Keep content within the viewport, scroll long content inside the overlay, and never rewrite component geometry with a page selector.
- Use only FsusUI overlay settle; reduced motion removes nonessential translate, scale, and blur, and reading content does not reveal again.
- Verify open/close, Escape, outside-close policy, initial focus, trap/return, long title/content, destructive/pending/error, mobile, zoom, themes, and reduced motion.

## Cross-profile invariants

- One semantic H1 per page; theme and viewport never change information order.
- FsusUI public components, tokens, focus, and state semantics remain shared.
- `--fsusblog-*` expresses Blog semantics, not shadow FsusUI tokens.
- Real content must cover loading, empty, error, success, disabled, and permission states; static gates and zero diff cannot replace rendered evidence.
