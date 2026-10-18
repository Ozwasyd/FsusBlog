# Canonical Block Anchor Contract

This document is the current FsusBlog contract for the FsusUI #289 block-anchor
projection. It owns the Blog identity and codec boundary only. query/index/picker/refactor/package
and editor transaction consumers must carry the
contract version and digest but are separate authorities.

## Identity

`BlockAnchorId` accepts exactly `[a-z][a-z0-9-]{0,63}`. Validation is ordinal and
ASCII-exact: uppercase, Unicode, underscore, a leading digit, `^`, percent encoding,
trimming, transliteration, and automatic suffixes are rejected. The stable target is
`article identity + BlockAnchorId`; a slug, URL, display text, source offset, DOM
coordinate, database ID, sidecar, or content hash is never a durable target.

The portable article identity uses the existing `article:<lowercase UUID>` identity
authority. This contract does not create or query articles and does not decide whether
an anchor exists, is duplicate, or is visible.

## Projections

FsusUI owns the source transaction and emits one source marker:

```text
^anchor-id
```

The URL projection is one raw fragment:

```text
#anchor-id
```

The fragment never includes the source marker prefix. `#^anchor-id`, wikilinks such
as `[[Article#anchor-id]]`, `{#anchor-id}`, HTML IDs, database or sidecar anchors,
aliases, and compatibility normalizers are unsupported syntax. A URL parser does not
percent-decode, inspect rendered HTML, scan Markdown source, or guess a position.

The only standard Markdown builder emits a link whose visible text is `display text`
and whose destination is the following exact route projection:

```md
/posts/canonical-slug#anchor-id
```

Only the current route slug is percent-encoded as a route projection. The validated
anchor bytes are appended unchanged. Slug changes therefore do not change the
durable `ArticleBlockTarget`.

## Error and digest boundary

The closed error taxonomy distinguishes `InvalidGrammar`, `UnsupportedSyntax`,
`Duplicate`, `MissingArticle`, `MissingAnchor`, and `CodecMismatch`. Duplicate and
missing-target outcomes are supplied by the owning document/article authority; this
codec never first-matches or creates `-2` suffixes.

`BlockAnchorContractDigest` seals the versioned contract, target identity, and future
consumer identities using length-prefixed UTF-8 and lowercase SHA-256. Query, index,
picker, refactor, and package plans must bind the exact contract version/digest. A
changed contract invalidates old plans and results instead of entering a compatibility
branch. The independent verifier returns a versioned
`fsusblog.block-anchor-verification-receipt.v1` with the contract digest and an
independently recomputed verification digest.

`BlockAnchorIndependentVerifier` rebuilds and independently re-parses the source
marker, URL fragment, and Markdown link, then compares the exact `BlockAnchorId`,
display text, and encoded route projection. It is a contract verifier, not a query,
relation, UI, package, or source mutation implementation.

## Target query contract

`BlockTargetQueryRequest` separates the article page from heading/block drill-in.
Drill-in requires an exact stable article/revision/content coordinate. Authoring
accepts current or draft revisions; public queries require published coordinates.
Read and edit permission dispositions are separate. Authoring tokens require both
allowed; a public publication target may be read-only to its caller.
Requests bind actor/site, permission context and revision, query/index/route
generations, request sequence, search and page limit, plus the existing anchor
contract version/digest. A changed coordinate invalidates cursors and tokens.
The selected article coordinate includes its authoritative current canonical slug;
even a resealed token with another slug is rejected against that coordinate.

`BlockTargetArticleQueryPage` carries only bounded authorized article projections,
with unique stable identities, title, revision/lifecycle/permission/route coordinates
and update timestamp. It contains no heading or block inventory. The separate
`BlockTargetHeadingQueryPage` binds every heading to the exact selected article
coordinate and reuses the existing canonical portable heading identity validator.
Duplicate identities, diagnostics with selectable items, mismatched layers and
stale/out-of-order response bindings are rejected. These result schemas do not
build heading URLs or acquire inventory; both remain upstream producer duties.

