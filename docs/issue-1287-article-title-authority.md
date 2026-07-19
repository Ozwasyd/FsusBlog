# Issue #1287 article title authority

## Contract

The article detail header is the only page-title authority. It retains the
20/24/30px display scale established by #1280, uses the loaded 700 weight, and
widens multiline leading from 1.05 to 1.15 for Chinese titles.

Markdown H1 elements are chapter headings only when `MarkdownRenderer` runs in
`article` mode. Their 1.4em/700, left-aligned treatment and 3em top spacing keep
them inside the prose hierarchy instead of creating a second centered page title.
The renderer's `preview` and `editor` modes do not inherit this article-only
override; a faithful article preview may still opt into `article` mode explicitly.

## Preserved boundaries

The `about` mode continues to own the `markdown-body--document` rules introduced
by #1294. Its legal and policy layout, natural character spacing, paragraphs, and
lists are unchanged. The #1290 decorative metadata separators and shared dot
loader tokens also remain unchanged.

No routes, Markdown sanitization, APIs, auth, notification stream, binary
contracts, or package dependencies change.

## Regression ownership

`check-article-title-authority.mjs` pins the page-title scale and leading, the
article-only H1 rule, and the preserved #1294/#1290 boundaries.
`articleTitleAuthority.test.ts` verifies runtime mode selection and the same
typography roles. The existing visual-density guard remains aligned with the new
1.15 article-detail title leading.

Focused acceptance commands:

```bash
node ../../tests/frontend/checks/static/check-article-title-authority.mjs
npm run check:visual-density-governance
npm run typecheck
vitest run --config vitest.config.ts ../../tests/frontend/unit/contracts/articleTitleAuthority.test.ts ../../tests/frontend/unit/contracts/markdownDocumentMode.test.ts
```

Rollback is a CSS/class/token revert and requires no service restart or data
migration.
