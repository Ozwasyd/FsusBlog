# Security-log IP pseudonyms

Event-level read telemetry is retired. `20260715-post-read-event-retirement` physically drops `sys_visit_log`, and the human-read path must never persist an IP value or pseudonym. This document now governs only the narrowly scoped PoW/crawler security-log pseudonyms that retain the legacy `VisitLogIpPseudonymizer` type name.

Security-log IP values are pseudonyms, not absolute anonymization. A holder of the active key can still test candidate addresses within an active window. The control objective is therefore to minimize linkability, key exposure, stored precision, retention, and access rather than to label the value anonymous.

## Cryptographic contract

`VisitLogIpPseudonymizer` is the only supported visit-log IP derivation path. It normalizes IPv4-mapped IPv6 addresses, derives a separate HMAC-SHA256 key for each purpose and UTC day, and then HMACs a framed normalized IP. Only the first 128 bits are stored as 32 lowercase hexadecimal characters.

The derivation context binds all of the following values:

- protocol version;
- purpose: `security-log`; the compatibility `analytics` enum value is forbidden on the read-analytics path;
- KMS key epoch;
- UTC day window (`yyyyMMdd`).

Consequently, the same IP cannot be joined across UTC days or key epochs. No read aggregate contains the hash, epoch, or window. The 128-bit security-log value remains restricted personal data and must not be exported as an anonymous dataset.

## Secret-manager and KMS integration

The root key is independent, random, at least 32 bytes, and Base64 encoded. Production injects it through the deployment's secret-manager/KMS envelope into the ASP.NET Core configuration provider:

```text
VisitLog__IpPseudonymization__CurrentEpoch
VisitLog__IpPseudonymization__CurrentKey
VisitLog__IpPseudonymization__PreviousEpoch
VisitLog__IpPseudonymization__PreviousKey
VisitLog__IpPseudonymization__PreviousAcceptUntilUtc
```

The repository, image, deployment manifest, process arguments, logs, backup configuration snapshot, and database must never contain plaintext KMS root material. A secret-volume/configuration adapter may replace environment injection, but it must populate the same keys before startup. Production validation rejects missing, weak, template, legacy `VisitLog:IpHashPepper`, or cross-domain reused key material, including reuse of JWT and security-risk pseudonym keys. There is no fallback key.

Daily purpose keys are derived automatically, so no deployment is needed at the UTC boundary. Rotate the KMS root on a regular operator schedule and immediately after suspected exposure:

1. Generate a new 32-byte root in KMS/secret manager and increment `CurrentEpoch`.
2. Promote the new root to `CurrentKey`; move the old epoch/root to `Previous*` with an explicit UTC deadline no more than 31 days ahead.
3. Start the candidate slot and verify startup validation plus focused pseudonym checks before shifting traffic.
4. Keep previous material only while an explicitly approved incident workflow needs it. Security-log ingestion writes the current epoch only; read analytics writes no IP pseudonym.
5. Remove and destroy the previous root at the deadline. Do not extend it to preserve analytics continuity.

Compromise response skips the overlap unless incident containment explicitly requires candidate matching: pause the affected security-log writer, promote a clean key epoch, delete records from the exposed epoch, destroy the compromised KMS version, and record the operation in the security audit.

## Access, retention, and deletion

- Read analytics never groups, filters, joins, exports, or persists an IP pseudonym. Its bounded dimensions are article/hour, event type, and four coarse dwell buckets.
- Direct security-log record access is restricted to the database service principal and an approved incident role. Routine author/admin UI access is not permitted.
- Joins to account, admin-principal, session, device fingerprint, moderation subject, audit identity, read aggregate, or another pseudonym domain are prohibited.
- The historical `20260715-pre-visit-log-ip-pseudonym-epoch` descriptor remains replayable only so old upgrade histories are deterministic; the later retirement migration deletes the whole table.
- A deletion/erasure request cannot reliably select one person's unlinkable read aggregates. Do not create a linkage table to enable it; apply aggregate-window or site-wide deletion according to the approved retention policy.
- Database deletion must propagate to backup, WAL archive, logs, Redis legacy keys and ETL/object-store copies. The cross-media inventory, DSR interface, verification command and monthly drill are defined in [historical raw-IP lifecycle](ip-anonymization-lifecycle.md); backup encryption alone does not count as erasure.

## Failure and rollback

Missing or invalid production key configuration fails startup readiness. Runtime logging emits `ip_hash_unavailable`; it never logs raw IP or borrows another secret. To stop new read aggregation without affecting public content reads, set `HumanReadProof:Mode=paused` through the active configuration path.

For no-restart traffic rollback, keep the current serving slot active, correct the candidate slot's secret-manager mapping, and only then retry promotion. If an already promoted slot must be withdrawn, shift traffic only to a build compatible with the aggregate-only schema. Never restore the retired stable pepper, recreate `sys_visit_log`, or recreate raw/account identity columns. A destructive migration rollback requires a verified pre-migration database backup and an isolated maintenance decision; image rollback alone cannot restore deleted legacy hashes.
