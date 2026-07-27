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

The file cache commits each immutable artifact through a durable
`staged -> artifact-committed -> registry-committed -> pointer-advanced -> complete`
journal. The journal binds the artifact id, cache key, cache-root-relative path,
invalidation generation, payload SHA-256 and every Redis registry bucket. Both
the journal and its transaction pointer are content-digest sealed and replaced
atomically. A cache-key-derived cross-process file lock serializes journal
replacement and recovery for the same artifact. A file becomes readable only
when its journal is `complete`, its
transaction pointer selects the same path and generation, and the bytes match
the journal payload digest. An `artifact-committed` file is therefore not a
cache hit during the registry crash window.

Startup reconciliation consumes the bounded transaction index rather than
trusting a scan of artifact files. It resumes an intact staged or committed
transaction through the remaining idempotent registry and pointer transitions;
a missing or digest-mismatched artifact becomes `rollback-required` and any
bytes are moved to the orphan quarantine. A compatibility artifact without a
journal is also quarantined and recorded in the orphan ledger, never promoted
to a transaction. Prefix invalidation merges Redis registry members with the
transaction index, so a missing registry cannot hide an orphan transaction and
does not trigger a routine full-disk scan. Generation cleanup excludes the
active transaction path and every complete pointer target.

The shell retains request sequencing, error classification, runtime health signals, and logging. Test-session isolation, renderer/frontend compatibility, TTL, write source, and stale-write protection remain unchanged.

Hydration sidecar identity only accepts lowercase hexadecimal SHA-256. A document with a legacy Base64Url sidecar hash is a cache miss and its document entry is removed; it is never served through a compatibility branch. Recovery invalidates and rebuilds the affected entry without restarting the server. Legacy ArticleDetail artifact removal remains a one-time schema migration owned by [Retired runtime fallback migrations](../database-migration.md#retired-runtime-fallback-migrations), not a runtime admin action.

Public AOT file serving and backfill do not have a reloadable enable switch;
`PublicHotRead:Enabled=false` disables only the L0 snapshot path and must not be
described as disabling Public AOT. Rollback therefore drains and deactivates the
candidate release, then switches traffic to the preceding verified Blue/Green
slot. The candidate journal and orphan ledger remain available for operator
inspection, and that release must complete startup reconciliation before it can
be activated again. Replacing the scoped artifact-store implementation does not
change endpoints, cache payloads, database state, or AEDS contracts.
