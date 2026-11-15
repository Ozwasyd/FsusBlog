# 2026-11-15 ConserveMemory=5 长测

候选 `eabe6d7e4c9450131873c94453d128a77a612c32` 使用干净的独立检出、固定 FsusUI、macOS ARM64、.NET 10.0.15、Release Kestrel 和 PostgreSQL 18.7 私有 Unix socket。保留 Server GC 及动态适应，实际 GC 样本为 `GCConserveMem=5`、`GCDynamicAdaptationMode=1`。构建源摘要 `246b893264e672b561db88975ab4fd38647399167c7d8be45d93f30eaa0d4ea0`，语料摘要仍为 `c08eaf7d41674ba0641fee99d317c1985e47baa915691a4c13d1e9ea535781d3`。预检从真实接口取得 61 页、47,186,376 字节，独立重算公开代次 `6243701252468465754`，逐项核对 2,402 个 URL。

独立供给进程先用 30 秒预热完成 60,000 个正确响应。计时从 UTC 19:30:27.340904 开始，单调时钟量得 900.000024375 秒。仍用冻结的四路线配比、256 在途、2 秒端到端期限和完整内容校验。

| 指标 | 实测 |
| --- | ---: |
| 计划、完成写入、正确响应 | 各 7,200,000 |
| 漏发、未供给和已发错误 | 各 0 |
| p95 / p99 | 0.121 / 0.276 ms |
| 热读 PostgreSQL 命令 / 物理连接 | 0 / 0 |
| 发布与租约后台命令 | 各 3,600 |
| 每正确响应托管分配 | 1,877.75 字节 |
| Gen0 / Gen1 / Gen2 | 138 / 1 / 0 |
| 完整 CLR 暂停 p50 / p95 / p99 | 1.858 / 3.437 / 6.872 ms |
| 回收后堆 / GC 提交量样本峰值 | 374,026,712 / 1,785,937,920 字节 |
| 冷渲染 / 投影重建 / 发布轮询 | 0 / 0 / 450 |
| 线程池待处理采样峰值 / 末段中位增长 | 4 / 0 |
| RSS 峰值 | 1,904,064 KiB |
| 第 6–10 分钟 / 末 5 分钟 RSS 中位 | 各 1,142,976 KiB |

计时约第 48 秒的首个超标样本为 1,588,768 KiB，早于首个计时区间 Gen0 暂停。峰值出现在 UTC 19:34:56，之后回落，两段 RSS 中位增长为零。整个时间窗的 RSS 上限仍未通过，未观察到冷渲染或投影重建。上轮默认配置的源码候选和构建不同，两样本之间的 RSS 峰值差不能单独归因于此设置。 [默认 GC 长测](default-gc-soak-2026-11-15.md) · [.NET GC 内存设置](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/garbage-collector#conserve-memory)

运行 ID `8d25968c24737376925a7b4752473104`，退出 1，所有本次数据库、服务和监听已清理。容量前置门槛未通过，本次为完整时长的诊断。客户端 JSON SHA-256 `e774e8b6cd39782527f7a814efb25147d637c1fc181c9c081a07e555804a2bb8`，运行时汇总 SHA-256 `1b75554e9ed45bbc0c4116526886a7ccc3014735b40e4f8d20e71034dd09203a`。 [原始记录](../../artifacts/p2-eabe6d7-conserve5/soak/)

候选 `a665fb8` 增加了 GC 限额观测。诊断启动传入 `DOTNET_GCHeapHardLimit=0x44000000`，实际 CLR 样本为 1,140,850,688 字节。每秒 2,000 请求的 10 秒短测完成 20,000 个正确响应，热读数据库命令为零，计时 RSS 峰值 762,704 KiB，已清理。该样本确认限额生效和正常启动，长时 RSS、GC 暂停与容量仍需按原口径实测。 [限额短测](../../artifacts/p2-a665fb8-heap-cap/smoke/runtime-result.json) · [.NET 堆硬上限](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/garbage-collector#heap-hard-limit)