`BlockTargetQueryToken` carries the existing `ArticleBlockTarget`, selected source
revision, canonical source node/range, block kind, bounded snippet and current slug.
The source coordinate, content digest and slug are evidence/projections. They never
replace stable article+anchor identity. The existing codec builds URLs and Markdown;
the query contract introduces no grammar, parser, normalizer or source writer.

Limits are 100 items per page, 128 search characters and 256 snippet characters.
An over-budget page is rejected rather than truncated. Duplicate anchors cannot
appear as selectable items. Duplicate/invalid/malformed/orphan inventories use a
blocked page with no items or continuation. Missing and denied targets share the
content-free unavailable shape; cancelled pages also carry no content. There are
no global corpus counts in this contract.

`BlockTargetQueryValidator` checks structural bounds, scopes, exact current request
binding and recomputed digests. The producer must authorize the actor on the server
before reading inventory or returning diagnostics, obtain inventory exclusively
from the canonical parser, and supply independently observed current coordinates
before opening or inserting a result. Seals are consistency checks, not signatures,
permission evidence or proof of parser provenance. The opaque continuation must be
admitted by the server pagination owner. Contract tests do not establish service
privacy/timing, cancellation, database pagination, 100000-anchor scale or receipts.

## Canonical relation index

`ArticleRelationIndex` is the backend relation-set index algorithm over the existing
`ArticleRelationSet` / `ArticleRelationRecord` schema. Article, heading and block
targets use that same catalog, validator and digest. Its target lookup projects the
same immutable records; it is not a block-only side store. It does not parse Markdown,
infer identities from URLs, change source bytes or generate permission facts.

`IArticleRelationIndexSource.ReadAsync` supplies complete ordinal article-family
pages at one source generation. `ReadArticleAsync` supplies a complete family for
incremental lifecycle replacement and current-source revalidation. Both bind the
exact actor/site/permission context. Families carry monotonic source sequences,
current/draft sets and immutable publication sets from the canonical producer.
The index owns copies of relation lists and verifies their existing seals before
sorting through the existing canonical set sealer. Source seals remain consistency
checks rather than proof of observed parser or permission provenance.

`RebuildAsync(expectedIndexGeneration)` stages bounded pages and publishes only after
source-generation revalidation and an atomic in-process generation check.
`ApplyAsync(articleIdentity, expectedIndexGeneration)` rereads the producer, replaces
the complete family and rejects stale sequences, conflicting duplicate observations,
generation gaps and concurrent replacement. A source-generation gap requires full
rebuild. Exact repeated observations do not increment the index generation.
Cancellation, budget overflow and source drift leave the prior snapshot intact.

Publication source sets cannot be changed or removed by either path. Current/draft
replacement does not mutate retained snapshots. Relation-set ordering is canonical,
so incremental replacement and full rebuild produce the same set digests for the same
source facts. Route slugs are absent from relation identity; a route-only observation
does not rewrite a stable target. A renamed anchor remains broken at its old identity
when the canonical producer supplies `MissingAnchor`; the index never repairs links
or selects a different anchor. Resolution/lifecycle diagnostics are preserved from
the existing contract rather than being synthesized by an index read.

Limits are 100 articles per source page, 10,000 article families, 100,000 source sets
and relations, and 32 Mi characters of stored occurrence text. These are in-process
algorithm limits. Fixture tests execute the 0/1/10,000 article and 100,000-edge cases;
they do not qualify durable storage, production source paging or crash recovery.

`InspectTarget` reads exact target/kind candidates from the actual immutable index.
`RevalidateSourceAsync` recomputes inspection parity against that index, rejects
fabricated or stale records, and sequentially rereads each affected family from the
original producer at the frozen source generation. It also revalidates empty results.
These APIs follow the unadmitted inspection/revalidation boundary of the supplied
`AuthorFullTextSearchQueryEvaluator` source; its text-search candidates are not block
query results. No item/count here may be exposed as a permission-safe response or
used as an executable impact plan without current authorization admission.

## Block source production

