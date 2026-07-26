# Layout visual governance

Design intent, ownership and rule precedence come from
[`../design/governance.md`](../design/governance.md). Route-level composition is
classified by [`../design/surface-profiles.md`](../design/surface-profiles.md).
This document owns representative-route evidence and baseline movement only; it
does not establish a second design language.

The canonical representative route set lives in
`tests/frontend/fixtures/layout-archetype-matrix.json`. Public, identity, and
admin Playwright suites consume this registry directly. Adding a business route
does not add a screenshot; add or replace a representative only when it creates
a new page archetype.

Critical representatives own desktop/mobile and light/dark screenshots. Every
registered path still runs structural, theme, focus-visible, hit-target,
reduced-motion, high-contrast, and horizontal-overflow checks through the
focused suites. Public representatives additionally retain the existing
PublicShell AOT/hydration ownership assertions. Dashboard tests keep the
separate 1366x768 first-fold contract for actionable tasks and summary content.

`tests/frontend/fixtures/layout-visual-change-ledger.json` is the only approval
ledger for baseline movement. Each entry links an issue and affected archetype
to exactly one classification:

1. `visual-equivalent-refactor`
2. `expected-harmonization`
3. `required-accessibility-ergonomic-correction`
4. `unintended-regression`

A baseline update requires an issue-linked rationale in that ledger. Snapshot
movement by itself is not approval. The governance checker rejects unknown
archetypes, missing dependency classifications, route-name visual branching,
consumer dependencies on PublicShell internal BEM selectors, misleading local
`FsusUi*` implementations, and retired generic primitives.

`PublicBlogLayoutShell.vue` is the sole Blog integration point for PublicShell,
but it may use only public props, slots, tokens and stable `data-*` hooks. No
consumer file may address `el-public-shell__*` selectors, and there are no
temporary external-selector exceptions. Apple Touch Icon remains a
standards-facing asset label; Apple or Linear design-language names in
production classes, tokens, or route metadata are prohibited.

Public/design documentation follows the single-concern ownership map in
`../design/governance.md`. Shell implementation ownership and geometry live in
`public-shell-ownership.md`; public product composition lives in
`../public-layout-rules.md`; reading typography and page titles live in their
separate design documents. A current document must not cite an issue/handoff file
as its contract, and deleted migration sources are represented only by lifecycle
`pathMigrations`, not by replacement aliases or copied session notes.
