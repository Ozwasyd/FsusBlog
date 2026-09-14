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

The receiving node resolves every canonical `CacheTags`/`RouteKeys`/`ArtifactKeys` value before touching local state. Partial resolution must not apply a subset and then fall back to a second broad pass. Each known kind has one owner:

- `article_mutation`: the named article detail, list/hot/stats generations, and the matching AOT/HotRead article and list fragments.
- `comment_mutation`: comment cursor/version/stats and the affected article comment surface only. Article detail bodies, taxonomy, and unrelated shells stay resident.
- `taxonomy_mutation`: category/tag frames, related list generations, and the matching public routes. Unrelated article detail frames stay resident.
- `system_page_mutation`: the exact slug's AOT/HotRead HTML route.
- `seo_mutation` / `compliance_mutation`: SEO/compliance keys and the public shell HTML they own, never binary article frames.
- `public_aot_artifact_updated` / `public_hot_read_version_published`: only the artifact or version named by the event.
- `article_view_projection`: the versioned article-ID/view-count pairs only; it does not evict ArticleDetail L1 or AOT content, and it schedules the named article plus hot/featured PublicHotRead fragments.

After the plan is exact, local apply is target-scoped:

1. Invalidate only the resolved L1 policy identities. Unrelated policy entries, bytes, and hit rates must not change.
2. Invalidate only the resolved Public AOT route/artifact metadata. SEO/compliance may clear the public shell set they own, but must not clear unrelated article/taxonomy artifacts.
3. Publish an immutable PublicHotRead snapshot fragment copy-on-write for the resolved routes. The store stays ready; comments must not retire article, taxonomy, home, or other unrelated artifacts.
4. Queue a durable fragment rebuild obligation for those same targets. Known events must not enqueue `FullRebuildMarker`.
5. Persist `applied` and the generation in the target inbox only after the exact local invalidation and the fragment rebuild obligation are durable, then atomically write the target ACK to the source outbox.

Unknown schema/target, target-resolution failure, integrity-proof failure, and a durable recovery watermark that requires a full rebuild establish a named `FullReconcile` obligation. That disaster-recovery entry may clear local L1, Public AOT memory, and PublicHotRead readiness and queue a full rebuild. It is not a silent fallback for a known event, and there is no legacy broad-applier mode, dual apply, compatibility adapter, or `Runtime:UseLegacyDistributedInvalidation` switch.

The local apply receipt records resolved target count, actual L1 policy/entry/byte counts, AOT route count, PublicHotRead fragment count, whether full reconcile ran, and the reconcile reason. These steps converge only the node-local view. The respective domain documents remain authoritative for L1, Public AOT, and PublicHotRead storage, version, and rebuild contracts; other cache/AOT documents must not duplicate this bus protocol.

## Replay, retry, and loop prevention

The bus uses `runtimeScope:eventId` as replay identity. A source ignores its own message; the receiver calls the local applier directly, never re-enters dispatch or publish, and therefore cannot loop. The target durably upserts an inbox by `(runtimeScope,eventId,targetNodeId)`, then atomically claims `pending|retryable-failed` as `applying` with a database condition; in-process collections do not establish correctness. A duplicate payload is complete only when the durable inbox is already `applied`; a different payload digest for the same event ID marks both inbox and source outbox `terminal-failed` in one transaction.

The local applier returns a structured result containing memory invalidation, AOT memory invalidation, AOT generation mark, HotRead fragment publication, rebuild obligation (`durable`, `queued`, `rejected`, or `failed`), local-apply terminal status, and the exact-target receipt fields. The bus records `applied` only when the exact local stages succeed, full reconcile did not run, and the obligation is `durable` (with obligation ID and generation) or `queued`. `rejected` or unknown/null/incomplete results become `retryable-failed` after bounded in-process retries and may be claimed by durable replay; an explicit terminal result, including an unresolved target that established `FullReconcile`, becomes `terminal-failed` and is not applied again. Startup recovery first changes an interrupted `applying` to `retryable-failed`. The runtime snapshot separately counts `received`, `local-invalidated`, `rebuild-obligated`, and `applied`, rather than substituting log detail for phase fields.

## Degraded operation and recovery

`DistributedInvalidationConvergenceObligationStore` is the sole delivery-ledger owner. Source outbox identity is `(runtimeScope,eventId)` and target inbox identity is `(runtimeScope,eventId,targetNodeId)`. During prepare, the source ACKs only its completed local mutation; other required nodes use one PostgreSQL atomic ACK-set update, so concurrent target ACKs cannot overwrite one another. The source becomes `complete` only after every current required node ACKs; Redis subscriber count, wait time, and publish success cannot complete it. Legacy dispatcher `UpsertAsync` only records the same transport receipt idempotently by `observedAt` and never creates a second fact without payload.

The hosted-service subscription and recovery poll run in parallel. Temporary database unavailability at startup, Redis subscription failure, or lost Pub/Sub messages cannot permanently end the worker; the recovery poll boundedly retries, at `RecoveryReplayIntervalMilliseconds`, current-scope outbox rows not yet ACKed by this node and honors host cancellation. Explicit topology retirement first writes the retirement ledger in one PostgreSQL transaction, then removes the node from unfinished outbox required sets and recomputes state; there is no timeout completion.

Full-reconcile compaction requires the `(runtimeScope,targetNodeId,kind)` coverage row's generation to reach the watermark and every required target inbox to be `applied`. A caller number or one event's applied generation cannot replace scope/kind coverage proof. Retention removes only `complete` payloads with that proof; `pending`, `partially-acked`, and `terminal-failed` are never compacted.

`pending`, terminal, oldest age, ACK gap, and ledger availability enter `distributedConvergence` readiness and the deployment drain/release snapshot. Any pending, terminal, ACK gap, or ledger-unavailable state fails closed. `single` returns `LocalOnly` and creates no remote ledger row.

When Redis is temporarily unavailable, the node completes local invalidation and lets reads fall back to PostgreSQL or another authoritative path while the subscription loop retries. Recovery needs no restart; later events and PublicHotRead rebuilds continue converging. Do not manufacture consistency by republishing received events, skipping local-first ordering, or changing the mutation to failed.

To fully disable multi-node coordination, set `Runtime:Mode` back to `single` and perform the normal rolling restart because hosted-service DI composition is fixed at startup. This mode switch is not a prerequisite for recovering a transient Redis failure.

## Verification ownership

`DistributedInvalidationBusTests` uses two independent bus instances to verify peer L1, Public AOT, and PublicHotRead convergence, self filtering, duplicate idempotency, no publish loop, apply retry, startup retry while the ledger is unavailable, and local-first behavior with Redis unavailable. `DistributedInvalidationDeliveryLedgerIntegrationTests` uses a real PostgreSQL/Redis two-node fixture to verify offline/lost Pub/Sub, disconnect/reconnect, restart after apply failure, duplicate exactly once, digest mismatch, partial/concurrent ACK, retirement, scope/kind generation coverage, retention, and terminal readiness. Tests must assert durable rows, never replace ledger evidence with mocks, logs, or in-process counters.
