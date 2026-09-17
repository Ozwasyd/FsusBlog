# Issue #1248 private storage registry

## Boundary

`src/frontend/src/services/privateStorageRegistry.ts` is the machine-readable
owner for browser persistence and page-memory cleanup. Every entry declares a
stable ID, storage medium, data scope, data class, cleanup triggers, and a
literal or prefix matcher. The supported data scopes are:

| Scope | Meaning | Ordinary account logout | Independent admin logout |
| --- | --- | --- | --- |
| `public` | Theme and non-identity upload preferences | retain | retain |
| `account` | Account drafts, upload resumptions, account caches | clear | retain |
| `admin` | Author/admin drafts and admin fixture state | retain | clear |
| `session` | Notification proof, request cache, offline private history | clear | registry rule |
| `temporary` | Cross-tab signals, bootstrap retry, challenge proof | clear | clear |

Strong-anonymous comment draft content remains owned by #1199. This registry
declares the generic comment draft prefix and lifecycle boundary, but does not
weaken or replace #1199 encryption and recovery requirements.

## Triggers and results

The primary reasons are `logout`, `admin-logout`, `account-switch`, and
`session-expired`. Emergency/privacy reasons continue to use the same cleanup
entry point. Public entries have an empty `clearOn` list and therefore always
return `retained`.

Each cleanup is idempotent and returns one result for every registry entry:
`retained`, `not-present`, `removed`, `cleared`, `inactive`, or `failed`, plus
an affected-item count. Errors expose only the stable registry ID, never the
stored value, key payload, request URL, or exception message. Independent
entries use settled results so one failure does not skip later cleanup.

Web Storage and CacheStorage use injected adapters in tests. Pinia, private
cursors, request state, and challenge proof memory register handlers by stable
registry ID. Disposing the auth composition unregisters its handlers, so a
replaced Pinia root cannot be mutated by stale cleanup callbacks.

## Adding persistence

Before adding a new `localStorage` or `sessionStorage` key:

1. add exactly one registry entry with the correct data scope and triggers;
2. use a stable exact key or the narrowest possible prefix;
3. add reason-specific cleanup coverage;
4. run the static ownership gate.

For CacheStorage or runtime memory, add the registry entry before installing
the producer/handler. Do not call `Storage.clear()` or delete unrelated cache
families as a shortcut.

## Focused verification

```bash
cd src/frontend
vitest run --config vitest.config.ts \
  ../../tests/frontend/unit/services/privateStorageRegistry.test.ts \
  ../../tests/frontend/unit/services/serviceWorkerRuntime.test.ts \
  ../../tests/frontend/unit/services/authBroadcastRuntime.test.ts \
  ../../tests/frontend/unit/store/admin.test.ts

cd ../..
node tests/frontend/checks/static/check-storage-registry.mjs
node --test tests/tools/storage-registry.test.mjs
```

The tests use JSDOM Storage/CacheStorage substitutes and a real Pinia fixture.
They require no Service Worker process, public network, cloud storage,
production browser, or external privacy platform.
