# Issue #1024 immutable release identity handoff

This file maps landed code to the issue contract without asserting that an image was built or pushed during the code-landing phase.

## Landed behavior

- `tools/release/release-manifest.mjs` defines the release manifest schema and rejects malformed release IDs, mutable tags, digest/tag mismatches and incomplete frontend/Wasm/ZK-local-review/toolchain identity.
- `tools/build-final-image.sh` requires exactly one local-only or push mode. It accepts an explicit `FSUSBLOG_RELEASE_ID`, or generates `<UTC timestamp>-<12-char commit>` when the value is absent; both paths pass the same safe immutable-ID validation. It tags the immutable release, resolves a registry digest for pushed candidates and writes `build/releases/<release-id>/release-manifest.json` atomically.
- `tools/deploy-production.sh` requires a release manifest in production, validates the exact release/slot/image reference, pulls `repository@sha256:...`, verifies pulled digest and OCI labels, and uses Compose `--no-build`. Dry-run reports release, slot, digest and rollback target.
- `ops/docker/docker-compose.yml` consumes the same immutable image reference and injects release ID, slot, commit, digest and runtime generation into labels and environment.
- `ReleaseIdentityProvider` fails closed for incomplete production identity, writes non-secret startup identity, contributes protected readiness detail and emits only release ID/slot response headers for gateway verification.

## Direct test owners

- `tests/tools/release-manifest.test.mjs` covers manifest creation, atomic persistence, mutable-reference rejection, digest/label mismatch, deployment input and dry-run output.
- `tests/backend/Unit/ReleaseIdentityTests.cs` covers production fail-closed behavior, startup logging, protected readiness serialization and public verification headers.

## Risk and rollback

Rollback consumes a retained manifest and digest; it never reparses `latest`, `final-current` or an untagged local image. A missing registry digest or manifest disagreement blocks candidate start before traffic mutation.

## Validation status

No build, registry push, image inspection or test command was executed in this phase.
