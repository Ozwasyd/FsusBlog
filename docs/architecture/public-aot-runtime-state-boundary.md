# Public AOT runtime state boundary

## PublicHot delivery obligation

`PublicHotArtifactUpdateQueue` is a bounded, in-process notification channel and is not a durability boundary. Every producer declares exactly one delivery class in [`config/development/public-hot-delivery-registry.json`](../../config/development/public-hot-delivery-registry.json). Before notification, the queue persists or merges one Redis obligation in the runtime scope. Its schema contains `obligationId`, monotonic `targetGeneration`, dirty reasons, article/release coordinates, full-rebuild flag, attempt number, state, last failure kind, next eligibility and immutable per-attempt evidence. The channel is only a low-latency wake-up: a full channel does not erase the obligation. Required content and taxonomy callers may report success only for a typed durable result; `cancelled`, `closed`, and `failed` remain explicit failures, never warning-only success.

| Delivery class | Owner semantics under pressure |
| ------ | ------ |
| `required-content` | Persist the generation before notifying; `persisted-dirty` is durable, while cancellation, closure, or persistence failure propagates to the caller |
| `required-taxonomy` | Same durability boundary as content; binary taxonomy mutation success is forbidden without a durable receipt |
| `best-effort-view` | Incremental notifications may coalesce, but a full queue advances the global marker and upgrades recovery to a full rebuild |
| `full-rebuild-marker` | Repeated notifications may return `coalesced`; each generation is monotonic and at least one covering rebuild remains required |

Lua CAS owns `pending|failed-retryable -> processing -> published|failed-*`; startup turns an interrupted `processing` record back into pending. A worker may write `published` only after projector, snapshot publish, revocation completion and target-generation coverage all succeed. A merge during processing raises target and forces another pass instead of allowing the earlier pass to acknowledge it. Recovery includes the windows after obligation write/before projector and after publish/before completion; replay cannot regress a newer snapshot. Retry is only for the failure registry's machine-readable transient kinds, uses bounded exponential backoff and retains evidence. A terminal record is never deleted and makes `publicHotRecovery` readiness fail; a recovered attempt is exposed as qualification metadata.

The Redis generation and pending keys share the `{delivery}` hash tag, so the Lua mark/compare-clear scripts remain valid in Redis Cluster. Redis write failure is `failed` and does not authorize a required mutation success. Cancellation before the durable write is `cancelled` with no generation; cancellation after the write or a closed notification channel still reports its distinct result while the recovery generation remains pending.

### Recovery runbook

1. Restore Redis availability and inspect `public-hot-read:{delivery}:obligation:active` plus its `record:<obligationId>`. Do not replace or delete a corrupt/terminal record merely to make readiness pass.
2. Restart the affected application instance, or invoke the protected `public-hot-rebuild` admin operation after Redis is healthy. Startup reclaims interrupted processing and replays the retained obligation.
3. Confirm `/api/ops/health/ready-detail` reports a newer successful `runtime.publicHotRead` snapshot and `publicHotRecovery.status=ok`. A required obligation is complete only after snapshot publication, revocation completion and Lua generation CAS; `recovered=true` is valid but is not clean first-attempt qualification.
4. For a taxonomy `InfraFailure` returned after the database write, re-read the admin taxonomy state before retrying. The error does not promise database rollback; a blind create retry can conflict with the already committed name.

The no-restart recovery path is to stop retrying the affected taxonomy mutation, restore Redis, and invoke `POST /api/binary/author/cache/actions` with action `public-hot-rebuild`. The running worker consumes the retained marker and publishes a full snapshot; healthy public reads continue from the previous verified snapshot during the repair. Do not delete the marker, switch required delivery to an in-memory store, or turn the failure into success as a degradation shortcut.

Rollback of this delivery change means restoring the previous application binary, not deleting Redis state. A retained obligation must remain available for a subsequent corrected deployment to replay; terminal evidence is an operator signal, not disposable cache data.

`IPublicAotRuntimeState` is the single owner of request-visible render state and SSR health state:

```text
PublicAotShellService
  -> IPublicAotRuntimeState
       -> PublicAotSsrRuntimeState
```

The module projects source, renderer version, backfill status, render state, and asset mode into `HttpContext.Items`. It also classifies and records backfill failures, records successful backfills, and clears route quarantines during invalidation. It never calls back into the shell.

`PublicAotShellService` retains only use-case sequencing and logging. Header values, state names, failure classes, circuit/quarantine behavior, and invalidation ordering remain unchanged.

The module is singleton-scoped like its underlying SSR state. Rollback requires no endpoint, cache, database, or AEDS migration.
