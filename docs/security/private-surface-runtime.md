# Private-surface runtime cleanup boundary

`PrivateSurfaceRuntime` is the shared in-memory boundary for account and admin pages. On user/admin logout, session expiry, or cross-tab account switch, it executes this order; generation semantics are canonical in [Private request generations](private-request-generations.md):

1. Retire original private authority before owner-controlled writes/callbacks. Enter `clearing` synchronously and create a random `authGeneration`; it contains no account, admin, Cookie, or session identifier and is absent from BroadcastChannel messages.
2. Notify termination handlers synchronously, abort account/admin requests, and stop Notification Stream, challenge-proof runtime, page Workers, timers, and subscriptions.
3. Before the next render, `App.vue` removes the private route tree and mounts no stale replacement during cleanup.
4. The private-storage registry clears the relevant Pinia state, browser caches, and temporary credentials. Delete admin-scope `fsusblog-article-recovery-journal` IndexedDB on admin/account logout, account switch, session expiry, privacy cleanup, and shared-device cleanup; article publish/delete/explicit discard use narrower article-owner scope cleanup.
5. After cleanup, `router.replace` enters a safe route: account logout/switch goes home, expiry goes to login, and admin logout goes to the identity page or home.

## Original producer custody

The original `PrivateSurfaceRuntime` issues process-local, frozen identity tokens through `sealAuthority()`, checks them with `hasAuthorityCustody(seal)`, and releases individual reservations with `cancelAuthority(seal)`. The lookup reads only private epoch/token state. Each transition publishes one private reservation before Promise construction or reactive notification; its completion belongs to that same reservation. A superseded operation rechecks ownership after observers, generation allocation, request advancement, and callbacks, and cannot replace or restore a newer operation's clearing/epoch. While clearing, admission refuses; a later completed transition uses a fresh epoch, so an old token cannot revive. Reset also retires the epoch before changing any projection. `authGeneration` and `isClearing` expose computed read-only projections, keeping their writable refs inside the original owner.

State ownership does not certify cleanup completion. Supersession before the requested cleanup is confirmed rejects with `PrivateSurfaceCleanupIncompleteError`; already-started outcomes are observed without claiming success. A synchronous cleanup throw after reentering a newer reservation propagates that exact cause directly; it is not replaced by an incomplete-completion error. After awaiting actual cleanup outcomes, a lost reservation still propagates its cleanup rejection. Only confirmed fulfilled cleanup can return successfully without owning later navigation or state restoration. The admin logout caller therefore records incomplete/rejected cleanup as `localCleanupComplete = false`, while the newer transition alone controls clearing and the current epoch.

The original admin store exposes `sealAdminPrincipalAuthority(expectedIdentityId)`, `hasAdminPrincipalAuthorityCustody(seal)`, and `cancelAdminPrincipalAuthority(seal)` as stable function-valued getters, avoiding Pinia action wrapping and its allocation/subscriber callbacks on the final lookup. Admission requires its committed independent, active, non-step-up principal with nonempty permissions and an unretired original surface reservation. Consumers check their exact required permission against this store before admission; custody itself grants no permission and does not attest Writer, Document, Root, or Renderer lifetime. Tokens belong to the same store instance and private custody epoch; copies, serialization, cancellation, replacement, and A-B-A transitions never retain custody. Cancellation releases one token without clearing the principal or other reservations.

Public auth mutation entries use the real Pinia setup `action` helper behind an owner proxy. Before entering Pinia's action wrapper, the proxy retires the old custody epoch and marks the invocation pending; `$onAction` therefore cannot observe or reseal the old custody. After notification, the tracked body checks that the same invocation still owns admission. A superseded synchronous void action performs no older write; a superseded asynchronous entry rejects with `AdminPrincipalMutationSupersededError`. Existing action names, argument lists and callbacks remain tracked through the original Pinia wrapper, without copying private library markers. A cache hit retains the genuine committed principal and original checked-at/TTL, but the previous token's epoch cannot revive when the invocation ends.

