# Site Backup Envelope Encryption

`tools/operations/backup-site.sh` no longer emits a directly unpackable site `.tar.gz`. It builds the database, uploads, X.509-wrapped Data Protection ring, sanitized configuration, AOT, and search artifacts in mode-0700/0600 temporary directories, then an independent backup recipient wraps them as `fsusblog-site-backup-envelope-v1`:

- content encryption is AES-256-GCM; key wrapping is RSA-OAEP-SHA256 with a recipient RSA key of at least 3072 bits; and the header is GCM AAD, so any header, ciphertext, or authentication-tag change makes recovery fail.
- Inner manifest version 2 stores each artifact's SHA-256, recipient key id, and Data Protection encrypted-generation count. The final `.tar.gz.fsbenc` is mode 0600 and unreadable by `tar`; temporary plaintext tar is deleted on success or failure.

## Key custody

Backup and restore use an RSA key pair independent of the Data Protection X.509, JWT, audit, and database keys. Data Protection ring behavior is defined by the [Data Protection key-ring boundary](data-protection-key-ring.md).

- The backup host sets only `FSUSBLOG_BACKUP_RECIPIENT_FILE`, which must be an RSA public PEM; the tool rejects a recipient containing a private key. `FSUSBLOG_BACKUP_IDENTITY_FILE` supplies a regular, non-symlink private PEM at mode 0600 or stricter, and an encrypted PEM passphrase may come only from mode-0600 `FSUSBLOG_BACKUP_IDENTITY_PASSPHRASE_FILE`.
- Keep the private identity in an offline/independent KMS disaster-recovery secret domain, never in the backup root, application shared volume, Data Protection ring, repository, image, release evidence, or site package. Reports/manifests record only the public SPKI `sha256:` key id—not key path, passphrase, private PEM, or wrapped content key.

Example:

```bash
FSUSBLOG_BACKUP_RECIPIENT_FILE=/etc/fsusblog/backup-recipient.pem \
FSUSBLOG_BACKUP_ROOT=/srv/fsusblog-backups \
tools/operations/backup-site.sh

FSUSBLOG_BACKUP_IDENTITY_FILE=/run/dr-identity/backup-identity.pem \
FSUSBLOG_RESTORE_ROOT=/srv/fsusblog-restore-staging \
tools/operations/restore-site.sh \
  --backup /srv/fsusblog-backups/fsusblog-site-20260715T010000Z.tar.gz.fsbenc \
  --confirm
```

The restore entry accepts only an authenticated envelope. Missing/mismatched identity, broad permissions, plaintext tar, truncation, tag/header/ciphertext tampering, a manifest-recipient mismatch, or an artifact-digest mismatch blocks before writing the database, uploads, or key ring.

Backup, restore, and site-package drill reports record `packageSha256` for the exact encrypted package bytes. Restore and drill reject package changes during authentication. A site-package drill rejects separately supplied database, Redis, uploads, AOT, or search overrides rather than validating one package and restoring another artifact. This package binding is not a source-database fingerprint, current-snapshot proof, or a successful restore credential; those require the original database observer and actual isolated restore evidence.

For offline migration backup capture, explicitly supply `FSUSBLOG_MIGRATION_SERVER_DLL` pointing to the original Migration host and `FSUSBLOG_BACKUP_DATABASE_PROVIDER=postgresql`. The native observer owns a read-only repeatable-read transaction, observes the actual instance/database and complete source content, and exports the snapshot used by the original `pg_dump`. The transaction remains alive until the dump completes and the native owner hashes its bytes. Inner manifest version 3 binds that capture evidence and the database artifact digest; caller JSON cannot replace it. MySQL and SQLite do not yet have a native snapshot capture adapter in this entry and are rejected, not advertised as backed-up providers.

