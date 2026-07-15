# Audit retention and cryptographic erasure

## Security and privacy boundary

`IsHighValue` and `Critical` determine write durability and investigation priority; they do not grant indefinite retention. `AuditRetentionCatalog` is the machine-readable source of truth. Every known action has finite `maxFullRecordAge`, `maxPseudonymAge`, `aggregateAfter`, `anchorForever`, `legalHoldAllowed`, and `cryptographicEraseKeyDomain` values. A new or misspelled action is rejected before persistence, and the repository checker rejects uncovered `AuditActionCatalog` constants.

The anonymous credential issuance action has a 30-day maximum full-record and pseudonym window. Other currently registered actions have a 90-day maximum. These are maximum ages, including high-value and Critical rows.

## Retention-epoch envelope encryption

Before an audit record is signed and persisted, sensitive actor, target, request, trace, network/device, reason, event, and context fields are serialized and encrypted with AES-256-GCM under a unique retention-epoch DEK. The database and local fallback retain only the ciphertext envelope, non-identifying classification fields, and DEK-keyed actor/target pseudonyms. The DEK lives in the local `FSUSBLOG_DATA_ROOT/audit-retention/epoch-keys` store with owner-only permissions.

At expiry the cleanup flow is fail closed and ordered:

1. Load the exact expired action batch.
2. Reuse the #1111 canonical audit snapshot and order-sensitive Merkle builder to create an identity-free checkpoint.
3. Sign and append that checkpoint with the independent #1111 ECDSA key domain.
4. Destroy every batch DEK.
5. Append signed key-destruction evidence containing only hashed key-domain/epoch identities, record count, Merkle root, checkpoint digest, time, and signing-key identity.
6. Delete ciphertext rows through the active-release fenced transaction.

If checkpoint signing, append, DEK destruction, evidence persistence, or fenced deletion fails, the operation is not reported as successful. DEK destruction makes copied database rows, WAL payloads, replicas, backups, and fallback ciphertext cryptographically unreadable without claiming that the application deleted storage it does not control.

## Legal hold

Legal hold is empty/off by default. It is available only for catalog policies with `legalHoldAllowed=true` and requires a non-empty purpose, approval reference, explicit hold identity, and future expiry of at most 30 days. The registry treats the hold as inactive at expiry, so normal cleanup resumes automatically. Anonymous credential issuance does not allow legal hold.

Legal hold is an exception to deletion timing, not a bypass of encryption, query authorization, or audit durability.

## Local fallback and storage contract

Critical local fallback JSONL uses the same protected record and retention DEK. It does not write raw identity or request context. Expired fallback files are parsed fail closed, partitioned by action, anchored through the same identity-free checkpoint path, have their DEKs destroyed, and are then deleted.

`AuditRetentionStorageContract` applies the same finite ciphertext maximum to database, local fallback, backup, WAL, and replica surfaces. The application directly controls only database and local fallback cleanup. Backup, WAL, and replica deletion require operator/platform attestation; this implementation does not call or claim control over any external backup provider, object lock, TSA, public chain, replica manager, or WAL archive.

Local checkpoints and destruction evidence are append-only ordinary files, not WORM. The #1111 limitation remains: privileged same-host deletion requires custody outside the host to resist, but external custody is intentionally omitted from this local-only issue scope.

## Administrative investigation

Ordinary audit reads remain PII-redacted. Investigation disclosure additionally requires `audit.investigate`, a valid purpose string, trusted origin, and a consumed admin step-up proof. List results remain capped at 200 rows. There is no raw bulk audit export endpoint; any future export must reuse the same purpose, step-up, row-limit, query-audit, and expiry gates.

## Rollback

The safe runtime rollback is to stop the cleanup worker while keeping encrypted writes enabled. Do not revert to raw sensitive payloads, skip the anchor, retain DEKs indefinitely, or restore the old high-value/Critical SQL exclusion. Pausing cleanup increases retention age and must be treated as degraded privacy posture, but it avoids deleting data without a valid checkpoint/evidence chain.
