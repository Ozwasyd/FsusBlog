# Active Release Fencing and notification-stream drain

This document defines the singleton, monotonic-generation, unified-drain, and notification-stream reconnect contract while production blue/green releases coexist. The implementation entry point is `IActiveReleaseFence`; the host registration entry point is `AddActiveReleaseFencing()`.

## Invariants

1. Production instances always start as `Candidate`. `Candidate`, `Draining`, `Stopped`, and `Failed` cannot claim new global background work.
2. PostgreSQL `sys_deployment_fence` is the durable witness and the Redis hash is a rebuildable low-latency mirror. Together they hold one active release fence identified by `releaseId + slot + generation + imageDigest`; generation is strictly increasing.
3. Target acquire must carry the current owner's `expectedReleaseId + expectedSlot + expectedGeneration`. A SQL transaction uses `SELECT ... FOR UPDATE` to compare, check generation, and replace the owner, then updates the monotonic Redis Lua mirror after commit.
4. Source revoke withdraws only an exact owner match. If the target already acquired the fence, source revoke returns `already-superseded` and cannot affect the target.
5. Each `active-singleton` worker holds both an active-release ticket and the existing worker lease. The lease owner contains release, slot, generation, and process instance; renew first reads the fence, and losing either the fence or lease cancels the current work round.
6. The final commit boundary for a durable side effect must call `IActiveReleaseCommitGuard.EnsureCurrentAsync()`. This forces a durable-witness reconcile; an old generation cannot commit even before its next renew tick.
7. Production fails closed when the durable witness is unavailable or identities diverge at one generation. It never guesses the active owner from process age, traffic, container state, or local cache. Total Redis loss recovers from SQL; temporary Redis unavailability reads SQL in degraded mode. A synthetic local fence is allowed only in `Development` with explicit `ActiveReleaseFence:AllowSyntheticLocalFence=true`; production startup validation hard-rejects that setting.
8. Metric labels may contain only low-cardinality fields such as operation, result, and reason; releaseId, digest, and process instance never enter metric labels.

## Worker execution chain

`ActiveReleaseFencedBackgroundWorkerLease` replaces the former `IBackgroundWorkerLease` implementation:

1. Read the background claim from `DeploymentRuntimeState`.
2. Get the current-generation ticket from `IActiveReleaseFence`.
3. Acquire a worker lease whose owner includes the generation.
4. Put the ticket in `IActiveReleaseExecutionContextAccessor`.
5. On renew, validate the fence before CAS-renewing the worker lease.
6. Before a database transaction commit, object-storage finalize, or irreversible external send, the action calls the commit guard.
7. Force one more fence validation after the action returns.

The authoritative classification for every `BackgroundService` is `tests/backend/Fixtures/background-service-classification.json`. The only valid classifications are:

- `active-singleton`: global work that must use the active fence, worker lease, and pre-commit guard;
- `multi-consumer-safe`: instances consume non-overlapping local inputs and must declare idempotent identity and replay source; and
- `instance-local`: derived state for only this release/process, with no global-owner semantics.

`tools/check-background-service-classification.mjs` scans all backend C# files in one pass and reports every missing, duplicate, unregistered, lease-less, or invalid drain field; it has no maximum error count.

## Host control contract

All three fence endpoints require a loopback source, `system.config` admin permission, and the `fixed_ip` rate limit.

### Target acquire / CAS

`POST /api/ops/deployment/fence/acquire`

```json
{
  "releaseId": "20260711010101-0123456789ab",
  "slot": "green",
  "generation": 42,
  "imageDigest": "sha256:...",
  "expectedReleaseId": "20260710183000-fedcba987654",
  "expectedSlot": "blue",
  "expectedGeneration": 41,
  "dryRun": false
}
```

For the first acquire, all three expected fields may be `null`. Once a fence exists, omitting the expected owner returns `expected_current_required`. Retrying the same owner/generation/digest returns `already-active`; changing the owner at the same generation returns `active_release_generation_not_monotonic`.

### Source revoke

