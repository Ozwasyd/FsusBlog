# FsusBlog Design Governance

> **Role:** Normative FsusBlog entry point for page, layout, composition, theme,
> token, typography, icon, motion, responsive, and rendered-output changes.
> **Authority:** Defines how FsusBlog consumes the active FsusUI contract; it
> does not change or copy FsusUI's generic design system.

FsusBlog is content-first editorial reading with a quiet, compact task surface. Public pages make content the visual focus; account and admin pages make the current task the focus. Both share FsusUI components, tokens, states, and interaction language; neither creates a general-purpose UI system.

## Task routing

Choose context and completion requirements from the actual change, not its line count or the selected model. The repository [design Skill](../../.agents/skills/fsusblog-design-conformance/SKILL.md) routes to task-specific references.

| Task | Required scope and completion |
| --- | --- |
| Editorial-only correction, with no contract or observable behavior change | Verify the relevant paragraph/authority and affected documentation checks. No upstream checkout, browser run, or UI dispatch is required solely for spelling or link repair. |
| Semantic design-document change without application changes | Establish ownership, update applicable current contracts and checks, and resolve FsusUI only for FsusUI-dependent claims. Do not claim the intended rendered behavior is implemented or accepted. |
| Agent/Skill or scheduler-policy change without application changes | Verify the affected policy, schema, checker, generated output, and integration contract. Documentation-stage dependencies of an observable UI task do not block this isolated tooling task. |
| Read-only rendered review | Resolve the active baseline, apply relevant contracts, inspect affected states, and report findings. Formal independent UX acceptance additionally requires the domain classification and acceptance receipts. |
| Observable UI implementation, including copy, CSS, layout, or interaction changes | Freeze classification, use the current domain stage policy, preserve implementation ownership isolation, and perform independent behavior/UX acceptance. A one-line change or a `prescribed` classification is not an exemption. |
| Backend-only or non-visual frontend runtime work | Use the relevant architecture/protocol/test contracts; do not load the design workflow solely because the path is in the frontend. |

A mixed task retains the stronger requirements for its affected observable surfaces; labeling it documentation or tooling cannot bypass them. Uncertainty about impact requires inspecting the relevant implementation, not assuming exemption. A documentation or policy change that requires application changes is not complete until those requested changes and their applicable verification are complete.

Domain classification, ownership, and acceptance bindings belong to the [stage policy](../../.agents/skills/fsusblog-design-conformance/contracts/blog-ui-stage-policy.json) and its checker, not AGENTS.md or repeated Skill prose. Shared orchestration authority is external: model/profile/effort selection, route selection, leases, stage order, checkpoints, and retries are not owned by this repository Skill. Changing the deployed domain policy requires owner-controlled migration and consumer revalidation; it does not remove design ownership, candidate identity, or acceptance requirements.

## 1. Baseline and precedence

Resolve the active FsusUI baseline when implementation, review, or a semantic design claim depends on FsusUI. The local alias is determined by `src/frontend/scripts/fsusui-root.mjs`, its `fsusui-local.ts` consumer, and the active build configuration. Use the actual worktree-aware resolver and environment; do not replace them with a package-version guess or another path-discovery algorithm.

- For active local source, record the absolute path, Git HEAD, package identity, dirty state and content fingerprint. Consult that checkout's `fsusui-design-conformance` Skill and the relevant current domain contract; use its index only when the authority is not already known.
- Only when the alias is inactive use the exact installed/locked version or CI pin. Without authoritative design documents, report compatibility checks only; do not claim current FsusUI conformance.
- Reuse verified context while checkout, alias inputs, pin, dirty files, consumed Skill/authority digests, and affected domain are unchanged. Refresh invalidated context and dependent receipts when any identity changes; do not mechanically reread the full documentation set before each edit.

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
