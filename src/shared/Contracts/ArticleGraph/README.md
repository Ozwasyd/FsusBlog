# Local graph integration boundary

This source slice implements graph admission, bounded response validation, a
read-only query facade, deterministic transient layout and graph/list composition.
It does not supply a relation index or register a route, transport root or DI service.

The original relation owner must implement `IArticleGraphRelationProjection` using
the canonical permission-filtered relation query. Apply authorization before
expansion, counts, budgets and truncation. Return no anonymous targets or hidden
totals. Bind the actor/site/permission, root revision/document epoch and index
generation exactly. The port receives the hard budgets and cancellation token;
the source must bound index operations and payload before materializing results.
The facade additionally refuses oversized, stale and malformed projections and
enforces a deadline even if an integration ignores cancellation.
The response seal binds a separately computed admitted-request digest, including
scope, filters and budgets. Invalid requests are never serialized into a refusal
receipt and cannot amplify its payload.

`null` depth defaults to one. Explicit zero, unknown and greater-than-two values
are refused. Two requires the current session's explicit expansion action.
Complete results cannot report a reduced effective depth. Truncated results must
name the exhausted budget. No cursor is offered until the canonical query owner
provides authenticated cursor semantics.

`ArticleGraphUnavailableRelationProjection` and the frontend unavailable host
return honest empty unavailable results until that API is supplied. There is no
source scanner, client permission filter, relation cache or fallback index.
The existing relation catalog's outgoing/backlink vocabulary and embed facts must
be mapped by their owner to the closed graph link/embed/broken/visibility-risk
projection; the graph does not guess a kind from text or URLs.

The frontend types are integration projections, not an AEDS codec. The canonical
host must verify transport and server digests before returning them. The C# result
digest seals this slice's response; it is not a new public wire digest authority.
Navigation must bind `openOrActivate` to the existing workspace router and
`revealSource` to the public exact relation/source reveal path. Neither binding is
implemented by guessing routes, article titles or text ranges.

`ArticleGraphSession` is the single local state owner. New opens and identity
changes reset depth to one, abort old work and erase old facts. Filters reset the
query to one; explicit expand/collapse is session-only. Close/background/unmount
release local state and signals. Positions and drag adjustments have no storage
or writer port. Static layout is identical under normal and reduced motion and
uses no animation, worker, observer or timer. The list has bounded pages of forty
items and retains access to the full returned node/edge set.

Canonical backend and frontend unit/component tests are executable source
controls. They do not establish real relation permissions/timing noninterference,
HTTP/PoW/no-store, production navigation, rendered viewport/theme/a11y acceptance,
performance qualification or complete terminal acceptance. Those remain WIP until
the original source/transport integration and independent review are available.
