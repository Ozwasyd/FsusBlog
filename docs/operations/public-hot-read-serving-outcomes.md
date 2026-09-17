# PublicHotRead serving miss outcomes

L0 list, category, tag, and diagnostic HTML misses must not treat “not in this
snapshot” as authoritative not-found. Callers distinguish outcomes by HTTP
status and headers. Last-good serving uses the #3391 snapshot APIs
(`TryGetRequestSnapshot` reason `last-good` or `ok`).

## Outcome table

| Outcome | When | HTTP | Headers |
| --- | --- | --- | --- |
| Fresh L0 hit | Classified route is resident in the current Ready snapshot | `200` | Normal artifact cache headers. Opt-in `X-Fsus-HotRead-*` on success only. Metric `fsus.hotread.fresh.hit`. |
| Last-good hit | Age-stale or `RetainLastGood` snapshot still has the artifact | `200` | Same as a fresh hit. Metric `fsus.hotread.last_good.hit`. No `Retry-After`. |
| Not-resident / rebuild-pending | Snapshot is requestable but the artifact is not resident: un-preloaded list page/size; missing always-built taxonomy collection (`/api/binary/category.aeds`, `/api/binary/tag.aeds`); home/archive/hot/featured miss; category/tag list whose taxonomy collection is not in the snapshot; diagnostic HTML miss on last-good that is not in `htmlRemovedPaths` | `503` | `Retry-After: 1`, `Cache-Control: no-store`. No body. |
| Snapshot not ready / drop-to-empty | `IsReadyFast` is false (including `DropToEmpty`) and fail-open is off | `503` | `Retry-After: 1`, `Cache-Control: no-store`. Public HTML falls through to the AOT pipeline instead. |
| Authoritative not-found | Unpublished, deleted, or never existed under this snapshot’s public visibility: category/tag list ID absent from a snapshot that already has the matching taxonomy collection; diagnostic HTML in `htmlRemovedPaths` or missing from a complete fresh snapshot | `404` | `Cache-Control: no-store`. No `Retry-After`. No body. |
| Invalid route shape | Unclassified or rejected path characters | `404` | `Cache-Control: no-store`. Unchanged. |

Article-detail misses still fall through to the canonical binary endpoint
(`next()`); they are not a Serving `miss → 404` site. Public HTML page misses
also fall through so the AOT shell can emit the real 404/503 page.

## Classification rules

- Home, archive, hot, and featured lists always exist. A miss is not-resident
  (`503`), never `404`.
- `category.aeds` / `tag.aeds` are always-built critical artifacts. A miss is
  not-resident (`503`), never `404`. An empty catalog is a resident `200` frame.
- Category/tag *list* IDs are `404` only when that taxonomy collection is
  resident in the same snapshot and the ID has no public list pages in that
  generation. If the taxonomy collection itself is missing, the list miss is
  `503` because the catalog cannot authoritatively deny the ID.
- Diagnostic `/api/binary/article/html/{pathKey}.html` uses `htmlRemovedPaths`
  as authoritative gone (`404`). A last-good snapshot without the route is
  rebuild-pending (`503`). A complete fresh snapshot miss is `404`.

Negative L0 responses keep the existing static browser-security headers.
Diagnostic `X-Fsus-HotRead-Version` / `Artifact` / `Key` stay success-only and
must not leak keys on `404`/`503`.
