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

This boundary does not inline-edit or copy referenced content. Its private
transport is described below; UI composition and canonical article-link
integration have separate implementation and acceptance scopes. Collaboration,
plug-in nodes and public canvases remain outside this boundary.

## Typed private transport

`AuthoringCanvasTransport` projects the existing document, operation and reference
owners through the authenticated authoring endpoint group. Owner and actor derive
from its administrator session and primary-site scope. The shared contracts live
in `src/shared/Contracts/AuthoringCanvas`; Server retains persistence and HTTP
semantics. Node/edge reads recheck the document coordinate after loading a page;
history also binds the actual history/content coordinate. Prepare validates the
original planner and reference facts without committing. Apply repeats validation
and uses the original transactional CAS and idempotency semantics.

The schema `authoring-canvas-wire.json` binds thirteen closed frame roots 253–265
to domain constructors, enums and limits. Its canonical producer is
`tools/contracts/generate-authoring-canvas-wire.mjs`; `--check` verifies C#, C++
and TypeScript outputs. The current protocol producer also maintains the golden
catalog metadata. Production C++ validates Canvas payloads alongside the existing
FontTheme payload checks. Frozen vectors cover all thirteen roots and malformed
inputs. Codec, source, PostgreSQL, HTTP/session and rendered UX evidence remain
separate acceptance stages.
