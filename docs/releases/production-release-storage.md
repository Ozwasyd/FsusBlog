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

`tools/storage/release-browser-projection.mjs` derives a signed public credential
only after the original manifest verifier has read the trusted key/policy,
operational manifest, current-schema projection and every inventoried asset byte.
The credential carries the exact candidate/content identity, opaque schema digest,
current contract versions/hashes, worker identity and the sole inventory URL/hash.
It carries no database identity or host artifact path. Its signature uses the same
admitted Ed25519 key; browser verification requires independently configured public
key bytes, key identity and public-key hash, never trust taken from the response.

`public/current-release-assets.js` verifies that credential with WebCrypto and
reads only the hash-bound inventory. Install preparation hashes every JS/CSS,
Wasm/font and entry asset, checks media type, bounded size and privacy directives,
and rejects index references outside that current inventory. Immutable assets enter
an operation-owned staging cache; current cache keys bind candidate, build, worker
version and inventory digest. Warm hits are rehashed; a miss fetches only the exact
current URL. Unknown/old URLs, corrupt cache hits and copied unverified inventories
fail closed. Failed preparation and discard remove only the acquired staging cache;
cache collisions cannot acquire another operation's cleanup authority.

The SW fetch handler routes static asset requests through this consumer. Private
requests still enter the original credential-preserving network-only path first.
Generic cache-clear messages and development unregister cleanup cannot delete the
verified current static namespace; the explicit privacy panic wipe is preserved.
There is no browser trust bootstrap producer or native readiness bridge wired into
the production build yet. The original owner must emit the closed
`FsusCurrentReleaseBrowserConfiguration` through its activation bootstrap with
explicit public projection URL/hash, candidate/content identity and independent
build-pinned trust. Post-build candidate values must not be embedded in the sealed
worker artifact itself: that would make the candidate/SW digest circular. Until that
and the native admission bridge are implemented and independently accepted, install
and activate refuse before takeover and discard only owned staging. The focused
Node/WebCrypto/Cache-adapter controls are source evidence, not browser or release
qualification. Compatibility/retention tools remain pending replacement acceptance.

Worker bootstrap imports the release-ID contract and current asset verifier from
the same `/release-assets/<build>/` immutable namespace. A safe URL-segment check
only bounds the first import; the original release-ID contract still owns
canonical identity validation. Noncanonical build IDs cannot import the verifier
or acquire current admission. Root aliases are not bootstrap asset fallbacks.

## Current storage ownership planning

The existing `release-gc.mjs` owns the current registry/plan version as well as the
legacy reader awaiting retirement. `storage-ownership.v2` is closed and sealed;
it binds exact active candidate/content/release/inventory identity and one explicit
owner receipt reference/hash per path, hash and size. Current planning verifies the
original signed active manifest and inventory bytes, then matches every regular
file in the declared store against the ownership roster. Unknown files or roots,
symlinks, external hardlinks, missing active refs and any hash/size/seal drift stop
the entire plan. Active paths and content-addressed shared copies stay protected
even when a caller mislabels their owner as obsolete.

Plans retain current candidates/operations, explicit backup ownership, shared and
user ownership; they select only terminal failed-candidate or explicit obsolete
ownership for proposed deletion. Selection never depends on last access, mtime,
version count, previous-client caches or grace deadlines. Occupation reports bind
active/candidate/operation/backup/shared/user/obsolete bytes to the same per-file
closure. Independent verification recomputes that closure from the exact source,
owner bytes and filesystem; it does not discover a latest plan.

The current CLI mode requires `--ownership`, `--ownership-sha256`,
`--release-manifest`, `--release-manifest-sha256`, `--trust-policy`,
`--trust-policy-sha256` and `--store`. It emits a content-addressed plan with
`deleteExecutionEligible=false`; `--apply` explicitly refuses
`native_storage_ownership_bridge_unconfigured`. Byte-bound owner receipts can
conservatively protect backup/operation artifacts but cannot prove native operation
state or verified backup restoration. The original native owner still must supply
durable active/operation observations, policy-qualified backup/restore facts,
locked crash/retry checkpoints and independent post-delete observations before
execution/cutover. Unactivated discard planning requires only that exact terminal
candidate's owned paths. Old directory/image restart is refused; backup restore
requires the original verified native restore bridge, and forward fix requires a
new exact current admission. No source planning check grants deletion or restore.
