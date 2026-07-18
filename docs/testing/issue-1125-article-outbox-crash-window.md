# Issue 1125: article outbox crash-window verification

## Acceptance map

| Risk | Automated evidence | Expected invariant |
| --- | --- | --- |
| claim/state machine drift | `ClaimStateMachine_PersistsOwnerHeartbeatAndIndependentRetrySchedule` | scheduling and lease fields are separate and persisted |
| two workers race | `ConcurrentWorkers_OnlyCurrentClaimTokenCanWriteReceiptRetryOrCompletion` | only the current token can write any durable transition |
| claim commit fails | `ClaimCommitFailure_CannotReachExternalEffects` | gate timeout/failed claim returns zero and all effect substitutes receive no call |
| worker crashes | `WorkerCrash_ExpiredClaimIsReclaimableButLiveClaimIsHeartbeated` | expired work is reclaimable; live batch and row deadlines move forward |
| duplicate delivery | `DuplicateDelivery_ReusesStableContentHashAndPassesItToNotificationPublisher` | retry key is stable; an existing Redis stream id gets neither a second append nor local fanout |
| unsafe schema rollout | `ClaimLeaseExpandMigration_IsAdditiveAndOnlineCompatible` | nullable columns/additive index are classified as compatible Expand |

The focused command is:

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --filter FullyQualifiedName~ArticleMutationOutboxClaimLeaseTests
```

Run the existing related contract groups after the focused tests:

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --filter 'FullyQualifiedName~PublicContentInvalidationFlowTests|FullyQualifiedName~NotificationStreamBoundaryTests|FullyQualifiedName~OnlineSchemaMigrationPolicyTests|FullyQualifiedName~SchemaMigrationRegistryTests'
```

## Manual crash drill

1. Insert or select one due `pending` article outbox row and record its `event_id`.
2. Start the dispatcher and stop the process after one external edge succeeds but before its edge
   receipt is visible.
3. Verify the row remains `processing` until the effective lease deadline; it must not be
   `processed`.
4. Start the active worker after the deadline. Verify `claimed_by` and `claim_token` change, the
   reclaim counter increments, and replay converges the edge.
5. For notification, verify only one Redis stream entry exists for the deterministic delivery key,
   even when the append response is interrupted and the same outbox event is replayed.
6. Verify final `processed` is written only when every required edge row is `completed`.

## Failure and rollback drill

Set reloadable `ArticleMutationOutbox:Enabled=false`. Within one poll, no new `pending` row should
gain a claim. Let an in-flight batch finish or wait one lease after fencing it. The database rows and
edge receipts remain intact, so switching the active release to compatible N-1 code requires no
database restart and no compensating data mutation. Restore the setting only after the active-release
identity is stable; stale work must be reclaimed rather than manually reset.
