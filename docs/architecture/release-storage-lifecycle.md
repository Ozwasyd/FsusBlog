# Release storage lifecycle

Release storage is classified by lifecycle, not by the container that first wrote a file. Blue and green may read shared durable state, but a candidate may never mutate active release-derived state or replace bytes behind an immutable asset URL.

## State classes

| Class | Contents | Ownership | Mutation rule |
| --- | --- | --- | --- |
| Durable shared | PostgreSQL, Redis, uploads, DataProtection key ring, runtime secrets | environment | shared by both slots; backed up and access controlled |
| Release-derived | Public AOT, public-hot projections, search, SSR, precompressed output, generated manifests | release ID | stage a generation, rename atomically, retain old generation and old release |
| Immutable cross-release | hashed JS/CSS/Wasm/fonts and asset manifests | release ID plus SHA-256 object | append only; same path/same hash is idempotent, same path/different hash fails closed |
| Instance-scoped | logs, upload staging, temporary files, runtime snapshots | slot/release/instance | never shared as mutable state; lease-protected cleanup |

`ReleaseStorageLayout` is the path authority. It validates release, slot and instance identity; constructs non-overlapping roots; and rejects cleanup outside the current release. `ReleaseDerivedArtifactPublisher` writes every search or renderer generation to a same-filesystem staging directory, fsyncs it, renames it to `generations/<generation>`, and only then atomically updates `current.json`. It does not delete prior generations.

## Shared security state

Production uses one controlled DataProtection ring and the exact application discriminator `FsusBlog`. Both slots must mount the same key-ring path read/write. `DataProtectionKeyRingProbe` reports only directory/read/write/application-name state; it never returns key names or contents. Cross-slot conformance protects with the old provider and unprotects with the new provider, then performs the reverse direction.

Uploads use a shared final directory. Direct uploads and chunk completion write an instance-namespaced `.incoming` file on the final filesystem, flush it, and rename with `overwrite: false`. Chunked final names are deterministic from `uploadId`, so a retry returns the same result after validating signature, length, and SHA-256. A pre-existing different payload fails closed. `UploadCommitTempCleanupLease` combines an exclusive handle with a random CAS token; cleanup protects the current instance and the retention window.

## Static assets

`tools/storage/release-assets.mjs` stores each file in both:

- `objects/<sha256>/<relative-path>` for content-addressed retention;
- `releases/<release-id>/<relative-path>` for the browser URL `/release-assets/<release-id>/<relative-path>`.

An existing destination is accepted only when its SHA-256 is identical. Mutable entry documents receive `no-store,max-age=0,must-revalidate`; all other files receive `public,max-age=31536000,immutable`. `ReleaseAssetStaticFileExtensions.UseFsusReleaseAssets` exposes the retained release directories and emits `X-Fsus-Frontend-Build` without falling back to a different release.

The CI production build receipt is sealed before release materialization. Its
read-only `frontend-dist` domain binds the original `.vite/manifest.json` and every
other frontend file by exact receipt-relative path, size, and SHA-256. The later
`asset-manifest.json` is intentionally absent from that receipt. Materialization
first validates the complete CI receipt and requires the extracted image source to
match that exact path/size/digest set before writing the asset store. It then creates
the release inventory from the copied file set and retains the receipt as
`releases/<releaseId>/production-build-receipt.json` and creates
`spa-manifest-descriptor.json`; neither authority may be replaced by a handwritten
subset.

Production SPA loading does not discover a `dist` directory. The runtime receives
`FSUSBLOG_SPA_MANIFEST_DESCRIPTOR` and
`FSUSBLOG_PRODUCTION_BUILD_RECEIPT`, both fixed to the current retained release. The
descriptor binds `releaseId`, `sourceCommit`, `worktreeFingerprint`,
`buildReceiptDigest`, `assetRoot`, `manifestPath`, `manifestDigest`, and
`assetInventoryDigest`, plus its canonical `contentDigest`. Validation requires the
receipt's `frontend-dist` artifacts, the inventory entries, and the materialized
release files to be the same set with identical paths, sizes, and digests. The
descriptor rejects missing, duplicate, extra, or undeclared fields, and `assetRoot`
must equal the current release directory below `FSUSBLOG_RELEASE_ASSET_ROOT`. Both
authority paths and every traversed component must stay inside the current release
root without symlinks.

A missing or mismatched descriptor, receipt, inventory, `index.html`, or Vite
manifest is a readiness failure. Readiness publishes the validated descriptor,
receipt, source/worktree, release, manifest, and inventory paths and digests; failure
publishes those fields as explicit `null` values plus the stable error. Production
template and stylesheet resolution consume only that validated snapshot; they never
search another `dist`, webroot asset directory, mtime, or latest candidate.

The frontend uses the generated canonical ReleaseId contract to normalize
`VITE_FSUSBLOG_BUILD_ID` once for bootstrap import recovery, Service Worker
query/cache identity, release-derived search paths, and Wasm release assets.
Production Vite builds fail closed when the value is missing, a mutable alias,
SemVer, or otherwise non-canonical; runtime production consumers also reject an
invalid identity instead of falling back to `unversioned`. Local Vite serve uses
the explicit `local-unversioned` sentinel, keeps release-derived search/Wasm on
their development paths, and does not register a production Service Worker.

## Compatibility metadata

`release-compatibility.mjs` records the frontend build ID, backend protocol range, AEDS emitted/decoder range, notification protocol range, service-worker namespace, Wasm ABI range, and asset-manifest hash binding. Materialization writes it as append-only `releases/<release-id>/release-compatibility.json` after hashing `asset-manifest.json`; the retained-asset gate verifies that binding. The generated matrix has explicit N-to-N, N-1-client-to-N-server, previous-client, old-service-worker asset retention, and old-decoder scenarios. Any failed scenario blocks traffic switching.

## Garbage collection boundary

GC is explicit and dry-run by default. `release-gc.mjs` protects active, previous, draining, retention-window, externally referenced, and the minimum newest release count. It derives protected object hashes from protected release manifests, acquires `.gc.lock` with create-new semantics, records before/after evidence, and deletes only with `--apply`. Missing active/previous assets or an unreadable protected manifest aborts the operation.
