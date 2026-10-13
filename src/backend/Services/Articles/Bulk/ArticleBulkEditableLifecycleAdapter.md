# Editable lifecycle adapter source integration

This is a WIP module note. The C# source, canonical transition policy, and original
owner authorities remain the contracts. It is not production admission, a runtime
receipt, or an independent acceptance record.

`ArticleBulkEditableLifecycleAdapter` consumes the opaque
`ArticleLifecycleTransitionWriter.ResolveBulkRevisionReferenceAfterLockAsync`,
`PrepareEditableTransitionFromBulkRevisionAsync`, and `CommitEditableTransitionAsync`
APIs at candidate source `d3803f2f63dab20d0dd31bc7c7809d191320cb79`, itself based on
Inbox `c1900f2d64b7dcb4d71f9aa78fa93770161a6cf7`. The revision producer remains under
independent source review; its presence does not mean acceptance or runtime
qualification. This isolated consumer does not advance the original #4248
`2b6e0276536c1700b12c3db4e8264f74977ef564` review candidate. It plugs into the existing
`IArticleBulkAtomicCommandAuthority`; it does not add an executor, selection query,
writer, permission provider, journal, result store, or DI registration.

The supported input is a verified, executable, explicit-ID frozen plan with one
lifecycle operation, positive canonical article IDs and original opaque revision
references. It supports
Draft-to-Inbox, Inbox-to-Draft, Inbox-to-Archived using `lifecycle.archive`, and
Archived restore to the canonical writer's recorded editable source. Other
archive sources, schedule, CurrentPage, Query, and SavedView are rejected before
reservation. The existing registry and operation names remain unchanged. The
actual atomic item limit comes from the original group authority and is capped
at 10000; no business chunking or fallback is present.

The original integration owner must implement
`IArticleBulkEditableLifecycleGroupAuthority` and its reservation. No default
implementation exists. Reserve must admit the whole exact execution/plan/set,
actor/site/session/policy, document and draft lifecycle revisions, rights and
preconditions, deterministic locks, idempotency, and required side effects. The
canonical single-article preparation explicitly does not grant these facts.
Neither a syntactically valid digest nor a related read projection substitutes
for that original admission.

The adapter binds the database instance, original native Npgsql transaction object,
configuration, and authoritative UTC transition time. It prepares every item
before any commit call, retains the original opaque objects, checks their exact
source/operation coordinates, and asks the original reservation to seal actual
whole-set preparation. It calls the original reference-shape check, resolves each
unchanged frozen reference against real locked article/revision/provenance rows,
and consumes the producer-owned resolution once through the original preparation
API. Actual revision IDs come only from that original resolution. No expected-revision
integer parsing, token encoding, issuer, projection-reference conversion or substitute
mapping is present. The preflight producer must use the original
`CaptureBulkRevisionReferenceAsync`; the adapter never captures/replaces a frozen
reference. A reference and a successful single-article check are not permission
or whole-set grants. A fresh reservation-owned admission check precedes all
mutations. Member commands execute in that same held transaction; none commits
it. `CompleteCommitAsync` alone completes the original draft/document and
transactional obligation protocol, persists the single group/item conclusion,
and commits once. It receives actual canonical results, including before/after
coordinates, revision, outbox, and audit references.

Failure before finalization calls only the original reservation's Abort, which
must independently prove release and zero visible business writes. An uncertain
release has no zero-write proof. Finalization exceptions never cause an inferred
Abort; the existing executor and `ReadGroupRecoveryAsync` own unknown recovery.
Request cancellation cannot interrupt member writes after commit begins. The
adapter serializes terminal calls and rejects reusing a concluded handle.
Dispose releases original resources and supplies no outcome evidence.

The original owner also retains production preflight/execution providers,
reconciliation storage, DI, and `ArticleBulkCanonicalCommandOwners`. Availability
and rollout remain unchanged until genuine original admission, atomic required
obligations, durable group/zero-write proofs and independent qualification exist.
The all-or-nothing registry's five lifecycle side-effect owners must be represented
by real original receipts; this adapter manufactures none of them.

Runtime, compilation/product imports, tests/list/discovery, security/privacy,
receipt/frozen-authority and native qualification are held. Source-only checks
do not satisfy issues [2397](https://github.com/Ozwasyd/FsusBlog/issues/2397) or
[2387](https://github.com/Ozwasyd/FsusBlog/issues/2387) closure. The remaining
archive/schedule capabilities and query/SavedView source branches retain their
original owners and holds. Rollback is to keep this module unregistered.
