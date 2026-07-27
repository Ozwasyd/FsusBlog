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

For public AOT output, the backend serializes only the versioned `PublicBootConfig`, the external BootKernel reference, and the frontend build identity. The build identity is the immutable release ID used by the compiled entry (`local-unversioned` for the development source entry); it is distinct from the semantic manifest/index digest retained as `FrontendAssetVersion` for artifact invalidation. The document contains no inline scheduler, Trusted Types policy, intent listener, or entry injection algorithm. CSP nonce attributes remain compiler-owned: `CspNonceUtf8Template` adds the same request nonce to the JSON config carrier and external BootKernel script together with every other executable document node; the composer never writes a nonce value.

`publicBootKernel.ts` exclusively owns idle warming, foreground-intent preemption, resource priority, entry injection, and its one-shot data handoff to `entry.ts`; it does not own routes or application composition. Every configured entry, preload, and stylesheet must be a distinct same-origin HTTP(S) URL. Foreground intent cancels animation-frame, idle, fallback, forced-timer, DOM-ready, and intent-listener state before injecting the sole entry. Entry load error, CSP or Trusted Types rejection, malformed config, and handoff schema/build mismatch destroy their carriers and permit at most one same-build document navigation; a repeated same-build failure leaves the AOT document readable instead of reloading forever.

The handoff contains only its schema, frontend build identity, and a nullable serializable intent summary. `entry.ts` compares that identity with its current compiled build identity, consumes and removes the carrier exactly once, and does not receive Vue, Router, Pinia, promises, controllers, callbacks, or application state.

Rollback replaces the scoped composition implementation. It requires no endpoint, AEDS, cache-key, cache-payload, or database migration.
