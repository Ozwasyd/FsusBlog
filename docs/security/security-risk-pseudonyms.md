# Security-risk identity pseudonyms

## Boundary

Persistent `security_risk_event` rows never contain raw client IPs, device fingerprints, or account subjects. The event sink converts each value to a lowercase HMAC-SHA-256 pseudonym before durable admission. Request paths and user-agent strings are no longer retained: the existing `SecurityRiskEventStore.ToEntity` normalization boundary strips them before journal encryption even for direct queue entry points. The bounded route key, HTTP method, reason, action, detail, and trace identifier remain available in authorized SQL operations, not delivery failure logs.

The input frame is unambiguous and domain separated:

```text
security-risk/{ip|device|account}/v1\0epoch:{positive integer}\0{normalized value}
```

IP normalization parses the address, maps IPv4-mapped IPv6 to IPv4, and writes canonical address text. Account input is normalized case-insensitively. Each row stores `pseudonym_epoch`; a row containing an identity pseudonym is rejected if its epoch is not positive.

## Key ring and production gate

Configure `Security:RiskPseudonymization` through the deployment secret provider, not a committed file:

```json
{
  "CurrentEpoch": 4,
  "CurrentKey": "<base64 for at least 32 random bytes>",
  "PreviousEpoch": 3,
  "PreviousKey": "<independent previous base64 key>",
  "PreviousAcceptUntilUtc": "2026-08-14T00:00:00.0000000Z"
}
```

Production startup fails when the current epoch/key is missing, the key is short, low-diversity, templated, or exactly reused from another configured security secret. A previous key must have a lower epoch, its own key material, an explicit UTC expiry, and a transition window no longer than 90 days.

Generate keys from a cryptographically secure source. Rotate on or before the security-risk retention boundary: deploy a new current epoch while moving the old key to `Previous*`, retain dual-read only for the documented transition, then remove the previous key after its acceptance time. Writes always use only the current epoch; PostgreSQL fallback reads query current and still-valid previous epochs without persisting raw input.

## Durable delivery boundary

The singleton `SecurityRiskEventWriteQueue` owns `security-risk-fallback` under an explicit absolute `FSUSBLOG_DATA_ROOT`. There is no source-directory, application-base-directory, ambient-root or process-global test journal fallback. Missing authority, unsafe permissions, symlink components, unavailable storage or key material reject admission with a current terminal blocker. The current private-file implementation requires Unix mode evidence: owner-only directories (0700) and files (0600). Tests must use an independent task-owned temporary root.

The bounded channel carries scheduling hints only for already protected events. Its capacity remains bounded; the replay owner retains at most the configured batch of in-flight leases, not a growing RAM index of the disk backlog. A private root-owner file lease rejects concurrent owners of the same admission/key namespace before they can alter each other's keys; after process exit a fresh owner can reuse the regular private lock file. It is control state, not an event or commit receipt. `EnqueueAsync` awaits local publication; compatibility `TryWrite`/`TryEnqueueOrShed` calls synchronously wait only for that same local authority and never invoke SQL. Full/closed/caller-cancelled scheduling still attempts required durable admission; actual local failure returns false and exposes a terminal state, never a dropped-success result. The sink preserves its existing score, projection and HTTP decision and does not report caught admission failure as durable acceptance.

Each event gets a random AEAD key from the existing `IAuditRetentionEpochKeyStore` file capability, with the independent `security-risk-delivery` key domain and an opaque per-event key identity. This is not the HMAC pseudonym key or pseudonym epoch. Before key creation, a private temp reservation makes interrupted admission discoverable for exact key cleanup. Only encrypted, bounded canonical event bytes are flushed and atomically published; the delivery reference and monotonic admission sequence bind AEAD associated data. A stable Id is never regenerated, equal-content events with distinct Ids remain independent, and conflicting deliveries under one Id reject. Journal replay does not recompute a score, time, TTL, expiry or pseudonym epoch. PostgreSQL timestamp comparison uses UTC microsecond storage precision without replacing the original journal time.

The existing worker reads immutable sources in admission order. The SQL store checks every normalized field, not merely Id existence, on both ordinary commit and duplicate delivery. An exception, missing key, malformed source or altered stored field retains the journal and records only an opaque reference/fixed failure reason. Cancellation has one disposition owner; it returns each unresolved lease to the durable source once. Queued, in-flight, durable-pending and current terminal counts are disjoint; cumulative accepted/rejected counters cannot certify drain or permanently substitute for current failure state. A retained failed source clears its current blocker only after successful exact replay/cleanup, including recovery from failure-marker publication errors. Rejected local admissions have a bounded opaque payload-identity ledger, sized to the larger configured channel/batch bound; only durable admission of that exact normalized payload resolves its rejection, not a different event's success. Preparation failures without a usable event identity or exhaustion of that bookkeeping budget remain an explicit unresolved-loss blocker requiring operator disposition; automatic clearing would fabricate retention. No rejected payload is treated as RAM-only success.

Failure-marker publication errors keep independent opaque source references, bounded by the configured lease batch; a successful marker or exact ACK clears only its corresponding reference. Missing tracked sources remain unresolved rather than being inferred committed. If this budget is exhausted, `security-risk:replay-failure-budget-exhausted` with an unknown item reference blocks qualification. Counts in that state include an opaque authority-loss guard and must not be presented as an exact whole-queue event count; unrelated successes or disappearing known files do not certify the unrepresented loss. There is no unbounded failure index or automatic budget-overflow waiver.

After exact commit, an owner-only ACK rename precedes per-event key destruction and exact source/failure-file deletion. Interrupted ACK cleanup can resume without another SQL delivery; interruption before ACK replays the same event Id and verifies the existing row. Failed/unacknowledged sources are not expired merely because their original score TTL elapsed: they must still receive an exact disposition, while SQL risk scoring continues to use their original expiry. Delivery logs, health and readiness expose neither payload, pseudonym, trace, path, root nor exception detail. Rollback must preserve this root and its delivery keys and must not return to a shedding writer while pending/terminal sources remain.

## Migration and retention

Migration `20260715-post-security-risk-pseudonym-epoch` adds the epoch column, removes retained path/user-agent values, deletes all legacy epoch-zero rows, and creates the epoch index. Those old unkeyed SHA-256 values are deliberately deleted because they cannot be securely transformed without the original identifiers.

The daily cleanup worker also deletes any epoch-zero row that appears during a mixed-version rollout. It uses bounded chunks and the active-release commit guard. After the previous-epoch read window closes, normal event expiry governs remaining keyed rows; operators must not extend the previous-key window to preserve obsolete correlations.

## Rollout, rollback, and observation

Use a rolling candidate slot. The candidate must pass production startup validation and schema migration before receiving traffic. No-restart fallback means leaving the already-active slot serving while an invalid candidate is rejected; never downgrade to plain SHA-256 or disable pseudonymization. During rollback, keep the previous epoch configured until every row written by the rolled-back release is outside the score transition window.

Check startup validation output, migration history, cleanup counts (`legacySecurityRisk`), risk-event queue metrics, and PostgreSQL fallback failures. A sudden zero score after rotation usually means the previous key/epoch pair or its UTC acceptance time does not match the prior deployment.
