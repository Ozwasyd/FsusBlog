# Admin artifact operations boundary

`IAdminArtifactOperations` owns the write-side admin actions for search, public-hot,
Public AOT, article-detail AEDS, output-cache, and SEO artifacts:

```text
POST /api/binary/admin/cache/actions
  -> IAdminArtifactOperations
       -> ISearchIndexService
       -> PublicHotArtifactUpdateQueue
       -> IPublicAotInvalidationService
       -> IArticleDetailAedsArtifactMaintenanceService
       -> ICacheInvalidationDispatcher
```

The endpoint depends on this narrow use-case port directly. Integrity operations
do not own or forward artifact maintenance commands, and
`AdminArtifactOperations` never call back into integrity operations.
Read-only cache diagnostics remain a separate concern.

Action names, normalization, AOT-before-public-hot ordering, queue degradation,
article-detail backfill controls, audit events, permissions, rate limits, and AEDS
request/response frames remain unchanged. Rolling back this boundary does not
require an artifact format, cache key, route, or protocol migration.