`ArticleBlockRelationProducer.Produce` derives one complete canonical source set from
original parsed-link nodes and target inventories. Each link carries its original
node, exact UTF-16 range/literal and separately resolved `ArticleBlockTarget`.
The existing `BlockAnchorMarkdownParser` validates that one supplied literal; the
producer never scans raw source, rendered HTML or a DOM. The parsed fragment must
match the already-bound canonical anchor. Route strings cannot resolve article
identity. Existing relation validators and sealers own the output bytes and catalog.

Inputs bind source facts, reader context, original parsed source digest, parser
contract, source generation and the exact anchor contract. Target inventories bind
the same reader/generation and existing article target facts. This is a consumption
shape, not a new parse package or proof of observed permission/parser provenance.
Denied target facts cannot carry route/anchor inventory. Unknown facts and unusable
inventories are refused before a source set is returned. Transclusions are excluded.

Production preserves the supported existing catalog states: outgoing/resolved,
broken/missing-anchor, unauthorized, archived, deleted or stale route projection,
and visibility-risk/draft or scheduled-private. A route change preserves the stable
article+anchor and original link bytes. Duplicate anchors/target inventories,
invalid/malformed/orphan diagnostics, duplicate nodes, overlapping/out-of-bounds
spans and stale bindings refuse the whole production; there is no first-match or
partial set. The current shared missing-target representation cannot retain a known
stable block identity, so missing targets are refused rather than erasing that
identity. Full diagnostic persistence remains a canonical schema integration gate.

Limits are 100,000 links and anchors, 10,000 target articles and the existing source
text budget. Controls actually exercise 100,000 links/anchors and 10,000 targets with
100,000 anchors. These are parsed-fact fixtures, not observed production corpus,
permission or storage evidence. `Produced` means internal fact projection only.

`ArticleBlockRelationIndexSource` implements the actual `IArticleRelationIndexSource`
integration. Its owned `IArticleBlockRelationParsedSource` read port supplies complete
original article families: per-revision original non-block sets and block parse
inputs. The integration verifies reader/generation/source binding, rejects a second
block producer, preserves original article/heading records, and merges/seals the
single complete source set before the sole index can stage it. Any refused revision
refuses the family. Original publication inputs must replay frozen facts; the index
also refuses publication rewrite/removal. This read port is now available to the
original parser adapter owner, but does not itself implement that authority.

`CanonicalArticleRelationParserBridge` now supplies a closed internal parse envelope
from the real `@ozwasyd/element-plus/markdown-runtime` public entry. Its only child
script, `canonicalArticleRelationParserBridge.mjs`, calls
`createMarkdownEditorProjection`, `stabilizeMarkdownEditorProjection`,
`collectMarkdownAnchorNodes`, `collectMarkdownEmbedNodes` and
`createMarkdownSourceCoordinateMap`. No C#/regex/DOM Markdown parser, private UI
import or PublicAot worker receives the body. Standard WebAssembly host observation
records the SHA-256 of the module actually compiled during that public call; expected
public-entry bytes, module bytes and runtime version are explicit trusted host pins.
The envelope also retains the runtime's actual parser/source/version identity and
the original byte digest. Pins are verified, never learned from the private request.
The local alias uses Node 24's native TypeScript stripping on the public entry;
there is no tsx loader or child compilation service. Published-package mode resolves
the same documented public export. The native .NET package remains unpublished.

The original `AuthoringRevisionComparePackageReader` supplies exact selected revision
or persisted draft bytes. Both reads use the same authorized selector and expected
digest; completion rereads the full package and refuses metadata/context/body drift.
There is no latest/path lookup. Portable source coordinates and the mounted document
id/numeric epoch remain independent caller observations: the compare draft-context
token is never converted to a mounted epoch. A fresh stable projection is scoped to
that supplied mount; this bridge claims no cross-revision identity continuation.
Raw BOM/CRLF/RTL/astral UTF-16 ranges use the public coordinate map, with UTF-8 and
line/column round-trip controls. Both the original projection range and the literal
link range are retained. Literal selection uses the map's forward start/backward end
affinities, preserving a collapsed BOM or CRLF outside the Markdown link without
reconstructing ranges from text. Links, anchors and embeds remain distinct. Parser
diagnostics block whole producer binding. The pinned public runtime currently emits
an embed projection inside a containing fenced-code projection for an embed-looking
literal line. Such conflicting canonical ownership refuses the whole parse; the
bridge neither repairs the UI parser nor admits that literal as a dependency. The
control exercises this actual upstream behavior. URL destinations are candidates only. The explicit
`ArticleBlockRelationProductionInput.FromCanonicalParsedSource` binding requires one
original registry decision per link and delegates all block validation to the
existing producer. It supplies no target resolver, non-block producer or embed
admission. Duplicate, orphan or changed bindings fail closed.

