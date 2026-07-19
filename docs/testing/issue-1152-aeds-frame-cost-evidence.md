# AEDS frame-cost evidence gate

## 证据边界

`./tools/test.sh ci-tier aeds-frame-cost` 仍是 browserless performance/correctness lane，也不改变 AEDS v2 wire format、`AedsFrameBufferWriter`、CRC 或敏感 pooled buffer 清零行为。它只修复旧 frame-cost summary 的结论语义：结构上少一次 payload copy 不再等价于机器实测性能胜出。

最终 `.tmp/perf/aeds-frame-cost/summary.json` 使用 `fsusblog.aeds-frame-cost.v2`：

- `structuralEvidence` 记录 copy count/bytes、推导文本和 `hardwareCounter=false`。`copyBytesBefore=payload.Length` 是旧双缓冲路径的代码结构推导，不是 PMU、profiler 或硬件 counter。
- `source.artifactSet` 同时绑定本次真正执行的 Release `FsusBlog.Core.Benchmarks.dll` 与其加载的 `FsusBlog.Core.dll`：每个条目保留仓库相对路径、字节数和 SHA-256，并对规范化后的完整集合再次计算 digest。finalizer 会从当前 Release 输出重读并校验这些字节，同时把完全相同的文件快照纳入 `.tmp/perf/aeds-frame-cost/**`；后续下载证据时可从快照复核，不能用只匹配 benchmark 外壳、却替换 Core 依赖的 stale artifact 冒充本轮结果。
- `measuredEvidence` 记录 commit、CPU、OS、runtime、GC、affinity、warmup、round/iteration/sample count，以及 before/after 的 allocation、mean、p50、p95、standard deviation、逐轮值、逐次 `samplesMs`、逐轮 allocation 总量和波动范围。权威门禁的 `meanMs` 是 round mean 中位数、`p95Ms` 是 round p95 中位数；`arithmeticMeanMs`、pooled p50/p95、standard deviation、CV 与 range 由全量样本重算，避免用稳健统计隐藏原始 outlier。
- `policy` 绑定 `tests/performance/perf-policy.yml` 的 SHA-256、authoritative mean/p95 aggregation 和实际阈值；checker 会从逐次样本重算每轮 mean/p50/p95/stddev、可验证 allocation，再重算 pooled 统计、median-of-round 聚合、scenario assessment 与三层 conclusion，不信任 summary 中手写的聚合值、`status` 或 conclusion。

## 场景与结论

场景分为四组：

| Group | 用途 | 是否门禁动态路径结论 |
| --- | --- | --- |
| `static-preencoded` | `EmptySuccess` 静态预编码 reference | 否 |
| `tiny-dynamic` | `ApiError` 等纳秒/微秒级小 frame | 是，使用独立较宽但有界 noise band |
| `representative-dynamic` | `ArticleList10/50/100`、`ArticleDetailLarge`、`CommentCursor`、`ConversationDetail`、`PublicAotBootstrap` | 是，全部必须存在且不回退 |
| `supplemental-dynamic` | `ArticleDetailSmall/Medium`、`UploadStatus` | 是，使用 representative policy，但不替代必需场景 |

字段驱动结论固定为：

```text
structural improved + authoritative measured improved/neutral -> overall improved
structural improved + measured blocked                      -> structural-only
structural improved + measured regressed                    -> regressed
structural regressed                                         -> regressed
```

代表性动态 frame 的 allocation 不允许增加；mean 与 p95 使用 policy 中 `max(relative band, absolute band)`，避免小样本时纳秒抖动，也避免把相对与绝对 allowance 相加放宽。tiny group 有单独的固定开销与相对噪声带，不能让 `EmptySuccess` 或单个 tiny result 代表真实动态响应。

## Authority 与失败处理

authoritative measured evidence 要求：当前 40-hex SHA、当前 Release benchmark/Core artifact set digest、tracked worktree clean、同进程五轮以上测量、最低 warmup/iteration、完整 CPU/OS/runtime/GC/affinity identity。五轮是对已观察到的单轮 scheduler outlier 的稳健下限，不是放宽 allocation/mean/p95 阈值。lane 先写 `raw-summary.json`，再由 `check-evidence-metrics.mjs --finalize-aeds-frame-cost` 重读当前 Release 文件、保存证据快照、绑定 policy 并计算结论，最后以 `--validate-aeds-frame-cost` 再次重读当前 Release 文件并 fail closed。归档后允许显式使用 artifact snapshot 复核，但普通本地权威校验不会静默降级到快照。

- stale/wrong SHA、benchmark/Core 任一 artifact 的路径/字节数/SHA/set digest 不一致、结构/实测场景集合不一致、原始样本与任一汇总统计不一致，或 policy digest/结论被篡改：证据无效，直接拒绝。
- authority 条件缺失但证据结构完整：保留 `blocked/structural-only` summary，不得描述为“实测胜出”。
- allocation、mean 或 p95 超出 policy：写出 `regressed` assessment，lane 失败。
- 极小 frame 在 tiny noise band 内：assessment 为 `neutral`，不产生随机失败。

排障时先查看 `measuredEvidence.authority.blockedReasons`，再查看每个 `assessment.regressionReasons`、`limits` 和逐轮值。需要回退治理时可以恢复旧 lane/checker，但不得把 v2 summary 降格成仅凭 derived copy bytes 的 `status=ok`；运行时回退不需要重启或切换 AEDS writer，因为本 issue 没有修改生产编码路径。
