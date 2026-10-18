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
The facade additionally refuses oversized, stale and malformed projections.
`QueryMilliseconds` (maximum/default 250 ms) is the fact-admission window and
cancellation-request deadline, measured across query admission and response sealing.
No complete/truncated facts are accepted after that window, including facts returned
by a source that ignores cancellation. Source completion must include outstanding
borrowed commands/readers and their awaited disposal; the facade awaits that task
before returning or releasing its cancellation scope. Npgsql cancellation/cleanup
may exceed the admission window. This contract promises neither cleanup nor a hard
real-time response within 250 ms, and grants no authority to switch or dispose the
caller client. A source without supported cancellation/completion semantics remains
unavailable; the production integration guard remains until those semantics are
integrated and verified.

This corrects the earlier facade's `WaitAsync` early return and its corresponding
uncooperative-source test: the old implementation denied late facts but could return
while source work still used a borrowed client. The regression now requests
cancellation, checks that the query remains pending until source completion, and
discards late facts/faults. Issues #2474 clauses 9–10 and #1870 require query time
budgets and cancellation safety; they specify no numeric cleanup deadline.
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
or writer port. One static deterministic kernel is identical under normal and
reduced motion. Product layout runs in finite cancellable MessageChannel tasks:
128 items per slice, at most 64 slices, 8 ms per measured slice, 50 ms total CPU
and 500 ms wall time. Native sorts remain capped at 1000 nodes/2000 edges; measured
budget exhaustion discards partial positions and preserves the authorized result
for list navigation. Task creation failure also degrades explicitly to list-only.
Terminal paths close both ports and detach cancellation; query/session/layout
generations deny old results after resets, identity changes and close. No animation,
worker, observer or timer drives product layout. The list has bounded pages of forty
items and retains access to the full returned node/edge set even while layout runs.

Canonical backend and frontend unit/component tests are executable source
controls. They do not establish real relation permissions/timing noninterference,
HTTP/PoW/no-store, production navigation, rendered viewport/theme/a11y acceptance,
production performance qualification or complete terminal acceptance. The standalone
`node tests/frontend/checks/runtime/article-graph-layout-task.mjs` pressure check
uses the actual layout/session modules with synthetic public fixtures in Chromium;
it measures task response and terminal port cleanup at 100/1000 nodes, exercises
the 2000-edge ceiling, active cancellation and allocation-free 10000-node refusal.
Its local receipt explicitly excludes production relation-query acceptance.
Integration acceptance remains WIP until
the original source/transport integration and independent review are available.
