# Issue #1024 immutable release identity handoff

This file maps landed code to the issue contract without asserting that an image was built or pushed during the code-landing phase.

## Landed behavior

- `tools/release/release-id.mjs` and `src/shared/Contracts/Validation/release-id-contract.json` are the single ReleaseId format authority. A deployable identity is exactly `YYYYMMDDHHmmss-<12 lowercase commit SHA chars>`; the UTC second must be a real calendar time and must match both the full commit prefix and `createdAtUtc`. Its stable CLI exposes `create`, `parse`, `validate`, `assert` and `compare` to shell callers, while `--check` prevents generated C#/TypeScript consumers from drifting.
- `local-unversioned` is an explicit non-publishable development sentinel. SemVer and mutable aliases such as `latest`, `current` and `final-current` are never ReleaseIds. AEDS, manifest, rollout, migration and cryptographic schema versions remain independent version domains and are not parsed as ReleaseIds.
- `tools/release/release-manifest.mjs` defines the release manifest schema and rejects malformed release IDs, mutable tags, digest/tag mismatches and incomplete frontend/Wasm/ZK-local-review/toolchain identity.
- `tools/build-final-image.sh` requires exactly one local-only or push mode. It captures one canonical `releaseId` / `createdAtUtc` / full commit snapshot before any build work; an explicit `FSUSBLOG_RELEASE_ID` is accepted only together with a matching `FSUSBLOG_RELEASE_CREATED_AT_UTC`. The same snapshot tags the immutable release, labels and builds the image, feeds frontend/.NET metadata, resolves a registry digest for pushed candidates and writes `build/releases/<release-id>/release-manifest.json` atomically.
- `tools/deploy-production.sh` requires a release manifest in production, validates the exact release/slot/image reference, pulls `repository@sha256:...`, verifies pulled digest and OCI labels, and uses Compose `--no-build`. Dry-run reports release, slot, digest and rollback target.
- `ops/docker/docker-compose.production.yml` consumes the same immutable image reference and injects release ID, slot, commit, digest and runtime generation into labels and environment.
- `ReleaseIdentityProvider` fails closed for incomplete production identity, writes non-secret startup identity, contributes protected readiness detail and emits only release ID/slot response headers for gateway verification.

## Direct test owners

- `tests/tools/release-id.test.mjs` and `tests/fixtures/release/release-id-cases.json` own the authority, shell CLI, generator drift and Node cross-field behavior; the same fixture is consumed by C# and TypeScript tests.
- `tests/tools/release-manifest.test.mjs` covers manifest creation, atomic persistence, mutable-reference rejection, digest/label mismatch, deployment input and dry-run output.
- `tests/backend/Unit/ReleaseIdentityTests.cs` covers production fail-closed behavior, startup logging, protected readiness serialization and public verification headers.

## Risk and rollback

Rollback consumes a retained manifest and digest; it never reparses `latest`, `final-current` or an untagged local image. A missing registry digest or manifest disagreement blocks candidate start before traffic mutation.

## Validation status

The contract is locally verifiable without a registry, production host, image push or deploy. Manifest-schema migration and deployment-wide identity propagation remain separate follow-up changes; they consume this authority without changing its format.
