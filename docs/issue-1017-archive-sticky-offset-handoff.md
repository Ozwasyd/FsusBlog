# Issue #1017 archive sticky offset handoff

GitHub #1017 is closed. Its owner comment identifies `238dd232` as the original
implementation and reports historical contract and Playwright results. Those results
are not current-workspace validation. This pass audited the shared workspace against
the issue body and dependency #1016, found the production implementation intact, and
did not rewrite the archive component or public shell.

## Current consumer contract

`PublicArchivePageContent.vue` currently preserves the required behavior:

| concern | current implementation |
|---|---|
| year target | `id="archive-year-${yearGroup.year}"` on every rendered year section |
| quick navigation | `href="#archive-year-${yearGroup.year}"` |
| anchor clearance | `.archive-year-section` consumes `--fsusblog-public-anchor-offset` with the documented header-derived fallback |
| sticky position | `.archive-year-heading` consumes `--fsusblog-public-sticky-top` with the documented header-height fallback |
| removed guess | no `top-24` utility and no scoped generic `.sticky` selector |
| year visibility | `view.yearGroups` is rendered directly; the current year is not filtered or sliced away |

Both `Archive.vue` and the public AOT page assembly consume the same
`PublicArchivePageContent` component. The audit found no archive data, route, AOT,
visual, or DOM-structure change to make.

## Acceptance gap repaired

The pre-existing source assertion used broad substring checks and could miss selector
lists, whitespace variants, or a drift between SPA and AOT consumers. The dedicated
`archiveStickyGeometryContract.test.ts` owner now parses the scoped CSS rules and
asserts:

- stable year ids and hash links for all `view.yearGroups`;
- absence of `top-24` and any selector that targets the generic `.sticky` class;
- exact token/fallback ownership on the dedicated section and heading selectors;
- shared archive component consumption by the SPA and public AOT assembly.

`archive-sticky-geometry.spec.ts` adds the missing rendered-browser contract at the
desktop and mobile acceptance viewports. It reads the actual computed header,
`scroll-margin-top`, sticky `top`, and inherited public tokens. Hash navigation must
settle with the target below the real header, then scrolling must settle the year
heading flush with that header. Completion uses `expect.poll` and error normalized to
the measured header height; it does not use a fixed pixel threshold or fixed delay.
A test-only spacer is placed inside the selected year section so the sticky containing
block remains tall enough to exercise the sticky state without altering production
markup.

## Scope preserved

- no production Vue, CSS, route, view-contract, data-fetching, or AOT renderer change;
- no edit to dependency #1016's shell token publisher or observer behavior;
- no FsusUI change and no current-year suppression;
- no deployment, authentication, schema, dead-code governance, or central test-file
  edit;
- no existing test was deleted or replaced.

## Risk and rollback

This pass changes tests and handoff evidence only, so it adds no runtime rollout risk.
If a test itself proves incorrect, reverting the two new test files restores the prior
test surface without a restart or production behavior change. At runtime the archive
consumer still retains its header-derived CSS fallbacks when measured #1016 tokens are
unavailable.

## Deferred verification

The following are intended targeted commands for the later unified validation phase;
they were not executed here:

```bash
cd src/frontend && npx vitest run --config vitest.config.ts ../../tests/frontend/unit/view-contracts/archiveStickyGeometryContract.test.ts ../../tests/frontend/unit/view-contracts/userFacingWorkflow.test.ts
cd src/frontend && env -u NO_COLOR NODE_PATH=./node_modules npx playwright test acceptance/archive-sticky-geometry.spec.ts --workers=2
```

The second spec still needs the root integration pass to add it to the existing public
acceptance invocation and central matrix/coverage ownership. It should share that
parallel lane rather than create a new serial lane.

## Validation status

No test, build, lint, restore, syntax, typecheck, profile, Playwright, screenshot, or
browser validation was executed in this implementation phase. The GitHub completion
comment and dependency comment remain historical evidence only.

