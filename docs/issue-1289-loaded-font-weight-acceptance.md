# Issue #1289 loaded font-weight acceptance

## Resolved baseline

The repository-wide font contract introduced for #1279 already removed the
synthetic `650`, `800`, `300`, `font-thin`, `font-light`, and `font-extrabold`
weights reported by #1289. This acceptance-only change does not manufacture a
second production delta for rules that are already compliant.

The current audited roles are:

| Surface | Role | Loaded weight |
| --- | --- | --- |
| `ArticleCommentComposer.vue` | identity label, badge, and toggle | 700 |
| `ArticleCommentComposer.vue` | draft, empty preview, feedback, and metrics | 700 |
| `ArticleTocPanel.vue` | desktop TOC title | 700 |
| `markdown.css` | blockquote | inherited 400 from `.markdown-body` |

`themeTokens.ts` remains covered without being edited here. The repository-wide
checker rejects out-of-contract utility classes, while
`publicTypography.test.ts` pins the article title and summary roles to
`font-bold` and `font-normal` respectively.

## Regression ownership

`check-font-weight-contract.mjs` retains the source-wide 400/500/700 whitelist
and now pins every non-token role reported by #1289. It also verifies that the
blockquote inherits the loaded 400 Markdown root weight instead of introducing
a synthetic local weight.

`loadedFontWeightRoles.test.ts` independently reads the three audited production
files and verifies the same selector-to-weight mapping. The test does not import
or mutate production modules, and this issue does not change FsusUI.

Focused acceptance commands:

```bash
node ../../tests/frontend/checks/static/check-font-weight-contract.mjs
npm run typecheck
FSUSBLOG_USE_LOCAL_FSUSUI=0 npx --no-install vitest run --config vitest.config.ts ../../tests/frontend/unit/contracts/loadedFontWeightRoles.test.ts ../../tests/frontend/unit/contracts/publicTypography.test.ts
```

## Scope and rollback

This acceptance changes no production CSS, Vue component, theme token, route,
auth, notification stream, binary contract, or package configuration. Reverting
the focused guard, contract test, this document, and its index entry rolls back
the acceptance evidence only; the repository-wide #1279 font contract remains
active without a service restart.
