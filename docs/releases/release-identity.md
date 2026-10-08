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

`fsusblog.release-manifest.v3` is the deployable identity authority. One manifest binds:

- release ID and creation time;
- full commit SHA;
- immutable `repository@sha256:<digest>` image reference;
- frontend, Wasm, ZK review and toolchain identities;
- the unique current-schema receipt artifact/ref/digest, exact target and database identity.

`tools/build-final-image.sh` captures this tuple once before build work and writes `build/releases/<release-id>/release-manifest.json` atomically. Explicit environment identity is accepted only as a comparison expectation and cannot replace the manifest.

The closed `identity` roster binds source/worktree/build receipt, backend artifact, frontend build/assets/Wasm, current Service Worker namespace/version, AEDS/protocol/Wasm ABI/notification artifacts, runtime roles/config/dependencies, provenance and an explicit Ed25519 key/trust policy. Every artifact has an explicit absolute reference and SHA-256. Source and frontend build IDs and the repeated image/build-manifest/Wasm digests must match. `frontend.buildManifest` binds the original `.vite/manifest.json` digest captured by the image builder; `frontend.assetManifest` independently binds the sole full `asset-manifest.json` inventory produced by the storage owner. These are different artifacts: the Vite build graph cannot substitute for an inventory of exact asset hashes and sizes. The creator requires `--identity-roster` and `--identity-roster-sha256`; publishing requires the corresponding `FSUSBLOG_RELEASE_IDENTITY_ROSTER` and `_SHA256` inputs. No missing roster is synthesized from a directory name or a default protocol version.

The manifest computes `candidateId` from the current source commit, image, frontend and Wasm digests, receipt artifact/content and database identities, toolchain, runtime profile and build target. Receipt location, release label and creation time do not choose the candidate. `contentDigest` seals the complete manifest projection, including those explicit labels and references; moving an artifact therefore requires a new manifest seal. Consumers independently recompute both values. Readiness fact projection uses the exact current receipt content digest and refuses the retired schema-window projection. This content binding does not supply the still-required signing, full contract roster or atomic activation authority.

The creator accepts `--signing-key <absolute-owned-file> --signing-key-sha256 <bare-sha256> --trust-policy <absolute-reference> --trust-policy-sha256 <sha256:digest>`. It reads bounded no-follow pinned key bytes, derives the Ed25519 public identity, signs and independently verifies artifacts/trust before immutable publication. Raw `--signature` declarations are rejected. Production image publication requires `FSUSBLOG_RELEASE_SIGNING_KEY`, `_SHA256`, and the independent trust-policy pair; an unsigned draft is never an implicit production fallback. A prepared manifest has `signature: null` and cannot pass artifact verification or activation. `signReleaseManifest` accepts a process-owned Ed25519 key and signs the manifest content digest; the signature is excluded from that digest to avoid a signing cycle. The signing authority/key/policy themselves remain inside the content seal. `verifyReleaseManifestArtifacts` independently recomputes the candidate/content identities, opens every referenced artifact and current receipt projection, verifies byte hashes and the Ed25519 signature, and checks a separately supplied trust-policy reference/digest. The canonical JSON trust policy `fsusblog.release-signing-trust.v1` has exactly `schema`, `version`, and `allowedKeys`; each admitted key has exactly `keyId`, `algorithm: ed25519`, and `publicKeySha256`. Unknown fields, duplicate keys, self-selected policy anchors, unsigned drafts and coherent resealing under an unadmitted key fail closed. `check-release-manifest --verify-artifacts true --trust-policy <absolute-reference> --trust-policy-sha256 <sha256:digest>` runs this verifier. Its result remains artifact/signature evidence with `qualificationEligible: false`; it grants neither DB admission nor traffic activation.

