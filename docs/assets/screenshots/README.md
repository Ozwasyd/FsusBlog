# Public Preview Screenshots

These screenshots are sanitized public-preview visual assets generated from deterministic safe sample content. They are intended to help external readers understand the product surface without exposing production data.

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

The screenshots use fictional sample content only:

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

Regenerate the PNG files with:

```bash
node tools/docs/generate-public-preview-screenshots.mjs
```
