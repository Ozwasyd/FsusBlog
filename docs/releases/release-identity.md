# Immutable release identity

Release identity is the immutable join key for build, deployment, rollback and release evidence. It is not a SemVer, image tag, branch name or mutable environment alias.

## Canonical format and owner

`tools/release/release-id.mjs` and `src/shared/Contracts/Validation/release-id-contract.json` jointly own the format:

```text
YYYYMMDDHHmmss-<12 lowercase commit SHA characters>
```

The timestamp is a real UTC calendar second. The suffix equals the prefix of the full commit SHA and `createdAtUtc` represents the same second. `local-unversioned` is the only development sentinel and is never deployable. Names such as `latest`, `current`, `final-current` and SemVer values are rejected.

AEDS, migration, rollout, evidence and cryptographic schema versions are independent version domains. They must not be parsed as release identities.

## Immutable manifest

`fsusblog.release-manifest.v2` is the deployable identity authority. One manifest binds:

- release ID and creation time;
- full commit SHA;
- immutable `repository@sha256:<digest>` image reference;
- frontend, Wasm, ZK review and toolchain identities.

`tools/build-final-image.sh` captures this tuple once before build work and writes `build/releases/<release-id>/release-manifest.json` atomically. Explicit environment identity is accepted only as a comparison expectation and cannot replace the manifest.

Deployment validates the manifest, pulls the exact digest, verifies OCI labels and uses Compose with `--no-build`. Compose receives the same release ID, creation time, commit, digest, slot and runtime generation. A disagreement fails before candidate state is persisted or traffic is changed.

## Propagation and evidence binding

The frontend build ID, Service Worker cache identity, release-derived storage root, Wasm asset identity, runtime labels, readiness detail and release evidence namespace all derive from the same manifest. Public verification exposes only release ID and slot; full identity remains protected operational detail.

Release closeout requires `FSUSBLOG_RELEASE_MANIFEST`. Its evidence namespace and immutable artifact name are derived from the canonical identity. A timestamp-only collector namespace is diagnostic and cannot become a release credential.

## Rollback

Rollback selects a retained manifest and immutable digest. It never resolves a mutable tag or reconstructs identity from an environment file. Pre-canonical slot state is readable only through the explicit rollback compatibility entrypoint and must not be rewritten into the canonical state model.

If the retained manifest, image digest, runtime labels or release identity disagree, candidate start and rollback fail closed. Operators preserve the current active slot and reconcile from controlled runtime labels and durable deployment state.

## Local validation

```bash
node --test tests/tools/release-id.test.mjs tests/tools/release-manifest.test.mjs
node tools/release/release-id.mjs --check
```

These commands validate the contract only. They do not build, push or deploy an image.
