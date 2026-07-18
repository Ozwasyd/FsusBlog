# comment.v2 Repository-local cryptographic review

## Review boundary

This is a **Repository-local cryptographic review**, not an independent or third-party audit. It is intentionally reproducible using only checked-in source, fixtures and local test tooling. No external auditor identity, signature, report URL, deployment transcript or hosted service is required or claimed.

The review covers the `fsus.anonymous.comment.v3` layout v4 circuit contract, deterministic R1CS fixtures, Groth16 artifact codecs, native MCL verification boundary, browser prover fixture, nullifier/root/epoch bindings, 100-scope transcript unlinkability and fail-closed production gates. The prior v2/layout3 ceremony and key artifacts had no supported consumer and were deleted. The new setup is not run, no active key is bound, and this repository-local review does not authorize production ZK mode.

## Local conclusions

- The circuit manifest fixes the public-input order and binds `action_context`, `scope`, active/grace credential root, revocation root, credential epoch, policy and verifying-key hash.
- The nullifier PRF is domain separated by action and scope. Same-scope replay remains stable; cross-scope values differ.
- Native proof and verifying-key parsing rejects wrong magic/version, truncated/trailing payloads, invalid curve points, invalid subgroup order and non-canonical serialized points before pairing.
- Backend verification is bounded by the existing concurrency gate and timeout; cancellation, timeout and native exceptions fail closed without logging proof, witness, raw nullifier or credential secrets.
- Circuit IR, MCL/native and browser/Wasm fixtures exercise the same public-input transcript and include positive and tamper-negative paths.
- No repository-local result is represented as independent assurance. The release gate consumes this review only as reproducible local evidence; trusted-setup and real cross-stack gates remain separate.

## Findings and limitations

No unresolved repository-local Critical or High finding remains within the reviewed code and fixture boundary. This conclusion does not cover an independent protocol review, a production ceremony, external key custody, deployed side-channel measurement or a live production transcript.

The committed v3 trusted-setup manifest is `not-run` and `production_usable=false`. The local review must never change that state, substitute for a real ceremony, or set a production authorization flag.

## Reproduction

Run the focused checks from the repository root:

```bash
node tools/security/check-zk-local-review.mjs
node tools/crypto/check-zk-artifact-ownership.mjs
node tools/crypto/check-zk-comment-v2-manifests.mjs
node tools/security/check-zk-comment-v2-unlinkability.mjs
node --test tests/security/zk-local-review.test.mjs tests/security/zk-comment-v2-unlinkability.test.mjs tests/security/zk-comment-v2-circuit-fixture.test.mjs tests/security/zk-comment-v2-cross-stack-fixture.test.mjs
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter 'FullyQualifiedName~ZkProofVerifierTests|FullyQualifiedName~NativeGroth16ZkProofBackendTests|FullyQualifiedName~AnonymousPrivacyConcurrencyTests|FullyQualifiedName~ZkCommentV2CrossStackFixtureTests' -p:TreatWarningsAsErrors=true
```

The manifest at `security/zk/provenance/comment-v2-local-review.manifest.json` is a source/R1CS-only v2 review contract. It hash-binds this report, circuit source and manifests, both R1CS forms, the identity-compatible cross-stack fixture manifest, verifier/prover source and focused tests. It deliberately does not bind a selected proving or verifying key. A future production release must supply a key-bearing review plus matching trusted-setup and release evidence. Any changed byte invalidates the local review until the report and evidence are reviewed and re-bound.

## Emergency response

If a circuit constraint, setup provenance, proving/verifying key, serialization or domain-separation defect is suspected, immediately set `AnonymousIdentity:ZkProd:Enabled=false`, stop credential issuance and keep the public opt-in comment path available. Preserve only release IDs, artifact hashes and sanitized failure categories; do not retain proofs, witnesses, credentials or raw nullifiers.

Recovery uses a new circuit/layout or key epoch, regenerated circuit and setup artifacts, refreshed positive/tamper/fuzz fixtures, a re-bound local review and a new immutable release. The affected key/root remains retired, and ZK production mode stays disabled until every local review, trusted-setup, root-bootstrap and real cross-stack gate passes again.

User-facing notification template: “Anonymous private comments are temporarily unavailable while we rotate privacy proof material. Existing public comments and account access are unaffected. We do not need your proof, credential or private witness for recovery.”

## Risk response and no-restart fallback

`AnonymousIdentity:ZkProd:Enabled=false` is the safe fallback. If a local review check, artifact hash, native fixture, timeout or concurrency invariant fails, keep ZK production mode disabled and continue serving the supported identified/comment modes. A configuration provider that supports reload may disable the feature without a process restart; otherwise drain only the affected instance before changing its configuration. There is no fallback to a legacy anonymous proof or text API.
