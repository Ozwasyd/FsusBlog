# Admin cache diagnostics boundary

`IAdminCacheDiagnosticsReader` owns the read-side cache and artifact diagnosis use
case:

```text
GET /api/binary/admin/cache/diagnostics
  -> IAdminCacheDiagnosticsReader
       -> cache ownership/storage snapshots and runtime counters
       -> public-hot and Public AOT runtime snapshots
       -> search manifest and distribution diagnostics
       -> optional article visibility/artifact diagnosis
```

The endpoint consumes the narrow reader directly. `AdminOperationsHealthReader`
uses only its search-index snapshot while composing the broader operations
health view; integrity operations do not own or forward the cache-diagnostics
request and do not depend on cache storage, invalidation, counter, or
distribution ports. The diagnostics reader never calls back into integrity
operations.

The route, admin permission, fixed-IP rate limit, AEDS frame, status aggregation,
manifest format, cache ownership catalog, and diagnostic wording remain
unchanged. Rollback requires no cache flush or artifact migration.
