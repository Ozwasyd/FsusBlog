# Public article-list keyset verification

The public list orders by `createtime DESC, id DESC`. The first page has no cursor; later requests return the preceding frame's `nextCursor` unchanged. This versioned opaque base64url cursor binds category, tags, and normalized keywords; clients must not parse or reuse it across filters. See the [testing strategy](../testing.md) for the canonical matrix.

## Correctness gate

Local PostgreSQL `ArticleListKeysetPaginationIntegrationTests` covers:

- multiple IDs at one `createtime`, proving composite ordering loses no rows;
- simultaneous category, tag, and keyword filters;
- a later insertion after page one, then cursor exhaustion with no duplicate or skipped original within the first-page boundary;
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` using an ordered index with no `Sort` or `OFFSET`.

Run the focused gate:

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --filter "FullyQualifiedName~ArticleListKeysetPaginationIntegrationTests"
```

The test starts only a temporary local PostgreSQL container: no production database, real traffic, or external load platform. Performance is fixed-fixture query-shape regression evidence, not a production latency promise.

## Compatibility and rollback

Existing page URLs remain available. A deep page without a cursor advances through a server-side keyset window and never uses public-list `OFFSET`. Pre-generated first-page/page artifacts emit the new cursor, which browsers prefer.

For a no-restart downgrade, clients may stop sending `cursor` and keep the old page URL; the admin list retains page/offset. Frame cache uses `core:v5` cursor identity and source-list cache uses the `v2` prefix, preventing an old envelope/cache from entering the new read path.
