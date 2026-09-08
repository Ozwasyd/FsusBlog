# Audit detached checkpoints

## Security claim

`sys_audit_log`'s `RecordMac` proves only that a holder of `Audit:TamperEvidenceKey` produced the record; it is not WORM and cannot stop that HMAC-key holder rewriting database history.

A detached checkpoint adds a local, exportable proof: recompute the existing audit canonical record hash in `sys_audit_log.id` order, freeze `id`, `chain_id`, `prev_hash`, stored/canonical record hash, record MAC, and raw context-payload digest in a record snapshot, then reuse the existing Merkle builder for an order-sensitive root. Its manifest binds:

- monotonic `sequence` plus the previous checkpoint digest; `fromRecordId` / `toRecordId` / `recordCount`; the Merkle root plus the range's final audit-record head hash; and UTC creation time, independent trust domain, and signing-key identity.

The checkpoint is signed by the independent `ECDSA_P256_SHA256` private key in `AuditCheckpointKeyRecord`, domain `fsusblog.audit.detached-checkpoint.v1`. Do not reuse it for Audit HMAC, JWT, PoW, Perception, Site Integrity publish-proof, or Data Protection. An independent verifier needs only the checkpoint public key, imported packages, read-only database record source, and optional expected detached head—not Audit HMAC or the checkpoint private key.

## What verification detects

Complete chain verification fails closed on:

- changed database fields or raw `context_payload`; history rewritten by an Audit-HMAC holder recomputing `RecordHash` / `RecordMac` / `PrevHash`; deleted, replaced, or reordered records in a range; a broken audit-chain link; tampered checkpoint content, signature, or filename digest identity; sequence gaps, predecessor-digest mismatch, or overlapping ranges; an unknown, wrong, expired, revoked, or compromised key; or local checkpoint-tail deletion/rollback when the verifier has a newer expected detached head.

The expected head is `trustDomain + sequence + checkpointDigest + signingKeyId`. Export it to an independent trust domain and supply it during verification to detect deletion of the newest local checkpoints; if it and the files remain on the same machine, account, and backup domain, a privileged attacker can delete both.

## Local file transport

`LocalFileAuditCheckpointTransport` implements pluggable `IAuditCheckpointExporter` and `IAuditCheckpointImporter`:

1. `FileMode.CreateNew` obtains an exclusive sequence lock; canonical JSON goes to a unique same-directory temporary file and `Flush(flushToDisk: true)`.
2. `File.Move(..., overwrite: false)` publishes atomically; the final filename binds zero-padded sequence and signed-envelope digest.
3. Import rejects non-canonical JSON, unknown fields, filename/digest mismatches, and damaged packages.

This gives append-only create-new semantics and concurrent-writer conflict detection, but an ordinary filesystem is not WORM: root/admin, a privileged host process, disk administrator, or same-backup writer can delete the directory. Resisting same-host privileged deletion requires external custody or a WORM/notary domain for the package, public-key registry, and expected head. This issue provides only export/import interfaces, not TSA, S3 Object Lock, a public chain, or a network service.

## Key rotation

During rotation, new checkpoints use only the current private key while the independent verifier registry retains old public keys for old checkpoints. Do not distribute old private keys. A revoked key verifies only pre-revocation checkpoints; every checkpoint from a compromised key is rejected. Release/backup the public registry and exported expected head separately from checkpoint files under controlled custody.

## Integration and rollback

The composition root registers the SQL record source, reload-aware worker, file/export boundary, and verifier. `Audit:DetachedCheckpoint` supplies a data-root-relative directory, bounded period/batch, one current key identity, and separate SPKI/PKCS#8 DER paths; Unix private-key files must be at most 0600. Each round verifies existing checkpoints against the database, creates the next batch, and rechecks it with the new expected head. No HTTP/admin API or external service is added.

No-restart rollback hot-updates `Audit:DetachedCheckpoint:Enabled=false`, stopping the creator/scheduler while retaining Audit-HMAC writes and read-only packages. If the signing key is missing, append conflicts, or verification fails, never create an unsigned checkpoint, overwrite an old file, or mark success. Evidence becomes less fresh, but anonymous, login, admin, notification-stream, and binary API wire semantics do not change.
