# Historical raw-IP lifecycle

Dropping the event-level `sys_visit_log` table is not complete privacy erasure by itself. A pre-cutover database dump, archived WAL segment, application log, Redis legacy key, or ETL/object-store export can preserve raw IP or a read trajectory. This runbook treats those media as one lifecycle and produces one fail-closed report.

## Policy and inventory

The site-owned configuration follows [`ops/privacy/ip-anonymization-lifecycle.example.json`](../../ops/privacy/ip-anonymization-lifecycle.example.json). Retention is explicit and configurable per deployment; the baseline maximums are:

| Medium | Maximum grace/retention before historical raw-IP removal |
| --- | ---: |
| Redis legacy keys | 1 hour after cutover |
| ETL / warehouse / S3 export | 7 days |
| PostgreSQL WAL archive | 30 days |
| application/security logs | 30 days |
| encrypted database/site backup | 90 days |

Encryption and re-encryption are custody controls, not erasure. An artifact known to contain raw IP remains `rawIpState=present` until it is deleted. `unknown` is never promoted to `absent`. Each inventory has an immutable ID, canonical UTC cutover timestamp, capture timestamp, media, storage kind and raw-IP state. It must explicitly mark backup, WAL, log and ETL/object-store catalog coverage complete with a recent scan timestamp; the default maximum inventory age is 24 hours and cannot exceed 168 hours. Local paths must be beneath the configured per-medium roots; S3 objects must be beneath an approved per-medium prefix. Symlinks, unowned paths, arbitrary buckets and Redis keys outside a segmented `legacy` namespace are rejected.

The inventory comes from the backup catalog, WAL archive catalog, log index, Redis legacy-key scan, and ETL/object-store catalog. Do not omit an unavailable medium: record its artifact state as `unknown`, which keeps verification failed until an operator resolves it.

## Propagation and verification

Use a mode-0600 site configuration and inventory. Connections are passed through named environment variables, never the JSON file or command line.

```bash
node tools/operations/ip-anonymization-lifecycle.mjs plan \
  --config /etc/fsusblog/ip-anonymization-lifecycle.json \
  --output /var/lib/fsusblog/privacy/plan-$(date -u +%Y%m%dT%H%M%SZ).json

node tools/operations/ip-anonymization-lifecycle.mjs apply \
  --config /etc/fsusblog/ip-anonymization-lifecycle.json \
  --output /var/lib/fsusblog/privacy/apply-$(date -u +%Y%m%dT%H%M%SZ).json \
  --actor-ref-file /run/fsusblog/privacy/change-actor.ref \
  --allow-live-mutation

node tools/operations/ip-anonymization-lifecycle.mjs verify \
  --config /etc/fsusblog/ip-anonymization-lifecycle.json \
  --output /var/lib/fsusblog/privacy/verify-$(date -u +%Y%m%dT%H%M%SZ).json
```

`apply` removes only due artifacts declared by the inventory, issues Redis `UNLINK` only for approved legacy prefixes, verifies those keys are gone, proves the entire `sys_visit_log` table is absent, and calls `pg_switch_wal()` so the archive boundary advances. A post-cutover artifact marked `present` is due immediately instead of receiving a new retention window. It never runs `FLUSHALL`, deletes active `pg_wal`, or treats a successful WAL switch as archive deletion. Archived WAL objects remain inventory entries and follow the archive retention rule. Text log/ETL artifacts receive an additional IPv4/IPv6 content scan; large or unparseable media require authoritative catalog state rather than an optimistic scan result. Every applied propagation appends a mode-0600 operation audit record.

`verify` fails when media coverage is missing/stale, any declared `present` or `unknown` artifact, a textual raw-IP match, a legacy Redis key, the retired event table, a missing required connection, or a cleanup failure remains. Restored databases and backups must contain neither the table nor recoverable viewer/proof/device/IP/UA, route, exact timestamp, or per-event dwell fields. Retention settings may be shortened for a jurisdiction but cannot exceed the table above. Evidence contains artifact IDs and counts, not raw IP, Redis key values, credentials, or object content. Run the fixture independently with `tools/operations/test-ip-anonymization-lifecycle-fixture.sh`.

The scheduled `.github/workflows/monthly-ip-anonymization-scan.yml` full-chain drill uses a production-audit self-hosted runner with access to the private catalogs and admin connections. Its report is retained as restricted security evidence. A skipped, queued, missing-config, or failed job is not a passing monthly scan.

## Data-subject rights

Read aggregates deliberately contain no account/data-subject link. Reintroducing a lookup table to make one person's reads addressable would break that privacy boundary. The DSR interface therefore has two explicit outcomes:

```bash
node tools/operations/ip-anonymization-lifecycle.mjs dsr-export \
  --config /etc/fsusblog/ip-anonymization-lifecycle.json \
  --output /var/lib/fsusblog/privacy/dsr-export-<case>.json \
  --request-ref-file /run/fsusblog/privacy/dsr-case.ref \
  --actor-ref-file /run/fsusblog/privacy/dpo-actor.ref

node tools/operations/ip-anonymization-lifecycle.mjs dsr-delete \
  --config /etc/fsusblog/ip-anonymization-lifecycle.json \
  --output /var/lib/fsusblog/privacy/dsr-delete-<case>.json \
  --request-ref-file /run/fsusblog/privacy/dsr-case.ref \
  --actor-ref-file /run/fsusblog/privacy/dpo-actor.ref \
  --allow-live-mutation
```

Reference files must be mode 0600 regular non-symlink files; raw case and actor references therefore do not enter the process command line. `dsr-export` returns zero individually addressable read rows and explains the unlinkability boundary. `dsr-delete` performs immediate site-wide cleanup of every declared raw-IP/trajectory artifact rather than pretending to select a person's rows. Both append a mode-0600 audit record with hashes of the case, actor and evidence path; neither record contains the supplied reference, account ID, raw IP, pseudonym, credential, or Redis key.

## Failure, rollback, and no-restart containment

Deletion is irreversible, so first seal the inventory and review `plan`. A failed run retains explicit violations; rerun with a new evidence path after correcting only the failed adapter. Do not recreate deleted artifacts or restore a pre-cutover backup into a connected production environment. If restore is essential, isolate it, run the database migration and full lifecycle cleanup before network access, then generate a new raw-IP-free backup.

No application restart is required for lifecycle cleanup. If new raw-IP or event-trajectory persistence is suspected, pause `HumanReadProof:Mode`, stop the affected ETL/log export, disable the legacy Redis writer, preserve the current serving slot, and complete verification. Rollback means stopping further deletion and fixing inventory/adapter configuration; it never means restoring `sys_visit_log`, raw-IP columns, stable hashes, account linkage, legacy Redis keys, or pre-cutover exports.
