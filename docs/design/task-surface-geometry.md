# Task Surface Geometry

Account and admin are the `task` profile from [`surface-profiles.md`](surface-profiles.md). They consume the active FsusUI spacing, radius, overlay, and responsive semantics; they do not define a third geometry system. Ownership and change routing are in [`governance.md`](governance.md).

## Spacing and radius

Use FsusUI public spacing tokens or equivalent utilities for CSS `gap`, `padding`, and `margin`, chosen by semantic role and task density. Do not copy token values, add private `px/rem` steps, or add a second spacing alias. Reading and editing preview are reading/editorial surfaces, not task geometry.

Inline marks, controls, popovers, panels, expressive surfaces, and pills use the corresponding FsusUI public semantic radius token. Do not use generic `rounded-*`, local radius literals, or `--fsusblog-*` shadow tokens. Prove a new role is reusable in FsusUI first.

## Dialog and responsive tiers

`src/frontend/src/fsusui/dialog.ts` selects and names only documented FsusUI width presets and type-preserving re-exports `FsusUiDialog`. The `FsusDialog` shell forwards Blog workflow props/emits/slots. FsusUI Dialog contract (#261) alone owns overlay, viewport, safe-area, centering, max-height, and generic padding. Blog may not use `modal-class`, private overlay bridges, global or `.el-*` selectors to create another geometry; mobile may not override caller width or add a page Dialog breakpoint.

Task tiers start at `640 / 768 / 1024 / 1440px` with closed upper bounds `639 / 767 / 1023 / 1439px`; the only narrow-screen exception is shared `max-height: 520px`. Do not add page-private `480/560/760/900/960px` tiers.

Account base/identity/admin frame CSS is owned by [Account style ownership](../frontend/account-style-ownership.md); this file does not duplicate its values, selectors, imports, or frame-root list.

## Verification boundary

`node tests/frontend/checks/static/check-account-css-ownership.mjs` checks the three CSS layers. `node tests/frontend/checks/static/check-task-surface-geometry.mjs` checks shared account/admin CSS and components for spacing, radius, Dialog width, and breakpoints. Article Write, scheduled publish, revision, and editor/reading preview are explicitly excluded and use their own contracts.
