---
name: fsusblog-design-conformance
description: Apply FsusBlog design governance against the active FsusUI baseline. Use when implementing, reviewing, debugging, or documenting FsusBlog visual, layout, theme, token, typography, icon, component-composition, motion, responsive, accessibility-presentation, screenshot, or rendered-output changes. Do not use for backend-only, protocol-only, or non-visual frontend work.
---

# FsusBlog Design Conformance

Treat this Skill as a thin FsusBlog consumer adapter. Load design truth from the active FsusUI source and FsusBlog current documents; never copy token values or build another design system inside this Skill.

## 1. Resolve the active FsusUI baseline

Read `src/frontend/scripts/fsusui-local.ts` and the calling Vite/build configuration before reviewing design:

- If `FSUSBLOG_USE_LOCAL_FSUSUI` is not `0` or `false`, resolve `FSUSBLOG_LOCAL_FSUSUI_ROOT` or the default sibling `FsusUI`.
- Accept a local root only when the resolver's required FsusUI source exists.
- When local source is active, record its absolute path, Git HEAD, and dirty state. Use its current files even when `package.json` names an older package version.
- Read that root's `.agents/skills/fsusui-design-conformance/SKILL.md`, `docs/index.md`, `docs/design.md`, `docs/design/governance.md`, `docs/design/change-classification.md`, `docs/workflows/visual-change.md`, `docs/consumers/design-integration.md`, and the nearest domain contract.
- When local source is inactive, record the exact installed/locked package version or explicit CI pin. If authoritative FsusUI documents are unavailable, perform compatibility checks only and state that current FsusUI design conformance was not established.

Do not let the package version override an active local alias.

## 2. Load FsusBlog design contracts

Read, in order:

1. `docs/index.md` and the lifecycle status of every selected document;
2. `docs/design/governance.md`;
3. `docs/design/surface-profiles.md`;
4. the nearest current design document, such as reading typography, task geometry, page-title scale, public layout, shell ownership, account/admin ownership, or motion;
5. `docs/frontend/layout-visual-governance.md` and relevant fixtures when rendered evidence is required.

Do not treat proposed, historical, generated, retired, issue, or handoff documents as current design authority.

## 3. Classify before changing

State:

- FsusUI baseline;
- owner: FsusUI or FsusBlog;
- profile: `public-editorial`, `reading`, `task`, `focused-auth`, `status`, or cross-cutting `overlay`;
- affected hierarchy, contracts, states, themes, locales, viewports, zoom, focus, overflow, and reduced-motion behavior;
- whether the task restores conformance or changes a design contract;
- exact in-scope and out-of-scope surfaces.

Route reusable component geometry, public tokens, component states, shared motion, keyboard behavior, and shared accessibility defects to FsusUI. Keep information architecture, product copy, route composition, editorial/reading layout, documented variant selection, and `--fsusblog-*` product semantics in FsusBlog.

Apply these classification decisions:

- article image or code-block entrance animation: `reading`; reject decorative scroll reveal;
- admin Dialog radius or internal padding: FsusUI component geometry; reject consumer CSS override;
- login page composition: `focused-auth` owned by FsusBlog, with controls owned by FsusUI;
- home layout: `public-editorial`; reject admin card-grid composition;
- reusable color, radius, or motion token: FsusUI; allow `--fsusblog-*` only for a distinct Blog product semantic.

## 4. Preserve the design direction

Inspect the existing rendered state when possible. Preserve information architecture, content order, action priority, primary visual focus, component semantics, and accessibility unless the task explicitly changes them.

Choose the smallest coherent change. Do not add cards, badges, icons, helper copy, CTAs, gradients, glass, shadows, glow, illustration, or decorative motion to make a screen appear more complete. Do not define or override `--fsus-*`, target private FsusUI selectors, fork a primitive, or hide an upstream defect with a compatibility wrapper.

## 5. Select and inspect evidence

Use the affected entries from:

- `tests/frontend/fixtures/layout-archetype-matrix.json`;
- `tests/frontend/fixtures/ux-viewport-matrix.json`;
- `tests/frontend/fixtures/ux-content-boundary-corpus.json`;
- the nearest focused static, unit, browser, accessibility, or visual checks.

Inspect applicable realistic short, long, empty, loading, error, success, disabled, permission, and partial states across Light/Dark, narrow/wide viewports, supported locales, keyboard focus, zoom, overflow, and reduced motion. A compile, static checker, snapshot command, or zero diff does not prove an untested state.

Do not weaken a checker, threshold, fixture, or baseline to make a change pass.

## 6. Report completion

Report:

1. active FsusUI path/version, HEAD or pin, and dirty state;
2. owner and selected FsusBlog profile;
3. authoritative documents and contracts applied;
4. files and visual behavior changed;
5. validation commands and exact results;
6. rendered states and evidence actually inspected;
7. unresolved design drift or uncertainty;
8. confirmation that no parallel design system, fake FsusUI token, private-selector repair, component fork, or undocumented exception was introduced.

Do not claim visual acceptance without inspected rendered evidence.
