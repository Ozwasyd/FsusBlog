# MessageCenter responsibility boundary

`MessageCenterService` remains the in-process application façade and still implements the existing query, command, realtime, maintenance, and Outbox-delivery ports. Splitting source responsibilities adds no deployment unit, external dependency, or wire contract.

## Responsibility files

| File | Responsibility |
| --- | --- |
| `MessageCenterService.ConversationQuery.cs` | account/admin lists, details, deltas, and query composition |
| `MessageCenterService.MessageCommand.cs` | creation, account/admin replies, state changes, and system notices |
| `MessageCenterService.ReadState.cs` | account/admin read cursors and unread-projection inspection/repair |
| `MessageCenterService.DeliveryOutbox.cs` | mutation Outbox enqueue, delivery, and realtime transport |
| `MessageCenterService.Projection.cs` | DTO/viewer projection, fanout payload, and unread-cache refresh |
| `MessageCenterService.ContentPolicy.cs` | content-validation error mapping, mutation identity, and stable hash |
| `MessageCenterService.cs` | constructor dependencies, shared types, and the named-reader-governed SQL reader kernel |

Account and administrator replies must enter the same `WriteReplyAsync` transaction kernel. The request thread writes only the mutation Outbox and does not publish message events directly. Read ports accept `CancellationToken`; binary GET endpoints pass request cancellation. Existing routes, AEDS frames, and DTOs remain unchanged.

## Query-plan evidence

`MessageCenterQueryPlanIntegrationTests` creates 128 fixed conversations with 8 messages each in a local PostgreSQL fixture and runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for these production-equivalent queries:

- conversation list;
- conversation detail page;
- account unread total;
- batched last-message projection.

The fixture verifies that execution/planning time, actual rows, and shared-buffer metrics are present. This fixed dataset protects query shape and does not represent production traffic, so it does not justify adding or changing an index.

## Rollback

This split adds no schema migration, configuration switch, or external storage change. Revert the commit to roll back; after process restart the original single-file implementation returns, with no database or AEDS artifact migration.