`invalidateMissingCache()` retires authority even for an active principal while preserving its existing missing-only state-cache update. Event producers can call the stable, unwrapped `invalidateAdminPrincipalAuthority()` before advancing requests or notifying other observers; it retires the principal reservation without manufacturing a new session conclusion. The original `authBroadcastComposition` installs this same store function into the original transport through `registerAdminPrincipalInvalidation()`, before its general subscriber. Local `broadcastAdminChanged()` invokes it before the event clock and construction. For accepted local/validated remote admin-changed delivery, `dispatch()` remembers the existing type/time key and retires before the first general subscriber, including the composition callback that advances requests and clears challenge proofs. Repeated remote keys still return before retirement or callbacks; local transition intent retires before reading the clock even when its eventual key is a duplicate. Payload identity/fields, deduplication and storage/channel transport remain unchanged. Registration/disposal retire the old owner without letting an older registration disposer clear a newer binding. The runtime receives only a callback, imports no Store, and owns no parallel principal state. Accepted admin-changed delivery binds each original subscriber registration to its owner and a distinct registration record; live iteration retires the registered/current owner again before each actual call and refuses an owner change during that retirement. Old unregister functions cannot delete a replacement registration for the same callback. Composition install/dispose owns one original record containing only its real Pinia/store references, publishers and unregister handles. Every teardown call is followed by an identity check before further writes; a superseded disposer cannot clear the newer record. Optional ownership/expected-callback conditions in the actual admin/user logout-publisher and notification handler setters recheck after Pinia action hooks, protecting same-Pinia A-B-A reentry while preserving the original one-argument setters.

Principal replacement/clear, missing-cache invalidation, request cancellation/revalidation, logout, and store disposal retire custody before owner-controlled reactive writes, aborts, or callbacks. Snapshot fields and the copied permission array are frozen. Principal, session state, and checked-at retain Pinia ref/state entries through custom refs whose getters read private backing refs and whose setters route writes through the original owner. Principal replacement uses `setAdminPrincipal`; direct scalar state/checked-at writes retire custody before updating their backing values and cannot issue new authority. This preserves top-level assignment and state inspection without exposing a raw writable backing ref. Nested snapshot/permission mutation is refused; use principal replacement instead. A reentrant setter prevents an older mutation from finishing its remaining writes or issuing authority. Final admin lookup joins only its private committed record and the captured original surface predicate, with no reactive reads, allocation, clock reads, or consumer callbacks.

The existing `ADMIN_ACTIVE_TTL_MS` is a refresh-cache bound, not a server expiry timestamp. Admission checks this freshness bound; an owner timer retires issued custody when its callback runs without changing the existing session conclusion. Explicit expired snapshots and `session-expired` transitions revoke synchronously. The admin snapshot supplies no absolute server expiry, and delayed browser timers cannot establish exact wall-clock expiry during a blocked task. This custody API therefore attests producer-observed state and retirement, not unobserved server revocation or exact wall-clock expiry. Runtime expiry and reentrancy qualification remain separate requirements.

Queued cleanup callbacks retain their original obligation. Every composition-owned registry/termination cleanup requires the same active owner before and after each synchronous step; an inactive queued handler throws `AuthBroadcastCleanupIncompleteError` before touching state, so the original registry records `failed` rather than a fulfilled noop as `cleared/affected`. Notification cleanup returns its real stop promise and checks ownership after success; original failure reasons propagate unchanged. Owner-bound private-browser/user-expiry cleanup checks before deferred execution and after actual completion. Successful logout/expiry continuations recheck the same owner before dispatching any later event; retired continuation suppression is not a cleanup-success receipt.

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

The frozen aggregate `crashJournalRef` remains a string. The original journal now
issues `info.checkpointRef` only with completed private token custody, using native
cryptographic UUID issuance plus a monotonic owner sequence. It is a stable locator
into that same binding's existing custody slot, not a body/record digest or caller-
generated identity. No separate reference map or durable token ledger is added.
The locator inherits the token's exact invalidation/release/expiry lifetime and is
never reused in that owner. It does not independently authenticate persistence.
`inspectReference(ref)`, `validateReference(ref, nativeSource)` and
`restoreReference(ref)` resolve the actual private token only in the issuing
original binding and use its original validation/restore path.

`bindCheckpointSource` returns the additive
`ArticleRecoveryJournalCheckpointReferenceBinding`. The original six-method
`ArticleRecoveryJournalCheckpointBinding` remains source-compatible. Inspect also
synchronously checks the independently read Writer body against the completed
original record's SHA-256 source hash; canonical UTF-8 round-trip and size checks
prevent a lossy string from passing as equal source bytes. `validateContent(token,
nativeSource)` and `validateReference(ref, nativeSource)` additionally check the
actual original native digest callback's source with the same bounded source-hash
domain. They still require live same-owner, epoch, native/client/base/server and
all other revision facts, plus previously completed persistence. They cannot
synchronously query storage or certify unseen other-tab writes.

The exact Blog session contract inspected is
`f92031afab06dbf73e7de085418545504c2e5f89`, with real public UI source
`c3fa0d377702f41d3a9131ae04012ad52cf5f34e`. Its native `captureSnapshot` supplies the
actual transaction-store body to `digestSource` and rechecks document/revision/body
afterward. The original session caller must validate the issued locator and that
body before returning its **original** `calculateOpenArticleDocumentDigest(body)`;
the journal's namespaced `sourceHash` is not the native canonical JSON digest.
No caller may infer readiness from a syntactically valid locator alone.

