# Issue #1018 public typography handoff

GitHub #1018 is already closed. Its completion comment attributes the original
implementation to `d7a1cd35` and records historical checks. Those results are
provenance only: no test, build, lint, restore, syntax, typecheck, profile, browser,
or Playwright command was executed during this implementation phase.

The live dependency endpoints report no blockers and no issues blocked by #1018.
Related issues #140, #144, #146, and #148 continue to own font registry, loading,
and theme preview work; this issue does not duplicate those systems.

## Public typography roles

The retained production contract has three roles:

| role | hydrated scale | first-paint/AOT scale | purpose |
| --- | --- | --- | --- |
| display | 20/24/30px with 1.1/1.05 line height | 20/24/30px with 1.1/1.05 line height | article titles |
| reading | 16/18px with 1.8/1.9 line height | 16/18px with 1.8/1.9 line height | summaries and long-form prose |
| metadata | 12/14px with 16/20px line height | 12/14px with 16/20px line height | dates, categories, status, pagination, and read links |

`themeTokens.ts` owns hydrated article-list roles. The emergency block in
`public-page.css` and generated `public-shell-emergency.css` own the matching
first-paint values. `markdown.css` has one authoritative paragraph rule and keeps
the reading body at 16px/1.8.

Information-bearing Light tokens use `#71717A` or `#62626A` on `#F7F7F8`;
information-bearing Dark tokens use `#A1A1AA` or `#B2B2BA` on `#09090B`.
Decorative-only Dot Gray remains `#A1A1AA` in Light and `#52525B` in Dark and must
not carry a date, category, status, or action by itself.

## Automated acceptance ownership

`tests/frontend/checks/static/check-visual-density-governance.mjs` already owns the
issue acceptance contract:

- scans public, home, filter, article, renderer, view-contract, token, and relevant
  CSS sources for 9/10/11px and sub-12px readable scales;
- requires one Markdown paragraph rule and the canonical 16px/1.8 reading body;
- asserts display, reading, and metadata roles in `themeTokens.ts`;
- checks exact information/decorative token assignments and calculates the four
  Light/Dark information-text contrast ratios against WCAG AA 4.5:1;
- compares emergency/public AOT title, summary, and metadata sizes and line heights
  with the hydrated role contract;
- rejects the legacy `1.35rem` and `.96rem` AOT scales.

The checker and its current source owners were already modified in the shared work
tree, so this pass did not overwrite them or the dirty production typography files.

## FsusUI boundary reconciliation

The #1018 completion comment also records that sticky geometry moved to a
FsusBlog-owned header hook to avoid the strict `check:fsusui-boundary`
internal-selector warning.
This is an intentional successor to #1016's historical implementation state.
`usePublicStickyGeometry.ts` therefore queries only the stable
`[data-public-shell-header]` hook published by the alias-owned `ElPublicShell`.
The behavior test models that public hook directly and confirms that the measured
element is the real public header without coupling runtime code to an internal
FsusUI class.

## Scope and current status

- no font registry, loading, theme preview, PWA brand color, or FsusUI change;
- no visual redesign, thin-weight or negative-tracking treatment;
- no edit to deployment rollout, gateway, release evidence, auth/schema, archive
  geometry, audit governance, or central test-governance files;
- historical validation is not presented as current validation.
