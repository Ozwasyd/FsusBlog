---
name: fsusblog-design-conformance
description: Apply FsusBlog design governance against the active FsusUI baseline. Use when implementing, reviewing, debugging, or documenting FsusBlog visual, layout, theme, token, typography, icon, component-composition, motion, responsive, accessibility-presentation, screenshot, or rendered-output changes. Do not use for backend-only, protocol-only, or non-visual frontend work.
---

# FsusBlog Design Conformance

Treat this Skill as a thin FsusBlog consumer adapter. Load design truth from the active FsusUI source and FsusBlog current documents; never copy token values or build another design system inside this Skill.

Permanent Blog UI orchestration contracts live under `contracts/`.
`contracts/blog-ui-stage-policy.json` owns only consumer orchestration facts;
it does not copy FsusUI design facts. The adjacent JSON Schemas bind the active
FsusUI baseline, UI classification, writer dispatch, system adjudication, and
UX acceptance. Run the permanent checker with:

```bash
node .agents/skills/fsusblog-design-conformance/scripts/ui-orchestration.mjs
```

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

## 3. Freeze UI classification before changing

For orchestrated user-observable UI, produce
`fsusblog-design-conformance.ui-classification-receipt.v1`. Record:

- FsusUI baseline;
- owner: FsusUI or FsusBlog;
- profile: `public-editorial`, `reading`, `task`, `focused-auth`, `status`, or cross-cutting `overlay`;
- `uiImpact = true`;
- `uiDecisionClass`: `prescribed`, `bounded-composition`,
  `layout-judgment`, `interaction-judgment`, or
  `system-design-dispute`;
- `verificationClass`: `ux-local`, `ux-path`, or `ux-system`;
- affected hierarchy, contracts, states, themes, locales, viewports, zoom, focus, overflow, and reduced-motion behavior;
- whether the task restores conformance or changes a design contract;
- exact in-scope and out-of-scope surfaces.
- exact `fsusblog-design-conformance` and `fsusui-design-conformance`
  digests, current design-authority digests, slice/routing policy digests,
  context digest, candidate identity, and active FsusUI baseline identity.

For a local FsusUI alias, baseline identity includes the absolute path, Git
HEAD, package version, dirty state/fingerprint, Skill digest, and the
machine-readable contract digests. For a package pin it includes the exact
locked version and digests. Wrong checkout, baseline drift, missing Skill load,
or a copied natural-language summary fails closed.

The shared DAG proposal/validator freezes this receipt. Root cannot edit the
classification, hand-select a profile, or use failure count, cost, balance, or
model self-report as routing input.

Route reusable component geometry, public tokens, component states, shared motion, keyboard behavior, and shared accessibility defects to FsusUI. Keep information architecture, product copy, route composition, editorial/reading layout, documented variant selection, and `--fsusblog-*` product semantics in FsusBlog.

Apply these classification decisions:

- article image or code-block entrance animation: `reading`; reject decorative scroll reveal;
- admin Dialog radius or internal padding: FsusUI component geometry; reject consumer CSS override;
- login page composition: `focused-auth` owned by FsusBlog, with controls owned by FsusUI;
- home layout: `public-editorial`; reject admin card-grid composition;
- reusable color, radius, or motion token: FsusUI; allow `--fsusblog-*` only for a distinct Blog product semantic.

## 4. Bind one coherent executable UI slice

Every UI implementation dispatch must bind the verified permanent work plan,
executable slice, compiled prompt, checkpoint policy, execution route,
classification, candidate, exact target worktree, both Skill digests, design
authorities, and active FsusUI baseline.

The current slice and compiled prompt state:

```text
one coherent user-observable objective
first required edit or render-inspection action
first read targets
first writable component/page path
state and viewport subset
required implementation files
focused tests and render probes
explicit non-goals
checkpoint thresholds
completion and continuation predicates
```

Do not dispatch a complete page/system, unrelated interaction paths, design
governance, and the full render matrix as one writer task. Do not split the
states, interaction, visual support, or responsive behavior required for one
observable behavior into non-runnable fragments.

## 5. Route UI implementation by decision and execution shape

```text
prescribed/bounded + atomic-edit|bounded-multifile -> Sol/low
layout/interaction + bounded-multifile|iterative-debug -> Sol/medium
bounded render-probe-heavy -> Sol/medium
context-heavy|high-tool-depth|long-horizon-cross-module -> stop and re-slice
system-design-dispute -> stop and read-only adjudication
```

The UI/UX implementer is the single UI and UX implementation owner. Luna,
Terra, ordinary code agents, and Sol/high, Sol/xhigh, or Sol/max cannot
implement user-observable UI. Output-missing, red tests, UX rejection,
rework count, or “hard task” does not authorize promotion. The implementer
cannot modify frozen tests, fixtures, snapshot baselines, thresholds,
acceptance mappings, design Skills, or authority documents.

