# Public Layout Rules

This document owns FsusBlog public/editorial composition only. Baseline, ownership, and precedence are in [`design/governance.md`](design/governance.md); profiles are in [`design/surface-profiles.md`](design/surface-profiles.md). It does not replace FsusUI `docs/design.md` or own generic geometry/token values.

## 1. Token namespace

FsusBlog consumer tokens use `--fsusblog-*` and must express public layout, reading columns, content hierarchy, or another Blog semantic. Public layout may not define, override, or fake `--fsus-*` aliases or copy FsusUI values as local authority; map upstream semantics through public FsusUI or Element Plus tokens.

## 2. Public shell boundary

The canonical contract for public header, mobile navigation, search enhancement, auth entry, footer, AOT/emergency CSS, and sticky geometry is [`frontend/public-shell-ownership.md`](frontend/public-shell-ownership.md). This file only defines content inside the shell: the header is the sole brand surface, the body does not repeat a hero, and global BottomTabBar and page reading dock are mutually exclusive. ArticleDetail uses FsusUI `content-flow="content-driven"` and natural flow; other public routes use `viewport-stable`. Consumers must not rewrite shell flex or padding with deep/internal selectors.

Other production cross-component selectors must follow [`frontend/internal-selector-governance.md`](frontend/internal-selector-governance.md): classify the FsusUI/FsusBlog/third-party owner, then register a bounded expiry and replacement; the budget may only decrease. Rewriting `:deep()` as global `.el-*` is not a migration.

## 3. Reading surface contract

The following components must declare `data-fsus-surface="reading"`:

- root `<article>` and `#fsus-comments-island` in `PublicArticleDetailPageContent.vue`
- desktop TOC and mobile drawer in `ArticleTocPanel.vue`
- `MarkdownRenderer.vue`
- `ArticleReadingProgress.vue`
- `ArticleReadingNotice.vue`
- `ArticleDetailHeader.vue`
- `ArticleCommentsVirtualList.vue`
- `ArticleCommentComposer.vue`
- `PublicArticleList.vue`
- `FeaturedArticlesSection.vue`

Reading surfaces disable glass, motion trail, glow, accent shimmer, and scroll reveal. Body, headings, images, and code appear statically; copy, focus/target, reading-progress, and media-overlay feedback may use functional motion. Public reading skeletons use a neutral document placeholder, never `animated`.

ArticleDetail comments sit `40px` below the body on mobile and `56px` on desktop; section title→divider is `12px`, divider→first comment state `24px`. Empty and populated states share heading and side baselines, but Empty does not inherit pagination, loading-region, or shell viewport-fill budgets. Empty CTA is `44px` high with `6px` radius and `16px` horizontal padding. Keep only `48px` mobile / `64px` desktop from the final real state block to the footer; never fill short content with `min-height`, flex spacers, illustrations, or decorative cards.

## 4. Dialog width variants

FsusUI's public contract owns Dialog, Drawer, and Popover geometry. Public layout selects documented variants and owns title, content order, and action priority; it must not copy width values or add consumer CSS variants. Host relationship, material, and responsive acceptance are in the `overlay` profile of [`design/surface-profiles.md`](design/surface-profiles.md).

## 5. Glass-material allowlist

Glass is allowed only on:

- article image lightbox

All other public/reading surfaces use paper/document material. A new glass surface must carry `[data-fsus-material="glass"]` and document its overlay semantics.

## 6. Dark Scholarly Blue

The active FsusUI baseline owns Scholarly Blue's canonical values and theme mapping. Blog must not drift reading focus/active/link feedback to saturated blue or another decorative color, or register a second value here or beside a component.

Navigation progress and admin interaction feedback use the same upstream semantic mapping. The read segment of the article progress bar uses `--fsusblog-color-primary`, the unread track `--fsusblog-panel-border`; do not substitute text color or add a brand-color fallback. Scholarly Blue is only for link hover, focus, and active.

## 7. Typography boundary

The sole authority for body, summary, metadata, Markdown document mode, code font, and loaded weights is [`design/reading-typography.md`](design/reading-typography.md); page H1 scale and article-title uniqueness are in [`design/page-title-scale.md`](design/page-title-scale.md). Layout consumes these roles and does not copy size, weight, or heading rules.

## 8. Radius scale

Public layout consumes semantic radii from the active FsusUI baseline. Inline marks, controls, panels, popovers, expressive surfaces, and pills use their public tokens; ordinary public/reading surfaces may not be marked expressive for a larger radius. Blog may map product semantics under `--fsusblog-*`, never copy upstream values, use local literals, or recalculate the scale in `rem`.

## 9. Motion scale

The active FsusUI baseline owns duration, easing, and presets. Reading surfaces retain only color, border, copy, focus/target, progress, and overlay feedback; body, headings, images, and code use no translate, scale, stagger, scroll reveal, or motion trail. Under `prefers-reduced-motion: reduce`, remove nonessential movement while retaining state-machine completion semantics.

## 10. Commit review checklist

- Record the actual FsusUI baseline, owner, and profile through [`design/governance.md`](design/governance.md).
- FsusUI token/API/internal-geometry or cross-project rule changes belong to FsusUI; public-shell slots, reading layout, AOT/hydration markup, or SEO/archive/filter/article composition are FsusBlog `public-editorial` or `reading` changes.
- Consumer changes must not fake `--fsus-*`, copy upstream values, or depend on internal selectors. New reading components declare `data-fsus-surface="reading"`; new glass surfaces are added to this allowlist. Every new public motion states its semantic purpose and supplies inspected rendered evidence.