The actual Writer reader and six-method wrapper were inspected at
`dc98ae399932efa5445b6d4b4781e6ca17b37cd7` (caller implementation
`54ef3efee2ec7f2fff8e6dbcdfa6385a79e933ab`). Its mounted source verifies public native
revision against the original document source revision. That reader directly
supplies the required original scope fields and its six-method wrapper remains
compatible. At that inspected checkpoint, the wrapper lacked the four additive
reference methods. The subsequent Main source at
`bbed9ae73cc790abf7ff32b28abbd271add08ec3` consumes the reference methods and the
original pure custody check for retained recovery. Writer and session still own
the actual new prepared-publication forwarding/refset join; this journal increment
does not wire it. Full aggregate capture/restore stays blocked. Server-authorized
DocumentId binding, complete draft/panel checkpoints and disposed-session hydration
remain independent prerequisites.
The original plaintext policy, 168-hour TTL, principal/article/recovery-tab storage
key, payload integrity/capacity checks and server-confirmation deletion semantics
are unchanged. No second journal, body cache, storage fallback, coordinator or
factory is introduced.


Asynchronous observation invalidation is fenced to the custody captured when the
original read began. An old A restore/list result cannot revoke a newer B token.
Invalid-record cleanup rereads within its original readwrite transaction; a valid
replacement is preserved, while actual invalid-row deletion revokes the custody
of the row being deleted. Retired database callbacks cannot revoke a current
connection's custody. Original authoritative mutation invalidation remains intact.

Actual invalid-row deletion also revokes any preparation still awaiting its earlier
completed read. A deleted original row cannot become a newly issued token when an
old read later settles. This is authoritative mutation invalidation; an old list
that preserves a valid replacement performs no deletion and cannot revoke it.

Captured invalid custody is revoked before asynchronous cleanup, so cleanup failure
cannot keep that observed invalid token admitted. The original helper settles its
request and transaction failures and retains the primary failure; the read remains
unavailable. Replacement custody remains protected by the captured-object fence.

The same journal binding additionally returns
`ArticleRecoveryJournalCheckpointPublicationBinding`. `preparePublication(signal?)`
reserves at most one candidate alongside its current custody, completes the original
producer's transaction and rereads the original payload with the original integrity
hydrator. A protected row is reused only when its persisted metadata and the actual
input match exactly. Reuse does not rewrite the row or renew its original TTL. A
changed protected row, capacity failure, or records requiring original cleanup
refuse preparation without mutating that storage or replacing current custody.
Unprotected new writes stay in the original namespace and original capacity policy.
Original write/list still perform their original cleanup; callers must complete
that genuine cleanup before retrying a refused preparation. There is no rollback
claim for an unprotected write which already committed before cancellation.

The frozen prepared capability exposes its actual candidate `checkpoint` and
`info`; neither is live admission. `validatePrepared(preparation, nativeSource)`
rereads actual Writer facts, verifies the actual native body and expiry, and returns
the exact original candidate info. It reserves before external source/clock reads
and rejects validation/publication reentry. Failure drops only that candidate.
`hasPreparedCustody(preparation, info)` checks only exact validated private slot
continuity. `publishPrepared(preparation, info)` uses language-private checks and
preallocated custody to replace the live slot, without a reader, clock, hash,
signal, storage, listener cleanup, allocation or other owner callback.
`cancelPrepared(preparation)` drops only the exact candidate. The preparation's
AbortSignal covers its asynchronous operation; after it returns, use the explicit
cancel endpoint. A later original authoritative mutation/release/coordination
still revokes affected custody and preparations. Stale original read observations
are fenced to the exact captured candidate as well as the exact captured live
custody; actual deletion also cancels an affected prepared candidate.

Main must finish all genuine participant preparation and fresh source/admission
checks before the final callback-free private continuity/publication sequence, in
one synchronous operation with no await or external callback between those steps.
Pure checks do not establish fresh source/expiry/storage admission. The original
`hasReferenceCustody(reference, info)` implementation consumed by Main at
`bbed9ae73cc790abf7ff32b28abbd271add08ec3` is retained verbatim in this owner; exact
proof identity is required. The legacy six-method `prepare()` keeps its existing
destructive mutation semantics and is not this two-phase protocol. Writer owns
forwarding the extended methods on its SAME original binding; Main owns joining
its actual native, draft and renderer producers. Neither owner, store nor authority
is copied here. A differing body/revision at the same protected journal key cannot
be published through this protocol while claiming its prior row is preserved;
that storage limitation is refused, not disguised as a second durable checkpoint.
Complete host refsets, disposal/readiness and runtime qualification remain blocked.
