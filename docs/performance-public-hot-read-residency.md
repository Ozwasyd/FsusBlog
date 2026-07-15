# PublicHotRead residency、admission 与 snapshot 生命周期

## 物理模型

`PublicHotReadResidentAccounting` 在候选发布前生成 `independent-readonly-arrays-upper-bound-v1`。payload bytes 取实际 `ReadOnlyMemory<byte>.Length`；Frozen map、entry、key、ETag、cache-control、template string/offset/hash 清单使用稳定上界常量。该模型可能高估共享字符串和 map 内部布局，但不会把未知开销伪报为零。`85,000` bytes 以上的 backing array 计入 LOH eligible；runtime 同时报告 raw AEDS、br、gzip、HTML/template、key/index、article/list/taxonomy/HTML、base/overlay/removed、artifact/object/array 与 LOH bytes。

零配置从 `GC.GetGCMemoryInfo().TotalAvailableMemoryBytes` 派生，因此受容器/cgroup memory limit 约束。默认 resident 为可用内存的 1/8（64 MiB–2 GiB），raw 3/4、compressed 1/2、HTML 1/2、candidate/current overlap 2 倍 resident，article detail 取 resident 1/2 与 raw 3/4 的较小值。显式配置仍须落在 Blue/Green 双槽、SSR worker、managed heap 与系统余量共同允许的范围内。

## Admission 与存储选择

taxonomy、home、archive、hot、featured list 始终作为关键制品构建。article detail 候选由 views 热度与最近发布两个 segment 按确定顺序交错，再同时受 `MaxArticleFrames` 和 `MaxArticleResidentBytes` 限制；mutation/view delta 把本次变化的 article 放在 admission 前端，随后按 artifact version/article id 确定性淘汰。未 admission 的 article 仍由现有 binary endpoint 从版本化 L1/L2/DB 路径读取和回填，不改变 AEDS v2、ETag、visibility 或 invalidation。

当前选择独立只读数组，不采用连续 pack/mmap：L0 writer 已直接消费 `ReadOnlyMemory<byte>`，snapshot swap 只替换引用，pack 会在 publish 期间增加一次全量 copy 和更大的 overlap 峰值。若 data-scale 证据显示 object count、LOH 或 GC pause成为饱和资源，再引入 release-scoped immutable pack；届时必须绑定 release/digest、验证 offset/corruption、保留 N/N-1，并证明 slice 仍零 copy。

br/gzip 只在 publish/backfill 生成，并同时满足 `MinPrecompressedFrameBytes`、`MinCompressionSavingsPercent` 和对应 expected client share。默认份额基线为 br 80%、gzip 15%，低于 5% 的 variant 不常驻。请求只选择已存在 variant，不即时压缩。striped counter 记录实际 `identity/br/gzip` negotiation 次数并通过 ops snapshot 与 `fsus.hotread.encoding.*` 输出；下一次 release 必须用该观测分布更新 expected share，不能长期把默认基线当成真实客户端证据。

本机 release profiler（`bash tools/test/lanes/public-hot-read-residency-profile.sh`）用 12,000 篇、2,048-byte raw frame、br 80%/gzip 15% 的 fixture 准入 6,000 篇。2026-07-14 的重复证据为：snapshot 上界 16,770,460 bytes、raw 12,288,000、compressed 3,071,400、key/index 1,411,060、41,406 objects、11,700 arrays、LOH eligible 0；进程 RSS delta 约 63–64 MB，强制 full-GC pause 约 40–65 ms，100,000 次偏斜请求 hit rate 95.007%。全部通过动态 container-visible budget、RSS `<= 2x resident budget`、full GC `<= 1,000 ms` 与 hit rate `>= 90%` 门禁。数值是本机 release evidence，不是跨机器性能承诺；每次 release/data-scale 必须重新生成 `.tmp/release-evidence/public-hot-read-residency-profile.json`。

## 生命周期、证据与回退

阶段为 `build -> validate -> admit -> publish -> retire -> active`；实现把 build/admission 放在 projector，store 在原子 swap 前汇总全部 budget violation。拒绝时旧 snapshot 保持 active。交换后 store 用弱引用集合观察全部仍存活的 retiring snapshot，不延长其生命周期；下一候选的 overlap 会计入 current、candidate 与所有尚被 reader 持有的旧版本，旧 reader 释放最后引用后 GC 可回收。`MaxRetiringSnapshots`、`MaxRetiringBytes`、`RetiringSnapshotDeadline` 在同一个 publish lock 内形成独立硬门禁，默认值分别从 processor count、container-visible resident/overlap budget 与 count 派生。弱引用 target 已释放时按最老 retirement 顺序清除并记录 eviction；仍被请求持有时不能通过删除 tracking weak reference 强制释放，超过 count/bytes 或 reader pin deadline 会拒绝下一版本，而不是丢失 overlap 会计或伪造内存回收。HTML overlay 与 removed set 达到 `max(32, base/4)` 时合并，避免 delta 无限增长。

Public AOT shell 的 memory tier 使用 count/bytes/deadline 三重边界和 access-order LRU。`PublicAot:MaxMemoryCacheBytes`、`MaxMemoryCacheEntries`、`MemoryCacheEntryDeadline` 为零时按 container-visible memory 动态派生；每次 read/set/snapshot 都先清理 deadline，set 超过 count 或 bytes 时逐个淘汰最久未访问项。内存淘汰只使下一次读取回到版本化文件层，不删除当前磁盘 artifact，也不改变 PublicHotRead、binary 或 notification stream 语义。

受保护 `/api/ops/health/ready-detail` 与 author ops health 输出完整 residency/budget/overlap/lifecycle，OpenTelemetry 输出 `fsus.public_hot.resident.bytes`、`snapshot_overlap.bytes`、`loh_eligible.bytes`、`artifact_objects`、`fsus.public_hot.retiring.bytes`、`fsus.public_hot.retiring.evictions`、`fsus.public_aot.memory_cache.resident_bytes` 与 `fsus.public_aot.memory_cache.evictions`。release/data-scale 必须保存同一 release identity 下的这些字段以及进程 RSS、managed heap、LOH 与 GC pause；最终门禁不得用 payload 计数替代 RSS。

无需重启的降级顺序：降低 AOT memory cache count/bytes/deadline，使读取回退文件层；提高最小压缩收益或降低对应 client share；降低 article resident/count，并触发 `public-hot-rebuild`。retiring deadline 告警时先停止新的 snapshot publication，让现有 reader 自然结束；若仍异常，将 `PublicHotRead:Enabled=false` 热降级到常规 binary/cache 链。匿名、登录、admin、notification stream 与 binary fallback 均继续走原有管线；不得关闭 CSP、PoW/risk、安全头或失效链。恢复旧配置并重建即可回滚，无需重启。