`POST /api/ops/deployment/fence/revoke`

```json
{
  "releaseId": "20260710183000-fedcba987654",
  "slot": "blue",
  "generation": 41,
  "dryRun": false
}
```

### Status / verify

`GET /api/ops/deployment/fence/status?releaseId=...&slot=green&generation=42&requireActive=true`

All three endpoints return the same JSON fields: `accepted / idempotent / status / errorCode / dryRun / snapshot`.

Host command:

```bash
node tools/deployment/active-release-fence.mjs acquire \
  --port 18082 --release "$TARGET_RELEASE" --slot green --generation 42 \
  --digest "$TARGET_DIGEST" \
  --expected-release "$SOURCE_RELEASE" --expected-slot blue --expected-generation 41 \
  --admin-header-file "$FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE" \
  --origin "$FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN"
```

The command connects only to an explicit `127.0.0.1` port, checks the admin-header file mode is 0400/0600, and writes machine JSON to `.tmp/deployment/active-release-fence.json`. `--dry-run` still performs the server-side CAS decision without changing the owner; the witness read before the decision may repair a missing SQL/Redis mirror.

## Durable witness and startup reconcile

`DurableActiveReleaseFenceStore` reads PostgreSQL and Redis in parallel and converges as follows:

- SQL has a record and Redis is missing: treat this as Redis total loss and monotonically restore Redis from SQL;
- SQL is missing and Redis has a record: during the compatibility upgrade window, write the existing Redis owner to SQL before allowing mutation;
- generations differ: the higher generation wins and repairs the older side; generation never moves backward;
- same generation and identity but different state: `revoked` wins, preventing a revoked owner from returning; and
- same generation with different identity or digest: return `active_release_fence_witness_diverged`; readiness, claim, and commit guard all fail closed.

Acquire/revoke always commit the SQL transaction first and update the Redis mirror second. If SQL commits but the Redis update fails, the control request does not falsely report success; retrying the same request recovers Redis from SQL's idempotent state. PostgreSQL is the durable external witness outside Redis, so no extra etcd/Consul service is required.

## Stale snapshot policy

Production must explicitly configure `ActiveReleaseFence:RefreshIntervalMs` (100–30000ms) and `ActiveReleaseFence:StaleThresholdSeconds` (5–600s); the hard-stale threshold must not be shorter than the refresh interval. Deployment templates use 5000ms / 30s, corresponding to six consecutive failures. Both values are read dynamically each round; the failure count is not hard-coded.

After schema compatibility/migration and before the periodic refresh worker, startup runs `RefreshAsync(forceStoreRead: true)` once:

- if the PostgreSQL durable witness is readable, startup passes. A temporarily unavailable Redis mirror records degraded reconcile and SQL remains authoritative;
- if the PostgreSQL durable witness is unreadable, snapshots diverge, or the store returns unavailable, production throws `ActiveReleaseFenceStartupException` and refuses startup before listening for business traffic; and
- Development/Test records a degraded startup task and never fabricates an active owner for missing local infrastructure.

Runtime authorization never uses “fail once, keep using the old owner” soft-stale behavior. The first refresh failure publishes an unavailable runtime snapshot, and readiness, ticket capture, lease renew, and the commit guard immediately fail closed. Soft/hard describes only the process-retention window:

- first failure: Warning/P3 and increment the refresh-failure counter;
- half the dynamic failure limit: Error/P2; retain the process for infrastructure recovery, but produce no singleton side effect; and
- `ceil(staleThreshold / refreshInterval)` consecutive failures or actual stale time reaching the threshold: Critical/P1; production calls `IHostApplicationLifetime.StopApplication()`, after which Compose `restart: always` restarts the container with a fresh startup probe.

Any successful forced read clears consecutive failures and records recovery. Recovery first confirms a readable PostgreSQL durable witness with no generation/identity divergence, then lets the pod pass a fresh startup probe; a Redis-only fault needs no restart or owner switch. Process age, traffic, container health, and an in-memory old snapshot must never be used to guess the owner.

