# Public Preview Screenshots

These screenshots are sanitized public-preview visual assets captured from the live frontend route audit flow. They are intended to help external readers understand the current product surface without exposing production data.

## Gallery

| Surface | File |
| --------- | ------ |
| Public home page | [public-home-light.png](public-home-light.png) |
| Article detail page | [article-detail-light.png](article-detail-light.png) |
| Mobile article page | [article-detail-mobile.png](article-detail-mobile.png) |
| Dark mode public page | [public-dark.png](public-dark.png) |
| Admin dashboard | [admin-dashboard.png](admin-dashboard.png) |
| Article editor | [article-editor.png](article-editor.png) |
| Comment moderation console | [comment-moderation.png](comment-moderation.png) |
| Security / anti-crawler console | [security-console.png](security-console.png) |
| AOT / cache / operations status | [operations-status.png](operations-status.png) |

## Safety Rules

The screenshots come from the Playwright route audit fixtures and manual full-route screenshot capture, using local/demo content only:

- no real production domains
- no real ICP or public security registration numbers
- no real personal emails
- no real IP addresses
- no real usernames from production
- no real logs or audit records
- no tokens or object storage URLs
- no private roadmap or internal-only notes

## Cover Evidence Rules

Public home and article screenshots use the reviewed fixtures registered in
[`cover-art-manifest.json`](../../../src/frontend/public/fixtures/cover-art-manifest.json).
The assets depict route-audit UI, focus traversal, performance measurements,
route structure, or binary-frame output; they do not embed an article title,
category, site name, or CTA. Each concept has a distinct composition rather
than a palette-swapped abstract template.

Capture review must inspect both the 4:3 home crop and 16:9 article crop. The
key evidence stays inside the shared `center-80` safe area, and the renderer
adds only a neutral 1px boundary—no gradient, glow, colored backing surface,
filter, or decorative shadow. Dark captures must be reviewed for large bright
regions instead of applying an automatic darkening filter. A missing or blank
cover URL renders the complete text hierarchy without an empty media box.

The Do/Don't examples and full review checklist live in
[`public-layout-rules.md`](../../public-layout-rules.md#12-内容驱动的封面规范).

## Brand And Asset Rights

The screenshots do not include a separate logo file, trademark artwork, generated bitmap illustration, or production brand asset. The visible `FsusBlog` wordmark is rendered as plain text for documentation context. Code is covered by the repository license; screenshots and brand usage should be treated as documentation examples unless a later brand policy says otherwise.

## Provenance And Freshness

[`manifest.json`](manifest.json) is the machine-readable authority for the nine
managed images. It records source commit and canonical ReleaseId provenance,
frontend/backend build identities, deterministic fixture and capture digests,
the resolved local FsusUI commit/tree/lock identity, the visual-input digest,
and each PNG SHA-256. `sourceCommit` answers where an image was captured;
`visualInputDigest` independently decides whether it is fresh for this checkout.

These fast local checks do not start an application, browser, database, network
service, or GitHub API:

```bash
npm --prefix src/frontend run check:public-preview-screenshot-manifest
npm --prefix src/frontend run check:public-preview-screenshot-sync
```

## Regeneration And Verification

The formal writer owns a unique runtime namespace, allocates isolated ports,
builds the current checkout, seeds fictional fixtures, keeps runtime and layout
audits enabled, captures the complete registry into staging, validates it, and
atomically replaces the gallery only after every check passes. Success and
failure both clean processes, containers, ports, and fixture data:

```bash
npm --prefix src/frontend run capture:public-preview-docs
npm --prefix src/frontend run verify:public-preview-docs
```

`verify:public-preview-docs` is read-only: it recaptures into a temporary
directory, compares every screenshot ID, writes deterministic release evidence
under `.tmp/release-evidence/`, and requests the explicit capture command when
an update is required. Local `release-final` runs this same matrix tier. CI,
when available, is only another caller and is not the authority.

The manual audit derives broader human-review coverage from the frontend router
table and writes only below `FSUSBLOG_MANUAL_SCREENSHOT_DIR` or
`.tmp/manual-layout-screenshots/current`. A filtered viewport/theme/scope shard
cannot write or prune documentation assets. The retired
`FSUSBLOG_MANUAL_SCREENSHOT_WRITE_DOCS_ASSETS=1` setting fails explicitly.

For targeted local review or CI matrix jobs, keep each Playwright shard at
`--workers=1` and split the route matrix with deterministic filters:

```bash
FSUSBLOG_MANUAL_SCREENSHOT_VIEWPORTS=desktop \
FSUSBLOG_MANUAL_SCREENSHOT_THEMES=light \
FSUSBLOG_MANUAL_SCREENSHOT_SCOPES=anonymous,admin \
FSUSBLOG_MANUAL_SCREENSHOT_SHARD_NAME=desktop-light-main \
npm --prefix src/frontend run capture:manual-layout-screenshots
```

Supported `FSUSBLOG_MANUAL_SCREENSHOT_VIEWPORTS` values are `desktop`,
`mobile`, and `narrow-mobile`; supported `FSUSBLOG_MANUAL_SCREENSHOT_THEMES`
values are `light` and `dark`; supported `FSUSBLOG_MANUAL_SCREENSHOT_SCOPES`
values are `anonymous`, `user`, `admin`, and `edge`. When
`FSUSBLOG_MANUAL_SCREENSHOT_SHARD_NAME` is set and
`FSUSBLOG_MANUAL_SCREENSHOT_DIR` is not set, output defaults to a shard-local
folder under `.tmp/manual-layout-screenshots/current/<shard>`.

All shards keep PNGs in shard-local temporary folders. Only the unfiltered,
single-writer `capture:public-preview-docs` command can publish the complete
documentation gallery.
