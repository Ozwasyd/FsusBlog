# Issue #1019 public-home editorial handoff

The public home now has one deterministic editorial line shared by public AOT/SSR,
hydration, and SPA takeover. This implementation pass records the source and test
ownership only; it does not present unexecuted browser or screenshot work as passing.

## Composition contract

`selectHomeEditorialComposition` owns all three displayed collections in this order:

1. select at most one lead article from the featured source;
2. select at most five compact secondary articles from the hot source;
3. retain the current page feed entries not already displayed.

The selector preserves each backend source's order and keeps one article-id set across
all three stages. It does not mutate its inputs or change backend ranking. A coverless
lead remains the lead and renders as complete text hierarchy instead of being skipped
or replaced by an empty media card.

`createHomeEditorialPageState` applies the selector and returns both the composition
and the filtered article-list view. `Home.vue` and
`createPublicHomePageAssembly` call this same pure function, so initial public output,
hydration, and later page changes cannot acquire separate recommendation ordering.

## Rendered structure

- the top navigation remains the only site-brand surface; home content starts with
  article content and has no duplicate site Hero;
- `FeaturedArticlesSection` renders zero or one large lead;
- `HomeTextFirstRecommendations` is a compact text list rather than a second card
  grid or independent aside;
- the right-side hot list is disabled so it cannot reintroduce duplicate ids;
- `PublicArticleList` receives `showReadCta=false` on home, leaving the title as the
  ordinary article's single primary entry;
- empty recommendation sources fall through to the current feed, and a fully empty
  input retains the existing home empty state;
- reduced motion changes only transition duration and does not remove hierarchy.

## Acceptance ownership

- `tests/frontend/unit/view-contracts/homeSpotlight.test.ts` covers global id
  exclusivity, stable ordering, input immutability, coverless lead, empty sources,
  pagination changes, feed projection, and the shared page-state builder.
- `tests/frontend/e2e/visual/public-visual.spec.ts` covers the Desktop/Mobile ×
  Light/Dark matrix, one lead maximum, page-wide id uniqueness, one ordinary article
  link, cover/text lead layout, and reduced-motion hierarchy.
- the public visual snapshot catalog already contains desktop/mobile and Light/Dark
  home baselines. Any changed baseline must be reviewed and updated only during the
  later unified browser-validation phase.

The positive recipe and review checklist are in
`docs/public-layout-rules.md#11-首页单一编辑主线-recipe`.

## Risk and rollback

The selector is presentation-only. If a source is unavailable, callers can pass an
empty recommendation array and immediately retain the normal feed without restarting
the service. A rollback must keep one shared selector and the cross-collection id
exclusion; restoring independent card/hot/feed selection would restore the reported
defect.

No API contract, backend ordering, FsusUI component, route, or AOT payload shape was
changed. No test, build, lint, typecheck, Playwright, screenshot, or visual comparison
was executed while authoring this handoff.