The existing `rollout-state create-current-activation-plan --state <explicit-path> --manifest <absolute-path> --manifest-sha256 <sha256:digest> --active-candidate <sha256:identity> --active-manifest-digest <sha256:digest>` command uses the original atomic state writer. Gateway preflight requires `FSUSBLOG_CURRENT_ACTIVATION_PLAN` and `_SHA256`; it reopens these exact bytes and the manifest rather than accepting a caller status. The existing rollout owner exports the closed `fsusblog.current-activation-plan.v1` value contract. Plans bind explicit manifest bytes, the candidate/content identities, the entire artifact/contract closure and the current active identity. Artifact verification is replayable for prepared/verified plans and grants no native admission. Phases are `prepared`, `verified`, `switching`, `active`, `failed-before-switch`, `rollback-to-unactivated-candidate`, and `restore-required`; pre-switch failure keeps the active identity, and post-switch failure requires restoration of the whole matching candidate rather than frontend/backend splicing. Phase/status, fixture flags and process/HTTP liveness never grant switch permission. The actual original Server `CurrentSchemaReceiptAdmission.VerifyAsync` needs its DB/model inspector inputs, and only startup admission publishes `CurrentSchemaAdmissionState`. There is currently no Node/CLI bridge or exact-candidate native readiness/health port; `beginCurrentActivationSwitch` and the real rollout gateway preflight therefore reject with `native_current_schema_admission_bridge_unconfigured` before traffic changes. `FSUSBLOG_RELEASE_TRUST_POLICY` and `_SHA256` are explicit independent trust anchors, not inferred candidate metadata. No new native receipt, HTTP API or synthetic grant is introduced.

Deployment binds the manifest and its bounded current-schema receipt bytes, then pulls the exact digest, verifies OCI labels and uses Compose with `--no-build`. Compose receives the same release ID, creation time, commit, digest, slot and runtime generation. A disagreement fails before candidate state is persisted or traffic is changed. Byte binding does not validate the receipt semantic seal or observe a database; the canonical C# verifier and live Server admission remain mandatory. Signing and same-candidate atomic activation are additional acceptance gates, not proved by a manifest-shaped file.

## Browser build and worker serving

The existing frontend build DAG accepts `FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY`,
`FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY_SHA256` and `FSUSBLOG_RELEASE_BROWSER_KEY_ID`
as one explicit public input group. Partial, relative-path or malformed inputs
refuse. When supplied, `prepare-current-release-browser-trust` invokes the original
browser artifact producer before Vite reads `public/`; its sole output is
`public/generated/current-release-trust.js`. The producer must be present from the
original asset-owner handoff and independently verify the pinned key bytes.
Candidate/content digests belong to the detached postseal projection and are never
inputs to this prebuild stage. The run-bound assembly includes the current asset
consumer, and backend wwwroot synchronization preserves it. These registrations do
not constitute a signed projection, a successful full build or native admission.