## 11. Home single editorial line

Home makes content the primary visual anchor and uses this fixed order:

1. The header owns brand identity; body does not repeat site name or a site hero.
2. Show at most one primary recommendation. With a valid cover, use one media entry; without one, keep title/category/date hierarchy as text only.
3. Follow it with at most five compact text recommendations; no second large card, right-side popular rail, or standalone CTA.
4. The current-page article stream contains the remainder; each ordinary item uses its title link as the only primary entry, with no duplicate “Read” link.
5. `selectHomeEditorialComposition` is the sole selector for primary, text recommendations, and current-page stream. It preserves each backend source order and builds mutually exclusive article IDs in that order. AOT/SSR, hydration, and SPA takeover call the same function; components/islands do not filter again.
6. Pagination replaces only the current-page stream input; recommendation sources retain order and re-enter the same selection. With no recommendations start at the stream; with all three inputs empty show the home empty state.
7. Desktop/Mobile and Light/Dark share one DOM hierarchy. Reduced motion only shortens nonessential color transitions; it never hides title, metadata, cover, or pagination controls.

Review the recommendation count, page-wide article-ID uniqueness, no-cover text fallback, empty recommendations, before/after pagination, four Desktop/Mobile × Light/Dark screenshot groups, and reduced-motion hierarchy.

The single primary recommendation carries the home thesis; do not restore a site name hero. In every color mode, hierarchy is primary title → `18/20px` section title → `18/20px` ordinary title → `12px/500` metadata + `14px/400` summary. Primary content padding is `48px` mobile / `64px` desktop; section gaps are `32–48px`, with one `1px` editorial rule under each heading and no card border, section top rule, or decorative background. Scholarly Blue is only link hover/focus/active. The home period motif separates ordinary metadata only; do not repeat it in the primary, section heading, loading, or recommendation index.

<a id="12-内容驱动的封面规范"></a>

## 12. Content-driven covers

Cover art is evidence of article content, not a card background. Its presence must not change title, category, date, summary, or body-entry completeness. Use:

1. a directly relevant interface screenshot, chart, code/command output, device, or field photograph;
2. an editorial illustration of one concrete concept, with a distinct composition per article;
3. no cover when no suitable evidence exists: use text-first layout.

### Content and text

Do:

- Capture a state discussed by the article and remove real accounts, domains, IPs, email, tokens, and logs.
- Use measurements, call paths, protocol frames, focus order, or physical details that the body explains.
- Give each article distinct evidence and composition; color alone cannot distinguish articles.
- `alt` describes the evidence type; the page H1 or title link remains the article-title text.

Don't:

- Do not place article title, category, site name, “Read more”, or other page UI copy in the image.
- Do not recolor-copy one soft chart, abstract wave, sphere, or geometric template.
- Do not use unrelated gradients, atmosphere light, glow, decorative shadow, or a uniform filter to create a “series”.
- Do not imply every article needs a cover with blank/default/broken-image cards.

Repository examples are registered in `src/frontend/public/fixtures/cover-art-manifest.json`: public-route audit UI, keyboard focus path, hot-read performance curve, public-route graph, and AEDS frame check correspond to interface evidence, interaction diagram, performance chart, architecture diagram, and binary output. Manifest negative examples are review counterexamples, not page assets.

### Composition, crop, and safe area

- Fixture canvas is `960×640` (3:2). Higher-resolution photos/screenshots are allowed, but key evidence stays in the central 80% safe area (10% from each left/top edge through 90% right/bottom).
- Home primary recommendation uses centered 4:3 `object-cover`; article pages use centered 16:9 `object-cover`. Both use `object-position: 50% 50%` and `data-cover-safe-area="center-80"`.
- Keep the only key mark, legend, code line, or subject out of the outer 10%; do not rely on corner text visible in only one ratio.
- Containers use only reading radius and a neutral 1px `--fsusblog-panel-border`; background, gradient, filter, color backing, atmosphere light, and decorative shadow stay off.
- For unavailable URL (`null`, empty, or whitespace), emit no cover DOM. Home keeps category/date/title as a text-only primary recommendation; article pages start directly with the complete article header.

### Light/Dark review

- In Light and Dark, verify image edges separate from the page and the container has no extra color or glow.
- Check that broad white, fluorescent, or saturated areas do not shock in Dark; fix source art rather than masking it with a runtime darkening filter.
- Inspect home 4:3, article desktop 16:9, and article mobile 16:9; central 80% evidence must survive every crop.
- Adjacent title/category/date/body remain readable in both themes; the image is not their only expression.
- Ensure no repeated title/category/CTA or recolored abstract composition, and no blank media box on the no-cover path.
- Regenerate public-preview screenshots with manual route capture. Minimum aliases are Home desktop Light/Dark, ArticleDetail desktop Light, and ArticleDetail mobile Light.

## 14. Non-public boundary

Account, admin, auth, status, and ordinary overlays are outside this authority. Classify them with [`design/surface-profiles.md`](design/surface-profiles.md); then route account/admin through [Account layout ownership](frontend/account-layout-ownership.md), [Account navigation](frontend/account-navigation.md), [Account style ownership](frontend/account-style-ownership.md), and [Account motion](frontend/account-motion.md), while auth/status use their nearest domain documents. [Layout visual governance](frontend/layout-visual-governance.md) and its ledger alone manage representative routes and baseline movement.
