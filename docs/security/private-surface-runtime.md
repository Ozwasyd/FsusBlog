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

`bindCheckpointSource(reader)` creates a bounded binding inside the original
journal owner. Its reader must independently read the actual mounted Writer/native
owner and return the original write input plus `owner`, `mountedEditor`,
`siteScope`, `draftKey`, `registryRevision`, `associationRevision`,
`editorSessionRef`, `documentId`, `draftId`, `documentEpoch`, `editorRevision`,
`sourceRevision` and `draftRevision`. The two object references fence replacement;
the caller must check the real mount/registry association and the correspondence
between the original Writer body/client revision and native document revision.
Returning null means that ownership is unavailable or released. These are required
caller facts, not identities issued by the journal or server DocumentId authority.
The inspected Writer audit is at `7b203a3f4fd8346f05b7aeb176eb653bdb4b2fc9` in
`artifacts/article-editor/chain-2246-upload-source-boundaries/draft-flush-consumer-source-audit.md`.

A binding exposes `prepare(signal?)`, `inspect(token)`, `validate(token)`,
`restore(token)`, `invalidate()` and `release()`. Prepare executes the original
persistence implementation, waits for transaction completion and rereads its
original integrity-checked record before issuing a frozen, opaque object token.
It then rereads actual ownership and all coordinates; mismatch, busy, cancellation,
failed persistence or released ownership issues no token. Cancellation can leave
an already committed original recovery row; refusal does not claim rollback.
Custody uses language-private fields, retains only scalar record metadata and the
actual owner references, and admits at most 32 bindings and one preparation in
flight, with no queued body. Each binding holds at most one current token.

Inspect/validate synchronously check exact object custody, original owner facts
and TTL. They attest the earlier completed persistence and current owner-local
admission; they do not synchronously query IndexedDB or certify absence of an
unobserved external write. Restore asynchronously reopens the original list and
integrity/cleanup path, compares every persisted scalar field, and revalidates
custody before returning a frozen record. It never applies body, form, history or
selection to an editor. Existing explicit recovery/divergence decisions remain
with the Writer. Tokens are process-local and cannot be reconstructed from record
IDs, JSON, digests or a new journal instance; crash recovery still uses the original
principal-scoped journal list.

Original write/confirm/discard/article-scope clear revoke custody before work and
at asynchronous completion, including failed or uncertain mutation. Expiry,
invalid-record cleanup, observed record replacement/removal, database versionchange
or forced close, and the original coordination receiver also revoke custody.
The original private-storage cleanup entry invalidates the singleton journal
synchronously before asynchronous storage cleanup, even if database deletion is
unavailable or fails. A caller must invalidate on original staging, external
coordination or an ownership/context change, and release on original owner release.
Other-tab changes remain asynchronously observed by the original coordination/list
mechanisms; synchronous cross-tab storage existence is not supplied by IndexedDB.

Blog #4210's `crashJournalRef` is currently a string in the frozen aggregate
snapshot contract. This primitive returns an opaque object capability, not a
fabricated string ref. The original session owner must define and review the real
custody join and any contract change; until then full aggregate capture/restore
remains blocked. Server-authorized DocumentId binding, complete draft/panel
checkpoints and disposed-session hydration are also independent prerequisites.
The original plaintext policy, 168-hour TTL, principal/article/recovery-tab storage
key, payload integrity/capacity checks and server-confirmation deletion semantics
are unchanged. No second journal, body cache, storage fallback, coordinator or
factory is introduced.