The existing release asset middleware grants `Service-Worker-Allowed: /` only for
`/release-assets/<canonical-release-id>/sw.js?build=<same-id>` with exactly one build
query value and no additional fields. Nested scripts, aliases, invalid calendar
IDs and mismatched/duplicate queries receive no root-scope grant. Existing cache
and `nosniff` response policies remain in force. A serving header does not authorize
worker takeover: the original exact-candidate native schema/readiness bridge is
still required before activation.

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
| authorityModules | {"adapterSupport":{"sourceDigest":"sha256:d9df238f911dbd4d72050225caa64b46e08bedeb6473ecaf45a68aade8de49fc","sourcePath":"tools/test-matrix/outcomes/adapter-support.mjs"},"attemptProvenance":{"sourceDigest":"sha256:588d132a5e30a772f1990a3ed3d3f0e9e774d7743d2a41f43b5149edbca8bf1e","sourcePath":"tools/test/attempt-provenance.mjs"},"dispositionLedger":{"sourceDigest":"sha256:2292c31e85f21b945a414f5b6408485d0e5db7b4330f068170c24077e4cdd924","sourcePath":"config/testing/release-domain-assertion-dispositions.json"},"evidenceCatalog":{"sourceDigest":"sha256:de814266fc58064e3d824e5c298d9d3e1ba2c4ba8abeb420dfca9071b8e3fd03","sourcePath":"tools/test-matrix/required-evidence-catalog.mjs"},"evidenceContract":{"sourceDigest":"sha256:d33797ebe2abbfbc282998ec7d78aa0ef3f0d235214ba04643e9db107dfd4cfe","sourcePath":"tools/test-matrix/release-final-evidence-contract.mjs"},"failureTaxonomy":{"sourceDigest":"sha256:f3535c0ec00b827ecf1c142fbcb53115392118bb6b04e5e385db12800a83d9b5","sourcePath":"config/testing/outcome-failure-taxonomy.json"},"fieldDispositions":{"sourceDigest":"sha256:2ff8090c39edde49fc0940529592c3305300c265386b8c3d5f085a401a3f41e0","sourcePath":"config/testing/outcome-field-dispositions.json"},"outcomeContract":{"sourceDigest":"sha256:f13cbfc1ad8a96d177b9d4d96237c6a576f27dbbda3be64c3c8dccc4189321e9","sourcePath":"tools/test-matrix/outcomes/outcome-contract.mjs"},"postRuntimeSeal":{"sourceDigest":"sha256:e79612098d4d345344f7de0bf28011e81e0311194275253f7372071d5ddaeb74","sourcePath":"tools/test-matrix/behavior-evidence-post-runtime.mjs"},"releaseDomainLedger":{"sourceDigest":"sha256:bcd2108efc706f7e1bfc67b26889b7911f2f16e9986d07e967f34e8157241e18","sourcePath":"tools/test-matrix/release-domain-ledger.mjs"},"requiredEvidenceLedger":{"sourceDigest":"sha256:330cb3c156529a9f7be1a7dce7484cbcf4184bdbc32ccb36e637ce692517e18a","sourcePath":"config/testing/required-evidence-authority-ledger.json"},"semanticOutcome":{"sourceDigest":"sha256:c2e1c486e5251e849c2a786721527dda64334ecce66a28c32b0217f1754b6caf","sourcePath":"tools/test-matrix/outcomes/release-finalizer-adapter.mjs"}} |
| authorityState | conflict-unknown |
| claimEligible | false |
| currentRunBindingState | not-observed-by-static-authority-extractor |
| executesTestCommands | false |
| inputContractSchema | fsusblog.release-final-evidence-inputs.v1 |
| inputCount | 22 |
| inputTierIds | ["behavior-document-consistency-final","behavior-evidence-post-runtime","behavior-evidence-pre-runtime","browser-contract","coverage-gate-strict","native-fuzz-sanitizer","perception-character-v3-release-gate","production-correctness","production-xss-release","release-admin-console","release-aot-generation","release-auth-flow","release-authoring-flow","release-closeout","release-error-boundary","release-final-flaky-governance","release-final-shard-completeness","release-private-preview","release-reliability-fresh","release-static-asset-digest-coherence","runtime-order-equivalence","test-quality-lint"] |
| outputReceiptSchema | fsusblog.release-final-test-evidence-binding.v1 |
| planSchema | fsusblog.release-finalizer-plan.v1 |
| postRuntimeSeal | {"authorityId":"behavior-evidence-post-runtime","exactness":"artifact-set-exact","receiptSchema":"fsusblog.behavior-evidence-post-runtime-receipt.v1"} |
| publishGateState | blocked-current-run-binding-unverified |
| requiredEvidenceCatalog | {"authorityIds":["behavior-document-consistency-final","behavior-evidence-post-runtime","behavior-evidence-pre-runtime","browser-contract","coverage-gate-strict","native-fuzz-sanitizer","perception-character-v3-release-gate","production-correctness","production-xss-release","release-admin-console","release-aot-generation","release-auth-flow","release-authoring-flow","release-closeout","release-error-boundary","release-final-flaky-governance","release-final-shard-completeness","release-private-preview","release-reliability-fresh","release-static-asset-digest-coherence","runtime-order-equivalence","test-quality-lint"],"contentDigest":"sha256:4c1a57654bb596b1bd2f0c0dfc3d4bbadb21b77ab0c489a4d0f71dc9898ec270","locatorBindingKeys":["current-run.behavior-document-consistency-final","current-run.behavior-evidence-post-runtime","current-run.behavior-evidence-pre-runtime","current-run.browser-contract","current-run.coverage-gate-strict","current-run.native-fuzz-sanitizer","current-run.perception-character-v3-release-gate","current-run.production-correctness","current-run.production-xss-release","current-run.release-closeout","current-run.release-final-flaky-governance","current-run.release-final-shard-completeness","current-run.runtime-order-equivalence","current-run.test-quality-lint","release-domain.projection.release-admin-console","release-domain.projection.release-aot-generation","release-domain.projection.release-auth-flow","release-domain.projection.release-authoring-flow","release-domain.projection.release-error-boundary","release-domain.projection.release-private-preview","release-domain.projection.release-static-asset-digest-coherence","release-reliability.qualified-receipt"],"schema":"fsusblog.required-evidence-authority-ledger.v1"} |
| selectedTierIds | ["release-final"] |
| semanticAdapterContractProbe | {"completeMembershipStatus":"success","missingInputReasonKinds":["contract.missing-evidence"],"missingMembershipStatus":"failed","producerAuthorityId":"tools/test-matrix/outcomes/release-finalizer-adapter.mjs"} |
| targetTier | release-final |
<!-- FSUSBLOG-GENERATED:END release.aggregate-contract -->
