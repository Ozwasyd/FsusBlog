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

The endpoint depends on this narrow use-case port directly. `AdminOperationsService`
no longer owns or forwards artifact maintenance commands, and
`AdminArtifactOperations` never calls back into the aggregate operations service.
Read-only cache diagnostics remain a separate concern.

Action names, normalization, AOT-before-public-hot ordering, queue degradation,
article-detail backfill controls, audit events, permissions, rate limits, and AEDS
request/response frames remain unchanged. Rolling back this boundary does not
require an artifact format, cache key, route, or protocol migration.
