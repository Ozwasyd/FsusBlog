# Private-surface runtime cleanup boundary

`PrivateSurfaceRuntime` is the shared in-memory boundary for account and admin pages. On user/admin logout, session expiry, or cross-tab account switch, it executes this order; generation semantics are canonical in [Private request generations](private-request-generations.md):

1. Enter `clearing` synchronously and create a random `authGeneration`; it contains no account, admin, Cookie, or session identifier and is absent from BroadcastChannel messages.
2. Notify termination handlers synchronously, abort account/admin requests, and stop Notification Stream, challenge-proof runtime, page Workers, timers, and subscriptions.
3. Before the next render, `App.vue` removes the private route tree and mounts no stale replacement during cleanup.
4. The private-storage registry clears the relevant Pinia state, browser caches, and temporary credentials. Delete admin-scope `fsusblog-article-recovery-journal` IndexedDB on admin/account logout, account switch, session expiry, privacy cleanup, and shared-device cleanup; article publish/delete/explicit discard use narrower article-owner scope cleanup.
5. After cleanup, `router.replace` enters a safe route: account logout/switch goes home, expiry goes to login, and admin logout goes to the identity page or home.

## Risk and no-restart rollback

This changes only browser-memory lifetime, not Cookie, API, AEDS, or server authorization semantics. If a termination handler fails, the others still run through `Promise.allSettled`, and storage cleanup and safe navigation continue. Runtime rollback needs no service restart: restore the prior static frontend artifact; server-session revocation remains independent.

## Quick Capture journal adapter source boundary

`services/articleCaptureRecovery.ts` is an independent, unactivated consumer of the
sole original journal and borrowed `ArticleRecoveryCoordinator`. Its minimal
versioned envelope is stored only inside the original closed record's source
payload: actual capture/request/client identities, user/site-scoped identity hash,
original physical-tab identity and exact title/Markdown input/digests. No outer
journal field, database, TTL, encryption, queue or article-form owner is added.

The supported input is the actual #2380 schema-1 title/body request. The client
digest projection follows the original little-endian length-prefixed serializer
and Guid byte ordering; it is correlation, not a receipt or permission proof.
Source URL and template members are refused until the original request admits
them. Input bytes, BOM, line endings and whitespace are retained. Local operations
borrow actual Web Locks with `ifAvailable`; absence/contention cannot fall back to
another store or queue. Existing captures conflict rather than silently overwrite.
The first valid request pins immutable UUID/client-revision/input-digest/request-digest
coordinates before any asynchronous lock/storage operation or request-bearing
result, including an initially unprotected input. Every such result checks that
same private binding. A later different request refuses as capture-conflict before
local I/O; journal/lock failure can only reduce protection and never changes an
unknown request's identity. This scalar pin retains no title/body cache.
Repeated current input rereads the original journal without writing or extending
its original 168-hour expiry. After expiry it remains unprotected with the same
request identity, without inventing a new UUID or server absence.

The caller must supply genuine current session-owner, decimal admin-principal,
configured site scope, article-write admission, capture identity and the SAME
original coordinator. No browser hostname/default or credential becomes a site
grant. Observed scope/permission/owner change permanently retires the binding.
Explicit discard/retirement only cleans this instance's known original row after
original integrity read and exact metadata checks under its local lock. Cleanup
failures retain unknown status; no other valid record or borrowed coordinator is
deleted/disposed. These operations perform no server call and do not prove that a
server operation outside this adapter was cancelled or wrote nothing.

Recovery discovery is digest-only and always requires authoritative reconciliation;
it never exposes a ready recovered body, saved Inbox or open/document action.
The original `ReconcileInboxAsync` source is available at
`6b0fb53e7a42a48d27fe1005cbbee7d341ada5ef`; null is only no committed receipt
observed at that read, since an in-flight create may still commit. Typed transport
source at `ac727b42dea66811b906fe8b8ff408dea9401839` still lacks registered routes
and generated bindings in the inspected candidate. Its current request site/session
context is not historical receipt site/document authority. This adapter accepts no
fake success/receipt port and never calls journal confirmation cleanup. Actual
transport/context composition and historically bound, verified confirmation are
required before submit/retry/recovered-input admission/success cleanup can be wired.
No UI or runtime activation, independent acceptance or qualification is supplied.

Cross-tab broadcasts contain only `type` and `at`; never add account id, admin id, generation, permission, or token.

Article-recovery coordination uses an independent, versioned, body-free BroadcastChannel message containing only `type/articleKey/tabId/at`; body, identity, revision, and source hash never enter it. Without BroadcastChannel, low-frequency IndexedDB checks discover other-tab versions; full-text localStorage events are not a fallback. Cleanup failure never restores a revoked server session; the next private-page start revalidates the server session and journal schema, TTL, capacity, and identity scope.

Journal v2 raw IndexedDB values store only a versioned `utf8-v1` typed plaintext payload, never a full `content` string. Logical body and each stored payload are capped at 1 MiB; total stored bytes are capped at 4 MiB; TTL is 168 hours from the last unconfirmed mutation. Scheduling keeps at most one in-flight and one newest pending snapshot, so input cannot create an unbounded encode/IDB queue. The payload is unencrypted: same-origin scripts and local profile access can read it. SHA-256 digests isolate identity/source and are not a confidentiality claim. If IndexedDB is unavailable, journal fails soft without a localStorage/sessionStorage fallback and server autosave continues.
