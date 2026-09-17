# Admin Integrity Console

Admin Integrity Console troubleshoots the publication-proof chain; it is not a public verification API.

Entry points:

- frontend route: `/user/manage/integrity-proof`
- backend read-only endpoint: `GET /api/admin/integrity/console`
- backend retry endpoint: `POST /api/admin/integrity/console/proofs/{proofId}/retry`

## Permissions

Read and retry both reuse the existing `system.config` admin permission. Retry also requires `X-Fsus-Mfa-Proof` carrying an `admin-sensitive` step-up proof. The implementation adds no permission name, avoiding a wider permission matrix.

The retry endpoint is a JSON ops endpoint within the backend-operations boundary; public verification still uses `/integrity/**` manifests.

## Troubleshooting

1. Open the Integrity Proof page.
2. Optionally enter `articleId`, `articleRevisionId`, or `revisionNo` to narrow the scope.
3. Inspect recent proofs, failed/retrying proofs, the transparency log, checkpoint, and signing-key registry.
4. Retry a `failed`, `retrying`, or `pending` proof; the system requires admin step-up.

## Status meanings

- `pending`: proof is unfinished, usually waiting for a public-read artifact or background task.
- `ready`: proof is complete; its digest, signature, and public pointer can be verified.
- `failed`: proof generation failed; the console shows only low-sensitivity `failureCode`, never an exception stack.
- `retrying`: an administrator or background task triggered a retry, awaiting the proof worker.
- `superseded`: a newer revision or proof replaced this proof.
- `not-public`: the article is not currently public, so no public proof is produced.
- `chain-broken`: transparency-log chain validation failed; inspect log append and data migration first.
- `key-revoked`: the signing key used by the proof was unacceptable at signing time.

Additional auxiliary states:

- `signature-invalid`: signature format, payload, or key validation failed.
- `signature-missing`: a `ready`/`superseded` proof lacks its signature field.
- `missing`: the corresponding log or checkpoint does not yet exist.
- `stale`: the checkpoint trails the current transparency-log head.

## Data boundary

The console does not show private keys, internal exception stacks, user privacy data, comment text, site messages, audit details, IPs, sessions, or device fingerprints. Failed proofs expose only a low-cardinality failure summary; the public verification API exposes no failure details.

## Rollback

For temporary degradation, the gateway may reject `/api/admin/integrity/console/proofs/*/retry`; the read-only console does not modify data. A complete rollback must revert the console endpoint, frontend route/API, and this document.
