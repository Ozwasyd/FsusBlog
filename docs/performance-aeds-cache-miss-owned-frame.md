# AEDS cache-miss owned-frame construction and lifecycle

## Scope and conclusion

This optimization covers only cache misses, L2 backfill, and public-artifact rebuilds. It does not change the cache-hit direct path, and structural copy reduction is not reported as a steady-state QPS gain. Runtime cache frames use pooled `OwnedAedsFrame`; PublicHotRead snapshots and file artifacts use exact arrays. Both paths use the real POD writer to write the final AEDS frame directly, without first materializing an unnecessary exact payload array.

The `IUnifiedCache` raw-payload API keeps its defensive-copy contract. Pre-encoded frames use `IOwnedFrameCache`, so pooled buffers cannot escape as untracked `ReadOnlyMemory<byte>`. AEDS v2 headers, CRC, frame type, cache key, TTL, invalidation, and ETag/version are unchanged.

## Measurement method

The local profiler uses real POD writers for ArticleList 10/50/100, ArticleHot, ArticleDetail backfill, Comment cursor, UserComment, taxonomy, system, message, and AdminStats. Each scenario rotates these comparisons:

1. `pooled writer -> exact payload[] -> exact frame[] -> Redis/L1 defensive arrays`;
2. counting pass followed by one exact final-frame allocation;
3. one pooled `OwnedAedsFrame` write;
4. exact/pooled tiers selected by the current runtime's detected LOH threshold.

Evidence records synthetic rebuild count, production frequency metric name, payload/frame bytes, allocation/build cost, application copy bytes, p50/p95, logical length, backing capacity, and sensitive/public classification. The profiler sink reads only an immutable lease; it makes no zero-copy claim about the Redis client, socket, or filesystem internals.

```bash
dotnet build benchmarks/core/FsusBlog.Core.Benchmarks.csproj -c Release --no-restore
dotnet benchmarks/core/bin/Release/net10.0/FsusBlog.Core.Benchmarks.dll \
  --aeds-cache-miss-frame-cost \
  --iterations 50 \
  --warmup-iterations 5 \
  --rounds 5 \
  --out .tmp/perf/aeds-cache-miss-frame-cost/summary.json
node tools/operations/check-aeds-cache-miss-frame-evidence.mjs \
  .tmp/perf/aeds-cache-miss-frame-cost/summary.json
```

The 2026-07-18 Release local evidence used 5 warmups, 50 rebuilds per round, and 5 rotating rounds; the active runtime detected an 84,976-byte byte-array LOH threshold. All 11/11 scenarios kept byte parity; the pooled owner was no more allocative than exact in 11/11, and p95 stayed within 110% of exact in 11/11. The selected policy is therefore `cache=owned`, `public artifact=exact`. The raw summary is temporary `.tmp` evidence and is not committed; regenerate these numbers after runtime, machine, or POD scale changes.

The cache-owned strategy is selected only when most real scenarios have allocation no higher than exact and p95 no higher than 110% of exact. Tier boundaries come from runtime LOH detection, not a hard-coded frame size. PublicHotRead/file artifacts remain exact because their weak-snapshot/file lifetimes are not lease-owned. Runtime `fsus.cache.owned_frame.build.count` is labeled by policy, frame type, frame class, and storage kind; logical bytes, capacity bytes, and capacity overhead are reported separately. Local latency/allocation is evidence for that machine/runtime only, not a cross-machine promise.

## Ownership state machine

| Stage | Root owner | Read lease | Backing and accounting |
| --- | --- | --- | --- |
| build | builder exclusively | none | writer writes the final frame with its header reserved |
| Redis/file write | cache/artifact holder | write lease | do not return or clear backing before `await` completes |
| L1 active | cache | response/concurrent readers may acquire | residency counts both logical length and full backing capacity |
| replace/evict/invalidate/shutdown | root atomically retires; no new readers | issued leases remain valid | remove entry count immediately; retain logical/capacity accounting |
| final reader release | retired root | last lease releases | return pooled buffer exactly once; clear exact sensitive array; then decrement residency |

`OwnedAedsFrameReadLease` exposes read-only memory through its own `MemoryManager<byte>`. After disposal, captured memory, pin handles, and further reads fail closed; while a pin remains, the owner retains its backing. `BinaryPreencodedFrameResult` permits one execution per owned result and releases the lease in the same `finally` for normal writes, 304, HEAD, cancellation, and write exceptions.

## Cache and concurrency boundaries

- `SetOwnedFrameAsync` consumes the root at the first possible failure after parameter validation. Success, cancellation, exception, and cache shutdown never leave ownership with the caller.
- L1 admission writes `IMemoryCache` first, then publishes owned indexes and residency. An admission exception preserves the old entry/counters and retires the new owner.
- Exact, batch, and prefix invalidation use lexicographically acquired keyed mutation gates for parsed Redis keys. L2 reads, owned sets, and deletion cannot interleave into “delete then reload.”
- A keyed gate orders cache I/O only; it does not prove that a DB source read before the gate is fresh. `AdminStatsFrame` uses a persistent `frame-version` generation: Redis `INCRBY 0` bypasses process L1; after a new generation is published, the frame, core aggregate, overview, recent, and region sources all use identities never used by that generation. Different keys prevent old legacy/L1 sources from contaminating the new frame. The endpoint rechecks generation before and after rebuild, rereads on drift, and after bounded consecutive drift returns the current frame only without writing L1/L2. Invalidation also clears previous-generation source/frame. Articles, comments, and taxonomy already have their own version identities.
- `Dispose` rechecks state inside the L1 publication lock; a set/get awaiting Redis cannot reinstall after shutdown clear.
- L2 bytes transfer to an owner only after CRC and frame-type validation. Cancellation, exceptions, and invalid-frame temporary arrays are always cleared; sensitivity must not depend on an untrusted header.
- `OwnedFrameCacheResidencySnapshot` is consistent under the same publication lock. Retired backing still held by a response/Redis reader remains in logical/capacity totals until the actual release callback.

Sensitivity comes from the `AedsFrameSensitivity` public-immutable allowlist. Auth/session/MFA/Passkey/recovery/admin/anonymous-credential frames, and all future unregistered frames, default to clearing. Do not create another allowlist in cache policy or call sites.

## Public-artifact boundary

The PublicHotRead projector and ArticleDetail artifact store use a final-frame writer and then retain only an exact frame array. This removes the payload intermediate while preserving snapshot swap, HMAC/ETag, precompressed variants, and file-serialization lifetimes. PublicHotRead array-backed slices count full backing capacity; when no array segment is available, accounting falls back to logical length.

## Verification and risk

Focused coverage includes wire parity, CRC/frame type, concurrent readers, double-dispose/use-after-return, pin lifetime, replacement/eviction/compaction/cancellation/exception/shutdown, Redis await, Dispose/read/remove races, admission rollback, sensitive clearing, backing-capacity residency, 304/HEAD/cancel/write exception, and owned-result double execution.

The main risks are pooled-capacity overhead and owner/lease misuse. Capacity-overhead telemetry and the cache residency snapshot expose them; if data-scale evidence shows capacity or GC regression, a specific rebuild producer can fall back to `BuildExact` without changing wire or cache identity. PublicHotRead/file artifacts are already exact, so their snapshot lifetime need not move to the pool. Any fallback must not restore unconditional payload-array plus frame-array double materialization.
