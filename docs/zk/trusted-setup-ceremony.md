# comment.v3 trusted setup ceremony contract

Status: setup required. The v3/layout 4 statement removes the stable public
credential commitment, so the v2/layout 3 phase transcripts and keys cannot be
reused. The repository contains the new deterministic R1CS IR and binary
Groth16 R1CS handoff, while runtime ZK-Prod stays fail-closed until a fresh
ceremony, prover bundle, root rotation and release evidence all pass.

## Canonical Paths

Verifier/prover work must read the same manifest paths:

| Purpose | Path |
| --- | --- |
| Circuit constraints | `security/zk/comment-v2-circuit.manifest.json` |
| Trusted setup | `security/zk/comment-v2-trusted-setup.manifest.json` |
| Runtime verifying-key config | `config/zk/anonymous-comment-v2-verifying-key.manifest.json` |
| Repository-local review | `security/zk/comment-v2-local-review.manifest.json` |
| Artifact ownership and storage | `security/zk/artifact-ownership.manifest.json` |
| Checker | `tools/crypto/check-zk-comment-v2-manifests.mjs` |

The manifest names are stable. Artifact paths inside the setup manifest are the
handoff contract for #552 trusted setup artifacts, #553 browser wasm prover
bundle, and #555 native verifier / prover cross-stack fixture evidence.
`artifacts.r1cs` is the deterministic repository IR
`fsusblog.zk.r1cs-ir.v1` and is explicitly `ceremony_input=false`; phase-2
commands must consume `artifacts.groth16_r1cs.path`, whose SHA-256 is committed
in the trusted setup manifest before the ceremony starts.

## Ceremony Requirements

A production ceremony must provide:

1. A verified Powers of Tau phase-1 transcript for the selected curve.
2. A circuit-specific Groth16 phase-2 transcript for
   `fsus.anonymous.comment.v3`.
3. A binary Groth16 R1CS file generated from the committed circuit source and
   distinct from the deterministic repository IR.
4. A proving key for the browser prover asset pipeline.
5. Canonical verifying key bytes for the native verifier.
6. Transcript manifests with contribution hashes and verification commands.
7. A `verifying_key_hash = SHA256(canonical_verifying_key_bytes)` value bound to
   `circuit_id = fsus.anonymous.comment.v3` and
   `public_input_layout_version = 4` by the setup and config manifests.

The verifier must reject a proof if the public input layout version, circuit id,
or verifying key hash differs from the active root/config snapshot.

The repository currently provides only the two deterministic v3/layout4 R1CS
inputs. Phase transcripts, proving/verifying keys and delivery bundles are not
checked into ordinary Git. Their storage authority is immutable release or OCI
artifact storage, addressed by SHA-256 and bound to the trusted-setup and
release-evidence manifests.

## Committed Artifact State

The committed manifests now deliberately use:

- `ceremony_status: "not-run"`
- `production_usable: false`
- an empty active `verifying_key_hash`
- a non-empty `fail_closed_reason`
- required-but-missing v3 pk, vk, phase transcript, and browser prover bundle
  artifacts

That state is valid only for repository artifact consistency checks. It is not a
trusted setup result and cannot satisfy production readiness.
`AnonymousIdentity:ZkProd:Enabled=true` still requires #552 to replace the
placeholder artifacts with a real ceremony, plus native verifier configuration,
circuit-native credential issuer readiness, active credential roots, real smoke
evidence, and release gate success before startup/readiness can pass.

## Upgrade Rule

Changing any public input name, order, encoding, field width, semantic meaning,
or hash domain requires:

1. incrementing `public_input_layout_version`,
2. creating a new circuit manifest,
3. running a new circuit-specific Groth16 setup,
4. publishing a new verifying key hash,
5. rotating credential root metadata to the new layout.

Reusing the v2/layout 3 verifying key for this changed public layout is forbidden.

## Verification Commands

Current static verification:

```bash
node tools/crypto/check-zk-comment-v2-manifests.mjs
node tools/crypto/check-zk-artifact-ownership.mjs
node tools/security/check-zk-local-review.mjs
node tools/security/check-mcl-platform-assets.mjs
npm --prefix src/frontend run build:wasm
cd src/frontend && node ../../tools/frontend/ensure-wasm.mjs status
node tools/crypto/build-zk-comment-v2-circuit-fixture.mjs --check
node --test tests/security/zk-comment-v2-circuit-fixture.test.mjs
node --test tests/security/zk-comment-v2-cross-stack-fixture.test.mjs
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter FullyQualifiedName~ZkCommentV2CrossStackFixtureTests
node --test tests/security/zk-comment-v2-manifest.test.mjs
node --test tests/tools/issue-1168-zk-artifact-ownership.test.mjs
node tools/security/check-security-matrices.mjs
```

`tests/fixtures/zk/comment-v2/mcl-pairing` is a repository MCL pairing fixture
for #555 backend verifier coverage only. It proves the managed native verifier
can load committed vk/proof/public input bytes, bind the canonical transcript,
and reject tampered proof or scope. The public browser prover bundle is covered
separately by `tests/security/zk-comment-v2-cross-stack-fixture.test.mjs`, which
loads `src/frontend/public/wasm/comment-privacy-prover.js`, calls the C++23
WASM runtime, emits a proof, and verifies it through the MCL fixture tool.

The MCL platform gate is intentionally scoped to mainstream server deployment
RIDs: `linux-x64`, `linux-arm64`, `osx-x64`, `osx-arm64`, `win-x64`, and
`win-arm64`. `check-mcl-platform-assets.mjs` reads the restored NuGet package
and fails if any required native asset is absent; `linux-musl`/Alpine, mobile
and browser wasm remain outside this native distribution promise.

Production verification must run the commands recorded in
`security/zk/comment-v2-trusted-setup.manifest.json`, including phase transcript
verification, vk hash recomputation, and proof generation by the final proving
key verified against the final verifying key.

The local review is a separate repository-owned evidence layer. It validates
artifact and test consistency without requiring an external service or auditor,
and it never changes `ceremony_status` or `production_usable`. The complete
boundary and limitations are recorded in
`docs/zk/comment-v2-local-cryptographic-review.md`.
