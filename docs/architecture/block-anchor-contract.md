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

The permission-safe producer (#2441), sole relation producer/query (#2237/#2238 and
#2443), transactional impact execution (#2447) and real package round-trip (#2450)
remain separate integration obligations. This contract does not implement or certify
those capabilities.
