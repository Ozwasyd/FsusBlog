# Issue #1291 account page title hierarchy

## Contract

Account top-level pages use one fixed task-surface H1 role at every viewport:

| Surface | Selector | Typography |
| --- | --- | --- |
| comments and messages | `.account-page-title` | 24px / 700 / 1.2 |
| identity and security | `.identity-section-header__copy h1` | 24px / 700 / 1.2 |

The shared account title no longer scales from 24px to 36px on wide screens or
from roughly 22px to 32px on mobile. The mobile media query only removes the title
width cap; it does not own typography.

This 24px display role is intentionally separate from #1293's 12/14/16px
small-text ladder. It also leaves #1292's first-level and local navigation roles
unchanged.

## Regression ownership

`check:visual-density-governance` pins both H1 selectors to 1.5rem/700/1.2,
rejects a viewport clamp, and prevents the mobile rule from acquiring a second
font-size declaration.

`accountPageTitleHierarchy.test.ts` independently verifies the shared desktop and
mobile rule ownership plus the IdentityCenter H1 match.

Focused acceptance commands:

```bash
npm run check:visual-density-governance
node ../../tests/frontend/checks/static/check-font-size-contract.mjs
node ../../tests/frontend/checks/static/check-font-weight-contract.mjs
npm run typecheck
FSUSBLOG_USE_LOCAL_FSUSUI=0 npx --no-install vitest run --config vitest.config.ts ../../tests/frontend/unit/contracts/accountPageTitleHierarchy.test.ts
```

## Scope and rollback

This is a CSS-only account heading change. It does not alter account navigation,
routes, authorization, notification stream, binary contracts, or FsusUI. Revert
the two title declarations and their focused guard/test/documentation to restore
the former responsive sizing; no service restart or data migration is required.
