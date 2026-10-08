# Production release storage contract

The production host provides four non-overlapping roots:

```text
shared/                         PostgreSQL/Redis endpoints, uploads, DataProtection and secrets
derived/<release-id>/           AOT, public-hot, search, SSR, precompressed output and manifests
release-assets/releases/<id>/   browser-addressable immutable release tree
instances/<slot>/<id>/<inst>/   logs, temp and runtime snapshots
```

Required production identity:

- `FSUSBLOG_RELEASE_ID`: immutable ID from `release-manifest.json`;
- `FSUSBLOG_RELEASE_SLOT`: `blue` or `green`;
- `FSUSBLOG_DEPLOYMENT_GENERATION`: immutable candidate generation;
- `VITE_FSUSBLOG_BUILD_ID`: the same release ID at frontend build time;
- `DataProtection__ApplicationName=FsusBlog`;
- `DataProtection__KeyRingPath`: the shared controlled ring;
- `FSUSBLOG_RELEASE_ASSET_STORE`: host asset store, default `/var/lib/fsusblog/release-assets`.
- `FSUSBLOG_RELEASE_DERIVED_ROOT`: host/volume root containing `<release-id>/search` and the other derived classes; setting it also changes browser search URLs to `/release-derived/<release-id>/search/*`.

The candidate sequence is:

1. Verify the immutable image and release manifest.
2. Verify the sealed CI production receipt and materialize the image's `/app/wwwroot` under its release ID.
3. Create the immutable SPA descriptor and retained receipt before starting the candidate.
4. Verify append-only hashes and retention state.
5. Mount the materialized `releases` directory read-only and expose `/release-assets`; expose the derived root at `/release-derived` through `UseFsusReleaseDerivedArtifacts`.
6. Build candidate-derived generations under the candidate release ID; never clear the active release.
7. Run the compatibility matrix and warm/read smoke checks.
8. Switch the gateway only after all gates pass.
9. Persist active/previous/draining retention state before any GC.

The materialization host entry is:

```bash
bash tools/storage/materialize-release-assets.sh \
  --release-manifest build/releases/<release-id>/release-manifest.json \
  --build-receipt .tmp/ci-production-build/receipt.json \
  --slot green \
  --store /var/lib/fsusblog/release-assets \
  --runtime-release-asset-root /app/release-assets \
  --out .tmp/release-assets-materialization.json
```

Use `--source <wwwroot>` for an already extracted tree. Otherwise the tool creates a temporary container from the manifest's digest-pinned `imageRef`, copies `/app/wwwroot`, and removes the container. Receipt schema, source identity, producer, toolchain, inputs, domains, exact artifact paths/sizes/digests, digest table, and immutable seal are validated before asset-store mutation. The extracted source must be the exact receipted `frontend-dist` path/size/digest set before the first install. `--dry-run` performs the same receipt/source validation and collision discovery but does not mutate the asset store.

The output schema is `fsusblog.release-assets.materialization.v1`. `status=ok` or `dry-run` is required; `status=fail` exits non-zero. Stable fields include `releaseId`, `slot`, `dryRun`, `assetManifestSha256`, `spaManifestDescriptor`, `spaManifestDescriptorSha256`, `productionBuildReceipt`, `productionBuildReceiptSha256`, `assets`, `actions`, and `errors`. The four SPA authority fields are `null` only for a successful dry-run.

Risk and no-restart fallback: do not repoint a mutable entry to the candidate until candidate assets and compatibility pass. If a post-switch issue occurs, switch traffic to the previous slot and previous build ID; its static and derived state remains retained. DataProtection and uploads remain shared, so sessions and durable user content do not require a restart or copy.


## Current inventory source verification

The sole `asset-manifest.json` inventory remains produced by `release-assets.mjs`.
The current release signature verifier reads its pinned bytes, requires the exact
release/build identity and no compatibility metadata, and independently reads each
listed asset beside that inventory. Every URL, relative path, SHA-256, size and
cache class must agree; duplicate paths, aliases, private paths, traversal and extra
fields fail closed. The fixed media type is derived from the hash-bound file path.
The Vite build graph is a separate artifact and cannot replace this inventory.
These checks provide source artifact evidence; they do not provide browser install,
native schema admission, readiness or Service Worker activation evidence.


The checked-in worker now rejects install and activate with
`current_release_browser_admission_unconfigured` before `skipWaiting`,
`clients.claim` or any lifecycle cache deletion. A canonical build query, caller
status, fixture flag or cached response cannot admit it. Successful installation
still needs a public signed projection from the sole release owner binding the
candidate, inventory bytes, contract versions and SW identity, plus the original
Server native same-candidate admission/readiness bridge. The operational manifest
and database identities must remain private. Source refusal tests do not replace
the remaining cold/warm browser, interrupted update and request-byte acceptance.
