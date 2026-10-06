# Authoring canvas document boundary

`IAuthoringCanvasDocumentStore` is the server authority for direct lifecycle and
record writes to a private authoring canvas. `AuthoringCanvasOperationEngine`
and its one PostgreSQL transaction adapter are the only additional write path:
they apply the closed operation registry atomically with its append-only journal
and do not expose a generic second document store. A document is owned by the exact
`(admin_principal_id, site_scope)` pair and carries schema version, monotonic
revision, title, viewport snapshot, bounded counts, timestamps and a transition
digest. Calls for an absent document and calls using the wrong owner or site
share the same unavailable result; canvases are not exposed through public
routes, publication or search.

## Closed records

Schema version 1 admits exactly these node kinds:

- `article-reference`
- `heading-reference`
- `block-reference`
- `plain-text-note`
- `group-frame`

Reference nodes persist only the target article ID, optional stable
heading/block identity, optional pinned revision, display projection reference
and resolution state. They do not persist article source, rendered HTML, DOM,
asset bytes or target caches. `plain-text-note` is an 8,192-character private
canvas field with control-character and HTML-like payload rejection; it has no
article revision, rights, publication or search lifecycle. `group-frame` stores
only a label, geometry and document-local member node IDs. Nested frames are
rejected.

Edges are exactly `visual-only` or `explicit-reference-note`. Both store stable
document-scoped endpoints, order and an optional bounded plain label. They have
no relation, auto-link or article-mutation side effect. Node geometry and the
document viewport are canvas-owned values and never consume transient graph
positions.

## Writes, bounds and deletion

Every update and deletion supplies the expected document revision and an
idempotency request ID. The store locks the current document row, rejects stale
revisions, and records the applied transition receipt and digest in the same
transaction. Reusing a request ID with the identical command returns the prior
receipt; reusing it for another command fails closed.

Canvas operations use the same document lock, revision CAS, content digest and
idempotency coordinate. An apply, undo or redo updates the document-owned facts,
appends the operation journal and operation receipt, and appends a matching
document receipt in one database transaction. Consequently `VerifyAsync` stays
valid after every operation; a document receipt mismatch is never an accepted
precondition. Undo and redo retain bounded sealed before/after facts rather than
whole-document snapshots, and an apply after undo closes the redo branch while
preserving its audit entries.

An apply batch preserves its explicit command order. After all before/after
facts of each closed command are applied to the candidate state, its endpoints,
frame membership and record bounds must already be valid; creating a dependency
later in the same batch cannot repair an earlier invalid command. This is the
same command boundary used by independent journal replay. A Delete command still
applies node, incident-edge and frame-membership cleanup together before that
validation, and an invalid batch never reaches the transaction commit.

One owner/site pair may hold 100 canvases. One canvas may hold 10,000 nodes and
10,000 edges. Read pages contain at most 256 records; strings, geometry, viewport
and note fields have contract constants and database checks. Exceeding a budget
fails before the record is stored and is never reported as a truncated success.

## Reference resolution and privacy

The reference resolver reads article metadata in bounded PostgreSQL arrays and
never selects article bodies, rendered HTML or editable target state. Production
article facts are restricted to the primary site and to articles attributed to
an active `ArticleWrite` admin principal; an active root may read all articles. A different principal, wrong site or
revoked principal receives only `permission-denied/unknown` for an existing
inaccessible target, without its title, snippet, route, revision or projection
facts; a confirmed absent target remains `missing`. Heading and block coordinates enter
through exactly one typed provider, which delegates to the single registered
`IAuthoringCanvasExternalCoordinateAuthority`.

