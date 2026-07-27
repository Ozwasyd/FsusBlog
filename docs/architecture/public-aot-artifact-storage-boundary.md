# Public AOT artifact storage boundary

`IPublicAotArtifactStore` owns the cache and backfill artifact consistency boundary:

```text
PublicAotShellService
  -> IPublicAotArtifactStore
       -> IPublicAotShellCache
       -> IPublicAotCacheWriter
       -> IPublicAotBackfillScheduler
       -> ISpaAssetManifestService
       -> IRuntimeKeyScope
       -> PublicAotInvalidationTracker
```

The module derives runtime-scoped, invalidation-versioned document keys for every route, resolves frontend asset compatibility, reads and removes cached shells, schedules cold-miss backfills, rejects stale writes after invalidation, writes rendered artifacts, and invalidates the store. It never calls back into `PublicAotShellService`.

Rendering and staging remain outside the publication boundary. Each commit request carries the immutable cache key, page coordinate, scheduled generation, frontend/renderer versions, and payload digest. The final artifact write and `PublicHotRead` publish run under the page publication lock after rereading that coordinate. Page, route, and global invalidations acquire the same coordinate before advancing it and clearing compatibility projections. A successful commit records an in-memory receipt with scheduled/current/published generations plus matching SHA-256 payload, artifact, and hot-read digests. A stale request returns without a cache write or hot-read publish; a non-list route therefore cannot overwrite a bare current artifact after its invalidation generation has advanced.

The shell retains request sequencing, error classification, runtime health signals, and logging. Test-session isolation, renderer/frontend compatibility, TTL, write source, and stale-write protection remain unchanged.

Hydration sidecar identity only accepts lowercase hexadecimal SHA-256. A document with a legacy Base64Url sidecar hash is a cache miss and its document entry is removed; it is never served through a compatibility branch. Recovery invalidates and rebuilds the affected entry without restarting the server. Legacy ArticleDetail artifact removal remains a one-time schema migration owned by [Retired runtime fallback migrations](../database-migration.md#retired-runtime-fallback-migrations), not a runtime admin action.

Rollback replaces the scoped artifact-store implementation without changing endpoints, cache payloads, database state, or AEDS contracts.
