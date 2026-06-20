# comment.v2 trusted setup ceremony contract

Status: verified self-written trusted setup artifact contract for #552. The
repository contains the deterministic R1CS IR, the binary Groth16 R1CS phase-2
input, self-written phase transcripts, final proving key, canonical verifying
key, browser prover bundle, and hash-bound runtime verifying-key config. Runtime
ZK-Prod remains disabled by default until the production release gates, issuer,
credential root bootstrap, and rollout configuration all pass.

## Canonical Paths

Verifier/prover work must read the same manifest paths:

| Purpose | Path |
| --- | --- |
| Circuit constraints | `security/zk/comment-v2-circuit.manifest.json` |
| Trusted setup | `security/zk/comment-v2-trusted-setup.manifest.json` |
| Runtime verifying-key config | `config/zk/anonymous-comment-v2-verifying-key.manifest.json` |
| Checker | `tools/crypto/check-zk-comment-v2-manifests.mjs` |

The manifest names are stable. Artifact paths inside the setup manifest are the
handoff contract for #552 trusted setup artifacts, #553 browser wasm prover
bundle, and #555 native verifier / prover cross-stack fixture evidence.
`artifacts.r1cs` is the deterministic repository IR
`fsusblog.zk.r1cs-ir.v1` and is explicitly `ceremony_input=false`; phase-2
commands must consume `artifacts.groth16_r1cs.path`, whose SHA-256 is committed
in the trusted setup manifest before the ceremony starts.

## Ceremony Requirements

The checked-in self-written setup provides:

1. A verified Powers of Tau phase-1 transcript for the selected curve.
2. A circuit-specific Groth16 phase-2 transcript for
   `fsus.anonymous.comment.v2`.
3. A binary Groth16 R1CS file generated from the committed circuit source and
   distinct from the deterministic repository IR.
4. A proving key for the browser prover asset pipeline.
5. Canonical verifying key bytes for the native verifier.
6. Transcript manifests with contribution hashes and verification commands.
7. A `verifying_key_hash = SHA256(canonical_verifying_key_bytes)` value bound to
   `circuit_id = fsus.anonymous.comment.v2` and
   `public_input_layout_version = 3` by the setup and config manifests.

The verifier must reject a proof if the public input layout version, circuit id,
or verifying key hash differs from the active root/config snapshot.

## Verified Artifact State

The committed manifests now deliberately use:

- `ceremony_status: "verified"`
- `production_usable: true`
- `verifying_key_hash =
  27ea8a04e27eb66a5b61aab2251762a372bb3f39217c896bc5ad850fd859143c`
- hash-bound pk, vk, phase transcript, and browser prover bundle artifacts

That state is valid for repository artifact verification. It is not by itself a
runtime rollout approval. `AnonymousIdentity:ZkProd:Enabled=true` still requires
native verifier configuration, trusted setup verification, circuit-native
credential issuer readiness, active credential roots, real smoke evidence, and
release gate success before startup/readiness can pass.

## Upgrade Rule

Changing any public input name, order, encoding, field width, semantic meaning,
or hash domain requires:

1. incrementing `public_input_layout_version`,
2. creating a new circuit manifest,
3. running a new circuit-specific Groth16 setup,
4. publishing a new verifying key hash,
5. rotating credential root metadata to the new layout.

Reusing the `comment.v2` verifying key for a changed public layout is forbidden.

## Verification Commands

Current static verification:

```bash
node tools/crypto/check-zk-comment-v2-manifests.mjs
node tools/security/check-mcl-platform-assets.mjs
npm --prefix src/frontend run build:wasm
cd src/frontend && node ../../tools/frontend/ensure-wasm.mjs status
node tools/crypto/build-zk-comment-v2-circuit-fixture.mjs --check
node --test tests/security/zk-comment-v2-circuit-fixture.test.mjs
node --test tests/security/zk-comment-v2-cross-stack-fixture.test.mjs
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter FullyQualifiedName~ZkCommentV2CrossStackFixtureTests
node --test tests/security/zk-comment-v2-manifest.test.mjs
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