The process gate permits one in-flight read/parse and child at a time; concurrent
submissions refuse before another body is materialized. Source/input/output/node limits are
200,000 UTF-16 units, 1 MiB stdin, 2 MiB stdout and 4,096 projection nodes, with
4 KiB stderr and a 10-second deadline. Node has a 96 MiB old-space and 8 MiB
semi-space limit; the parent polls actual working set every 10 ms against 256 MiB
and the child checks its own RSS before publishing. RSS monitoring is not a kernel
allocation reservation or a measured storage/latency qualification. Caller
cancellation, timeout and failed I/O kill the child tree and await actual exit and
pipe cleanup. Body bytes travel only over bounded private stdin; exception/diagnostic
messages are not forwarded to logs or argv/environment. The original backend project
contains real process/WASM integration controls, separate from its parsed-fact unit
fixtures. The localUI public-entry alias and saved Blog locks are unchanged.

This remains WIP with no DI registration, endpoint or Graph enablement. Combining
the original portable coordinate readers, fresh permission/target registry decisions
and corpus source-generation observations into `IArticleBlockRelationParsedSource`
is still open; a supplied permission record or successful parse is not that receipt.
Fresh permission admission,
durable registration, permission-safe target query (#2441), complete block diagnostic
lifecycle persistence (#2443), transactional impact execution (#2447) and real package
round-trip (#2450) remain integration work. The producer, source integration, index
and their fixture ports do not certify those capabilities.

## Embed admission in the sole index

`ArticleRelationIndexDependencyKind` distinguishes `Link` and `Embed` without changing
or impersonating the closed shared link-kind catalog. Complete article families
carry their existing relation sets and versioned `ArticleRelationIndexEmbedAdmission`
objects in the same index. `ArticleBlockRelationIndexSource` passes this complete
embed carrier through its existing source integration. There is one expected-index-
generation commit and one combined set/edge/text budget; target lookups are projections
of the same article families.

The admission factories consume the actual upstream `1194ee450` separate authoring
projection, expanded graph and relation outputs, or a sealed publication plan and its
relation derivation. They call the original independent projection/relation verifiers.
They retain the original host/document/revision, authority generation, actor/site/
permission context, runtime, scope, source-artifact digest, every exact target revision,
kind/heading/anchor, dependency coordinate and projection/dependency digests. Authoring
also retains its first-stage projection receipt digest. Frozen publication retains
all original dependency receipts, including plan/publication-edge/coordinate bindings.
No parser, resolver, graph algorithm, identity or digest authority is recreated.

Each admission records its original host source sequence and source generation.
Authoring must match the current host sequence; artifact generations cannot be in the
future. An unchanged host can retain its original artifact generation while the corpus
advances. That capture is distinct from the inspection's current corpus generation.
Frozen publication capture, edge set, coordinates and receipts cannot be rewritten,
removed or rebound by current replacement or rebuild. A bridge owns immutable copies
of the original edge/receipt collections. Nested edges keep their actual nested owner;
inspection revalidation rereads the original host family, not a fabricated nested source.

`InspectEmbedTarget` requires an exact canonical embed target and explicit authoring or
frozen-publication scope. Its `ArticleRelationIndexEmbedInspection` remains unadmitted,
as do link inspections. The existing `RevalidateSourceAsync` rereads original families
at the exact corpus generation and refuses edited, stale or context-swapped inspections,
even when a result is empty. These APIs do not authorize public items/counts or writes.

Source-only verifier success is not an observed live permission grant or persisted
publication receipt. Production source registration, canonical identity/parse/permission
adapters, durable storage, runtime/publication/device qualification and all remaining
query/impact/package acceptance gates stay separate. Integration must consume upstream
`1194ee450` together with the exact canonical block validator offer; consuming only the
embed pipeline's older link validator does not provide canonical block-link admission.

## Article and heading query service

`ArticleBlockTargetQueryService.QueryArticlesAsync(request, cursor, cancellationToken)`
and `QueryHeadingsAsync` produce the existing `BlockTargetArticleQueryPage` and
`BlockTargetHeadingQueryPage`. They require independently observed source authority
facts through the owned `IArticleBlockTargetQuerySource` read port. Its observation
call receives actor/scope only, never the client's expected coordinate. Actual
`PermissionRevision`, `QueryRevision`, `IndexRevision` and `RouteRevision` must be
observed independently; none is inferred from `InspectTarget`. The index lease
generation is a separate field and can differ from the observed index revision.

Each read binds the complete observation and actual index source/generation/actor.
Candidate metadata must match an exact indexed source revision/content digest.
The service uses the sole index's actual `InspectTarget` and `RevalidateSourceAsync`,
then reobserves every authority field before returning a page. Stale observations,
index/source drift, conflicting frames, malformed/duplicate/reordered/oversized rows,
invalid lookahead and source errors refuse the whole page. Cancelled and unavailable
pages contain no items, cursor or diagnostic/existence details. Permission filtering
must precede search and limit at the actual source. Public scope requires a current
published target; target edit rights are separately required for authoring scope.

Article reads contain metadata only. Heading inventory is read only after exact
selected-article authorization and source validation, and must come from the unique
canonical parser with actual portable heading/node identities. Source ranges are
bounded by that inventory's original UTF-16 source length. Authorized global parse
diagnostics block every result. There is no source/DOM scan or title/hash-based
identity synthesis. Metadata and projection pages use at most limit+1 rows (101),
ordinal stable-identity ordering, bounded labels and exact request-bound cursors.

The new service and read port are usable algorithm/source-consumption APIs, not an
observed production provider or permission receipt. Production registration still
requires actual canonical portable article/revision mappings, authenticated rights,
independent revision observations, bounded metadata reads and original heading
inventory. The current DB article ID, history permission digest and structure
`IdentityDigest` cannot fill these fields. There is no default provider or invented
upstream method. Source/provider timing and bounded cached-fact revalidation require
real runtime qualification; the controlled 10,000-row fixtures are not such evidence.


## Incoming anchor impact preparation

`ArticleBlockAnchorImpactPlanner.FreezeAsync` consumes the sole actual relation
index and the existing independently observed query metadata port. It freezes
request identity, exact target/current revisions, index/source leases, original
source ranges, permission/editability facts and an internal operation fingerprint.
Current link candidates use the existing single-literal parser and Markdown builder
while retaining their original route and label. Published references are always
immutable. Read-only current references and default removal with current references
remain blocked; explicit leave-broken intent retains the original links.

Historical-only references also require a fresh current article read. Current
read permission does not admit past revision content: the candidate retains an
explicit canonical historical-permission admission requirement before exposure.
All current metadata coordinates are frozen separately from immutable past sources.

Every required source is revalidated before preparation returns. The index's
`RevalidateArticleAsync` also checks the target's original family when there are no
incoming relations. Prepare-only `RevalidateAsync` recomputes original facts and
refuses drift. Incomplete aggregate occurrence records (more than first/last),
overlapping ranges, unavailable reads or changed permission/revision observations
return no partial plan. Planning is bounded to the original index article/record/text
limits, uses sequential metadata/fact reads and never scans source bodies. Real
providers must serve bounded canonical cached facts; fixtures do not qualify runtime
latency, privacy timing or storage admission.

A frozen incoming-impact candidate is **not an executable refactor**. Every plan
still requires original anchor inventory/collision and exact marker-range admission,
explicit removal-policy admission, and the canonical expected-revision article/editor
transaction covering target plus incoming sources. The canonical writer source offer
`b4e8830b7231aee7c2333278bfaf6bb327a3f347` supplies
`ArticleMarkdownSourceAdmission.Require` and uses it in the existing single-draft
save and lifecycle revision writer. It preserves the supplied Markdown verbatim,
including BOM, line endings, trailing whitespace and final-newline state, within
the existing 200,000 UTF-16 code-unit bound; oversized and invalid UTF-16 input is
refused. Markdown normalization repair is therefore no longer a prerequisite.
This source offer has been inspected, not consumed into this branch, and does not
supply the cross-article expected-revision atomic/recovery protocol required here.
Its original owner's PostgreSQL evidence is not this planner's runtime acceptance.
No writer, marker mutation, history/outbox/audit/reindex receipt or collision authority
is fabricated. Execution and package round-trip acceptance remain open.

## Bounded article adjacency source capability

`ArticleRelationIndex.ReadAdjacencyAsync(request, authority, budget, cancellationToken)`
reads incoming/outgoing article adjacency from lookup references built and committed
with the same canonical index snapshot. It never calls `InspectTarget` and then
truncates a complete target result. The lookup includes original article, heading
and block link targets plus the existing independently typed embed edges. Ordering
is ordinal and deterministic; self-loops are admitted before deduplication. Exact
incoming link-target, revision and kind filters remain link-specific and cannot
reinterpret or suppress the separately selected embed domain. Explicit
`IncludeLinks`/`IncludeEmbeds` switches select domains after permission admission.
The sole codec, scanner, producer, history and impact APIs are unchanged.

The explicit `IAdjacencyAuthority` read port independently observes actor/site,
index/source generation, document identity/epoch, scope and opaque
permission/site/session versions. Observation reads receive actor/scope only;
client expected versions and document coordinates cannot become observed facts.
Every decision binds that complete observation and its original exact
source/target coordinate. Root admission precedes lookup; source and target
admission precede filters, node/edge charging and output. Nested embed hosts need
separate admission, including the original host document identity/epoch and source
sequence/generation binding. Missing embed revision identity/kind stays missing; authoring
scope is not fabricated as a Draft/Current revision. Unknown and denied decisions
produce no withheld metadata, degree, total or marker. The returned embed projection
contains a single approved edge, coordinate/receipt and original host bindings,
never its whole admission or sibling edge set.

`CreateAdjacencyBudget` permits lowering, not raising, the hard caps of 1,000 article
nodes, 2,000 domain edges, 1 MiB, 4,096 index operations and 250 ms. The lease is
bound to one index, authority and observation; concurrent readers are refused.
It applies cumulatively across Graph depth-one/depth-two reads. Depth selection,
frame IDs and final wire-envelope bytes remain Graph responsibilities. Operations
include candidate advances, permission/source reads, source-set lookups and each
original record/coordinate comparison. Byte charges conservatively bound UTF-8
metadata and payload using three bytes per UTF-16 code unit plus scalar allowance;
the same lease also pays complete original-family revalidation work. These are
upper caps, not a promise that 2,000 edges fit before another cap is reached.
Both the supplied clock and a system monotonic deadline enforce elapsed time.
Owned timeout scopes bound awaited reads, including noncooperative asynchronous
providers; an adapter must still bound synchronous work and storage materialization.

Before a successful read returns, complete original admitted host families are
reread with bounded full-fact parity, all admitted permission coordinates are
rechecked, the authority is reobserved and the original source generation is probed
again. Provider failure, tampering, drift or any exhausted budget returns a single
empty unavailable result and invalidates earlier staged reads under the lease;
caller cancellation throws. Graph must discard all staged items on any refusal
and call `VerifyAdjacencyBudgetAsync` before publishing a multi-read result.
No partial-success or truncation receipt is emitted.

This source capability has no SQL adapter, registration, endpoint, durable store,
Graph integration or runtime privacy/latency qualification. Ordinary controlled
unit fixtures exercise the algorithm; they cannot qualify observed permissions,
provider storage bounds, device/runtime behavior or publication. The real local
FsusUI alias stays under its existing owner; no UI source or package changes occur.