Version-3 restore requires a fresh staging root and file targets beneath it, independently observes a database target different from the captured source before database writes, and rereads exact restored content after `pg_restore`. A version-3 site-package drill similarly binds the actual disposable database observation and consumed dump to the package and manifest SHA. Ordinary version-2 encrypted backups remain readable for the existing disaster-recovery workflow, but cannot prove offline migration backup admission. A capture alone is not later source freshness: the planner must independently compare the current full content digest with capture and restore evidence. Neither script syntax checks nor fixture database tools prove an actual native snapshot or restore.

Version-3 source operations require the caller to explicitly set `FSUSBLOG_BACKUP_CAPTURE_TIMEOUT_SECONDS` to a canonical ASCII positive integer from `1` through `2147483` (no sign, leading zero, whitespace, or exponent). The upper bound is the native millisecond API's representation limit, not an approved business budget. Capture rejects a missing or invalid value before creating output or connecting. Restore and drill reject it after authenticated manifest classification but before database connections or target writes; ordinary version-2 DR does not require it. Each operation uses one monotonic deadline and passes only the remaining seconds to `observe-source --timeout-seconds`; capture start and completion must agree on that launch budget. The dump must exit successfully and synchronize its exact file before `DUMP_COMPLETED`. Failed or cancelled owned children receive bounded TERM/KILL cleanup and actual terminal checks; unverified cleanup is a blocker, retains owned work for recovery, and is never reported as released. Protected failure stderr is retained separately from the success receipt; it may contain operational details and must follow the existing custody policy.

## Recipient rotation and retention

Each envelope has one recipient. Rotate in this order:

1. Generate B in the disaster-recovery custody domain; retain B's private identity, verify offline recovery access, distribute only B's public recipient to the backup host, and create a backup with B. Run the fixture and isolated restore drill; manifest/report must show B's public key id.
2. Use B for subsequent backups. Keep A's private identity offline until every A-recipient backup reaches legal/business expiry, then securely destroy all A backups with audit evidence before destroying A; B becoming current is not an early-delete reason.

Backup retention is bound to identity retention: every retained package needs an available identity, and identity escrow requires two-person authorization, recovery audit, and periodic readability checks. Data Protection current/previous PFX has a separate window; retain an old PFX in the disaster-recovery domain while any backup-ring key generation it wrapped remains.

## Disaster recovery drill

Authorized recovery has two layers: authenticate the backup identity and open the site envelope, then use Data Protection current+previous PFX to open the corresponding encrypted generations in the restored ring.

`restore-site.sh` validates manifest version, recipient key id, six artifact digests, key-generation count, and each key XML's `encryptedSecret`/no-plaintext-`masterKey` rule after unpacking. Real `backup-restore-drill.sh` accepts the same encrypted package and external identity; site-package mode requires at least current+previous encrypted generations and records the actual count in `data-protection-current-previous-generations`. Rollover tests still prove an A+B blue/green provider reads both generations in both directions.

Run the disaster-recovery drill in an isolated restore root, database/Redis, and non-active web root. Evidence stores only status, recipient key id, generation count, artifact-digest pass states, and RPO/RTO; never copy identity, PFX, passphrase, plaintext tar, or key XML.

## Failure and no-restart rollback

Backup-envelope failure does not change active runtime: the command deletes plaintext temporaries, retains the blocker report, and never falls back to a plaintext archive. Fix the recipient and rerun; no application restart is needed.

Restore must complete authentication, manifest/digest, and generation checks in an isolated root before writing an isolated target. Wrong identity, tampering, or missing generations deletes temporary plaintext and stops. The active slot, shared production ring, and current database remain untouched, so no restart is needed; repair DR identity/PFX custody and rerun. External operations may schedule cutover only after isolated restore and application smoke both pass.

Never degrade by accepting an old plaintext `.tar.gz`, skipping GCM/tag or artifact-digest checks, copying the private identity to the backup host/shared volume, deleting a current/previous key generation, or temporarily changing Data Protection `ApplicationName`.
