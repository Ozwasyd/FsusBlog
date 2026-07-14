# Issue #1070：Production 物理 Artifact 摘要表

Production 的内容证明由 `.tmp/build/<run-id>/generated/artifact-digest-table.json` 统一生成。每个 bundle/step 仍声明 canonical artifact，但 logical tier 不再各自读取同一文件或目录树；它们同时记录 `artifactDigests` 与 `artifactRefs`，后者指向当前 run 唯一的物理记录。

## 身份、失效与并发

- 表绑定 scheduler run ID、Git commit（非 Git 测试夹具可为 `null`）与 tracked worktree fingerprint，不能跨 Fresh run 使用。
- 物理记录包含 run-bound path、canonical path、类型、size/count、内容 SHA-256 或确定性目录树 fingerprint、producer、logical consumer、source run 与 source fingerprint。
- file identity 使用 realpath、device、inode、mode、size、mtime/ctime nanoseconds 快速判断是否必须重读；这些字段不是权威摘要。首次读取及 identity 变化后仍读取完整内容并计算 SHA-256，读取前后 identity 不一致会重试一次后 fail closed。
- 同一目录根的 wildcard 使用排序后的共享 walk index。复用前会重新核验索引内每个文件、目录及 symlink identity；新增/删除子项会改变父目录 identity，原地覆盖、truncate、rename replace 与 symlink retarget 都会使缓存失效。
- 多 bundle 通过 PID 所有者锁串行更新表，写入使用同目录临时文件加原子 rename。失效锁可由确认死亡的 owner 回收；活动 writer 不会被覆盖。

真实路径必须留在仓库内。`..`、绝对路径、空 wildcard、缺失输出、realpath 逃逸与仓库外 symlink target 均 fail closed；目录 symlink 不会被递归跟随。

## Substitution、Projection 与最终证据

Artifact substitution 在表内使用独立的 `substitution` 记录，绑定 canonical path、所有 actual proof path、各自的物理 artifact ID 与 digest。member receipt 与 bundle summary 保存完整 `artifactRefs`；logical projection 只复用这些引用，不重新读取内容。

五个物理 bundle 全部 settle 后，runner 才允许将表标记为 `final`，并原子复制到 `.tmp/release-evidence/production-artifact-digest-table.json`。projection/checkpoint 同时保存表路径、run/source identity、artifact count 与表自身的 `contentDigest`；attach、resume 和 projection-only 均重新验证表以及每个 logical ref。表损坏、run/source 不匹配、缺失 record 或 digest/path 不一致都会拒绝 checkpoint。

## 指标

表累计真实的 `fileReadBytes`、`directoryWalks`、`shaCalls`、`statCalls`、CPU microseconds 与 wall-clock milliseconds。最终 `comparison.afterMeasured` 是当前 run 的实测摘要成本；`comparison.beforeEstimated` 明确标记为基于 logical consumer amplification 的旧逐 tier 重读估算，不冒充旧版本实测。最终发布验收仍需将迁移前保存的 Production 基线与本轮实测并列，确认 coverage/test-result 内容及 canonical digest 不变。

回退时必须以新 run ID 重跑，不能退读旧表。可关闭进程内/跨进程复用实现进行诊断，但不得跳过内容 SHA、减少 evidence path，或仅以 mtime/size 作为发布证明。
