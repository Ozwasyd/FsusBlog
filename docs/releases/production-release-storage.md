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
2. Materialize the image's `/app/wwwroot` under its release ID.
3. Verify append-only hashes and retention state.
4. Mount the materialized `releases` directory read-only and expose `/release-assets`; expose the derived root at `/release-derived` through `UseFsusReleaseDerivedArtifacts`.
5. Build candidate-derived generations under the candidate release ID; never clear the active release.
6. Run the compatibility matrix and warm/read smoke checks.
7. Switch the gateway only after all gates pass.
8. Persist active/previous/draining retention state before any GC.

The materialization host entry is:

```bash
bash tools/storage/materialize-release-assets.sh \
  --release-manifest build/releases/<release-id>/release-manifest.json \
  --slot green \
  --store /var/lib/fsusblog/release-assets \
  --out .tmp/release-assets-materialization.json
```

Use `--source <wwwroot>` for an already extracted tree. Otherwise the tool creates a temporary container from the manifest's digest-pinned `imageRef`, copies `/app/wwwroot`, and removes the container. `--dry-run` performs collision discovery but does not mutate the asset store.

The output schema is `fsusblog.release-assets.materialization.v1`. `status=ok` or `dry-run` is required; `status=fail` exits non-zero. Stable fields include `releaseId`, `slot`, `dryRun`, `assetManifestSha256`, `assets`, `actions`, and `errors`.

Risk and no-restart fallback: do not repoint a mutable entry to the candidate until candidate assets and compatibility pass. If a post-switch issue occurs, switch traffic to the previous slot and previous build ID; its static and derived state remains retained. DataProtection and uploads remain shared, so sessions and durable user content do not require a restart or copy.
