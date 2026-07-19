# Layout visual governance

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

`PublicBlogLayoutShell.vue` is the sole documented owner allowed to address
`el-public-shell__*` selectors. There are no temporary external-selector
exceptions. Apple Touch Icon remains a standards-facing asset label; Apple or
Linear design-language names in production classes, tokens, or route metadata
are prohibited.