Write leases are ordered and mutually exclusive:

```text
test owner -> UI/UX implementer -> documentation writer
```

Behavior verification, system adjudication, and UX acceptance are fresh and
read-only/read-execute. Documentation starts only after behavior green and
candidate-matching UX accepted.

## 6. Implement, checkpoint, and continue one slice

Within one implementation rollout:

```text
execute first required action
-> edit the current coherent slice
-> run frozen focused checks and rendered probes
-> diagnose failures
-> modify only authorized implementation
-> emit machine-observed artifact/checkpoint before thresholds
-> rerun to the completion predicate
-> emit slice terminal or continuation receipt
```

A checkpoint binds filesystem, Git diff, command, rendered-evidence, slice,
prompt, route, candidate, and `nextRequiredAction`. A prose plan is not a
checkpoint. Continuation resumes from that cursor instead of rereading both
design Skills. A partial checkpoint cannot become candidate-green. Only all
implementation slices plus the full frozen stage matrix can create the
self-test receipt, and that receipt cannot replace independent behavior or UX
verification.

Output-missing must be classified as slice/prompt non-executable, runtime
invocation failure, sandbox/cwd/worktree mismatch, first action not executed,
or verified profile capability mismatch. Retrying with only a new agent,
attempt, wording, worktree, slice ID, or model is forbidden. Recovery requires
a materially changed slice/prompt/runtime/permission/worktree fingerprint or
verified capability evidence with breaker-reset authority.

## 7. Adjudicate system disputes and gate human decisions

`system-design-dispute` stops implementation. A fresh read-only Sol/high
adjudicator handles a uniquely resolvable owner, authority, scope, or component
capability question. Authority conflict uses Sol/xhigh. The adjudication receipt
binds actual profile, both Skills, authorities, baseline, candidate/context,
allowed Sol/low or Sol/medium implementation class, in/out scope,
`requiredReslice=true`, and any required owner issue. The adjudicator never
edits, redesigns, expands scope, or signs UX accepted.

When a unique resolution exists, reclassify, re-slice, and re-route without
asking a human. Only a verified shared `human-decision` request is eligible,
and only for:

- unresolved Blog/FsusUI authority conflict;
- multiple valid product directions;
- a design-system change rather than use of the current system;
- an irreversible public interaction or compatibility tradeoff.

Layout difficulty, responsive complexity, screenshots, ordinary accessibility
blockers, test failure, prompt imprecision, re-slicing, or model uncertainty
cannot enter the human gate. After a decision is deposited into a remote
authority source, create a new context/authority digest, reclassify, re-slice,
re-route, implement a new candidate, and repeat behavior, UX, and docs. A human
decision never directly makes the old candidate green or UX accepted.

## 8. Verify behavior and UX independently

Candidate-green enters a fresh behavior verifier. After behavior green, a
fresh read-only UX verifier loads the same two Skills, authority digests, and
active baseline:

```text
ux-local -> Sol/medium
ux-path -> Sol/high
ux-system -> Sol/xhigh
```

`fsusblog-design-conformance.ux-acceptance-receipt.v1` binds classification,
dispatch, candidate/context, work plan, slice, prompt, route, actual profile,
both Skill digests, active baseline, distinct implementation/verifier run
identities, viewport/state/input matrix, inspected production rendered
artifacts, blockers, and status. Accepted has no blockers. Rejected has veto
authority only: no code modification, redesign, or scope change.

Each acceptance-group member repeats classification, baseline, work plan,
slices, route, candidate, human-decision state, and fresh receipts. A member
cannot inherit a previous member's profile, baseline, slice, or acceptance.

## 9. Preserve the design direction

Inspect the existing rendered state when possible. Preserve information architecture, content order, action priority, primary visual focus, component semantics, and accessibility unless the task explicitly changes them.

Choose the smallest coherent change. Do not add cards, badges, icons, helper copy, CTAs, gradients, glass, shadows, glow, illustration, or decorative motion to make a screen appear more complete. Do not define or override `--fsus-*`, target private FsusUI selectors, fork a primitive, or hide an upstream defect with a compatibility wrapper.

## 10. Select and inspect evidence

Use the affected entries from:

- `tests/frontend/fixtures/layout-archetype-matrix.json`;
- `tests/frontend/fixtures/ux-viewport-matrix.json`;
- `tests/frontend/fixtures/ux-content-boundary-corpus.json`;
- the nearest focused static, unit, browser, accessibility, or visual checks.

Inspect applicable realistic short, long, empty, loading, error, success, disabled, permission, and partial states across Light/Dark, narrow/wide viewports, supported locales, keyboard focus, zoom, overflow, and reduced motion. A compile, static checker, snapshot command, or zero diff does not prove an untested state.

Do not weaken a checker, threshold, fixture, or baseline to make a change pass.

## 11. Report completion

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
