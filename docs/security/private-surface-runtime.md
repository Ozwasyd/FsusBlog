# Private-surface runtime cleanup boundary

`PrivateSurfaceRuntime` is the shared in-memory boundary for account and admin pages. On user/admin logout, session expiry, or cross-tab account switch, it executes this order; generation semantics are canonical in [Private request generations](private-request-generations.md):

1. Enter `clearing` synchronously and create a random `authGeneration`; it contains no account, admin, Cookie, or session identifier and is absent from BroadcastChannel messages.
2. Notify termination handlers synchronously, abort account/admin requests, and stop Notification Stream, challenge-proof runtime, page Workers, timers, and subscriptions.
3. Before the next render, `App.vue` removes the private route tree and mounts no stale replacement during cleanup.
4. The private-storage registry clears the relevant Pinia state, browser caches, and temporary credentials. Delete admin-scope `fsusblog-article-recovery-journal` IndexedDB on admin/account logout, account switch, session expiry, privacy cleanup, and shared-device cleanup; article publish/delete/explicit discard use narrower article-owner scope cleanup.
5. After cleanup, `router.replace` enters a safe route: account logout/switch goes home, expiry goes to login, and admin logout goes to the identity page or home.

## Risk and no-restart rollback

This changes only browser-memory lifetime, not Cookie, API, AEDS, or server authorization semantics. If a termination handler fails, the others still run through `Promise.allSettled`, and storage cleanup and safe navigation continue. Runtime rollback needs no service restart: restore the prior static frontend artifact; server-session revocation remains independent.

Cross-tab broadcasts contain only `type` and `at`; never add account id, admin id, generation, permission, or token.

Article-recovery coordination uses an independent, versioned, body-free BroadcastChannel message containing only `type/articleKey/tabId/at`; body, identity, revision, and source hash never enter it. Without BroadcastChannel, low-frequency IndexedDB checks discover other-tab versions; full-text localStorage events are not a fallback. Cleanup failure never restores a revoked server session; the next private-page start revalidates the server session and journal schema, TTL, capacity, and identity scope.

Journal v2 raw IndexedDB values store only a versioned `utf8-v1` typed plaintext payload, never a full `content` string. Logical body and each stored payload are capped at 1 MiB; total stored bytes are capped at 4 MiB; TTL is 168 hours from the last unconfirmed mutation. Scheduling keeps at most one in-flight and one newest pending snapshot, so input cannot create an unbounded encode/IDB queue. The payload is unencrypted: same-origin scripts and local profile access can read it. SHA-256 digests isolate identity/source and are not a confidentiality claim. If IndexedDB is unavailable, journal fails soft without a localStorage/sessionStorage fallback and server autosave continues.

## Journal checkpoint integration boundary

The original journal persistence owner is `ArticleRecoveryJournal`, introduced by
`98b480fe9681e42720b94067409453e5574ae8e5`. The later plaintext/168-hour alignment
in #3413 did not introduce session checkpoint custody. A flush Promise, queued
client revision, mutable record ID or source digest cannot independently establish
a completed durable checkpoint. Session integration must receive the actual
principal, article/recovery-tab scope, editor session, document identity, epoch and
revision from their original owners and revalidate them across asynchronous work.

The bounded checkpoint extension is source WIP for #2295/#1813. Its consumer
contract is Blog #4210 at `114661988af3ab6022a5adf9a0e7b18d6c630388`; Writer and
factory wiring remain separate original-owner work. Source/compiler checks do not
qualify persistence, recovery, races, privacy or native session behavior. Runtime
qualification remains held until the coordinating parent reviews the original
preflight; no frozen authority or seal is refreshed for this source handoff.
