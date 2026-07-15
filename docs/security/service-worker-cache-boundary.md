# Service Worker private-cache boundary

Issue #1108 makes Cache Storage an explicitly public-only browser surface. The Service Worker must never infer cacheability from a file extension alone, and it must not use Cache Storage as a fallback for authenticated, administrative, personalized, notification, binary, or otherwise private traffic.

## Request classification

The fetch handler evaluates same-origin GET requests in this order:

1. `/api/**`, `/user/**`, `/admin/**`, `/login`, `/account/**`, `/manage/**`, `/author/**`, `/private/**`, notification paths, requests with authentication/proof headers, and requests whose browser cache mode is `no-store` are network-only. The original request and credentials are retained, while `fetch(..., { cache: 'no-store' })` prevents an HTTP-cache fallback.
2. Search alias, manifest-selected shards, and patches are limited to the release-derived public search namespace.
3. Offline HTML is limited to the existing public shell route allowlist.
4. Static Cache Storage writes require both an explicit public path allowlist and a `public,...,immutable` response. A static-looking path outside that allowlist remains ordinary network traffic.

All cache-write helpers reject failed/opaque responses, `Cache-Control: private`, `Cache-Control: no-store`, missing `public`, `Vary: *`, `Vary: Cookie`, `Vary: Authorization`, and visible `Set-Cookie`. Public shell HTML may omit `immutable`, but it must still be explicitly public and must not carry any private/no-store directive. Search manifest responses are fetched with `no-store` and kept only in Service Worker memory; they are not copied into Cache Storage.

## Logout, expiry, and shared devices

`clearPrivateBrowserState(reason)` sends a data-free `privacy.clear` control message to the controller plus active, waiting, and installing workers. This covers a new worker taking control while another tab is logging out. Every receiving worker broadcasts `private-state-cleared` to all controlled and uncontrolled windows.

The cleanup deletes every FsusBlog shell/search cache namespace across retained builds because those entries reveal offline reading/search history on a shared device. Immutable public static assets remain available. As defense in depth, sensitive-path entries are also removed from any legacy `fsus-*` cache that predates the strict allowlist. Account logout, admin logout, and cross-tab logout/session-expiry events all invoke the same idempotent cleanup.

No account id, admin id, token, session id, route history, or cache key is placed in the control or broadcast message.

## Risk and rollback

The safe failure mode is reduced offline availability: a public response missing the required cache directives is served from the network but not persisted. This is preferable to retaining an accidentally personalized response.

Rollback does not require loosening the private boundary. Operators can restore the previous immutable frontend release while keeping the cache namespace bump; activation removes legacy namespaces, and `privacy.clear` can be sent by any current client to clear shell/search history without restarting the backend. Do not roll back by restoring extension-only caching or by caching responses marked private/no-store.
