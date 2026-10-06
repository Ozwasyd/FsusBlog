# Issue #1069：Production run-bound 构建输出

Production、release-final 与对应 CI scheduler 运行把本轮编译输出集中到唯一的 `.tmp/build/<run-id>`。普通开发命令不设置 `FSUSBLOG_PRODUCTION_BUILD_ROOT`，仍使用项目默认 `bin/obj`；两种布局不会在同一次 Production 运行中并存。

## 权威布局与身份

- `.NET` 使用 `dotnet/<MSBuildProjectName>/bin`、`dotnet/<MSBuildProjectName>/obj`，`BaseOutputPath`、`BaseIntermediateOutputPath` 和 `MSBuildProjectExtensionsPath` 均从同一 run root 派生。不同项目的 NuGet assets、generated editorconfig、Razor/static-web-assets 不共享 project extensions。
- frontend 使用 `frontend/dist`、`frontend/cache`、`frontend/wasm` 与 `frontend/wwwroot`；CMake/Emscripten 中间产物使用 `wasm`，生成证据使用 `generated`。构建束是单写者，其他束只读取 readiness marker 中列出的文件与 SHA-256。
- `layout.json` 同时绑定 scheduler run ID、Git commit 和 worktree fingerprint；source identity 首次绑定后不可改写，同值重入保持幂等。backend server、backend tests、benchmark 与 frontend readiness marker 均绑定该 manifest digest，旧 run 文件即使仍在磁盘上也不能通过验证。
- process-tree receipt v2 同时封存 `managedResourceBoundaries`。Linux 资源创建者只能由当前 `building` owner 在 OS 创建前登记精确的 run/source/namespace/bundle/scheduler-token 引用及有限命令预算；登记写入 `layout.json` 和 `.active.json`，完成文件与目录 fsync 和双份读回后才确认。Linux owner 文件必须是当前 UID 的私有、单链接、非 symlink 文件；晚登记、不同 controller、重复冲突或替换记录路径均拒绝。该接口不建立第二个调度器，也不授权只凭环境中的 unit 名称领用资源。
- systemd 资源后端的 root/nested service 在同一 `managedContainmentAuthorities` 中使用 v2 两阶段记录：创建前持久保存 `prepared` intent，绑定资源父边界、随机 service 身份及私有控制目录；放行前由 `registerProductionBuildCompiler` 将同一 intent 绑定为 `pre-exec` 的真实 PID、InvocationID、cgroup 与文件身份。双份落盘读回不匹配时不得放行；后续观察和终止不退回仅按 unit 名称判断。这里保存的是 `execve` 前的真实 Python 身份，不伪造执行后的映像。原 owner 的私有 nested channel 描述也封存在此 receipt；嵌套请求必须核验内核 peer 身份和已登记 service 成员资格，由原 owner 用同一资源 grant 执行并登记。控制器硬中断与跨运行恢复仍属于[资源边界](issue-1072-production-resource-enforcement.md)的未完成验收，不由普通取消／调用方退出的组件证据替代。
- 矩阵仍保留 `src/frontend/dist`、`src/frontend/public/wasm`、`src/backend/wwwroot` 等逻辑声明；digest 层只在当前 scheduler 环境内把它们解析到本轮物理根，使 logical tier projection 与 release evidence 不依赖历史目录。

## Fresh、清理与中断

