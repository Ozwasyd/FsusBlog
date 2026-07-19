# Issue #1294 document Markdown layout

## Contract

The about, privacy, guidelines, and copyright routes already share
`PublicDynamicPage.vue`, which invokes `MarkdownRenderer` with `mode="about"`.
That existing mode is the ownership boundary for legal and policy typography.

`MarkdownRenderer.vue` adds `markdown-body--document` only for `about`. Article,
preview, and editor modes retain the existing article-prose presentation.

Document mode applies these focused overrides:

| Role | Document rule |
| --- | --- |
| root and rendered text | left aligned with natural letter spacing |
| CJK/Latin/number spacing | `text-autospace: normal` |
| paragraphs | no first-line indentation |
| ordered and unordered lists | zero horizontal margin and 1.5em marker padding |

The base Markdown contract was already left aligned and no longer assigned a 2em
paragraph indent when #1294 was implemented. The explicit document rules preserve
that behavior and prevent legal clauses from inheriting future article-prose drift.

## Regression ownership

`check:visual-density-governance` pins the about-mode class binding and each
document override without changing the public-reading guard owned by #1296.

`markdownDocumentMode.test.ts` verifies runtime class selection for about versus
article/preview modes and independently checks the CSS document contract.

Focused acceptance commands:

```bash
npm run check:visual-density-governance
npm run typecheck
FSUSBLOG_USE_LOCAL_FSUSUI=0 npx --no-install vitest run --config vitest.config.ts ../../tests/frontend/unit/contracts/markdownDocumentMode.test.ts
```

## Scope and rollback

This is a consumer-side Markdown presentation change. It does not alter Markdown
sanitization, FsusUI, routes, API/auth, notification stream, or binary contracts.
Revert the about-mode class and document CSS overrides with their focused evidence
to restore the shared prose layout; no service restart or data migration is needed.