The production coordinate authority
(`PostgresAuthoringCanvasCoordinateAuthority`) resolves the stable FsusUI #289
`^anchor-id` source markers inside the exact immutable target revision Markdown
of primary-site articles under the same principal/ownership scope as the article
reader: pinned targets read the pinned revision and current targets read the
article's current revision. A stored reference identity is the canonical anchor
grammar `[a-z][a-z0-9-]{0,63}`; a non-canonical stored identity is `invalid`,
zero matches are `missing`, repeated markers reaching anchor position are
`duplicate` (never first-match), and a heading reference resolves `current`
only when the unique anchor's owning block is a heading. Markers inside fenced,
LaTeX or `:::` regions and orphan or misplaced markers are source diagnostics,
never anchors. The authority emits only a bounded plain-text context snippet of
the owning block; inaccessible articles, absent revisions and missing content
return no coordinate, which the resolver projects as `source-stale` rather than
a guessed fact.

Revision Markdown is read once per distinct revision through a sequential native
reader and its borrowed connection/transaction. The coordinate scanner consumes
bounded text chunks, not full Markdown values or full lines; it retains only the
requested identities (the existing 10,000-node batch limit), including every
duplicate claim that survives the original grammar. Line state consists of a
64-character identity suffix plus caret/separator, two bounded context prefixes,
and lexical counters. Fences remain excluded even when unclosed. LaTeX and
container regions defer requested claims until their original closing delimiter
or EOF: at most one pending region of each kind is needed because same-kind
openers share the same next bare closer. Consequently at most three requested
claim maps coexist, independent of source length, line length or opener count.
The existing string scan entry uses the same grammar state machine; production
uses the requested-only streaming entry. This is an application retention bound,
not a claim about driver buffering or a physically measured process heap limit.

The cache is non-authoritative and binds document, node, stable target,
principal, site, permission fingerprint and authority generation. The resolver
rechecks the document revision and digest after asynchronous fact reads before
it caches or returns a result. It also validates a fresh authority coordinate
against the initial coordinate before cache writes or return, including cache hits.
It rechecks the document again after that asynchronous authority read.
Receipts bind stable heading/block identities,
authorized title and bounded context, exact revision and the actual open intent.
An optional target group is carried only in that intent; resolution never
creates a session or mutates workspace/group state.

Deleting a node cascades all incident canvas edges. A member node must first be
removed from its group frame, which keeps frame membership and the frame digest
atomic. Deleting a canvas removes only its owned document, nodes, frame
memberships and edges. It retains content-free receipts and never deletes or
updates referenced articles, assets, relations, properties, graph facts or
another canvas.

## Verification and prohibited authorities

`VerifyAsync` walks nodes and edges through bounded pages and compares their
closed-record digests, counts, endpoints and the current document receipt. The
operation database verifier independently reloads the document, journal and
receipts, replays the sealed facts, calls the document verifier and compares
article, revision, relation and mutation-outbox generations captured before the
operation sequence. This proves both canvas integrity and zero external-authority
mutation without trusting the operation engine's in-memory result. The
PostgreSQL integration suite covers both record kinds, all five node kinds,
CAS/idempotency, owner/site privacy, scoped deletion, tamper and the
0/1/100/10,000 bounds. `tools/governance/check-authoring-canvas-authority.mjs`
fails when a second canvas store, browser-local authority, executable/arbitrary
payload field, graph-position reuse or article/relation/property/graph write is
introduced.

## Private runtime transport

The private `/api/binary/author/canvases` adapter exposes the existing document,
operation and reference authorities through AEDS v2 only. Its pure domain
contracts now live under `src/shared/Contracts/AuthoringCanvas`; their CLR
namespace is `FsusBlog.Shared.Contracts.AuthoringCanvas`. This relocation changes
CLR type identities; consumers must rebuild and import the shared contracts.
The stored schema, canonical digest algorithms, operation registry and database
migration fingerprints do not change.

Every route requires the isolated authenticated administrator identity,
`ArticleWrite` permission and an actual administrator session. The server
supplies the exact administrator principal ID and existing `primary-site` scope;
requests cannot select an owner, site or actor. The operation journal's legacy
`ActorUserId` field records that same isolated administrator principal ID at this
entry point. It never uses or impersonates an anonymous account. Mutations and
reference-resolution POSTs retain the existing PoW filter and request origin,
CSRF, session and `X-Fsus-*` middleware boundaries. Private responses are
`private, no-store` and never enter public artifact or representation caches.

