# AEDS cache-miss owned-frame 构建与生命周期

## 范围与结论

本优化只覆盖 cache miss、L2 backfill 与 public artifact rebuild，不改变 cache-hit 直出路径，也不把结构性 copy 下降表述成稳定态 QPS 提升。运行时 cache frame 选择 pooled `OwnedAedsFrame`；PublicHotRead snapshot 和文件 artifact 选择 exact array。两条路径都由真实 POD writer 直接写最终 AEDS frame，不再先物化无用途的精确 payload array。

`IUnifiedCache` 的 raw payload API 保持原 defensive-copy 契约。预编码 frame 单独使用 `IOwnedFrameCache`，避免 pooled buffer 作为无跟踪 `ReadOnlyMemory<byte>` 逃逸。AEDS v2 header、CRC、frame type、cache key、TTL、invalidation 与 ETag/version 均不变。

## 测量方法

本地 profiler 使用 ArticleList 10/50/100、ArticleHot、ArticleDetail backfill、Comment cursor、UserComment、taxonomy、system、message 与 AdminStats 的真实 POD writer。每个场景轮换比较：

1. `pooled writer -> exact payload[] -> exact frame[] -> Redis/L1 defensive arrays`；
2. counting pass 后一次 exact final-frame allocation；
3. 单次写入 pooled `OwnedAedsFrame`；
4. 按当前 runtime 动态探测 LOH threshold 的 exact/pooled tier。

证据同时记录 synthetic rebuild count、production frequency metric 名、payload/frame bytes、allocation/build、application copy bytes、p50/p95、logical length、backing capacity 与 sensitive/public 分类。profiler 的 sink 只读取 immutable lease；它明确不声明 Redis client、socket 或文件系统内部零拷贝。

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

2026-07-18 的 Release 本机证据使用 5 warmup、每轮 50 rebuild、5 轮旋转顺序；活动 runtime 探测到 byte-array LOH threshold 为 84,976 bytes。11/11 场景保持 byte parity，pooled owner 在 11/11 场景 allocation 不高于 exact，且 11/11 场景 p95 位于 exact 的 110% 以内，因此本次选择 `cache=owned`、`public artifact=exact`。原始 summary 是 `.tmp` 临时证据，不提交仓库；上述数字必须在 runtime、机器或 POD 规模变化后重新生成。

选择规则不是写死 frame 大小：cache-owned 策略只有在多数真实场景中 allocation 不高于 exact 且 p95 不超过 exact 的 110% 时才选择 pooled owner；tiered 候选的边界来自运行时 LOH 探测。PublicHotRead/file artifact 因 weak-snapshot/file 生命周期并非 lease-owned，固定选择 exact final frame。

运行时 `fsus.cache.owned_frame.build.count` 按 policy、frame type、frame class 和 storage kind 补充真实 rebuild 频率；logical bytes、capacity bytes 与 capacity overhead 分开输出。release evidence 中的本机时延和 allocation 只代表该次机器/运行时，不是跨机器承诺。

## Ownership 状态机

| 阶段 | root owner | read lease | backing 与计账 |
| --- | --- | --- | --- |
| build | builder 独占 | 无 | writer 直接写保留 header 的最终 frame |
| Redis/file write | cache/artifact 持有 root | write lease | await 完成前不得归还或清零 |
| L1 active | cache 持有 root | response/concurrent readers 可并发获取 | residency 同时计 logical length 与完整 backing capacity |
| replace/evict/invalidate/shutdown | root 原子 retire，禁止新 reader | 已发 lease 继续有效 | entry count 立即移除；logical/capacity 仍保留 |
| final reader release | 已 retired | 最后 lease 释放 | pooled buffer 精确 return 一次；exact sensitive array 清零；随后扣减 residency |

`OwnedAedsFrameReadLease` 通过自有 `MemoryManager<byte>` 暴露只读 memory。lease dispose 后，先前捕获的 memory、pin handle 与再次读取都会 fail closed；pin 尚未释放时 owner 继续保留 backing。`BinaryPreencodedFrameResult` 只允许 owned result 执行一次，并在正常写出、304、HEAD、请求取消和 write exception 的同一个 `finally` 中释放 lease。

## Cache 与并发边界

- `SetOwnedFrameAsync` 从参数校验后的第一个可能失败点开始消费 root；success、cancellation、exception 和 cache 已 shutdown 都不会把 owner 留给调用方。
- L1 admission 先写 `IMemoryCache`，成功后才发布 owned indexes 和 residency；admission exception 保留旧 entry/counters，并 retire 新 owner。
- exact、batch 与 prefix invalidation 对已解析 Redis key 使用按字典序获取的 keyed mutation gates。L2 read、owned set 与删除不能交叉完成为“删除后重装”。
- keyed gate 只排序 cache I/O，不能证明 gate 之前读取的 DB source 仍新鲜。`AdminStatsFrame` 使用持久 `frame-version` generation：读取通过 Redis `INCRBY 0` 绕过进程 L1，发布新 generation 后，frame、core aggregate、overview、recent 与 region source 全部进入该 generation 从未使用过的 identity；旧节点的 legacy/L1 source 因 key 不同不能污染新 frame。endpoint 在 rebuild 前后复核 generation，漂移时重读，连续漂移超过有界重试时只返回当前 frame、不写 L1/L2；invalidation 同时清理 previous-generation source/frame。文章、评论和 taxonomy 已有各自 version identity。
- `Dispose` 在 L1 publication lock 内再次检查状态；已在 Redis await 中的 set/get 不能在 shutdown clear 后重新安装。
- L2 bytes 只有在 CRC/frame-type 验证通过后才移交 owner。取消、异常或无效 frame 的临时 array 一律清零，避免依赖不可信 header 判断敏感性。
- `OwnedFrameCacheResidencySnapshot` 是同一 publication lock 下的一致快照。retired 但仍被 response/Redis reader 持有的 backing 继续计入 logical/capacity，直到真实 release callback 完成。

敏感分类由 `AedsFrameSensitivity` 的 public-immutable allowlist 决定；auth/session/MFA/Passkey/recovery/admin/anonymous credential 及未来未登记 frame 默认清零。不得在 cache policy 或调用点另建第二套 allowlist。

## Public artifact 边界

PublicHotRead projector 和 ArticleDetail artifact store 使用 final-frame writer，随后只保留 exact frame array。这样删除 payload intermediate array，同时保持 snapshot swap、HMAC/ETag、预压缩 variant 和文件序列化的既有长期生命周期。PublicHotRead residency 对 array-backed slice 按完整 backing capacity 计账；只有无法取得 array segment 时才退回 logical length。

## 验证与风险

聚焦验证覆盖 wire parity、CRC/frame type、concurrent reader、double dispose/use-after-return、pin lifetime、replace/eviction/compaction/cancellation/exception/shutdown、Redis await、Dispose/read/remove 竞态、admission rollback、敏感清零、backing-capacity residency、304/HEAD/cancel/write exception 与 owned result double execute。

主要风险是 pooled capacity overhead 和 owner/lease 使用错误。运行时可用 capacity-overhead telemetry 和 cache residency snapshot 观察；如 data-scale evidence 显示 capacity/GC 恶化，可把具体 rebuild producer 回退到 `BuildExact`，wire/cache identity 不变。PublicHotRead/file artifact 已保持 exact，因此无需把 snapshot 生命周期迁移到 pool。任何回退都不得恢复 payload array + frame array 的无条件双物化。
