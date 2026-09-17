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
## Current release-final inputs

<!-- fsus-doc-claim
claimId: browserless-production-correctness.final-inputs
behaviorId: browserless-production-correctness
claimType: generated-section
generatedSectionId: release.final-input-schemas
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN release.final-input-schemas -->
- `fsusblog.release-final-evidence-inputs.v1`
<!-- FSUSBLOG-GENERATED:END release.final-input-schemas -->

## Aggregate release-final contract

<!-- fsus-doc-claim
claimId: release-final-aggregate-contract.aggregate-only
behaviorId: release-final-aggregate-contract
claimType: boolean
factPath: releaseFinalAggregate.executesTestCommands
render: boolean-negated
-->

Release closeout is aggregate-only: the contract sets `executesTestCommands` to `false` and never spawns producers to manufacture a passing result.

<!-- fsus-doc-claim
claimId: release-final-aggregate-contract.aggregate-artifact-only
behaviorId: release-final-aggregate-contract
claimType: boolean
factPath: releaseFinalAggregate.artifactOnly
render: boolean-affirmed
-->

The aggregate contract sets `artifactOnly` to `true`: it consumes artifact-bound evidence inputs only; absent evidence stays absent.

<!-- fsus-doc-claim
claimId: release-final-aggregate-contract.aggregate-contract
behaviorId: release-final-aggregate-contract
claimType: generated-section
generatedSectionId: release.aggregate-contract
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN release.aggregate-contract -->
| Key | Value |
| --- | --- |
| artifactOnly | true |
| authorityModules | {"adapterSupport":{"sourceDigest":"sha256:d9df238f911dbd4d72050225caa64b46e08bedeb6473ecaf45a68aade8de49fc","sourcePath":"tools/test-matrix/outcomes/adapter-support.mjs"},"attemptProvenance":{"sourceDigest":"sha256:588d132a5e30a772f1990a3ed3d3f0e9e774d7743d2a41f43b5149edbca8bf1e","sourcePath":"tools/test/attempt-provenance.mjs"},"dispositionLedger":{"sourceDigest":"sha256:2292c31e85f21b945a414f5b6408485d0e5db7b4330f068170c24077e4cdd924","sourcePath":"config/testing/release-domain-assertion-dispositions.json"},"evidenceCatalog":{"sourceDigest":"sha256:1e327550fde4ab0004a96765de399b99c17cde5457362312a136470d299b84e8","sourcePath":"tools/test-matrix/required-evidence-catalog.mjs"},"evidenceContract":{"sourceDigest":"sha256:3750cf27764e8954bd5c095872ea72390daebe8c80d9597861069ad70a8e769f","sourcePath":"tools/test-matrix/release-final-evidence-contract.mjs"},"failureTaxonomy":{"sourceDigest":"sha256:f3535c0ec00b827ecf1c142fbcb53115392118bb6b04e5e385db12800a83d9b5","sourcePath":"config/testing/outcome-failure-taxonomy.json"},"fieldDispositions":{"sourceDigest":"sha256:2ff8090c39edde49fc0940529592c3305300c265386b8c3d5f085a401a3f41e0","sourcePath":"config/testing/outcome-field-dispositions.json"},"outcomeContract":{"sourceDigest":"sha256:f13cbfc1ad8a96d177b9d4d96237c6a576f27dbbda3be64c3c8dccc4189321e9","sourcePath":"tools/test-matrix/outcomes/outcome-contract.mjs"},"postRuntimeSeal":{"sourceDigest":"sha256:4e0b8a954eb47e6487270ec9d9ddde416f58f143072463fa9575bbd7d0341e01","sourcePath":"tools/test-matrix/behavior-evidence-post-runtime.mjs"},"releaseDomainLedger":{"sourceDigest":"sha256:bcd2108efc706f7e1bfc67b26889b7911f2f16e9986d07e967f34e8157241e18","sourcePath":"tools/test-matrix/release-domain-ledger.mjs"},"requiredEvidenceLedger":{"sourceDigest":"sha256:fedb30a44d2aa3612192cd4c23aa8662a5e01dc35e0f76e1ae212e54cd8cf418","sourcePath":"config/testing/required-evidence-authority-ledger.json"},"semanticOutcome":{"sourceDigest":"sha256:c2e1c486e5251e849c2a786721527dda64334ecce66a28c32b0217f1754b6caf","sourcePath":"tools/test-matrix/outcomes/release-finalizer-adapter.mjs"}} |
| authorityState | conflict-unknown |
| claimEligible | false |
| currentRunBindingState | not-observed-by-static-authority-extractor |
| executesTestCommands | false |
| inputContractSchema | fsusblog.release-final-evidence-inputs.v1 |
| inputCount | 21 |
| inputTierIds | ["behavior-document-consistency-final","behavior-evidence-post-runtime","behavior-evidence-pre-runtime","browser-contract","coverage-gate-strict","native-fuzz-sanitizer","perception-character-v3-release-gate","production-correctness","production-xss-release","release-admin-console","release-aot-generation","release-auth-flow","release-authoring-flow","release-closeout","release-error-boundary","release-final-flaky-governance","release-final-shard-completeness","release-private-preview","release-reliability-fresh","release-static-asset-digest-coherence","test-quality-lint"] |
| outputReceiptSchema | fsusblog.release-final-test-evidence-binding.v1 |
| planSchema | fsusblog.release-finalizer-plan.v1 |
| postRuntimeSeal | {"authorityId":"behavior-evidence-post-runtime","exactness":"artifact-set-exact","receiptSchema":"fsusblog.behavior-evidence-post-runtime-receipt.v1"} |
| publishGateState | blocked-current-run-binding-unverified |
| requiredEvidenceCatalog | {"authorityIds":["behavior-document-consistency-final","behavior-evidence-post-runtime","behavior-evidence-pre-runtime","browser-contract","coverage-gate-strict","native-fuzz-sanitizer","perception-character-v3-release-gate","production-correctness","production-xss-release","release-admin-console","release-aot-generation","release-auth-flow","release-authoring-flow","release-closeout","release-error-boundary","release-final-flaky-governance","release-final-shard-completeness","release-private-preview","release-reliability-fresh","release-static-asset-digest-coherence","test-quality-lint"],"contentDigest":"sha256:f4b8b4116ff1b6fa8d942c0fbac16a4cda6ccde3ac73c2119148bb6b04b30a57","locatorBindingKeys":["current-run.behavior-document-consistency-final","current-run.behavior-evidence-post-runtime","current-run.behavior-evidence-pre-runtime","current-run.browser-contract","current-run.coverage-gate-strict","current-run.native-fuzz-sanitizer","current-run.perception-character-v3-release-gate","current-run.production-correctness","current-run.production-xss-release","current-run.release-closeout","current-run.release-final-flaky-governance","current-run.release-final-shard-completeness","current-run.test-quality-lint","release-domain.projection.release-admin-console","release-domain.projection.release-aot-generation","release-domain.projection.release-auth-flow","release-domain.projection.release-authoring-flow","release-domain.projection.release-error-boundary","release-domain.projection.release-private-preview","release-domain.projection.release-static-asset-digest-coherence","release-reliability.qualified-receipt"],"schema":"fsusblog.required-evidence-authority-ledger.v1"} |
| selectedTierIds | ["release-final"] |
| semanticAdapterContractProbe | {"completeMembershipStatus":"success","missingInputReasonKinds":["contract.missing-evidence"],"missingMembershipStatus":"failed","producerAuthorityId":"tools/test-matrix/outcomes/release-finalizer-adapter.mjs"} |
| targetTier | release-final |
<!-- FSUSBLOG-GENERATED:END release.aggregate-contract -->
