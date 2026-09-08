# Distributed cache invalidation

This document is the sole authority for the cross-node cache-invalidation runtime contract. Related issues are tracking metadata in `config/development/document-lifecycle.json`, not document identity or runtime authority.

## Runtime modes and transport scope

- `single` registers only `SingleNodeDistributedInvalidationPublisher`; after local invalidation it returns `LocalOnly`, creates no Redis subscriber, and starts no bus hosted service.
- `static-role` and `adaptive` register Redis Pub/Sub transport and `DistributedInvalidationBus`. `IRuntimeKeyScope` isolates the channel, whose default logical name is `fsus:distributed-invalidation:v1`.

Multi-node modes must also provide the current machine-readable subscriber manifest at `Runtime:DistributedInvalidation:Topology:SubscriberNodeIds`. It is the sole authority for publish-delivery expectations, includes the source node when it subscribes, and canonicalizes with the logical channel into a SHA-256 topology digest. Missing manifests, duplicate/empty node IDs, or a publisher absent from the manifest fail closed during startup registration; topology must not be inferred from process count, environment variables, or Redis publish ACKs.

Node ID defaults to `machine:process-id` and may be set by `FSUSBLOG_NODE_ID` or `Runtime:DistributedInvalidation:NodeId`. Multi-node deployments must give every node a stable, unique ID; runtime scope, channel, and node identity must all match the current topology.

## Publish and apply ordering

The writing node completes existing local/shared invalidation, creates the durable source outbox, and then publishes the distributed event. The outbox stores canonical payload/digest, runtime scope, kind, topology digest, required/acked node sets, attempt, and `pending|partially-acked|complete|terminal-failed`; an event without an outbox cannot enter transport. A transport receipt stores `channel`, Redis `subscriberCount`, manifest `expectedMinimumSubscribers`, `publisherNodeSubscribed`, `observedAt`, and `transportStatus` (`delivered`, `under-delivered`, or `transport-failed`). Only `subscriberCount >= expectedMinimumSubscribers` records `Published`; zero, null, negative, or insufficient counts are `under-delivered`, and a Redis exception is `transport-failed`. Thus `count > 0` never proves remote delivery: a self-subscribing source is included in topology expectations, and source completion remains driven only by durable per-node ACKs.

Each receipt's channel/count/expected/topology digest enters `DistributedInvalidationRuntimeSnapshot`; a non-`delivered` receipt also enters cache-runtime degraded detail. Redis errors or insufficient delivery do not rewrite a successful business mutation as failed, but the publisher must return `Degraded`, never record `Published`, and never hide the condition as a debug log.

The receiving node converges local derived state in this order:

1. Clear in-process L1 indexes and entries.
2. Clear Public AOT memory and file-metadata views without deleting shared or local-disk artifacts.
3. Mark Public AOT fully invalid and clear route quarantine.
4. Retire the current PublicHotRead snapshot so requests return to the authoritative read path.
5. Queue one full PublicHotRead rebuild and obtain its apply generation.
6. Persist `applied` and the generation in the target inbox, then atomically write the target ACK to the source outbox.

These steps converge only the node-local view. The respective domain documents remain authoritative for L1, Public AOT, and PublicHotRead storage, version, and rebuild contracts; other cache/AOT documents must not duplicate this bus protocol.

## Replay, retry, and loop prevention

The bus uses `runtimeScope:eventId` as replay identity. A source ignores its own message; the receiver calls the local applier directly, never re-enters dispatch or publish, and therefore cannot loop. The target durably upserts an inbox by `(runtimeScope,eventId,targetNodeId)`, then atomically claims `pending|retryable-failed` as `applying` with a database condition; in-process collections do not establish correctness. A duplicate payload is complete only when the durable inbox is already `applied`; a different payload digest for the same event ID marks both inbox and source outbox `terminal-failed` in one transaction.

The local applier returns a structured result containing memory invalidation, AOT memory invalidation, AOT generation mark, HotRead snapshot retirement, rebuild obligation (`durable`, `queued`, `rejected`, or `failed`), and local-apply terminal status. The bus records `applied` only when the first four stages succeed and the obligation is `durable` (with obligation ID and generation) or `queued`. `rejected` or unknown/null/incomplete results become `retryable-failed` after bounded in-process retries and may be claimed by durable replay; an explicit terminal result becomes `terminal-failed` and is not applied again. Startup recovery first changes an interrupted `applying` to `retryable-failed`. The runtime snapshot separately counts `received`, `local-invalidated`, `rebuild-obligated`, and `applied`, rather than substituting log detail for phase fields.

## Degraded operation and recovery

`DistributedInvalidationConvergenceObligationStore` is the sole delivery-ledger owner. Source outbox identity is `(runtimeScope,eventId)` and target inbox identity is `(runtimeScope,eventId,targetNodeId)`. During prepare, the source ACKs only its completed local mutation; other required nodes use one PostgreSQL atomic ACK-set update, so concurrent target ACKs cannot overwrite one another. The source becomes `complete` only after every current required node ACKs; Redis subscriber count, wait time, and publish success cannot complete it. Legacy dispatcher `UpsertAsync` only records the same transport receipt idempotently by `observedAt` and never creates a second fact without payload.

The hosted-service subscription and recovery poll run in parallel. Temporary database unavailability at startup, Redis subscription failure, or lost Pub/Sub messages cannot permanently end the worker; the recovery poll boundedly retries, at `RecoveryReplayIntervalMilliseconds`, current-scope outbox rows not yet ACKed by this node and honors host cancellation. Explicit topology retirement first writes the retirement ledger in one PostgreSQL transaction, then removes the node from unfinished outbox required sets and recomputes state; there is no timeout completion.

Full-reconcile compaction requires the `(runtimeScope,targetNodeId,kind)` coverage row's generation to reach the watermark and every required target inbox to be `applied`. A caller number or one event's applied generation cannot replace scope/kind coverage proof. Retention removes only `complete` payloads with that proof; `pending`, `partially-acked`, and `terminal-failed` are never compacted.

`pending`, terminal, oldest age, ACK gap, and ledger availability enter `distributedConvergence` readiness and the deployment drain/release snapshot. Any pending, terminal, ACK gap, or ledger-unavailable state fails closed. `single` returns `LocalOnly` and creates no remote ledger row.

When Redis is temporarily unavailable, the node completes local invalidation and lets reads fall back to PostgreSQL or another authoritative path while the subscription loop retries. Recovery needs no restart; later events and PublicHotRead rebuilds continue converging. Do not manufacture consistency by republishing received events, skipping local-first ordering, or changing the mutation to failed.

To fully disable multi-node coordination, set `Runtime:Mode` back to `single` and perform the normal rolling restart because hosted-service DI composition is fixed at startup. This mode switch is not a prerequisite for recovering a transient Redis failure.

## Verification ownership

`DistributedInvalidationBusTests` uses two independent bus instances to verify peer L1, Public AOT, and PublicHotRead convergence, self filtering, duplicate idempotency, no publish loop, apply retry, startup retry while the ledger is unavailable, and local-first behavior with Redis unavailable. `DistributedInvalidationDeliveryLedgerIntegrationTests` uses a real PostgreSQL/Redis two-node fixture to verify offline/lost Pub/Sub, disconnect/reconnect, restart after apply failure, duplicate exactly once, digest mismatch, partial/concurrent ACK, retirement, scope/kind generation coverage, retention, and terminal readiness. Tests must assert durable rows, never replace ledger evidence with mocks, logs, or in-process counters.
