# Article mutation outbox claim lease

`ArticleMutationOutboxDispatcher` is an at-least-once dispatcher. The article mutation and its
`article_mutation_outbox` row are committed in the primary database transaction. Only a later,
committed claim may start an external side effect; no cache, artifact, search, notification, or
PublicHot operation is executed inside or before that transaction commits.

Claims do not weaken the v2 event coordinate contract. Before an owner executes any edge it must
validate the persisted revision/release/rights/responsibility coordinates. A superseded event is
completed with terminal `skipped` edges and an explicit reason; an expired owner can be reclaimed,
but already completed or skipped edges are never executed again.

## State machine

| From | Guard | To | Atomic database write |
| --- | --- | --- | --- |
| `pending` | `next_retry_at <= now` | `processing` | set a random `claim_token`, `claimed_by`, `claimed_at`, `heartbeat_at`, and `claim_expires_at` |
| expired `processing` | effective lease deadline `<= now` | `processing` | replace the old token and owner; report a stale reclaim |
| live `processing` | matching token and unexpired deadline | `processing` | heartbeat and extend the deadline |
| owned `processing` | effect failed | `pending` or `poison` | increment retry count, set `next_retry_at` and error, clear all claim fields |
| owned `processing` | every required edge receipt is terminal (`completed` or version-superseded `skipped`) | `processed` | set `processed_at` and clear all claim fields |

Claim uses one `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED) ... RETURNING` statement.
The returned rows are visible to dispatcher code only after the statement has completed. A claim
timeout or commit error therefore produces an empty/failed claim result and cannot reach
`ProcessOneAsync`.

Every heartbeat, edge receipt, retry transition, and completion transition compares both `id`
and `claim_token`. Completion also re-reads the required edge receipts in its own SQL statement.
An old worker can finish an external call after losing its lease, but it cannot record the receipt,
schedule the retry, or mark the outbox event processed. The current owner replays that effect.

`next_retry_at` remains the pending retry schedule. While a row is processing, new code mirrors the
claim deadline into it solely as an N-1 compatibility bridge. Reclaim uses the later of
`claim_expires_at` and `next_retry_at`, so an older dispatcher and the token-aware dispatcher do not
immediately steal each other's live work during rollout.

## Heartbeat and stale recovery

The dispatcher renews the whole claimed batch in an independent dependency-injection scope, so a
long side effect does not block its heartbeat database command. It also renews the individual row
immediately before each effect. A heartbeat may renew only an unexpired token; a worker cannot
resurrect itself after missing the deadline.

Both values are read on every poll from reloadable configuration:

- `ArticleMutationOutbox:ClaimLeaseSeconds`: default `120`, bounded to `30..900`.
- `ArticleMutationOutbox:HeartbeatSeconds`: default `20`, bounded to at most one third of the lease.
- `ArticleMutationOutbox:Enabled`: default enabled; set to `false` to stop new claims without a restart.

Expired claims are naturally included in the next batch. Each poll records the remaining expired
processing count and logs `article-mutation-outbox-stale-claims-detected` when it is non-zero.

## Idempotency contract

The unavoidable crash window is `external effect succeeded -> edge receipt not committed`. Recovery
must replay, so receipts alone are never described as exactly-once. Every receipt stores
`delivery_key = SHA-256(outbox event id + ":" + edge name)` and retries reuse that key.

Required edges converge to current article state:

- PublicAOT and HTTP cache invalidation are repeated deletes/invalidations.
- search projection is article-keyed upsert/delete.
- taxonomy projection reconciles from the database source of truth.
- article-detail AEDS atomically replaces or removes the current content-derived artifact.
- PublicHot enqueues may duplicate, but the single reader coalesces article ids and publishes the
  same source-derived snapshot.

Notification stream delivery uses the deterministic key at the sink. Redis atomically maps it to
one stream event id for seven days. Retry reuses that id; an existing stream entry is accepted as a
successful duplicate instead of appended again, and duplicate local fanout is suppressed. A keyed publish failure is surfaced to the outbox
and retried. Notification stays outside the publication-integrity prerequisite set, so integrity
proof ordering remains based only on the source-derived public-read edges.

## Observability

The dispatcher emits:

- `fsus.article_outbox.claimed.count`
- `fsus.article_outbox.reclaimed.count`
- `fsus.article_outbox.claim_lost.count`
- `fsus.article_outbox.heartbeat.count` with bounded result tags
- `fsus.article_outbox.stuck_claims`

Alert when `stuck_claims > 0` persists beyond two claim leases, when `claim_lost.count` rises without
a deployment handoff, or when heartbeat failures persist for one lease. A single reclaimed row after
a process crash is expected; a continuously growing remainder is not.

## No-restart fallback

Set reloadable `ArticleMutationOutbox:Enabled=false` to stop new claims. In-flight owners may finish;
if an instance is fenced or terminated, their database leases expire and remain recoverable. The
nullable Expand columns are retained and ignored by N-1 code. Keep the active-release fence in place,
wait at least one configured lease, and switch to the retained compatible worker. Do not delete edge
receipts or reset retry counts. Re-enable only after the selected worker owns the active release.
## Current required outbox edges

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.required-edges
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.required-outbox-edges
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.article.required-outbox-edges -->
- `article-detail-aeds`
- `http-cache-invalidation`
- `public-aot-invalidation`
- `public-artifact-revocation`
- `public-hot-read`
- `search-projection`
- `taxonomy-projection`
<!-- FSUSBLOG-GENERATED:END content.article.required-outbox-edges -->
