# Comment mutation outbox

The comment-command transaction commits only authoritative state and the minimal Outbox identity. Model calls, cache-version advancement, notification-stream and site-message delivery, and audit projection no longer decide whether the request transaction commits; a post-commit worker recovers those side effects reliably.

## Transaction and events

The same transaction writes `comment` / `comment_region_compliance` and these events:

- `CommentCreated`
- `CommentModerationChanged`
- `CommentDeleted`
- `CommentEdited`
- `CommentReplyNotificationRequested`
- `CommentVisibilityChanged`

Events store only event/comment/article/root/parent/account/reply-target/admin actor, before/after moderation state, and time. The writer forces `payload_json` to `{}`, and the database rejects any other value; comment body, IP hash, anonymous proof, nullifier, ticket, and credential never enter the Outbox.

## Delivery state machine

```text
pending/failed -> processing -> processed
      ^               |
      +-- backoff <---+
                      +-- attempt >= 10 -> poison

expired processing lease -> processing
```

Each processing event has its own `claim_token`, `claimed_by`, `lease_generation`, `claimed_at`, `lease_expires_at`, and `last_heartbeat_at`. The worker reads reloadable `CommentMutationOutbox:ClaimLeaseSeconds` (default 60, range 30..300) and `HeartbeatSeconds` (strictly less than one third of the lease). Only the background heartbeat renews by event id, token, worker, and generation; it must affect exactly one row and increments `renewed` and `heartbeat` at that same success point. Ownership checks before the consumer, after an external call, before checkpoint write, and before Outbox completion use the same affected-row guard, but do not extend the lease, update `last_heartbeat_at`, or count as renewal. Zero rows, an expired lease, or a short heartbeat failure marks the event `lost`, stops later side effects, and prevents the old owner from writing a checkpoint, `failed`, or `processed` over the new owner.

`comment_mutation_outbox_delivery` has one row per `event id + consumer name` and uses `pending -> processing -> completed|retryable-failed|terminal-failed`. Before any side effect, the consumer atomically reserves with the event's current claim token, worker, and lease generation. Only the reservation owner may execute, record a failure, or write `completed` with a semantic `result_digest`. `completed` can be skipped only with a matching digest; live processing owned by another worker fails closed, while only expired processing or `retryable-failed` can be taken over. `terminal-failed` prevents the event from becoming `processed`. The delivery lease mirrors the event claim fence and is not renewed independently. External delivery uses stable keys: notification stream uses `comment-outbox:{eventId}:realtime`, and site messages use the existing deterministic source-event id. Model and manual state changes retain database CAS, so duplicate events cannot repeat a state transition.

Terminal transitions are claim-fenced SQL compare-and-swap operations. The current owner may write `processed` only when every required consumer has a `completed` receipt and every `result_digest` exactly matches the event/consumer-derived expectation; that exact digest set is the authoritative binding for the event's terminal result. The owner may write `failed` only after at least one delivery has recorded `retryable-failed` or `terminal-failed`. Any terminal UPDATE affecting other than one row means claim loss; the old owner cannot overwrite the new owner or increment `processed`/`failed` metrics. A completed receipt with a mismatched digest is first changed to `terminal-failed` under the current event claim, then follows the event failure path.

The worker always claims by `occurred_at_utc, id` but does not require absolute ordering; it rereads the current comment before realtime delivery. An old approve event sends no `CommentAdded` when the current row is hidden/deleted, and an old hide event sends no `CommentRemoved` when the current row is approved again. Cache invalidation may repeat and uses the current aggregate scope.

## Fault-injection coverage

- interruption before the authoritative transaction commits: comment and Outbox roll back together;
- interruption after commit and before the model call: a restarted worker reclaims pending `CommentCreated`;
- interruption before cache, realtime, or notification delivery: completed, digest-verifiable consumer checkpoints remain, and an unfinished reservation is retried only after its delivery lease expires;
- temporary consumer unavailability: the event enters `failed`, retries with exponential backoff, and enters `poison` after ten attempts;
- duplicate delivery: atomic reservation gives each consumer, including `cache-version`, one owner, with stable idempotency keys as a second guard for realtime and site messages;
- concurrent or out-of-order deletion/moderation: consumers read authoritative current state and cannot republish an old event.

## Observability and rollback

`runtime.commentMutationOutbox` in `/api/ops/health/ready-detail` returns backlog, failed, poison, oldest age, processed, last completed, last error, owned, renewed, lost, reclaimed, and oldest lease age. The corresponding metrics are `fsus.comment_outbox.processed.count`, `failed.count`, `claim_lost.count`, `heartbeat.count`, `backlog`, `oldest_age_seconds`, and `poison`; non-zero poison degrades runtime readiness.

For a no-restart fail-closed rollback, set reloadable `CommentMutationOutbox:Enabled` to `false`. The worker stops claiming while authoritative comment transactions continue writing pending events. After PostgreSQL, model, Redis/notification-stream, or message delivery issues are repaired, restore `true` and the backlog resumes. Do not delete events or checkpoints, or manually mark an unknown side effect completed.

## Risk boundary

Pausing the worker delays public cache, realtime, and notification delivery but does not lose authoritative comment state. Recovery may create short-lived backlog pressure; release batches while watching backlog age and failed/poison counts. This design adds no external messaging system: single-process development uses the built-in hosted worker, while multiple instances reuse `IBackgroundWorkerLease` leader election.
## Current comment outbox edges

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.comment-outbox
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.comment.required-outbox-edges
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.comment.required-outbox-edges -->
| Key | Value |
| --- | --- |
| CommentCreated | &#91;"audit-projection","cache-version","model-moderation","realtime-stream"&#93; |
| CommentDeleted | &#91;"audit-projection","cache-version","realtime-stream","site-notification"&#93; |
| CommentEdited | &#91;"audit-projection","cache-version","realtime-stream"&#93; |
| CommentModerationChanged | &#91;"audit-projection","cache-version","realtime-stream","site-notification"&#93; |
| CommentReplyNotificationRequested | &#91;"site-notification"&#93; |
| CommentVisibilityChanged | &#91;"audit-projection","cache-version","realtime-stream"&#93; |
<!-- FSUSBLOG-GENERATED:END content.comment.required-outbox-edges -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.comment-outbox-consumers
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.comment.outbox-consumers
render: enum-set
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.comment.outbox-consumers -->
- `audit-projection`
- `cache-version`
- `model-moderation`
- `realtime-stream`
- `site-notification`
<!-- FSUSBLOG-GENERATED:END content.comment.outbox-consumers -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.comment-outbox-terminal-states
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.comment.outbox-terminal-states
render: enum-set
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.comment.outbox-terminal-states -->
- `completed`
- `poison`
- `processed`
- `terminal-failed`
<!-- FSUSBLOG-GENERATED:END content.comment.outbox-terminal-states -->
