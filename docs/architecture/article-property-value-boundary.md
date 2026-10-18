# Article property value authority boundary

The existing `ArticlePropertyDefinitionContract` remains the sole eight-type catalog and definition-policy owner. Shared `ArticlePropertyTypedValue` payloads, presence, normalized entries and snapshot candidates do not introduce a second catalog or a persistence authority.

`ArticlePropertyValueValidator.ValidateAsync` reads the current canonical definition store and requires its existing permission authority. It validates expected definition ID/schema revision/digest, active status, presence/default/empty policies, the exact typed payload, active option IDs, UTC dates and URL constraints. Nonempty article references require the supplied `IArticlePropertyReferenceValueAuthority` to establish current identity, site, read permission, lifecycle and self/cycle policy. The current unavailable implementation refuses these references; it never treats missing authority as an empty impact or a successful resolution.

`ValidateInputsAsync` supplies the same read-only validation before a new article has a canonical identity. It supports primitive values and empty reference sets. Nonempty references, including defaults, fail with `article_property_reference_source_identity_unavailable` before invoking a reference provider. A package planner must not allocate a database identity or invent a source article ID to pass this check.

Normalized entries retain `Missing`, `Null`, zero, false, empty values and definition-owned normalization. `DefaultApplied` records normalization provenance separately from the value type and participates in the value/snapshot digest. Defaults and explicit identical values therefore remain distinguishable. Inputs and collection payloads are copied before normalization/binding; entries are sorted by stable definition ID.

`BindSnapshot` creates an immutable candidate from genuinely observed article/revision/property and optional draft/publication coordinates. `ValidateSnapshotCandidate` checks its closed schema, coordinate/value shapes and recomputed digests. These pure operations do not prove that coordinates were observed, persist anything, authorize a caller, produce a durable receipt or qualify a PostgreSQL transaction. The sole canonical article transaction must recheck current permissions, definitions and reference policies before a write.

## Canonical article participant

`IArticlePropertyValueAuthority` is implemented by the existing `ArticleService`. A mutation derives the actor's current admin permissions from the database, checks the current authenticated session and article access, locks the article and definition owners, checks article/property revisions, and validates the closed Replace/Patch command. The existing article update creates the actual revision and canonical outbox in the same transaction as property facts, snapshots, current head and request receipt. A replay requires current authorization and an identical command digest. A retained publication is bound only when its real revision matches the new revision.

`ArticlePropertyValuePersistence` participates in that ambient transaction; it never starts a second transaction. Seven additive relational tables retain typed scalar/option/reference facts, immutable snapshot coordinates, a current head and actor/request receipts. Independent hydration verifies shape, bounded resource use, value/factset/snapshot digests and the existing signed audit chain. Snapshot and receipt audit events contain digests rather than property plaintext. Ordinary article updates carry immutable facts into a new signed coordinate header; rollback copies authenticated historical facts into a new monotonic property revision. Definition-owner locks use the existing definition producer's lock identity and stable owner order.

The typed AEDS v2 read root is frame 269, `ArticlePropertyValueReadResponse`, at `GET /api/binary/author/articles/{articleId}/properties`. It returns the current persisted snapshot, canonical definition descriptors and closed reconciliation results under current article-write authorization and no-store response rules. Definition IDs from the stored snapshot are included in the bounded canonical batch read, so known deleted definitions remain available as tombstones. The aggregate definition budget is 1000 distinct IDs; oversized current/history unions fail explicitly. The wire's 8 MiB and 40,000 aggregate item limits remain independent limits. Generated C#, TypeScript and native validators consume one wire producer and the existing eight-type catalog.

Read payload version 2 requires a `Scope` even when no snapshot or definitions exist. Its definition owner, `primary-site` scope and definition schema version come from the authorized Server read. An omitted `ownerUserId` selects the site definition owner (`null`); it does not select the actor. Every descriptor and current snapshot must agree with this scope. Payload version 1 is retired; the persisted snapshot schema remains version 1. The frontend refuses a response whose article, owner or site differs from its request.

`articlePropertyValuesApi.readAfterSave` re-reads this private no-store endpoint using a positive int64 article revision from the canonical save receipt, and refuses a response whose current article revision has changed. The caller must still wire this read into the real Writer save/schema-refresh flow and render the returned authoritative descriptors and reconciliation. This API does not qualify that integration or manufacture a mutation receipt.

## Remaining acceptance

Related to #2322, #2323, #2324 and tracking #1808. This source increment does not qualify the entire property lifecycle. Direct lifecycle-writer and scheduled-publication paths still need the same participant integration and an authentic background actor boundary. Standalone drafts and nonempty article references remain unavailable. Original typed-command history/replay verification, durable reconciliation/query projections, permanent-deletion cleanup, full per-field error receipts and complete scale coverage remain open. Schema qualification, actual HTTP/session admission, rendered UX and full frontend types are separate unaccepted gates. The property mutation transport described below exposes the original authority; full production session/deployment qualification remains separate.

## Formal mutation transport

`POST /api/binary/author/articles/{articleId}/properties` accepts the Shared
`ArticlePropertyValueMutationCommand` and returns the original persisted
`ArticlePropertyValueMutationReceipt` from `IArticlePropertyValueAuthority.MutateAsync`.
It does not obtain a receipt by reading the current snapshot. The path article ID,
body article ID and server site must agree. Owner selection is explicit in the body;
mutation query parameters are refused. Existing actor/article/definition authorization,
transaction, article/property/schema CAS, factsets, snapshots, audit and replay stay in
the original ArticleService writer.

The definition routes are `POST /api/binary/author/property-definitions`,
`PUT`/`DELETE /api/binary/author/property-definitions/{definitionId}`, and
`POST /api/binary/author/property-definitions/{definitionId}/rename` or `/deprecate`.
Each has its own typed request frame and calls the original definition store command.
Settings reuse the definition-owned policies and eight-type payload catalog. Responses
project every field of the store's persisted write receipt, including obligations,
revision transitions, digests, audit identity and replay status. No request accepts
an actor or permission list. The authenticated admin session identifies the actor;
the current active SQL principal supplies root/permission authority. Site definition
management still requires SystemConfig in addition to ArticleWrite; user definition
management remains restricted to the same principal.

All six mutation routes retain ArticleWrite authorization, the original PoW filter,
private no-store responses and ApiError failures. Denied private articles remain
indistinguishable from unavailable articles, including the original article-lock
access exception. Nonempty references and standalone drafts keep their existing
unavailable-authority refusal.

One `article-property-value-read-wire.json` schema and its original
`generate-article-property-value-read-wire.mjs` producer own read and mutation roots.
Frame allocations live only in `aeds-protocol.json`; the original protocol generator
owns C#/Shared/TS/native frame constants and the golden catalog. The same strict
8 MiB / 40,000 item primitive implementation carries int64 decimal strings,
96-bit decimal words/scale/sign and UTC 100 ns ticks for every root. Native production
dispatch, C# and TS reject unknown discriminants, malformed UTF-8, truncation,
trailing data and budget overruns. The original read v2 layout is retained.

`articlePropertyValuesApi.mutate` and `articlePropertyDefinitionsApi` use the existing
private AEDS client, PoW and decoder registry. They bind response request/owner/site,
identity, command kind and revision transitions to the submitted command. A read
snapshot is never accepted as a mutation receipt. These client checks supplement
the original server's authenticated persistence and do not authenticate arbitrary
receipt bytes independently of that server.
