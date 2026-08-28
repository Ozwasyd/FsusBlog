# Authoring canvas document boundary

`IAuthoringCanvasDocumentStore` is the single server persistence authority for a
private authoring canvas. A document is owned by the exact
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

One owner/site pair may hold 100 canvases. One canvas may hold 10,000 nodes and
10,000 edges. Read pages contain at most 256 records; strings, geometry, viewport
and note fields have contract constants and database checks. Exceeding a budget
fails before the record is stored and is never reported as a truncated success.

Deleting a node cascades all incident canvas edges. A member node must first be
removed from its group frame, which keeps frame membership and the frame digest
atomic. Deleting a canvas removes only its owned document, nodes, frame
memberships and edges. It retains content-free receipts and never deletes or
updates referenced articles, assets, relations, properties, graph facts or
another canvas.

## Verification and prohibited authorities

`VerifyAsync` walks nodes and edges through bounded pages and compares their
closed-record digests, counts, endpoints and the current document receipt. The
PostgreSQL integration suite covers both record kinds, all five node kinds,
CAS/idempotency, owner/site privacy, scoped deletion, tamper and the
0/1/100/10,000 bounds. `tools/governance/check-authoring-canvas-authority.mjs`
fails when a second canvas store, browser-local authority, executable/arbitrary
payload field, graph-position reuse or article/relation/property/graph write is
introduced.

This boundary does not resolve reference content and does not implement an
operation history, undo/redo, runtime route, UI, edge-to-link conversion,
package exchange, collaboration, plug-in nodes or public canvases.