`recoverProductionBuildResourceTree` 提供已到达 pre-exec 阶段的 Linux 死控制器资源恢复组件：消费独立留存的精确 build-owner 引用，使用共享 reclaim marker 排除并发回收，并经既有 process owner 终止已登记的 root/nested service，再由 resource owner 回收空父组。未知同级 unit 保留且继续阻止容量释放。实际资源消失后，既有 process owner 才按原目录 device/inode、私有文件清单及原 binding 逐项回收控制 carrier；共享 channel 还必须证明原 broker 已退出及目录/socket 身份不变。预检任何 carrier 的未知文件、链接或身份漂移都会在删除前拒绝；逐项删除前重验原 owner 和剩余文件，原 binding 在原文件中最后删除，清理计划随后移除。非 resident carrier 允许已删部分文件的精确重试；resident 输出 carrier 在首次删除前 fsync 原文件清单与内容摘要的私有清理计划，重试只接受该计划绑定的精确剩余后缀，缺失输出而无计划仍拒绝。真实 Linux 组件 fixture 已覆盖清理计划写入和输出删除的注入中断；另有原控制器 SIGKILL、回收进程在输出删除后再次 SIGKILL 的独立资源组件重试。它们尚不能代替完整 build/scheduler 恢复流程验收。独立调用该组件不改写原构建 receipt、不释放 scheduler grant；pending creation 与完整跨运行验收仍未完成，不能据此把中断构建或 Production lane 标记成功。配额对账和容量释放分别由下述 scheduler 与 capacity owner 完成。

Fresh 不再递归删除每个项目的 `bin/obj`、frontend dist、Wasm build 或 backend wwwroot。它删除本轮非依赖证据幞创建新的 run ID；`.tmp/dependency-cache`、NuGet、Emscripten cache 与历史 build roots 都不属于可复用的本轮结果。

旧 build roots 由 detached GC 独立回收，不计入当前关键路径。GC 只接受 `.tmp/build` 的直接、非 symlink 子目录，并核验 `.tmp/test-runs/.locks/<run-id>.lock` 的 owner 身份；当前 run、仍存活的 run 和尚未证明资源清理的 run 必须保留。`..`、仓库根、文件系统根、仓库外路径、build base 本身与 symlink 一律 fail closed。正常成功、失败或 cancellation 只有在已登记资源完成实际清理后才移除 `.active.json`，并把 inode、写入字节、Fresh 遍历量、清理耗时与 wall-clock 写回 `layout.json`。资源检查重读独立留存绑定及真实 unit/cgroup/临时配置，不接受仅有文件中的 released 声明。资源仍存在或身份不可核验时，失败收尾保留 active marker 和 `finalizing` owner；不得重封存丢失或篡改的引用来放行回收。生命周期外层只有在 manifest status 与 owner 终态匹配时才执行 `afterFinalize`，资源保留结果不能授权 post-seal 回调。硬中断资源仍由对应执行／资源 owner 按精确绑定处理，GC 不能将控制器退出等同于全部资源已回收。

Production 磁盘容量账本在 scheduler admission 前留存该 build owner 的精确引用，正常释放移到生命周期 post-seal 回调；异常路径和死控制器恢复也必须重新核验原 owner、真实资源、containment 与上述 carrier。目录替换、引用丢失、残留或身份不可核验均保留容量，不能用空进程组代替 systemd 清理证据。GC/Fresh 同样保留仍有 carrier 的 build root，避免先删除后续回收所需的独立归属记录。详见[资源容量保留](issue-1072-production-resource-enforcement.md)。显式 `reconcileSchedulerResourceGrants` 组件在实际取得的新 scheduler lease 与原 build reclaim 排他区间内调用同一资源恢复 owner，再经原 scheduler journal 写入 grant 对账；原 receipt 和失败不变，投影发布中断仍保留容量，精确重试不重复释放。

规范 local production CLI 在取得新容量预留、验证 BehaviorDoc receipt 及 lease-bound 源码身份后，才调用既有容量 owner 的 `reconcilePriorBuildResources`，随后进入 Fresh 清理和物理构建。准入失败或源码漂移不得执行恢复，projection-only resume 也不触发资源回收。恢复只消费同仓库私有账本中的原 build-owner 引用，并在资源操作与 grant 发布前重验当前进程持有的真实 repository lease；原容量仍计入新预留的准入计算，容量不足不得提前清理。完成资源与配额对账后才将旧容量封为 aborted，不把旧构建改成成功，也不释放新预留。这些接口和 root/nested service 接线不代表 #3527 已完成；resident 组件闭环及资源组件的硬中断后部分清理重试已有真实 Linux fixture，但部分建立、完整 build/scheduler 恢复及规范 lane 仍需实现并独立验收。

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
