# Public Preview Screenshots

These screenshots are sanitized public-preview visual assets captured from the live frontend route audit flow. They are intended to help external readers understand the current product surface without exposing production data.

## Gallery

| Surface | File |
|---------|------|
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

## Brand And Asset Rights

The screenshots do not include a separate logo file, trademark artwork, generated bitmap illustration, or production brand asset. The visible `FsusBlog` wordmark is rendered as plain text for documentation context. Code is covered by the repository license; screenshots and brand usage should be treated as documentation examples unless a later brand policy says otherwise.

## Regeneration

Regenerate the PNG files by running the manual route screenshot audit from the frontend workspace:

```bash
FSUSBLOG_MANUAL_SCREENSHOT_RUNTIME_AUDIT=0 FSUSBLOG_MANUAL_SCREENSHOT_LAYOUT_AUDIT=0 FSUSBLOG_MANUAL_SCREENSHOT_WRITE_DOCS_ASSETS=1 npm --prefix src/frontend run capture:manual-layout-screenshots
```

The manual audit derives its coverage from the frontend router table. It writes full route screenshots under `FSUSBLOG_MANUAL_SCREENSHOT_DIR` or `.tmp/manual-layout-screenshots/current`, and copies the selected documentation aliases above into this directory when `FSUSBLOG_MANUAL_SCREENSHOT_WRITE_DOCS_ASSETS=1` is set. Leave the audit flags enabled for layout QA; set them to `0` only for capture-only documentation refreshes. This is the only screenshot capture path for these documentation assets.

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

Only one shard should write documentation assets. For sharded captures, set
`FSUSBLOG_MANUAL_SCREENSHOT_DOCS_SHARD_NAME=<same shard name>` on the intended
docs writer together with `FSUSBLOG_MANUAL_SCREENSHOT_WRITE_DOCS_ASSETS=1`.
Other shards keep their PNGs in shard-local temp folders and do not mutate
`docs/assets/screenshots`.
