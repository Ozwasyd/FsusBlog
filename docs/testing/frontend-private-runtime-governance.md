# Frontend private runtime governance

Private browser behavior is accepted locally. The gate does not depend on a
real account, public network, production deployment, cloud telemetry, external
scanner or third-party browser platform.

## Required local matrix

The Vitest suite covers the four independent Cookie states: no session,
account only, admin only and both sessions. Each state crosses guest, account
and manage routes with `createMemoryHistory`. Passkey login starts by
invalidating any in-memory Guest result before the ceremony.

Cross-tab `login`, `logout`, `expired`, `user-expired` and `admin-changed`
events contain only an event kind and timestamp. A remote account-generation
change discards the current account snapshot; a remote logout or expiry emits
the route-free session-expiry bridge. The bridge removes the mounted private
view, which runs component request abort and subscription cleanup before the
sanitized login redirect is committed.

The private Storage Registry is the machine-readable inventory for auth
markers, challenge proofs, drafts, upload sessions and identity-derived UI
preferences. Every exact key or prefix has a table-driven cleanup assertion.
Public theme, image preferences and Public AOT seed state are deliberately not
part of that registry.

Binary failure telemetry is categorical. Browser events may include failure
kind, numeric status/category, challenge outcome and frame type. They must not
include URL, query, server details, free-form message, token, trace ID or
business identifier. Private route query/history state follows an explicit
per-route allowlist and strips private fragments.

Run the focused gate from `src/frontend`:

```bash
npx vitest run --config vitest.config.ts \
  ../../tests/frontend/unit/router/index.test.ts \
  ../../tests/frontend/unit/bootstrap/sessionExpiryBridge.test.ts \
  ../../tests/frontend/unit/security/privateNavigationPolicy.test.ts \
  ../../tests/frontend/unit/services/privateStorageRegistry.test.ts \
  ../../tests/frontend/unit/services/authBroadcastRuntime.test.ts \
  ../../tests/frontend/unit/services/binaryTransport.test.ts \
  ../../tests/frontend/unit/services/serviceWorkerRuntime.test.ts
npm run check:private-runtime-governance
npm run check:pwa-offline-policy
```

## Risk and rollback

The policy fails closed by dropping undeclared private query fields and
clearing registered private browser state. If a legitimate private filter is
lost, add that field to `PRIVATE_NAVIGATION_ALLOWED_FIELDS` with a focused
history test; do not disable the sanitizer. Operators can degrade without a
server restart by sending the existing privacy-clear control message, signing
out the affected browser session or disabling Service Worker registration in
the existing client runtime switch. Public AOT remains available because its
shell routes and cache inventory are separate from private state.
