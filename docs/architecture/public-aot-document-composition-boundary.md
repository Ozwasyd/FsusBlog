# Public AOT document composition boundary

`IPublicAotDocumentComposition` owns the complete snapshot-to-document use case:

```text
PublicAotShellService
  -> IPublicAotDocumentComposition
       -> IPublicAotRouteIdentity
       -> IPublicAotBootstrapProvider catalog
       -> IPublicAotEntryRenderer
       -> IPublicAotDocumentService
       -> ISpaAssetManifestService
```

The module classifies route availability, builds navigation snapshots, normalizes rendered entry contracts, and composes background backfill HTML. It owns provider coverage validation; the shell no longer retains provider maps or renderer/document ports and the module never calls back into the shell.

The shell remains responsible for request-level cache/backfill orchestration and the database gate around the complete operation. Existing provider calls, canonical tag redirects, renderer version, SEO head model, cache document contents, and error classification are preserved.

Rollback replaces the scoped composition implementation. It requires no endpoint, AEDS, cache-key, cache-payload, or database migration.
