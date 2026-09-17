# Issue 1243 router Session matrix

This acceptance lane is intentionally local and deterministic. It uses Vue Router Memory History and fresh Pinia stores for each case; it does not require a real Cookie, account, administrator, network, or browser process.

## Covered matrix

`tests/frontend/unit/router/index.test.ts` is table-driven across `/user`, `/user/identity`, and `/user/manage` for:

- no Session;
- account Session only;
- administrator Session only;
- both Sessions;
- expired account Session;
- expired administrator Session;
- active administrator Session without the required permission.

The same suite asserts:

- all self route records declare `requiresAccountSession` and no administrator requirement;
- all manage route records declare `requiresAdminSession` and at least one `requiredAdminPermissions` entry;
- `/user` probes both Session domains before selecting a landing route;
- an administrator-only attempt to enter a self route is redirected before `beforeResolve`, the protected target never enters Memory History, and the account Pinia conclusion remains unauthenticated;
- login return targets keep only declared query fields and discard private fragments;
- 403 contains no source query or fragment;
- public routes do not probe either private Session.

## Focused commands

Run from `src/frontend`:

```bash
vitest run --config vitest.config.ts \
  ../../tests/frontend/unit/router/index.test.ts \
  ../../tests/frontend/unit/bootstrap/sessionExpiryBridge.test.ts \
  ../../tests/frontend/unit/security/privateNavigationPolicy.test.ts

vue-tsc --noEmit -p tsconfig.fsusui-published.json
```

Related regression coverage is split by boundary:

- anonymous and login behavior: the no-Session and account-only rows;
- administrator behavior: administrator-only, dual-Session, expired, and permission-insufficient rows;
- notification stream: the notification runtime unit lane verifies that route metadata changes do not alter stream envelopes or reconnection state;
- binary: auth adapter unit tests verify account/admin AEDS snapshots remain independent; this issue does not change frame types, POD layouts, or binary endpoints.

The static views constraint lane also checks that local fixture Cookie bootstrap covers account, administrator, and confirmed-identity root routes before Session probes.
