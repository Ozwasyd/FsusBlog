# Visit-log IP pseudonyms

Visit-log IP values are pseudonyms, not absolute anonymization. A holder of the active key can still test candidate addresses within an active window. The control objective is therefore to minimize linkability, key exposure, stored precision, retention, and access rather than to label the value anonymous.

## Cryptographic contract

`VisitLogIpPseudonymizer` is the only supported visit-log IP derivation path. It normalizes IPv4-mapped IPv6 addresses, derives a separate HMAC-SHA256 key for each purpose and UTC day, and then HMACs a framed normalized IP. Only the first 128 bits are stored as 32 lowercase hexadecimal characters.

The derivation context binds all of the following values:

- protocol version;
- purpose: `analytics` or `security-log`;
- KMS key epoch;
- UTC day window (`yyyyMMdd`).

Consequently, the same IP cannot be joined between analytics rows and PoW/crawler logs, across UTC days, or across key epochs. `sys_visit_log` stores `ip_hash`, `ip_hash_key_epoch`, and `ip_hash_window_utc`; it stores neither raw IP nor account/admin identity. The 128-bit value remains restricted personal data and must not be exported as an anonymous dataset.

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
4. Keep previous material only while an explicitly approved read/incident workflow needs it. Normal visit ingestion writes current epoch only.
5. Remove and destroy the previous root at the deadline. Do not extend it to preserve analytics continuity.

Compromise response skips the overlap unless incident containment explicitly requires candidate matching: pause visit writes, promote a clean key epoch, delete rows from the exposed epoch, destroy the compromised KMS version, and record the operation in the security audit.

## Access, retention, and deletion

- Application statistics may aggregate by UTC window and pseudonym but must not return `ip_hash`, epoch, or window to public/admin DTOs.
- Direct row access is restricted to the database service principal and an approved incident role. Routine author/admin UI access is not permitted.
- Joins to account, admin-principal, session, device fingerprint, moderation subject, audit identity, or security-risk pseudonyms are prohibited.
- Standard retention deletes visit rows after 30 days in bounded batches. A shorter jurisdictional policy may delete sooner.
- Pre-CodeFirst migration `20260715-pre-visit-log-ip-pseudonym-epoch` deletes legacy stable hashes because they cannot be safely transformed without raw IP and the old pepper.
- The daily cleanup worker also removes any row with a missing epoch/window or a non-128-bit hash, preventing restored legacy rows from silently surviving.
- A deletion/erasure request cannot reliably select one person's anonymous visit rows because no account link is retained. Do not create a linkage table to enable it; apply time/epoch/site-wide deletion according to the approved retention policy.

## Failure and rollback

Missing or invalid production key configuration fails startup readiness. Runtime logging emits `ip_hash_unavailable`; it never logs raw IP or borrows another secret. To stop new persistence without affecting public content reads, set `HumanReadProof:Mode=paused` through the active configuration path.

For no-restart traffic rollback, keep the current serving slot active, correct the candidate slot's secret-manager mapping, and only then retry promotion. If an already promoted slot must be withdrawn, shift traffic to the previous compatible slot while its approved key-ring configuration remains available. Never restore the retired stable pepper or recreate raw/account identity columns. A destructive migration rollback requires a verified pre-migration database backup and an isolated maintenance decision; image rollback alone cannot restore deleted legacy hashes.
