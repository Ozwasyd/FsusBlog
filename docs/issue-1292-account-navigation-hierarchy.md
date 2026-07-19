# Issue #1292 account navigation hierarchy

## Contract

`AccountNavigationPanel.vue` keeps one semantic and visual hierarchy across the
desktop rail and mobile drawer:

| Level | Typography | Left padding | Minimum height |
| --- | --- | --- | --- |
| first-level module | 14px / 700 | 1rem | 44px |
| desktop local destination | 12px / 500 | 2rem | 40px |
| mobile local destination | 12px / 500 | 2rem | 44px |

The 14px and 12px roles preserve the repository's 12/14/16px integer small-text
contract from #1293. Both weights are actually loaded by the 400/500/700 font
contract; synthetic 680 must not return.

The local destination is indented one additional 16px step. Its desktop height
uses the issue's strict-touch alternative of 40px rather than the retired 36px
tier. The shared 44px base remains authoritative in the mobile drawer.

## Regression ownership

`check:visual-density-governance` pins both typography roles, the 2rem local
indent, the desktop 40px override, and the shared mobile 44px base. The existing
font-size and font-weight checkers retain their repository-wide integer-size and
loaded-weight bans.

`AccountNavigationPanel.test.ts` independently verifies these source contracts
alongside the rendered module/local navigation and route-state tests.

Focused acceptance commands:

```bash
npm run check:visual-density-governance
node ../../tests/frontend/checks/static/check-font-size-contract.mjs
node ../../tests/frontend/checks/static/check-font-weight-contract.mjs
npm run typecheck
FSUSBLOG_USE_LOCAL_FSUSUI=0 npx --no-install vitest run --config vitest.config.ts ../../tests/frontend/unit/components/account/AccountNavigationPanel.test.ts
```

## Scope and rollback

This is a scoped account-navigation CSS change. It does not alter route identity,
authorization, notification stream, binary contracts, or FsusUI. Reverting the
component hierarchy rules and their focused guard/test/documentation restores the
previous presentation without a service restart or data migration.
