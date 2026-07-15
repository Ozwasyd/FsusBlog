# Issue #1108 Service Worker cache verification

The focused policy test executes the checked-in Service Worker inside a Node VM. It exercises the real fetch listener and cache-policy helpers instead of relying only on source-string checks.

```bash
cd src/frontend
node ../../tests/frontend/checks/public/check-pwa-offline-policy.mjs
npx vitest run --config vitest.config.ts ../../tests/frontend/unit/services/serviceWorkerRuntime.test.ts ../../tests/frontend/unit/services/authBroadcastRuntime.test.ts ../../tests/frontend/unit/store/user.test.ts ../../tests/frontend/unit/store/admin.test.ts
```

The policy check proves:

- auth/account/admin/private/login routes and notification/binary API routes use network-only `cache: 'no-store'` and perform zero Cache Storage writes;
- a private-looking URL cannot become cacheable merely by ending in `.png`, `.js`, or another static extension;
- `private`, `no-store`, mutable, credential-varying, and non-public responses are rejected by the cache-write boundary;
- explicit public immutable assets remain cacheable;
- public shell invalidation and search-index single-flight/version pruning remain intact.

The runtime unit test proves that a shared-device cleanup reaches both active and waiting workers, removes all shell/search namespaces, purges sensitive entries from legacy static caches, and preserves explicit public immutable assets. Auth broadcast/store tests cover the caller wiring for local logout and another tab receiving logout or expiry.

## Identity and protocol scenarios

| Scenario | Expected result |
| --- | --- |
| Anonymous public shell | May be retained only when the route is allowlisted and the response is explicitly public; offline response is marked stale/no-store. |
| Logged-in account request | `/api/**` and `/user/**` are network-only; logout removes offline shell/search history on every tab. |
| Admin request | `/admin/**`, `/manage/**`, `/author/**`, and admin API traffic are network-only; admin logout uses the same cleanup. |
| Notification stream/preflight | Notification API traffic is network-only and never enters shell/static/search caches. |
| Binary AEDS | `/api/binary/**` keeps the original request credentials, bypasses HTTP/Service Worker caches, and returns only the existing network-unavailable fallback when offline. |

The focused tests do not claim full production, browser, rollout, or N/N-1 compatibility validation. The existing production preview `check:pwa-offline-smoke` and release asset compatibility Playwright lane remain the broader acceptance gates.
