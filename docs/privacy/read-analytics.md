# Read analytics privacy boundary

Production read analytics is aggregate-only. The request path may verify a human-read proof and apply a short-lived deduplication lease, but it must discard request identity before queueing. No database row, log, metric, backup, or author/admin response may contain a viewer key, proof identifier, device fingerprint, IP/UA value, route sequence, exact request timestamp, exact dwell duration, or a stable cross-article identifier.

Raw network identity is minimized synchronously at the request boundary. `ForwardedHeadersMiddleware` may first replace `Connection.RemoteIpAddress`, but only for configured `KnownProxies` / `KnownNetworks`; read-proof code never reads `X-Forwarded-For` or `X-Real-IP` itself. The normalized address is used only to create (1) a one-minute, path-scoped HMAC rate-limit partition and (2) the article/site + 15-minute dedup HMAC. Both outputs have separate domain labels. The raw string and request context are not stored in a message, callback, retry item, log scope, trace baggage, metric tag, exception data, or fallback file.

## Collection and deduplication

- Article proofs are deduplicated by `article + 15-minute UTC epoch + scoped token`; site proofs use the corresponding site scope.
- The scoped token is derived with an independent rotating deduplication key. It cannot be reused across articles or epochs and never borrows JWT, proof-signing, IP-pseudonym, or DP key material.
- The lease exists only in Redis or the in-memory development store, expires after 20 minutes, and is not copied to a database, log, metric, or backup.
- Obvious refresh/retry traffic within the same article/epoch consumes the same lease and increments no second count.
- Proof verification may bind transient request properties, but those properties are removed before the aggregate message is created.
- Redis/cache failure returns `dedup_unavailable` and drops the statistic. It must not enqueue a background retry, write a fallback file, or attach the infrastructure exception to a raw request identifier.

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

## Static privacy gate

`node tools/security/check-async-telemetry-privacy.mjs` discovers every backend `Channel<T>` contract and rejects raw network types or address-shaped members, while permitting explicitly named one-way values such as `ClientIpHash`. It also rejects direct `GetClientIp()` / `RemoteIpAddress` writes into scalar async writers and pins `VisitLogMessage` to `AggregateHourUtc`, `EventType`, `ArticleId`, and `DwellBucket`. The fixture command `node tests/frontend/checks/static/check-async-telemetry-privacy-fixture.mjs` proves raw fields, raw `IPAddress` values, and scalar raw-IP queue writes fail the gate. Both checks run under `npm run check:telemetry-privacy`.

## Operations and rollback

Restore and monthly privacy checks fail if the retired event table reappears, even when its raw-IP column is absent. Backup/WAL/log/Redis/ETL cleanup follows [Historical raw-IP lifecycle](../security/ip-anonymization-lifecycle.md).

Ordinary production containers disable .NET managed dumps and diagnostic-port capture, set the OS core-dump soft/hard limits to zero, drop Linux capabilities, and enable `no-new-privileges`. `check-production-network-baseline.sh` enforces this automatically. An exceptional dump requires an isolated non-public replica, explicit incident approval, an encrypted destination outside ordinary logs/backups, access audit, and a short deletion deadline; never enable dumps on the active/candidate traffic slot.

The no-restart degradation is `HumanReadProof:Mode=paused`: public content remains readable while new counting stops. Never roll back by recreating the event table or by routing traffic to a binary that requires it. A destructive investigation uses an isolated, verified pre-migration restore and must run the final migration plus lifecycle verification before network access.
