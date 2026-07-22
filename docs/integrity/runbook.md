# IntegrityProof Operator Runbook

Use this runbook for local proof failures, admin console triage, release evidence, and recovery actions. It is not an external anchoring runbook; IntegrityProof stays off-chain and local.

## Fast Checks

```bash
./tools/test.sh integrity-proof-verification
node --test tests/tools/integrity-proof-projection.test.mjs
```

The canonical `backend-unit` producer executes the verifier tests once and writes a source-bound producer receipt. The lightweight projection tier writes `.tmp/release-evidence/integrity-proof-verification.json`; a healthy receipt records `status=success`, `executionMode=projection`, `executionOwner=backend-unit`, and zero test-runner launches.

## Status Meanings

- `pending`: Required content or artifact inputs are not available yet. Check background publication side effects and artifact generation before retrying.
- `retrying`: A failed or pending proof has been queued again. Confirm the retry is not repeatedly blocked by the same artifact digest or key state failure.
- `proof failed`: A proof reached a non-ready state because canonical hash, artifact digest, signing, transparency log, or checkpoint work failed. Use low-cardinality failure code first; do not expose stack traces in public manifests.
- `superseded`: A later revision replaced this proof as the current public proof. Keep it available only as historical proof when the public API supports that route.
- `not-public`: The article is draft, scheduled, archived, deleted, hidden, or lacks a public artifact. Do not force a ready proof for this state.

## Admin Console Triage

1. Open `/user/manage/integrity-proof`.
2. Filter by `articleId`, `articleRevisionId`, or `revisionNo`.
3. Check proof status, signing key state, transparency log head, checkpoint state, and artifact digest summary.
4. Retry only after confirming the article is public and required artifacts exist.
5. If retry needs privileged action, provide the existing admin step-up proof; do not add password fallbacks.

## Transparency Log Broken Chain

For a broken chain:

1. Stop retrying publish proofs for the affected range.
2. Inspect `integrity_transparency_log` ordered by `seq`.
3. Find the first sequence gap, duplicate sequence, or `previous_hash` mismatch.
4. Compare rows against database backup or release evidence.
5. Rebuild local checkpoints only after the log range is understood.
6. Preserve audit and incident notes separately; do not put admin principal id or audit detail in public proof manifests.

## Checkpoint Rebuild

Use the verification gate first:

```bash
./tools/test.sh integrity-proof-verification
```

For production operations, a checkpoint rebuild command must be an explicit implemented tool before the runbook names it as runnable. Until that tool exists, rebuild through the reviewed server-side checkpoint service path and record the produced checkpoint manifest plus `.tmp/release-evidence/integrity-proof-verification.json`.

After rebuild:

- verify Merkle root from the declared leaves;
- verify the checkpoint signature against `/integrity/keys.json`;
- compare `logHeadSeq` and `logHeadHash`;
- publish the new checkpoint only if it covers the intended local log slice.

## Key Revoke And Compromise

For key revoke:

1. Set `revokedAtUtc` for the key.
2. Rotate `IntegrityProof:Signing:CurrentKeyId`.
3. Keep public metadata so historical signatures before revoke can verify.

For compromise:

1. Mark `compromisedAtUtc`.
2. Remove private key material from environment variables, secret volumes, and configuration.
3. Rotate to a clean key.
4. Treat signatures from the compromised key as untrusted.
5. Rebuild affected proofs and checkpoints where policy requires fresh trust.

Never write private keys, raw admin step-up proof, session ids, tokens, IP addresses, device fingerprints, or private draft content into release evidence.

## Escalation

Escalate when:

- a ready proof has a signature mismatch;
- transparency log broken chain affects published proofs;
- checkpoint mismatch persists after rebuild;
- a signing key is suspected compromised;
- public manifests expose any private data.