## Unified drain and notification stream

`ReleaseDrainParticipantRegistry` starts all participants in parallel. Each has an independent `MaxDrain` and is also bounded by the global deadline. Explicit adapters currently include article-view, hot-stats invalidation, and notification stream; the long-term classification of other channels/queues is jointly governed by `tests/backend/Fixtures/background-service-classification.json` and the current implementation. Drain is bounded, not an unbounded wait: every participant must declare pending count, status, maximum duration, and replay source.

Notification drain calls `NotificationStreamRestartCoordinator`, cancelling every session's linked token. Existing connections close with WebSocket 1012 / `fsus_service_restart`; the browser retains its cursor and reconnects quickly within a 250–1250ms jitter window. If replay finds a gap outside the retention window, the server sends no incomplete batch and closes with 4009 / `fsus_replay_miss`; the browser clears the cursor, and a successful reconnect calls `onReconnectSuccess(true)` to trigger the existing full-resync schedule.

Control entries:

- `POST /api/ops/deployment/notification-stream/restart`
- `GET /api/ops/deployment/notification-stream/restart/status`
- host tool: `tools/deployment/notification-stream-restart.mjs`
- machine evidence: `.tmp/deployment/notification-stream-restart.json`

## Readiness, metrics, and evidence

`ActiveReleaseFenceReadiness.EvaluateAsync()` returns `ok` only when the store is reachable and the local identity exactly owns the active fence. Once wired into production readiness, `Candidate` and an old generation remain not-ready.

Metrics:

- `fsus.active_release_fence.operations{operation,result,reason}`
- `fsus.active_release_fence.eligibility{result,reason}`
- `fsus.active_release_fence.witness_reconcile{result,reason}`
- `fsus.active_release_fence.witness_generation_gap{result}`
- `fsus.active_release_fence.refresh_failures{reason,severity}`
- `fsus.active_release_fence.refresh_consecutive_failures{reason,severity}`
- `fsus.active_release_fence.refresh_stale_seconds{reason,severity}`
- `fsus.active_release_fence.refresh_shutdowns{reason}`

Release evidence must include at least target acquire/CAS, source revoke, target status verify, notification restart status, and a terminal drain-participant snapshot. Runtime-generated files are not committed; the static implementation map without fresh authority is `security/evidence-contracts/active-release-fencing-implementation.json`.

## Failure and rollback

- PostgreSQL durable witness unavailable or same-generation identity divergence: stop new claims, cancel global tasks currently renewing, and fail readiness.
- Production startup probe finds the durable witness unavailable: refuse startup; persistent runtime hard-stale: request graceful shutdown so the orchestrator restarts and reprobes.
- Total Redis loss: rebuild from the SQL snapshot on the next read; while Redis is temporarily unavailable, SQL still blocks the old generation and records a degraded-reconcile metric.
- Target acquire CAS failure: do not switch traffic; retain the source fence.
- Target acquired but post-validation fails: reacquire the source release as active with a higher generation; never roll generation back.
- Client cannot reconnect after notification 1012: retain the cursor and continue exponential backoff; a backlog beyond the window triggers 4009 and full resync.
- Drain deadline expires: publish blockers, do not stop the source, and do not present an undrained state as success.
- To pause control-plane mutation without restart, set reloadable `ActiveReleaseFence:MutationEnabled=false`; status/readiness/worker commit guard stay enabled. After restoring `true`, complete SQL/Redis reconcile before accepting acquire/revoke. Never roll production back by enabling a synthetic local fence.

## Verification boundary

Focused tests cover SQL-first write order, Redis total-loss recovery, legacy Redis startup bootstrap, same-generation divergence fail-closed, revoked precedence, reloadable mutation pause, the production synthetic-local-fence hard gate, migration, and metric contracts. Anonymous, login, notification-stream, and binary API request/response contracts are unchanged; control endpoints remain loopback-admin only, and existing endpoint-contract tests continue to cover that boundary. Actual results belong only in the run-scoped release evidence receipt and are not declared in this current document.
