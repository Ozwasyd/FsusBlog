# Issue #1293 account integer typography

## Resolved baseline

The broad small-text migration in #1281 resolved the fractional values originally
reported by #1293 before this focused acceptance was added. The current repository
contract is stricter than the issue's proposed 12/13/14/16px mapping: account,
public, and admin small text uses 12/14/16px and does not reintroduce 13px.

`IdentityCenter.vue` therefore keeps this hierarchy:

| Role | Size |
| --- | --- |
| status labels and descriptions, summary terms | 12px |
| summary values, policy rows, state messages, secret values | 14px |
| status values | 16px |

`account-shell-base.css` keeps `.account-header-link` at 12px. Display headings may
continue to use their existing responsive `clamp(...)` rules; they are outside the
small-text ladder audited by this issue.

## Regression ownership

`check-font-size-contract.mjs` retains the repository-wide ban on 11px, 13px, and
fractional 0.6-0.9rem/em declarations. It also pins every IdentityCenter role listed
above and the account section eyebrow to its exact size so a selector cannot drift
while the global scan still passes.

`accountIntegerTypography.test.ts` independently verifies that both target files
contain no fractional small-text declarations, all explicit pixel sizes are
integers, and the role mapping remains 12/14/16px.

Focused acceptance commands:

```bash
node ../../tests/frontend/checks/static/check-font-size-contract.mjs
npm run typecheck
FSUSBLOG_USE_LOCAL_FSUSUI=0 npx --no-install vitest run --config vitest.config.ts ../../tests/frontend/unit/contracts/accountIntegerTypography.test.ts
```

## Scope and rollback

This acceptance does not change layout, routes, auth, notification stream, binary
contracts, or FsusUI. Reverting the focused guard, unit test, and this document is
sufficient to roll back the acceptance-only addition; the production typography
remains governed by the broader #1281 contract without a service restart.
