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

### Required channel admission and recovery

The catalog classifies the production `AuditLogChannel` owner as required, including
ordinary records. `TryWrite=true` means a protected record has been published to
`FSUSBLOG_DATA_ROOT/audit-fallback`, not that a volatile channel accepted it. There is
no unbounded required lane. The bounded lane remains only for ownerless best-effort
fixtures; a missing durable owner rejects security/audit/high-value records. Closed
production admission persists first and returns false; persistence failure returns
false and records a terminal item/category that blocks qualification.

Each new JSONL file is immutable and contains at most 256 records. A single-owner
publication timestamp retains admission order even if the wall clock moves backwards.
Writes use owner-only CreateNew temporary files, WriteThrough, FlushAsync and
`Flush(true)`, followed by a non-overwriting rename. Retention DEKs are already
flushed before publication. Process termination after successful admission leaves
the exact encrypted record available to a fresh owner. This is not a claim of
host-loss recovery, directory-entry durability after power failure, or external
custody. Unpublished `.tmp` files are not accepted records and are never replayed;
operators must quarantine crash residue and apply the retention-key lifecycle,
not promote a partial file as a successful admission.

The worker replays on startup and every 500 ms, using batches of at most 256 records
and bounded-memory filename selection. Failure or cancellation retains the source;
successful database confirmation removes it without an indefinite ciphertext
archive. Existing protected daily fallback files remain replayable without
re-encrypting their envelope. New pending files stay in the same finite fallback
retention/anchor/key-destruction path.

The owner-local delivery identity is the SHA-256 of the unique retention envelope;
it does not replace an action, actor, business identity, or audit chain hash. The
store uses existing ciphertext rows as commit postconditions, with delivery and
daily-chain PostgreSQL transaction fences. An existing envelope counts as committed
only when both the intended record and the actual row reproduce its stored signed
hash/MAC. Missing rows are committed; duplicate, changed-classification, or mutated
rows fail closed. This covers commit acknowledgement loss without another schema
or ledger. UTC timestamps are projected to PostgreSQL microsecond precision before
signing; opaque ciphertext and delivery identity remain stable on replay.

Disk pending and active replay counts feed the existing channel snapshot and
catalog drain/health adapters. `QueuedCount=0` alone is not drained. Unreadable
journal state, malformed records and failed commit postconditions block
qualification. Admission success is not a claim that the database already committed.
The synchronous protected-file write adds admission latency and disk dependence;
full or unavailable storage must fail closed, never fall back to successful RAM-only
audit. Other queue owners and the PublicHot core are outside this change.

### Administrative audit admission and recovery

`AdminAuditLogChannel` owns a separate encrypted journal at
`FSUSBLOG_DATA_ROOT/admin-audit-fallback`, using per-event keys in the existing
retention key store under the `admin-audit-delivery` domain. Every admission creates
an independent opaque event identity and an immutable copy of the full payload.
Successful admission completes the protected-file flush and atomic publication
before returning from bounded admission. Full, closed or cancelled single-record
admission uses the same durable event for direct fallback; a failed fallback keeps
that event pending and propagates the failure. This does not change administrative
event authorization, payload fields or the existing database representation.

The administrative worker replays this journal on startup and polls disk-pending
events every 250 ms, independently of volatile wake hints. Filename selection is
bounded to 128 entries and follows the single owner's publication order. Before an
insert, the store reserves an existing PostgreSQL serial identity and publishes
that reservation in the journal. Retry verifies that same identity and every
stored payload column under an owned transaction, including PostgreSQL timestamp
precision, before acknowledging the journal. Commit-before-acknowledgement loss
must not create another row. Legitimate events with identical content remain two
distinct admissions; content equality is not a deduplication identity. Transactions
are per event, not an all-or-nothing batch contract.

The recovery boundary is process crash/restart with the same preserved data root,
journal and key store. It is not a guarantee for power failure or directory-entry
durability, host/disk loss, or admission order across nodes with independent data
roots. Do not delete or replace pending journals or their keys during restart or
rollback. Returning to a RAM-only owner is not a safe rollback while admissions
continue or durable work remains pending.

The existing admin drain participant forwards only opaque item references and
classified failure reasons as blockers when the current terminal-failure count is
positive. Queued, in-flight and durable-pending work still participates in the
aggregate. Health, readiness and qualification consume that same aggregate;
historical reasons alone must not keep a recovered, committed owner blocked.
Payload, exception messages and absolute journal paths are not diagnostic blockers.
The focused administrative unit and real PostgreSQL/process tests are
`AdminAuditDurableAdmissionIssue2040Tests` and
`AdminAuditDurableReplayIssue2040IntegrationTests`; fixture/aggregate checks are not
substitutes for the real owner crash and commit windows, nor for other required
queue owners' independent acceptance.

`AuditRetentionStorageContract` applies the same finite ciphertext maximum to database, local fallback, backup, WAL, and replica surfaces. The application directly controls only database and local fallback cleanup. Backup, WAL, and replica deletion require operator/platform attestation; this implementation does not call or claim control over any external backup provider, object lock, TSA, public chain, replica manager, or WAL archive.

Local checkpoints and destruction evidence are append-only ordinary files, not WORM. The #1111 limitation remains: privileged same-host deletion requires custody outside the host to resist, but external custody is intentionally omitted from this local-only issue scope.

## Administrative investigation

Ordinary audit reads remain PII-redacted. Investigation disclosure additionally requires `audit.investigate`, a valid purpose string, trusted origin, and a consumed admin step-up proof. List results remain capped at 200 rows. There is no raw bulk audit export endpoint; any future export must reuse the same purpose, step-up, row-limit, query-audit, and expiry gates.

## Rollback

The safe runtime rollback is to stop the cleanup worker while keeping encrypted writes enabled. Do not revert to raw sensitive payloads, skip the anchor, retain DEKs indefinitely, or restore the old high-value/Critical SQL exclusion. Pausing cleanup increases retention age and must be treated as degraded privacy posture, but it avoids deleting data without a valid checkpoint/evidence chain.
