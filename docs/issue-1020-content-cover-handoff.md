# Issue #1020 content-driven cover handoff

The public cover contract now treats media as article evidence and treats no cover as
a first-class text layout. This handoff distinguishes landed implementation and test
code from the documentation PNG regeneration that must happen during unified browser
validation.

## Shared presentation contract

`resolvePublicCoverPresentation` normalizes a cover URL and returns either:

- `null`, which means no cover DOM and no placeholder; or
- the source URL plus `object-position: 50% 50%` and the `center-80` crop-safe token.

`FeaturedArticlesSection` consumes the contract in a 4:3 lead container.
`PublicArticleDetailPageContent` consumes it in a 16:9 detail container. Both use one
neutral `--fsusblog-panel-border`, reading radius, `object-cover`, no filter, no
decorative shadow, and no colored/gradient backing surface. Their surrounding title,
category, date, summary, and body hierarchy does not depend on media availability.

## Reviewed fixture set

`src/frontend/public/fixtures/cover-art-manifest.json` registers five distinct
positive examples:

- route-audit interface evidence;
- keyboard focus-traversal diagram;
- hot-read performance chart;
- public route architecture map;
- AEDS frame inspection output.

Each SVG has a different semantic concept and composition, contains no `<text>`,
article title, category, site name, or CTA, and uses no gradient, filter, glow, or
drop-shadow primitive. The manifest also records the explicit negative examples:
title cards, recolored abstract curves, decorative gradient/glow, and empty media
placeholders.

`tools/dev/demo-seed.sql` now assigns the route-map and frame-inspection fixtures to
the two fictional articles. `docs/development/demo-data.md` documents their purpose
and confirms that deleting either cover URL is supported.

## Acceptance ownership

- `tests/frontend/unit/view-contracts/coverArt.test.ts` owns URL normalization,
  text-first fallback, the shared crop geometry, manifest diversity, absence of
  embedded copy, and rejection of decorative SVG effects.
- `tests/frontend/e2e/visual/public-visual.spec.ts` inspects the actual home/article
  cover in every configured Light/Dark and viewport case: at most one cover,
  `center-80`, `object-fit: cover`, centered position, neutral 1px boundary, no filter,
  no background image, and no shadow.
- `docs/public-layout-rules.md#12-内容驱动的封面规范` contains content priorities,
  Do/Don't examples, 4:3/16:9 crop rules, center-80 safe area, and the Light/Dark
  review checklist.
- `docs/assets/screenshots/README.md` binds public-preview capture and review to the
  manifest and the existing manual route-capture workflow.

## Remaining dynamic deliverable

The checked-in public-preview PNG aliases have not been regenerated in this
implementation-only phase because the parent instruction requires all issue code to
land before any browser validation or dynamic output generation. The later unified
validation phase must run the documented manual route capture, inspect Home desktop
Light/Dark plus ArticleDetail desktop/mobile, and update every affected alias from the
live route. Existing PNGs are not accepted as proof merely because fixture source
changed.

## Risk and fallback

A blank or unavailable cover URL degrades immediately to the full text layout without
a restart. If a reviewed asset causes brightness or crop problems, remove that exact
URL or replace the source fixture after review; do not add a runtime darkening filter,
placeholder, glow, or global cover requirement.

No image generator, FsusUI change, API change, test, build, lint, typecheck,
Playwright, screenshot capture, or visual comparison was executed while authoring
this handoff.