Reads contain at most 256 nodes or edges per page and carry their document
revision and digest. The adapter rechecks the header after each read; callers
must require one coordinate across all pages, exact record counts, unique IDs
and a final current header. A mixed revision is a conflict, never a successful
partial snapshot. History exposes bounded journal identities and the real
history digest. Apply, undo and redo retain the existing document/history CAS
and request idempotency; their receipts remain authoritative server facts.

A client sends only closed unsealed operation facts. Ingress validates and seals
them with the original domain validator and digest producer before calling the
single operation engine. The engine compares these facts with persisted facts
and validates operation semantics, references and the atomic journal update.
The adapter does not accept a substituted document or a client transition digest.
Reference create/pin/unpin intentions first use the read-only `/prepare` POST.
Both its request and prepared response use `AuthoringCanvasApplyRequest` (frame
258), rather than an operation receipt. Preparation processes commands in order,
resolves each reference through the existing permission-filtered authority and
changes only display projection reference and resolution state. Subsequent
facts for the same node inherit precisely that prepared metadata. The original
planner validates the first persisted before-fact, operation semantics and every
prepared reference without committing; document and history coordinates are
rechecked before return. Preparation cannot authorize a write: formal Apply
seals the exact facts anew and repeats the original reference validator for
each create/pin/unpin command, in order, plus transaction CAS checks. A later
valid fact cannot hide an earlier invalid reference in the sealed journal. Permission or target changes invalidate stale preparation.

The browser wraps every binary call and decode in the administrator private
request generation lease. Logout or session replacement rejects late responses
before they can enter Canvas state. A session retains one bounded pending write
slot containing its exact apply or undo/redo payload and request ID until receipt
and fresh readback succeed. Explicit retry reuses the same command IDs, prepared
metadata, history target and request ID without a fresh preparation. A different
intention is refused while that result is unresolved; this retry slot is neither
a document store nor a browser-local persistence authority. A failed read-only
preparation releases that slot because no write was submitted.

Reference resolution accepts bounded persisted node IDs, reloads them under the
same owner and document coordinate, then invokes the original typed resolver.
Unknown document and foreign-owner access remain indistinguishable.

The payload schema in `authoring-canvas-wire.json` binds to the frame registry;
`generate-authoring-canvas-wire.mjs` owns the C#, TypeScript and C++ payload
surfaces. Its `clientLimits` entries reference the existing shared domain
constants; the generated `authoringCanvasLimits` is the browser's public
presentation-budget surface and cannot become a second numeric authority.
Frame IDs 253–265 do not reuse Font/Theme 244–250/252 or `ApiError`251.
All payloads have schema byte 1, bounded UTF-8 strings and arrays, explicit null
presence, network-order GUID bytes, little-endian scalars, and exact trailing
byte rejection. Int64 values remain decimal strings in TypeScript. Aggregate
before/after facts are capped at 40,002 before allocation and each complete
payload at 8 MiB. HTTP requests also retain the existing binary binder's
8 MiB complete-frame limit, including the 16-byte AEDS header. The wire is
binary POD, with no JSON or text fallback.

Frozen payload vectors in
`tests/fixtures/protocol/authoring-canvas-wire-golden.json` cover every root
and typed malformed controls. `AuthoringCanvasWireCodecTests` consumes them
through the actual C# POD codec; the wire tool tests use the generated TypeScript
codec; `check-generated-frame-schema-sync.mjs` retains the original frame
controls and sends those same bytes through production C++ `DecodeFrame`.
`AuthoringCanvasPreparationControls` also runs the actual transport, resolver,
reference validator, planner and semantics against deterministic fixture ports,
including same-node batches, stale coordinates, inaccessible targets, forged
before-facts and exact idempotent retries. These source controls and payload
parity do not qualify PostgreSQL, HTTP middleware or rendered browser acceptance.

