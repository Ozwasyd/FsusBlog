# Issue #1069：Production run-bound 构建输出

Production、release-final 与对应 CI scheduler 运行把本轮编译输出集中到唯一的 `.tmp/build/<run-id>`。普通开发命令不设置 `FSUSBLOG_PRODUCTION_BUILD_ROOT`，仍使用项目默认 `bin/obj`；两种布局不会在同一次 Production 运行中并存。

## 权威布局与身份

- `.NET` 使用 `dotnet/<MSBuildProjectName>/bin`、`dotnet/<MSBuildProjectName>/obj`，`BaseOutputPath`、`BaseIntermediateOutputPath` 和 `MSBuildProjectExtensionsPath` 均从同一 run root 派生。不同项目的 NuGet assets、generated editorconfig、Razor/static-web-assets 不共享 project extensions。
- frontend 使用 `frontend/dist`、`frontend/cache`、`frontend/wasm` 与 `frontend/wwwroot`；CMake/Emscripten 中间产物使用 `wasm`，生成证据使用 `generated`。构建束是单写者，其他束只读取 readiness marker 中列出的文件与 SHA-256。
- `layout.json` 同时绑定 scheduler run ID、Git commit 和 worktree fingerprint；source identity 首次绑定后不可改写，同值重入保持幂等。backend server、backend tests、benchmark 与 frontend readiness marker 均绑定该 manifest digest，旧 run 文件即使仍在磁盘上也不能通过验证。
- 矩阵仍保留 `src/frontend/dist`、`src/frontend/public/wasm`、`src/backend/wwwroot` 等逻辑声明；digest 层只在当前 scheduler 环境内把它们解析到本轮物理根，使 logical tier projection 与 release evidence 不依赖历史目录。

## Fresh、清理与中断

Fresh 不再递归删除每个项目的 `bin/obj`、frontend dist、Wasm build 或 backend wwwroot。它删除本轮非依赖证据幞创建新的 run ID；`.tmp/dependency-cache`、NuGet、Emscripten cache 与历史 build roots 都不属于可复用的本轮结果。

旧 build roots 由 detached GC 独立回收，不计入当前关键路径。GC 只接受 `.tmp/build` 的直接、非 symlink 子目录，并检查 `.tmp/test-runs/.locks/<run-id>.lock` 的 owner PID；当前 run 和仍存活的 run 必须保留。`..`、仓库根、文件系统根、仓库外路径、build base 本身与 symlink 一律 fail closed。正常成功、失败或 cancellation 会移除 `.active.json` 并把 inode、写入字节、Fresh 遍历量、清理耗时与 wall-clock 写回 `layout.json`；硬中断留下的根由下一次 GC 回收。

MSBuild node reuse 在物理 bundle 子进程中保持关闭。Production postflight 为每个 Roslyn/MSBuild server 维护包含完整 process identity、server kind、`runId`、namespace、build root 与 `fresh`/`resume` start source 的 owner inventory；只终止与本轮所有字段完全匹配的 orphan，并在 signal 前重新核验全部字段。其他 run 的活跃性只经共享的 `scheduler-run-owner` verifier 分类；active、inactive 或 unverifiable 的其他 owner 都保留。IDE、其他仓库及 owner 无法证明的 server 同样记录为 external/shared 并保留。不得由 qualification 调用全局 `dotnet build-server shutdown`；如需人工维护，操作员可在 Production qualification 之外显式运行该 .NET CLI 命令，且它不会生成或满足任何 receipt。

Benchmark build readiness 在进入任何 measurement admission 前复用同一 exact-current
owner verifier，回收本轮 benchmark build 遗留的 attached 或 detached
Roslyn/MSBuild server；旧 postflight orphan 清理仍只处理 `PPID=1`。
cleanup receipt 位于 `.tmp/run-once/<namespace>/backend-benchmark-release-build.cleanup.json`，
逐次保留 cleanup 前后完整安全 identity inventory、选中 PID、实际终止 PID 与失败，
并以 content digest 封存；post inventory 仍含本轮 owner、receipt 损坏或 binding
不完整时不得启动 measurement。该 producer lifecycle cleanup 不属于 qualification，
也不授权终止 sibling、IDE、未知 owner 或其他外部进程。

## 风险与回退

如 run-bound consumer 发现路径、run ID、source fingerprint 或 digest 不一致，应直接终止该 tier，不能退读项目树中的旧 DLL/dist。无需重启即可回退：停止当前 scheduler run，清理其 namespace，再以新 run ID 重跑；依赖 cache 可保留，但不能复制旧编译产物或 test result 到新根。

验收命令以 `./tools/test.sh production --fresh`、`./tools/test.sh release-final --fresh`、backend/frontend build governance 为准。最终证据必须记录迁移前后清理耗时、遍历/inode 数、写入字节和完整 wall-clock；不得通过 `--incremental`、旧 checkpoint 或旧 TRX 获得收益。

## Deterministic restore/build reuse

Fresh run roots remain unique and all tests, coverage, runtime state and release evidence remain current-run facts. Deterministic restore/build domains may be materialized from the content-addressed cache described in [`content-addressed-build-cache.md`](content-addressed-build-cache.md). Cache objects never become writable `bin/obj/dist` authorities: they are immutable, hash-verified sources that are cloned or copied into the new run root before use.

The immutable Production artifact producer requires the current run's five-domain cache summary before adopting run-bound outputs. Missing, partial, corrupt or identity-mismatched cache evidence blocks adoption rather than causing an implicit historical-result fallback.
