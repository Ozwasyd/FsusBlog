# Issue #1029 implementation handoff

The storage lifecycle implementation is now wired through the production writers that actually exist in this repository. The code remains deliberately marked **unverified** because the current orchestration instruction prohibits running tests, builds, linters, syntax checks, Docker operations, Git operations, or issue mutations.

## Completed production composition

1. `ops/docker/FsusBlog.Server.Dockerfile` injects the immutable release identity into the frontend build as `VITE_FSUSBLOG_BUILD_ID`.
2. `ops/docker/docker-compose.production.yml` mounts the append-only release asset store read-only and mounts the shared release-derived volume. `WebApplicationCompositionExtensions.UseReleaseScopedStaticAssets` installs `UseFsusReleaseAssets` and `UseFsusReleaseDerivedArtifacts` before the SPA fallback.
3. `ProductionHealth` reports the shared DataProtection probe and validates the materialized asset manifest without exposing key material.
4. `tools/deployment/release-rollout.sh` materializes release assets, persists retention state, and blocks traffic switching on retained-asset verification.
5. `FileService` uses the upload commit guard and `UploadCommitTempCleanupLease` from the existing cleanup cycle.

## Release-derived publication seam

`ReleaseDerivedArtifactPublisher` now owns both immutable generation commit and the compatibility paths consumed by the current readers.

- Kind-level publication stages a complete generation outside the visible tree, acquires `<release>/<kind>/.publication.lock` with `FileStream`/`FileShare.None`, then serializes final-generation validation, compatibility projection, commit-last aliases, and `current.json` advancement. Lock acquisition has bounded retry, cancellation, and timeout; timeout deletes staging and leaves aliases and the pointer unchanged.
- `SearchIndexService` publishes the dictionary, full shards, optional patches, `index.bin`, and `index.manifest.aeds` as one content-derived generation. `index.manifest.aeds` is projected last, so existing `/release-derived/<release-id>/search/index.manifest.aeds` clients remain valid while `/generations/<generation>/...` retains the immutable copy. `ReactivateGenerationAsync` reprojects a retained generation without restarting the process.
- Public AOT entries do not share a misleading kind-level pointer. `PublicAotFileShellCache` publishes each versioned entry through `PublishArtifactAndProjectAsync`: immutable data lives under `.artifacts/<compatibility-path-hash>/generations/<generation>`, the independent pointer lives under `.pointers/<compatibility-path-hash>.json`, and the lock lives under `.locks/<compatibility-path-hash>.lock`. Two cache keys therefore publish and roll back independently while the existing direct cache path remains readable.
- Public AOT invalidation scans exclude retained `.artifacts` generations and remove each compatibility alias plus its pointer while holding the same entry lock. A failed conflicting publish, a lock timeout, or a stored manifest whose release identity does not match the current publisher fails closed before changing aliases or pointers.

## Actual writer ownership

No placeholder writer or interface was added for a storage kind that has no production writer.

| Storage concern | Current production owner | Publication classification |
| --- | --- | --- |
| Search shards, patches, dictionary, alias, manifest | `src/backend/Services/SearchIndexService.cs` | Kind-level generation with manifest commit-last |
| Public AOT HTML plus embedded Brotli/GZip variants | `src/backend/Infrastructure/PublicAot/PublicAotFileShellCache.cs` | Per-artifact generation and pointer |
| Public AOT hydration sidecar | `src/backend/Infrastructure/PublicAot/PublicAotDocumentService.cs` | Existing content-addressed `/aot-cache/payloads/<hash>.aeds`; not a mutable multi-file generation |
| Public-hot snapshot | `PublicHotArtifactProjector` + `PublicHotReadStore` | In-memory immutable snapshot; no release-derived disk writer exists |
| SSR rendering | `PublicAotNodeSsrRenderer` | Returns rendered output to the Public AOT cache; it does not persist a separate runtime SSR tree |
| Precompressed output | `PublicAotHtmlArtifactFactory` | Brotli/GZip bytes are serialized inside the Public AOT entry and therefore use the entry publisher |
| Generated runtime manifest | `SearchIndexService` for the search manifest | No production writer targets `ReleaseStorageLayout.Paths.GeneratedManifestRoot`; no fake writer was introduced |
| Frontend asset manifest | `tools/storage/materialize-release-assets.sh` | Append-only immutable release asset store, not release-derived runtime state |

## Direct behavior coverage added

- `ReleaseStorageLifecycleTests.SearchDerivedPublication_KeepsLegacyUrlsAndGenerationPointerConsistentDuringReactivation`
- `ReleaseStorageLifecycleTests.DerivedArtifacts_TwoPublisherInstancesSerializeAliasesAndPointerToOneGeneration`
- `ReleaseStorageLifecycleTests.DerivedArtifacts_PublicationLockTimeoutLeavesAliasesAndPointerUnchanged`
- `ReleaseStorageLifecycleTests.DerivedArtifacts_TamperedReleaseIdentityCannotReactivateOrChangeVisibleState`
- `PublicAotFileShellCacheTests.SetAsync_ReleasePublisherKeepsPerArtifactPointersIndependentAndRetainsHotRollbackGeneration`

The Public AOT behavior test uses two distinct cache keys and verifies independent pointers, independent rollback/invalidation, retained newer generations, compatibility-path bytes, conflict fail-closed behavior, and wrong-release manifest rejection. The orchestrator has registered these production, test, evidence, and handoff paths in the central coverage registry, matrix, and backend requirements catalog; those registrations remain unverified until the unified validation phase.

## Verification status

No verification command has been executed. This handoff records code and test intent only; issue closure still requires the orchestrator to run the required acceptance suites and evaluate their real results.