This document store does not inline-edit or copy referenced content and does not
implement package exchange, collaboration, plug-in nodes or public canvases.
The explicit article-owned conversion below is a separate authoring action;
graph operations retain zero external mutation. UI presentation cannot publish content or introduce
another document store. Source integration, codec checks, PostgreSQL verification
and rendered UI acceptance remain separate evidence lanes.

## Explicit article-owned link conversion

`IArticleCanvasLinkWriter` is implemented by the production `ArticleService`.
An explicit confirmation appends one server-derived Markdown link at the end of
the source article through its existing `UpdateAsync` owner. It is not a Canvas
operation or a browser clipboard confirmation. The same owned PostgreSQL
transaction contains the article revision, canonical outbox writes, a new
`article_canvas_link_journal` receipt and the bounded
`article_canvas_link_history` head. The existing private article transaction
scope defers cache/AOT/realtime work until commit; an ambient transaction by
itself never qualifies for scope reuse.

The authenticated admin/session route supplies the principal and primary-site
scope. The transaction locks the active `ArticleWrite` principal for share,
serializes the owner/site/request identity, locks distinct article IDs in
ascending order, then locks the owned Canvas header. It validates the complete
Canvas receipt chain, exact Canvas revision/digest, source and target article
revision CAS, selected persisted explicit edge and both persisted endpoints.
Heading and block endpoints must resolve through the registered coordinate
authority against those revisions. Target pins may equal the current revision;
an older pin is rejected because no immutable-revision public URL is available.
For a heading/block target, the actual public publication must exist, be visible,
and bind the same target revision. An unpublished authoring anchor or a current
edit ahead of its publication is rejected; draft-write permission cannot prove
that public coordinate exists.
An ordinary article reference may retain a draft's stable article ID as a future
publication path; its conversion receipt confirms the source article write and
does not claim that the target is already public or currently resolvable.
Links use the actual public article ID route and canonical `#anchor-id` fragment,
not editor routes, guessed slugs or a new block query syntax. Neither the Canvas
document nor a target article is changed by conversion.

Apply, undo and redo share a scoped idempotency receipt. An identical request ID
and payload replays the original receipt; another payload conflicts. Replay is
read before old target or Canvas availability is required, while still checking
the active principal and current source write permission. The browser binds the
request, owner/site and receipt digests before acknowledging success. Its admin
generation lease spans the network response, asynchronous digest validation and
final receipt/history return; a changed admin generation rejects the response
and leaves an uncertain write pending.
An unknown outcome or malformed receipt retains the exact request and UUID in
the provider's single unresolved slot. After an ambiguous attempt, a later
permission or unavailable response cannot establish that the original write did
not commit and does not clear that slot. A valid receipt closes it before any
projection refresh. This slot holds request recovery state, not article or
Canvas authority, and is not persisted to browser storage.

Article-link undo/redo is separate from graph history. Its head must match the
current article revision and the requested top journal ID. It restores the
original immutable body and summary through the same canonical writer and
creates a fresh revision; it never moves an article pointer backward. Normal
article edits invalidate the old head. A subsequent explicit Apply ends that
undo/redo branch while retaining its journal. Each stack is bounded at 100;
capacity exhaustion fails before commit. Digests are unkeyed SHA-256 bindings,
not MACs; ownership, database locks and immutable revisions supply authority.

Migration `20261006-post-article-canvas-link-history` adds these two tables
without rewriting published migrations. Historical principal, source, target
and revision identifiers in the journal are scalar audit subjects so permanent
article deletion remains possible. The deletion kernel removes only the mutable
source history; principal deletion also removes its mutable history. Journals
remain preserved under the article deletion catalog. Compatible older code can
ignore the additive tables; rollback must retain journals and article revisions
already committed. Dropping either table or undoing published article mutations
is not a code rollback.
