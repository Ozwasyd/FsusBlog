# Read analytics privacy boundary

Production read analytics is aggregate-only. The request path may verify a human-read proof and apply a short-lived deduplication lease, but it must discard request identity before queueing. No database row, log, metric, backup, or author/admin response may contain a viewer key, proof identifier, device fingerprint, IP/UA value, route sequence, exact request timestamp, exact dwell duration, or a stable cross-article identifier.

## Collection and deduplication

- Article proofs are deduplicated by `article + 15-minute UTC epoch + scoped token`; site proofs use the corresponding site scope.
- The scoped token is derived with an independent rotating deduplication key. It cannot be reused across articles or epochs and never borrows JWT, proof-signing, IP-pseudonym, or DP key material.
- The lease exists only in Redis or the in-memory development store, expires after 20 minutes, and is not copied to a database, log, metric, or backup.
- Obvious refresh/retry traffic within the same article/epoch consumes the same lease and increments no second count.
- Proof verification may bind transient request properties, but those properties are removed before the aggregate message is created.

## Durable aggregates

The durable write contains only bounded dimensions:

| Aggregate | Dimensions | Value |
| --- | --- | ---: |
| article read | article ID + UTC hour | count |
| event type | `article_read` or `site_read` | count |
| daily totals | UTC date | total and human-verified counts |
| dwell histogram | UTC date + `lt_10s`, `10_30s`, `30_120s`, or `gt_120s` | count |

`sys_visit_log` and `article_view_projection_watermark` are physically dropped by `20260715-post-read-event-retirement`. Region and author-route history is cleared during the same transaction. The old descriptors remain replayable for upgrades, but their compatibility table is empty on fresh databases and is always removed before the final schema is accepted.

Twenty reads across twenty articles therefore produce independent article/hour counters, not an ordered journey. Article view projections consume the grouped counters directly; there is no event replay or reconciliation watermark.

## Release privacy

Low-sample region and dwell cells are suppressed below `k=10`. Allowed admin release scopes use deterministic daily Laplace noise with default `epsilon=0.5` per scope and a default daily cap of `1.0` across the fixed `admin-region` and `admin-dwell` scopes. A result is stable for a UTC day, so repeated reads cannot average noise away. Unknown scopes, weak/reused secrets, invalid numeric settings, and a scheduled budget above the daily cap fail closed.

Region collection is currently disabled and historical region/route rollups are deleted. Reintroducing a region writer requires a separately reviewed coarse catalog, the same k/DP release policy, and no free-form location value.

## Operations and rollback

Restore and monthly privacy checks fail if the retired event table reappears, even when its raw-IP column is absent. Backup/WAL/log/Redis/ETL cleanup follows [Historical raw-IP lifecycle](../security/ip-anonymization-lifecycle.md).

The no-restart degradation is `HumanReadProof:Mode=paused`: public content remains readable while new counting stops. Never roll back by recreating the event table or by routing traffic to a binary that requires it. A destructive investigation uses an isolated, verified pre-migration restore and must run the final migration plus lifecycle verification before network access.
