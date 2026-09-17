# PrivateSurfaceRuntime Verification Checklist

Issue #1244 focused verification covers:

- Anonymous requests: public routes use no private generation and are not remounted by private cleanup.
- Authenticated requests: a `login` broadcast is an account switch; old-identity requests stop first, then the old private component tree is destroyed before returning to a safe public route.
- Admin requests: `admin-logout` clears only the admin session, preserves a valid account session, and navigates to the identity page.
- Notification stream: every account-invalidating path stops the stream and clears cursor/subscription state synchronously.
- Binary: AEDS frames, binary endpoints, Worker decoding protocol, and fallback semantics are unchanged; existing binary-contract gates remain applicable.

JSDOM cases mount private components containing old-account content, send `logout` and `expired` through a simulated `BroadcastChannel`, and assert that the request signal is aborted, Pinia identity is cleared, old DOM is unmounted, the random generation rotates without an account identifier, private DOM is not restored before cleanup completes, and safe replacement navigation ultimately fires.

Suggested focused commands:

```bash
npx vitest run --config vitest.config.ts \
  ../../tests/frontend/unit/services/authBroadcastRuntime.test.ts \
  ../../tests/frontend/unit/services/authSessionRuntime.test.ts \
  ../../tests/frontend/unit/store/user.test.ts \
  ../../tests/frontend/unit/store/admin.test.ts
npm run typecheck:published-fsusui
node ../../tools/frontend/check-auth-broadcast-boundaries.mjs
```
