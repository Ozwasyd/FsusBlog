# Public AOT runtime state boundary

## PublicHot delivery obligation

`PublicHotArtifactUpdateQueue` is a bounded, in-process notification channel and is not a durability boundary. Every producer declares exactly one delivery class in [`config/development/public-hot-delivery-registry.json`](../../config/development/public-hot-delivery-registry.json). Before notification, the queue persists a monotonic `public-hot-read:{delivery}:pending-generation` watermark in the runtime Redis scope. The channel is only a low-latency wake-up: a full channel does not erase the watermark or enter a retry loop. Required content and taxonomy callers may report success only for a typed durable result; `cancelled`, `closed`, and `failed` remain explicit failures, never warning-only success.

| Delivery class | Owner semantics under pressure |
| ------ | ------ |
| `required-content` | Persist the generation before notifying; `persisted-dirty` is durable, while cancellation, closure, or persistence failure propagates to the caller |
| `required-taxonomy` | Same durability boundary as content; binary taxonomy mutation success is forbidden without a durable receipt |
| `best-effort-view` | Incremental notifications may coalesce, but a full queue advances the global marker and upgrades recovery to a full rebuild |
| `full-rebuild-marker` | Repeated notifications may return `coalesced`; each generation is monotonic and at least one covering rebuild remains required |

The worker checks the watermark before consuming the channel and again after each publish. Recovery markers always request a full rebuild. It clears the marker only after publishing the snapshot, using compare-and-clear so publication of generation `n` cannot erase a concurrently written generation greater than `n`. Consequently both crash windows (after marker write/before channel write, and after channel write/before publish) replay on process start. Queue results are machine-readable: `accepted`, `persisted-dirty`, `coalesced`, `cancelled`, `closed`, and `failed`.

The Redis generation and pending keys share the `{delivery}` hash tag, so the Lua mark/compare-clear scripts remain valid in Redis Cluster. Redis write failure is `failed` and does not authorize a required mutation success. Cancellation before the durable write is `cancelled` with no generation; cancellation after the write or a closed notification channel still reports its distinct result while the recovery generation remains pending.

### Recovery runbook

1. Restore Redis availability and validate that `public-hot-read:{delivery}:pending-generation` is either absent or a positive integer. Do not replace or delete a corrupt marker merely to make readiness pass.
2. Restart the affected application instance, or invoke the protected `public-hot-rebuild` admin operation after Redis is healthy. Startup and the next worker cycle load the pending generation and force a full rebuild.
3. Confirm `/api/ops/health/ready-detail` reports a newer successful `runtime.publicHotRead` snapshot and no build failure. A required marker is complete only after snapshot publication and generation compare-and-clear.
4. For a taxonomy `InfraFailure` returned after the database write, re-read the admin taxonomy state before retrying. The error does not promise database rollback; a blind create retry can conflict with the already committed name.

The no-restart recovery path is to stop retrying the affected taxonomy mutation, restore Redis, and invoke `POST /api/binary/author/cache/actions` with action `public-hot-rebuild`. The running worker consumes the retained marker and publishes a full snapshot; healthy public reads continue from the previous verified snapshot during the repair. Do not delete the marker, switch required delivery to an in-memory store, or turn the failure into success as a degradation shortcut.

Rollback of this delivery change means restoring the previous application binary, not deleting Redis state. A pending generation written by the newer binary is harmless to the older binary and must be retained so a subsequent corrected deployment can rebuild it.

`IPublicAotRuntimeState` is the single owner of request-visible render state and SSR health state:

```text
PublicAotShellService
  -> IPublicAotRuntimeState
       -> PublicAotSsrRuntimeState
```

The module projects source, renderer version, backfill status, render state, and asset mode into `HttpContext.Items`. It also classifies and records backfill failures, records successful backfills, and clears route quarantines during invalidation. It never calls back into the shell.

`PublicAotShellService` retains only use-case sequencing and logging. Header values, state names, failure classes, circuit/quarantine behavior, and invalidation ordering remain unchanged.

The module is singleton-scoped like its underlying SSR state. Rollback requires no endpoint, cache, database, or AEDS migration.
