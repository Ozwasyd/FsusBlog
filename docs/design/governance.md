# FsusBlog Design Governance

> **Role:** Normative FsusBlog entry point for page, layout, composition, theme,
> token, typography, icon, motion, responsive, and rendered-output changes.
> **Authority:** Defines how FsusBlog consumes the active FsusUI contract; it
> does not change or copy FsusUI's generic design system.

FsusBlog is content-first editorial reading with a quiet, compact task surface. Public pages make content the visual focus; account and admin pages make the current task the focus. Both share FsusUI components, tokens, states, and interaction language; neither creates a general-purpose UI system.

## 1. Baseline and precedence

Resolve the active FsusUI baseline before every design task. The source of truth for the local alias is `src/frontend/scripts/fsusui-local.ts`:

- Unless `FSUSBLOG_USE_LOCAL_FSUSUI` is `0` or `false`, use `FSUSBLOG_LOCAL_FSUSUI_ROOT`, or the sibling `FsusUI`, when it contains valid source. Record its absolute path, Git HEAD, and dirty state.
- Read that checkout's `docs/index.md`, `docs/design.md`, design governance, the relevant domain contract, and `.agents/skills/fsusui-design-conformance/SKILL.md`.
- Only when the alias is inactive use the exact lockfile or CI-pinned package. Without authoritative design documents, report compatibility review only; do not claim current FsusUI conformance.

A local source alias outranks its package version, and current contract documents outrank historical screenshots. Resolve conflicts in this order:

1. security and accessibility requirements;
2. the active FsusUI baseline and public-domain contract;
3. this document;
4. [`surface-profiles.md`](surface-profiles.md) and the nearest current Blog design document;
5. approved implementation and visual baselines;
6. workflow, examples, framework defaults, trends, or implementer preference.

Generic visual and accessibility rules belong to FsusUI. Product-specific accessibility application belongs in the nearest surface profile or business contract.

## 2. Ownership

FsusUI owns public component APIs, documented variants, internal geometry, generic color/type/spacing/radius/material/motion tokens, control states, keyboard/focus/overlay/shared accessibility semantics, and reusable task, navigation, form, data-region, and feedback primitives.

FsusBlog owns routes, information architecture, workflows, product copy and content order; page composition, content priority, reading columns and editorial layout; selection among documented variants; product-semantic `--fsusblog-*` tokens; realistic fixtures, end-to-end states, and visual evidence. Fix a reusable primitive in FsusUI; fix route composition, hierarchy, or variant selection in FsusBlog. Never mask either defect with a consumer compatibility wrapper.

## 3. Component and token boundary

Compose pages only with FsusUI public components, props, slots, tokens, and stable `data-*` hooks. FsusBlog must not:

- define, fake, override, or copy values from `--fsus-*`;
- use `:deep()`, `.el-*` internals, generated paths, or private imports to fix component geometry;
- fork a generic component, mislabel a surface for radius/glass/shadow/motion, or turn page composition into an FsusUI global default.

`--fsusblog-*` is valid only for Blog semantics and may map to public FsusUI tokens. A Blog wrapper may add product meaning or stable composition, but may not replace its primitive.

## 4. Classification and exceptions

Before editing, record the active FsusUI baseline, owner, profile from [`surface-profiles.md`](surface-profiles.md), affected hierarchy/components, states, themes, locales, viewports, reduced-motion behavior, whether the change restores or changes a contract, and exact in/out scope. If ownership is unclear, use the smallest fixture to locate the defect; do not add an override.

Preserve information architecture, content order, action count and priority, primary focus, component semantics, and existing accessibility. Do not add cards, badges, icons, helper copy, CTAs, illustrations, gradients, glass, shadows, glow, or decorative motion without explicit authorization.

An exception requires a source contract, semantic reason, exact scope, owner, affected states/platforms, evidence, and removal or review condition. Aesthetic preference, framework default, imitation, avoiding an upstream fix, or passing one screenshot is not an exception.

## 5. Evidence and document ownership

Compile success, a static checker, or zero-diff screenshots cannot alone prove design acceptance. Inspect affected realistic states in Light/Dark, narrow/wide viewports, expanded locales, keyboard focus, zoom, overflow, and reduced motion; record the rendered evidence actually inspected.

The current documents have one owner each:

- this file: baseline, precedence, ownership, classification, and exceptions;
- [`surface-profiles.md`](surface-profiles.md): route/surface composition;
- [`reading-typography.md`](reading-typography.md): reading typography;
- [`task-surface-geometry.md`](task-surface-geometry.md): Blog task-surface geometry consumption;
- [`page-title-scale.md`](page-title-scale.md): page-level title hierarchy;
- [`../public-layout-rules.md`](../public-layout-rules.md): public/editorial composition;
- [`../frontend/layout-visual-governance.md`](../frontend/layout-visual-governance.md): representative routes, screenshots, and baseline movement.

Workflows and Skills reference these authorities; they do not duplicate their design values. A current document must not use an issue or handoff file as its contract.
