# Issue 1211 article asset reference verification

The focused suite is `ArticleAssetReferenceLifecycleTests` plus `ArticleAssetUrlNormalizerTests`.

Covered behavior:

- two current articles share one file; the first delete does not queue it and the final source removal creates one queue row;
- a server draft keeps the file referenced after the current article source is removed;
- immutable revision sources preserve the old file through a content update and a later rollback;
- concurrent final-source removals serialize on advisory locks and create one queue item;
- the cleanup consumer rechecks all PostgreSQL sources, deletes through an `IFileService` local-storage substitute once, and treats replay as a no-op;
- path aliases normalize to one identity while external and traversal paths are rejected;
- the schema migration declares source-kind constraints, the composite reference key and the due-queue index;
- background-service classification records the worker as multi-consumer safe.

Run the focused checks with:

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --filter 'FullyQualifiedName~ArticleAssetReference|FullyQualifiedName~ArticleAssetUrlNormalizer'
node tools/check-background-service-classification.mjs
```

The tests use the repository PostgreSQL fixture and an `IFileService` substitute. They do not require object storage, a CDN, an upload endpoint or any external image service.

This change does not alter HTTP routes, AEDS frames or authorization. Anonymous, logged-in, admin, notification-stream and binary request behavior therefore stays on the existing contract; the focused suite exercises the storage boundary behind the existing admin article deletion routes.
