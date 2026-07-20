# 测试策略

FsusBlog 采用机器可读测试 DAG。`tests/matrix.yml` 是唯一测试拓扑源，`tools/run-test-matrix.mjs` 负责 `preflight` / `validate` / `list` / `plan` / `run` / `ci-plan` / `docs` / `evidence-plan`，`tools/test.sh` 是唯一公开 shell 入口并代理到 runner。lane 脚本只能执行一个已由 matrix 声明的叶节点；共享 shell 文件是 source-only 能力库，不得包含 tier 分派、依赖关系或另一个命令清单。后端 profile、mutation、security static/runtime 和 cross-stack static/runtime 都由 matrix 或 production bundle 投影到同一组叶节点，不能通过兼容 alias 再建一套拓扑。

性能测试资产统一放在 `tests/performance/`，不再保留旧短名测试根。`browser-contract` 是 release correctness 的最小浏览器契约，而 `browser-diagnostics` 是 scheduled/manual 的诊断集合；两者的命令、artifact 和结论互不替代，diagnostics 失败不能伪装成 correctness 通过，contract 通过也不能覆盖 diagnostics 的独立风险报告。

`tests/coverage-registry.json` 是 matrix `coverage[]` 的机器可读索引。每个 coverage id 必须声明 `description`、`owner`、`risk`、`evidencePaths`、`assertionType`、`failClosedRule` 和 `minimumRequirement`；`description` 必须描述实际覆盖语义，不能保留 `Coverage contract for ...` 这类模板句，`minimumRequirement` 必须写明最低可接受断言或 evidence 形态，不能只重复 tier 类型。`tools/run-test-matrix.mjs validate` 会拒绝未注册的 coverage id、未被对应 tier artifact/evidence 声明的 evidence path、未使用的 registry id，拒绝只指向 unit/property 测试文件却标成非 `unit` 的明显 assertionType 错配，也会拒绝 `runtime` / `browser` / `perf` / `fuzz` / `mutation` 类型只指向静态 docs/source 文件的条目。该 registry 不替代测试本体，只把“这个 coverage 标签由什么证据证明”变成 fail-closed 合同。

普通 PR 使用 smart gate：`plan-pr-risk` 始终运行并生成 `.tmp/pr-plan.json` 与 `.tmp/release-evidence/pr-smart-gate-summary.json`，fast lane 与 backend-qps sentinel 默认保留，Production、release、load、resilience 等 correctness lane 只在 changed paths、coverage id 或显式 full gate 命中时运行。backend/frontend coverage 已并入对应 fast `ci-job`，并通过 `supersedes` 替代同一 `executionKey` 的普通 unit 执行；跳过必须写入 skip evidence，不得 silent skip。普通 PR 与 `production-correctness` 的完整依赖闭包固定为零浏览器、零 Playwright、零 browser resource、零 session schema；只有 browser-boundary PR、主分支 push 或显式 release 追加一个 10 分钟、零 retry 的 Chromium `browser-contract`。Acceptance、visual、UX full/risk、cross-browser、geometry/motion/focus、browser a11y/performance/resilience 以及 search/PoW/permission/zero-auth browser probe 只由 scheduled/manual diagnostics 运行。完整拓扑见 [`testing/issue-1150-browserless-ci-topology.md`](testing/issue-1150-browserless-ci-topology.md)，receipt、flaky 与迁移治理见 [`testing/issue-1151-evidence-governance.md`](testing/issue-1151-evidence-governance.md)。

测试瘦身只允许基于机器证据推进。`static-governance` 会运行 `tools/check-test-retention.mjs` 并写入 `.tmp/release-evidence/test-retention-audit.json`，按测试文件归类为 `must-keep`、`conditional`、`review-candidate` 或 `obsolete-candidate`。audit 对每个测试 ID 保存 framework、tier 调用次数、p50/p95、coverage ID、断言目标、失败历史、唯一证据与 replacement IDs；没有计时或历史样本时必须显式记录证据缺失，不能伪造为零。`catalogSnapshot` 同时保存 matrix tier/artifact/evidence、coverage registry、backend requirement catalog 与 release-evidence 路径及其源文件 SHA-256。producer 元数据记录 `runId`、`sourceState` 与 `generatedAt`；矩阵内执行自动继承 `FSUSBLOG_TEST_RUN_ID`，而 standalone audit 的 `runId=null` 只能用于诊断，不能成为 release authority。`must-keep` 覆盖 API/安全/协议/发布/矩阵/治理等契约；`conditional` 代表成本较高但仍由 smart gate 或 release-final 保留的 lane；`review-candidate` 只能进入人工复核，不得自动删除；只有 coverage registry、断言目标、critical mutation slice 与矩阵/requirement/release-artifact 维度均不下降，并为每个被删 test ID 给出已保留 replacement IDs，才允许标为删除。

权威 before snapshot 固定为 `tests/test-retention-before.json`。它由删测前的完整 audit 压缩生成，绑定当时的完整 commit 与 tracked worktree fingerprint，并内嵌 backend/frontend/merged coverage 基线和 `backend-mutation` / `release-mutation-critical-slice` scope identity。仓库一旦存在该文件，capture 命令会拒绝向任何路径再次捕获 before；最终 optimization report 也只接受这个 tracked 路径，并重新核对其中四个 catalog source digest 与所绑定 commit。若从已保存的 clean audit 迁移，`--audit-input` 会先验证 matrix、coverage registry、requirement catalog 与 coverage baseline 和该 audit commit 完全一致。后续历史 replacement 条目会作为 prior-campaign evidence 保留，但只对 before snapshot 中仍存在的 test/assertion ID 执行本轮删除校验。

local production 的 backend union 由 `tools/test/run-backend-production-shards.mjs` 执行。脚本先用 `Category!=Integration&Category!=Performance` 发现本轮全部测试，再按完整测试方法名生成确定性、互斥的分片；每个分片使用同一次 fresh build 的独立 DLL 复制，避免 Coverlet 并发插桩同一文件。成功条件不是“两个命令均返回 0”，而是两份 TRX 的逐方法用例计数与 discovery 完全一致、所有 outcome 均为 `Passed`，随后才允许合并 Coverlet JSON/Cobertura。`.tmp/dependency-cache/dotnet` 只保存 NuGet/.NET 工具依赖缓存，可跨 fresh 保留；编译输出统一写入 `.tmp/build/<run-id>`，新 fresh run 通过新根获得空状态，TRX、coverage、checkpoint 与 release evidence 仍逐轮重建，不能作为历史结果复用。布局、锁与 GC 契约见 [`testing/issue-1069-run-bound-production-builds.md`](testing/issue-1069-run-bound-production-builds.md)。

同一 run 的物理 artifact 内容摘要由单一、source-bound 表生成，bundle member 与 logical tier 通过 artifact ID 引用复用；表最终副本和自身 content digest 一并进入 release evidence/checkpoint。缓存只用 inode/size/mtime/ctime 等判定是否需要重新读取，权威值始终是内容 SHA-256 或确定性目录树 fingerprint。详见 [`testing/issue-1070-production-artifact-digest-table.md`](testing/issue-1070-production-artifact-digest-table.md)。

production scheduler 的 reserved/granted 资源不能替代实际利用率。fresh 运行会生成绑定 run/source/checkpoint/bundle summary 的 canonical CPU、RSS、I/O、动态 grant 积分、等待分类及 collector 开销证据；失败运行也保留 partial evidence。指标定义、平台降级和采样误差见 [`testing/issue-1071-production-resource-utilization.md`](testing/issue-1071-production-resource-utilization.md)。

Linux production 可把动态 grant 映射为 run-bound cgroup v2 与 Docker/OCI CPU、memory、pids 边界；bundle entry 在归组后才恢复执行，动态扩缩会立即更新控制文件。无 controller/delegation/rootless 权限时 `auto` 明确降级并写 evidence，`strict` fail closed，`off` 可完整回滚。策略、平台合同和清理语义见 [`testing/issue-1072-production-resource-enforcement.md`](testing/issue-1072-production-resource-enforcement.md)。

Production 的 unit/property/model Vitest 使用单次权威 test catalog、确定性 immutable partition 和 live grant rolling host；grant 扩张可增加 host，收缩只停止新 admission，不再为 coverage universe 冷启动无测试进程。exact-once、隔离输出、coverage 与证据合同见 [`testing/issue-1073-production-vitest-rolling-hosts.md`](testing/issue-1073-production-vitest-rolling-hosts.md)。

Production `runtime-browser` 已停止声明或动态解析 counted `chromiumLane`，也不再生成 browser admission evidence。#1150 后该兼容 bundle 实际只承载 browserless runtime/database correctness，普通 correctness 中不存在窄 browser acceptance。固定单 browser admission 只属于 release `browser-contract` 或 nightly/manual diagnostics 外层。退役边界与回退合同见 [`testing/issue-1074-runtime-browser-counted-slots.md`](testing/issue-1074-runtime-browser-counted-slots.md)。

视觉、UX viewport、cross-browser、geometry/motion/focus、browser a11y、真实 renderer/AEDS browser performance 与 browser resilience 已建立独立 diagnostics 目录和 scheduled/manual workflow。每类独立保留 summary/artifact，runner 固定一个外层 worker、内层 worker 1、0 retry 且无 dynamic inner pool，聚合全部独立失败，并把 browser crash/OOM/launch failure 标为 infra；这些 evidence 不改变普通 correctness 结论。geometry 类的 menu motion/focus 使用本地 FsusUI source/dist isolated harness，archive sticky/hash 仍明确标为 release-preview integration。权威目录、local alias/no-publish 规则、轻量替代与 #1074 适用边界见 [`testing/issue-1148-browser-diagnostics.md`](testing/issue-1148-browser-diagnostics.md)。

Production 物理 bundle 将启动保底与稳态目标分开：`startupMinCpuUnits`、`startupMemoryWeight` 和 `startupPriority` 只决定首次 admission，`minCpuUnits` 与常规权重决定启动后的扩容。继续支持 4 CPU，以 `1/1/1/1` 启动四个关键 bundle；5 CPU 的额外槽按启动优先级确定性给 backend，形成 `build/backend/frontend/runtime = 1/2/1/1`。公平顺序、内存门禁、checkpoint grant history 与回退合同见 [`testing/issue-1075-production-startup-grants.md`](testing/issue-1075-production-startup-grants.md)。

Frontend isolated perf 不再等待整个 `build-static` summary。它是 contention-aware 的功能性预算 smoke，在同一 frontend weighted DAG 中只依赖当前 run 的 `frontend-build-ready` 与 `vitest-settled`；前者校验 source/build-layout/producer/artifact digest，后者由 rolling runner 全部 host 退出并封存 transform cache 后产生。精确 barrier、失败/取消传播和 admission evidence 见 [`testing/issue-1076-frontend-perf-readiness.md`](testing/issue-1076-frontend-perf-readiness.md)。

长生命周期 command manifest 与 shell collect pool 在每轮 child admission 前重读同一份 run-bound resource grant。增长不等待当前 wave 清空，收缩只暂停新 admission；CPU、memory 与 nested Node worker 配额均从当前 parent grant 分割，entry environment 无权覆盖这些边界。写任务只按 `ownedOutputs` 或命名资源的真实冲突排序，不再使用全局 write 锁；failure、cancel 与 execution deadline 都保留 partial evidence。动态/固定调用边界、内存 class、回退和证据 schema 见 [`testing/issue-1077-live-grant-command-pools.md`](testing/issue-1077-live-grant-command-pools.md)。

Production child 输出使用单一异步 raw byte log，并以 sequence、stream identity、monotonic timestamp 和 byte range index 重建 combined/stdout/stderr 视图。raw/index writer 共享 backpressure，writer error fail closed；console tee 是显式、有界且可降级的派生 sink。normal/failure/cancel/forced kill 均先 flush 已接收 bytes，再在 checkpoint/bundle member 中引用 raw/index/pipeline evidence，避免 per-chunk `appendFileSync()` 和完整 payload 双写。详见 [`testing/issue-1082-async-log-pipeline.md`](testing/issue-1082-async-log-pipeline.md)。

`runtime-browser` bootstrap 返回后，backend、debug frontend、release preview、PostgreSQL 与 Redis 不再从资源账本消失。bootstrap 原子发布绑定 run/namespace、原始 grant、精确五服务 roster、PID start time 或完整 container ID+created time 的 resident inventory；scheduler 重新派生每项 reservation，并让普通 admission、动态扩容、等待分类和 cgroup scope 都先扣除 live resident usage。`performance-evidence` 必须通过跨进程 lock 消费一次性、generation/digest/health 绑定的 handoff receipt；错 run、错 namespace、PID/container 复用、stale、并发或 double consume 均 fail closed。restart generation 替换前重新对账 cgroup/OCI 并刷新 enforcer；退出仅在身份确认消失后返还容量，pending cleanup 保留 pid/env/runtime handle 供 stale cleanup 重试。完整账本、回收与回退合同见 [`testing/issue-1080-resident-resource-leases.md`](testing/issue-1080-resident-resource-leases.md)。

UX risk matrix 已退出 Production，并成为 diagnostics-only probe。runner 固定一个外层 browser lane、一个 Playwright worker 和一个 CLI/session；它拒绝普通 production 调用，不读取 live free-memory/load 扩张 worker，也不再消费 persistent/elastic pool。完整 risk plan、progress 与多错误聚合仍保留在独立 diagnostics evidence 中。退役的 #1084 pool 与当前替代边界见 [`testing/issue-1084-persistent-ux-browser-pool.md`](testing/issue-1084-persistent-ux-browser-pool.md)。

Public HTML production/acceptance 门禁把未知路由、无效动态 identity、不存在或不可公开的 article/category/tag 验证为首响应真实 404；provider/DB gate 临时故障验证为 503 + `Retry-After`，仅有明确永久删除语义时才允许 410。负响应必须 GET/HEAD 状态与关键头一致、noindex/no-store、无成功 canonical/OG/BlogPosting/SPA script，并证明没有 AOT backfill。尾斜杠只允许 301 到无尾斜杠 canonical。测试矩阵与回退边界见 [`testing/issue-1085-public-route-real-status.md`](testing/issue-1085-public-route-real-status.md)。

fresh local production 在删除 `.tmp` 前先按其中的 PID/env 记录清理旧 acceptance namespace，并向 setsid 进程组发送终止信号，避免中断运行遗留 backend/Vite 子进程。随后 runner 解析 Docker 的真实 `DockerRootDir`，要求仓库与 Docker 数据文件系统均至少有 4 GiB 可用空间；不足时在启动测试前 fail closed。managed acceptance 进程继承 256 MiB 单文件写入上限，schema-migration PostgreSQL fixture 删除容器时同时删除匿名 volume。五类 acceptance 服务使用低于 Linux 默认 ephemeral range 的互斥 `20000–29999` 端口区间；Vite 使用 `--strictPort`，禁止 Docker 随机映射竞态导致 preview 静默漂移到未声明端口。

UX risk matrix 只接受 browser diagnostics catalog 调用，并要求 `FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS=1`、`FSUSBLOG_PLAYWRIGHT_WORKERS=1`、`FSUSBLOG_UX_VIEWPORT_WORKERS=1`、diagnostics config 与 0 retry。它使用一个 CLI、一个 managed Chromium、一个 prepared fixture session，拒绝普通 Production 调用、resume、persistent worker、elastic pool 和基于 CPU/free-memory/load 的动态扩张。risk plan 内可继续执行的独立 case 会一次性汇总错误；失败截图、error context、progress 与 summary 保留在 run/category/probe namespace。旧 #1084 pool 的 worker lifetime/process-count 优化证据不再是当前验收要求。

mobile-landscape chrome 检查只审计主内容和 footer 之外的全局 header/nav；可换行的 footer 导航属于滚动内容，不按固定 chrome 高度误报。账户全局 header 在 `max-height: 520px` landscape 下把 inner block padding 收紧到 `0.5rem`，并从完整 desktop action row 切换到 mobile actions，确保 150–200% zoom 时仍保留足够内容高度且不会横向溢出。

local production correctness 以 `./tools/test.sh production-correctness` 从 shell 入口到最终 runtime cleanup 完成的真实 wall-clock 作为优化观测；`./tools/test.sh production` 保留为同一 browserless 拓扑的兼容别名。fresh 清理、capacity preflight、namespace prepare 和 build-server shutdown 全部计入，不能只报告 DAG 内部时间。`budgetMs`、`deadlineWeight` 与 `minimumDeadlineShare` 继续作为性能目标和容量规划证据，但 production 设置 `enforceBudget: false`；直接 `production-correctness` / `production` / `release-final` 的 browserless tiers 同样使用 `observe-only`，不得把 CI timeout 元数据变成进程截杀预算。完整失败与实际耗时必须自然暴露；唯一例外是 release-final 中单 Browser Contract 仍保留 10 分钟 deadline。优化目标是在本机当前依赖和资源条件下继续减少可重复的 wall-clock，不把任何百分比描述为硬件极限；不允许用截杀、跳过或历史结果复用缩短观测。当前五束相对权重为 `build-static=18`、`backend-tests=48`、`frontend-tests=34`、`runtime-browser=70`、`performance-evidence=44`。`runtime-browser` 从 time zero 运行 build-independent security static，完成后利用 build marker 间隙执行 cross-stack/CSRF；bootstrap 仍必须等 run-bound backend/frontend marker 并独占刷新后的 runtime grant。`runtime-integration` 会先完成文章创建、更新、删除与缓存失效验证；唯一的 `release-public-hydration` 写屏障随后重建并复制最终 AOT generation，`release-public` 最后读取稳定数据集。三者不得改回 mutation 与 hydration/readers 并发；不读取 release dist 的 `security-runtime-core` 可在 bootstrap 后独立开始。

bundle 内同一 wave 的独立步骤不会在首个失败后停止调度，而是受 CPU/内存约束继续执行并在 wave 结束时聚合全部错误。step DAG 仅阻断依赖已失败节点的下游，其他独立分支及其下游继续运行；多个分支失败时统一以 `AggregateError` 报告，单个失败保持原错误对象。这样一次运行能暴露多个互不依赖的问题，同时不会在前置条件已经失败时伪跑依赖项。

`privacy-zk-comment-matrix` 拆成跨物理束的 run-bound 阶段：`frontend-tests` 先完成 contract，并从本轮 backend production TRX 与主 Vitest JSON fail closed 投影 functional receipt；MCL P99 不在 frontend 的普通并发负载中重跑，而由后置 `performance-evidence` 消费同 run 的 contract/functional receipts，在独占 `benchmark-window` 中只执行唯一 benchmark case，最后由 finalize 同时校验 contract、functional、benchmark 三份 receipt 并生成 canonical matrix artifact。Wasm prover bundle 使用固定 entry order、epoch mtime、numeric owner 与无 gzip 时间戳的可重复归档，manifest 校验的是该确定性 SHA-256。cross-stack 导出的 AEDS OpenAPI 由矩阵生成器写入 canonical 输出，.NET 原生 OpenAPI 只写入独立 runtime 目录作构建验证，不得覆盖 AEDS 快照。

`production-build-artifacts` receipt 绑定当前 v5 circuit/setup/config 与 `comment-privacy-build-contract.mjs`。默认 fail-closed build 不包含 `comment-privacy-prover.zkey` 或其 public manifest；这表示 ZK 功能关闭，不表示用占位 key 通过 gate。只有显式 production ZK build 才把这两个文件加入 Wasm artifact contract，并在编译前校验完整 ceremony/transcript/artifact SHA。正向测试使用临时 hash-bound v5 fixture，负向测试必须覆盖 setup 未就绪、旧 circuit/layout 与 artifact digest 漂移；测试不得生成或下载真实 ceremony key。

lane-local collect executor 会等待全部独立子任务结束后聚合失败，不因首错 kill peer。security 的 matrix、ZAP policy、SBOM、supply-chain 与 network baseline 静态检查并行；共享安全 fixture/runtime state 的 API、认证、权限、攻击矩阵、notification stream、a11y 与 DAST 保持有序执行，但每个失败只记入汇总，后续检查和必要 reset 继续执行，最后一次性报告全部失败。跨 lane 的依赖、取消和资源 admission 仍只属于 matrix scheduler。

本轮删测证据按以下顺序生成和核验（`<run-id>` 与 checkpoint 路径必须来自同一次权威 fresh run）：

```bash
# 仅在任何删测发生前执行一次；已有文件时命令会失败
node tools/check-test-retention.mjs \
  --out .tmp/release-evidence/test-retention-before-source.json \
  --capture-before tests/test-retention-before.json

./tools/test.sh production --fresh
./tools/test.sh ci-tier ux-viewport-boundaries --fresh
./tools/test.sh ci-tier release-mutation-critical-slice --fresh
node tools/check-test-retention.mjs \
  --run-id <production-run-id> \
  --out .tmp/release-evidence/test-retention-audit.json
node tools/test/optimization-report.mjs \
  --before tests/test-retention-before.json \
  --after .tmp/release-evidence/test-retention-audit.json \
  --checkpoint .tmp/test-runs/<production-run-id>/checkpoint.json \
  --checkpoint .tmp/test-runs/<ux-boundaries-run-id>/checkpoint.json \
  --checkpoint .tmp/test-runs/<mutation-run-id>/checkpoint.json \
  --mutation-evidence .tmp/mutation/backend-critical/authority.json
```

mutation 使用仓库锁定的 Stryker.NET `4.14.2`。nightly `backend-mutation` 从 solution 根发现 Core/Server 可变项目，读取 `config/testing/mutation/default.json` 的项目根相对 glob，保留 Core/security/binary/cache/service 全范围并写入 `.tmp/mutation/backend`；`release-mutation-critical-slice` 从 `src/core` source-project context 启动，以 `tests/backend/FsusBlog.Server.Tests.csproj` 为 test project，读取 `config/testing/mutation/critical.json` 中经审阅的 AEDS v2 wire-frame 核心 `Algorithms/AedsEncoder.cs`，并只选择直接覆盖该范围的 `AedsEncoderTests`，写入 `.tmp/mutation/backend-critical`。该过滤器不得扩展到依赖 `.tmp` release evidence 的无关治理测试，fresh 清理后的 mutation discovery 仍必须自足。critical 运行不能用 full 历史输出替代；solution mode 也禁止用 `project` 键错误地把 test-project 路径固定为被测项目。两者保持 `Debug` configuration，并由 mutation runner 导出专用 MSBuild 标记 `FSUSBLOG_MUTATION_BUILD=1`；由于该版本在 .NET 10 下无法回滚 ASP.NET OpenAPI XML source generator 的 checksum interceptor，`FsusBlog.Server.csproj` 仅在该标记存在时移除 generator analyzer，普通 Debug/Release 的 OpenAPI 行为及业务 mutate scope 不变。阈值由各 config 的 `thresholds.{high,low,break}` 声明，动态输出通过受支持的 `--output` CLI 参数指定；`tools/test/check-stryker-report.mjs` 会拒绝没有实际执行 mutant 的零分报告，并为 critical tier 原子写入 `.tmp/mutation/backend-critical/authority.json`。authority 同时绑定 raw report/config SHA-256、mutate scope、test filter、score/status counts、fresh scheduler run id 与 source state；最终报告会重新核验两个文件 digest 和对应 mutation checkpoint，零删测也不能只凭 scope identity 跳过本轮 Stryker。配置不得重新加入旧版顶层 `threshold-*` 或 `output` 键，solution-context glob 不得带 `src/` 前缀；`backend-test-governance` 会 fail closed。

最终优化报告默认 fail closed：调用方必须显式传入本轮 production、`ux-viewport-boundaries` 与 `release-mutation-critical-slice` 三个 checkpoint；不会扫描旧运行或用 focused fresh 代替 production。local production checkpoint 必须附带 exact 77 的 logical projection（76 个成功 fresh member，加 1 个明确的 external `summary-only` 兼容证据），`integration` 与 `static-governance` 使用各自 member 的真实 step 耗时；`ux-viewport-boundaries` 仍只能由同 source 的独立 fresh checkpoint证明。`ux-viewport-boundaries <= 20m`、数据库 `integration <= 4m`、`static-governance <= 20s` 必须全部通过。报告拒绝 undeclared test IDs、undeclared assertion targets、missing coverage IDs，以及 production tier、matrix artifact、release evidence 或 requirement catalog 的未声明消失；replacement manifest 中早于当前 before snapshot 的历史条目不会被误判为本轮声明。production fresh 完成后，必须用 checkpoint 的 run id 显式重跑 retention audit；报告拒绝 producer run id 不同、audit `generatedAt` 早于 production checkpoint `finishedAt`，或缺少任一时间戳的证据。三个 checkpoint、mutation authority、retention audit 以及 backend/frontend/merged coverage producer 必须同时匹配当前 `HEAD` 和 worktree fingerprint；coverage 与 retention audit 还必须来自同一个权威 production run id，源码在验证后发生任何变化都会使报告失效。仓库内的 `tests/test-optimization-coverage-baseline.json` 是优化前的默认 coverage 基线；需要捕获新的显式 coverage 基线时运行 `node tools/test/optimization-report.mjs --capture-snapshot <path>`，缺少任一 line/branch scope时命令直接失败，也可用 `--baseline-snapshot` / `--current-snapshot` 显式覆盖。若 before 没有可比较 mutation score，current critical score 只有达到 100% 才能数学上证明不低于未知基线；否则必须提供可比较的 before score。没有 before/after timing 样本时，报告只能写 `not measured`，PR、issue 评论和文档均不得声称具体分钟数收益。

旧 `ux-viewport-canary-parity` tier 依赖不完整的历史失败签名，已从 active matrix、release evidence 和测试 inventory 中删除；缺失的历史材料不得由当前全绿结果或 tier 预算推断。当前 viewport diagnostics owner 由 `ux-viewport-smoke`、`ux-viewport-boundaries`、`ux-viewport-visual` 与 risk probe 组成，`ux-viewport-plan-progress` 作为 browserless planner/progress correctness replacement 保留。`ux-viewport-summary.json` 只陈述 diagnostics 本轮实际完成数、失败数、plan fingerprint 与 mode artifact，不参与 release correctness closeout，也不得读取 legacy runner 或伪造 parity 结论。

`coverage-threshold` 会分别校验 merged、backend-only 和 frontend-only coverage。默认 frontend 阈值与常规 merged gate 保持保守一致：`FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD=35`、`FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD=20`、`FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD=30`；PR/push 可以通过这些环境变量临时调高或降低，但 release evidence 会把 `coverage.frontend` 单独展示，避免 frontend 退化被 merged totals 掩盖。

---

## 层级总览

层级表由 `tests/matrix.yml` 生成，提交快照见 [testing.generated.md](testing.generated.md)。本地查看当前 browserless production correctness DAG：

```bash
./tools/test.sh production-correctness --plan-only
```

更新生成文档：

```bash
node tools/docs/generate-testing-docs.mjs --out docs/testing.generated.md
node tools/docs/generate-testing-docs.mjs --check
```

本地与 GitHub Actions 使用同一个 matrix 元数据。常用复现入口：

```bash
./tools/test.sh ci-fast
./tools/test.sh ci-tier production-correctness
./tools/test.sh ci-production
./tools/test.sh ci-job fast-backend
./tools/test.sh ci-tier backend-fast
./tools/test.sh ci-plan --out .tmp/ci-plan.json
```

`ci-job <job>` 按 `ciJob` 聚合运行该 Actions job 里的 required matrix tiers；`ci-tier <tier>` 运行单个 tier，默认包含它的 matrix 依赖，可继续传 `--no-deps` 或 `--shard i/n`。权威 CI/release 运行必须显式传 `--fresh`；调试中断点续跑使用 `--resume`，并可用 `--max-parallel N` 人工收紧并发。每个 tier 执行前都会在日志里打印对应的本地复现命令。完整 tier 与 CI job 对照见 [testing.generated.md](testing.generated.md)。

Matrix 同时声明调度元数据：`phase` 表示 CI DAG 阶段，`cost` 表示预期耗时，`resourceClass` 标识主要资源（如 `browser`、`database`、`benchmark`），所有逻辑 tier 与本地物理 bundle 都只声明无量纲 `cpuWeight`、`memoryWeight` 和保证可运行下限的 `minCpuUnits`，不得写入机器绝对 `cpuUnits` / `memoryGiB`。`parallelizable` / `shardable` 表达语义能力；只有不可并行、不可分片时才保留 `maxParallel=1` / `defaultShards=1`。scheduler 不按整个 phase 预先切碎机器：每个 admission wave 都只对当时 ready 的 tier 结合 active reservation、`os.availableParallelism()` 和实时 free memory 重新分配 grant，单一 ready tier 因而可以拿满剩余容量；worker、Playwright 与 .NET processor 都以该实际 grant 为上限。`exclusiveResources` 声明互斥写入或共享服务，`requiresBootstrap` 标明是否依赖本地 runtime bootstrap；benchmark 噪声隔离通过 `benchmark-window` 表达，包含真实 P99/BenchmarkDotNet 测量的 logical tier 同时不可与其他 tier 并行，lane 内编译与治理准备必须先结束。benchmark runner 按 `STEP > TIER > BUNDLE > host` 读取动态 grant，不使用某台机器的固定并发数。

Matrix 的可选 topology metadata 只描述“同一 FsusBlog 程序、同一发布物”的测试运行态，不代表固定服务拆分。字段缺失时统一解释为 `runtimeMode=single`、`nodeCount=1`、`artifactStorage=local`、`coordinationStore=none`、`clusterScenario=none`、`clusterBootstrap=none` 与空 `clusterFixtures`，所以现有 single mode tier 行为不变。多节点 tier 必须显式选择 `static-role` 或 `adaptive`、`homogeneous` bootstrap、具体 `clusterScenario`、`shared-volume` artifact storage 和 Redis coordination，并同时声明 `shared-postgres`、`shared-redis`、`shared-artifact-storage` fixture；其 `services` 必须包含 PostgreSQL/Redis，且必须有现有 `requiresBootstrap` 来源。validator 会拒绝缺 fixture、store/service 不一致、single mode 多节点或只有 HTTP 服务数量而没有同构拓扑声明的 tier。runner 将解析后的值传为 `FSUSBLOG_TEST_RUNTIME_MODE`、`FSUSBLOG_TEST_NODE_COUNT`、`FSUSBLOG_TEST_ARTIFACT_STORAGE`、`FSUSBLOG_TEST_COORDINATION_STORE`、`FSUSBLOG_TEST_CLUSTER_SCENARIO`、`FSUSBLOG_TEST_CLUSTER_BOOTSTRAP` 与 `FSUSBLOG_TEST_CLUSTER_FIXTURES`，后续 fixture 不应再次猜测默认值。two-node fixture 仍只能通过 env、`nodeId`、`baseUrl` 区分节点，不得生成第二个业务发布物。

`homogeneous-two-node-fixture` tier 是上述 contract 的最小可运行入口。`tools/test/lanes/homogeneous-two-node-fixture.sh` 只构建一次 backend DLL、只准备一组 PostgreSQL/Redis 与 shared artifact root，然后由 `tools/test/homogeneous-two-node-fixture.mjs` 用同一个 artifact 启动 node A/B。两个进程使用不同 `FSUSBLOG_TEST_NODE_ID`、loopback `baseUrl`、data/log 路径，但共享连接身份、artifact root、runtime mode、app artifact digest 与 frontend asset identity。fixture 等待两个 `/health/live` 均返回 `live`，原子写入 `.tmp/fixtures/<namespace>/homogeneous-two-node/cluster-summary.json` 后停止子进程；summary 只记录共享基础设施指纹，不写连接串或凭据。模块 API 可被后续 convergence/handoff/notification 测试复用并自行控制 `stop()` 生命周期。该 tier 是同一程序的双节点测试夹具，不是第二个业务发布物，也不引入 reverse proxy。

Public AOT lease 的聚焦回归位于 `PublicAotBackfillLeaseTests`、`PublicAotArtifactStoreBoundaryTests`、`PublicAotBackfillSchedulerTests` 与 `PublicAotSsrRuntimeStateTests`。双节点模拟必须让两个独立 `PublicAotBackfillLease` 实例共享同一个 lease store，并断言同一 route/asset/session 同时只有一个 holder；随后推进受控时间越过 TTL，证明第二节点可接管且旧 holder 的迟到 release 不能删除新 token。单机用例必须断言 local handle 不调用 cache port。artifact store 用例在 active-release commit guard 回调后切换 frontend asset version，证明最后一道校验拒绝 stale write。lease contention/loss 与 quarantine-before-acquire 只计协调 drop，不得增加 renderer/circuit failure；公开请求仍由既有 shell tests 证明 cold miss 返回 SPA fallback 而不等待 backfill。

外层 matrix scheduler 与 bundle 内 weighted DAG 对 `exclusiveResources` 使用同一集合交集语义：active step 和当前 admission wave 已选 step 都只锁住自己声明的资源名。`build-output` 不会阻止无资源声明的静态检查或使用 `benchmark-window` 的独立步骤；两个写同一输出目录、同一 benchmark window 或同一数据库写窗口的步骤仍严格串行。coordination-only step 不占 CPU/内存且禁止声明资源锁。发生冲突时 bundle 日志写出 `exclusiveResource`、`heldBy` 与 holder state，资源在成功或失败 settle 后都由 active record 删除，独立失败继续聚合。

本地 fresh production 的五个物理 bundle 只保存相对资源意图。time zero 的 build、backend、frontend、runtime 都声明启动 CPU `1`，启动 memory weight 为 `3/4/2/5`、优先级为 `3/4/3/4`；稳态 `minCpuUnits` 为 `2/2/1/1`，后置 performance 为 `1`。启动 admission 先按 priority、critical-path deadline weight、稳定 ID 排序，再在实时 CPU/free memory 内成波放行，因此不受 YAML 数组顺序影响。4 CPU 机器首波得到 `1/1/1/1`；5 CPU 的额外槽按启动优先级给 backend，形成 `1/2/1/1`；更多 CPU 仍从机器资源和相对策略计算，并在 sibling 结束后继续扩容。runtime 内两个 build marker 等待节点是零 CPU / 零内存协调节点，bootstrap-free contract/security 可以在等待期间使用实时 grant。核心数、free memory 或 reserve 变化时，解析结果和各 bundle 内部 worker 数随之变化；无法满足启动保底时记录 `waiting-for-startup-capacity`，低于 profile 的 4 CPU 支持下限则在执行前 fail closed。

全局 `static-governance` 装入 `frontend-tests`；privacy contract receipt 由 frontend 生成，project-functional/input verification 则在早启动的 `performance-evidence` 中消费 exact backend/frontend coverage 与 frontend build marker。logical `privacy-zk-comment-matrix` member 仍只登记一次并绑定 benchmark/finalize canonical artifact。`runtime-browser` 的物理依赖为空，time0 同时等待两个 marker 并执行 bootstrap-free security/contract；只有两个 marker 都成功时才允许 bootstrap，伪造、过期、缺失或 digest 漂移的 marker 一律 fail closed。`performance-evidence` 同样没有整个 backend/runtime/frontend bundle 的入口依赖：coverage merge 与 deterministic compression 按精确 marker 提前，runtime consumers 稳定且 #1080 resident handoff 被一次性消费后，才在该 bundle 内并行运行隔离 namespace 的 `data-scale-xs` / `data-scale-s`，随后 evidence summary 与 fault injection 收口。五个 timed profiler 还必须等待三类 producer quiet marker；quiet marker 仅在对应 physical summary、member receipt、artifact digest 与 resource evidence 全部原子落盘后发布。所有 performance step 都标记 coordination/preparation/measurement/post-measurement phase，v2 deadline evidence 拒绝 profiler 互相重叠或与 preparation/finalize 噪声重叠；只有 measurement step 持有 `benchmark-window`。完整合同见 [`testing/issue-1081-performance-evidence-marker-dag.md`](testing/issue-1081-performance-evidence-marker-dag.md)。五个 bundle 不保存固定 CPU、GiB 或 worker 数：scheduler 每次从在线 CPU、实时 free memory、bundle 相对 workload 权重与语义最小 CPU 重新计算 grant；矩阵权重仅描述工作量比例。production 不把性能目标传成 scheduler 或 bundle deadline，直接 correctness aggregate 也不执行逻辑 tier 截杀。scheduler 将本轮 grant 传为 `FSUSBLOG_BUNDLE_CPU_BUDGET` 和 `FSUSBLOG_BUNDLE_MEMORY_GIB`，bundle runner、backend union、frontend Vitest 与 build-static command manifest 都从该运行时配额派生并发，不得从 8 核示例或历史运行反推固定 worker 数。

`frontend-static-governance` 与 `frontend-runtime-contracts` 的命令组由 `tests/matrix.yml.commandGroups` 唯一声明，不再维护 lane-local JSON manifest。local production 仍使用 `blocking-prebuild`、`concurrent`、`postbuild`、`isolated`、`final` 显式阶段；每个有效命令必须声明 reason、consumed inputs、owned outputs、dependencies 与动态资源/互斥资源。命令 runner 每次从 matrix 重读同一份声明，阶段内部使用 settled failure aggregation，独立命令不会因首个失败而静默跳过。

Production 的 ordinary unit/property/model Vitest 进程与后置 perf 进程共享 Vitest filesystem module transform cache，但不共享 controller、worker、module graph、mock/global state、测试结果或 coverage。cache 位于 `.tmp/test-runs/<run-id>/frontend-vitest-transform-cache/`，由 source commit/worktree fingerprint、Node/Vitest/Vite 版本、完整 Vitest 配置输入 digest、`NODE_ENV`/`VITEST_MODE`/`VITE_*` 环境以及 production project identity 共同寻址；因此不能跨 fresh run 或不同输入复用。ordinary 进程完全退出并把 lifecycle 从 `ordinary-active` 封存为 `ordinary-ready` 后，独立 perf runner 才可打开 cache；中断/失败会删除 module cache 并写 `failed` 状态，身份清单损坏或漂移 fail closed，单个缺失/损坏 transform entry 则安全删除并由 Vite 重建。Vitest 会把 coverage provider 的 transform 决策纳入 cache key，而 V8 coverage 本身不改写源码；perf 因此只启用 `transform-cache-key-compatibility` no-op provider 来选择相同 key，它不启动 profiler、不收集 payload、不写 coverage，也不进入 ordinary coverage merge。perf 仍只写 canonical `production/perf-isolated.json`，额外的 `production/perf-isolated-timing.json` 记录 hit/miss/write、修复计数、process startup、time-to-first-test、wall-clock、ID exact-once/disjoint 与 coverage 未变化证明；关闭 cache 的回退路径是让 production config 不接收两项 `FSUSBLOG_VITEST_TRANSFORM_CACHE_*` 环境，独立 perf 语义不变且无需重启服务。

`phase` 是可执行 DAG 契约：任一 tier 的 dependency phase 必须小于等于该 tier phase，`tools/run-test-matrix.mjs validate` 会拒绝 phase 倒挂。`requiresBootstrap != none` 也必须有明确来源：matrix 依赖链能到达 `bootstrap`，或 tier 自身声明 `selfBootstraps: true`，或由 GitHub Actions job 手工先跑 bootstrap 并在 tier 上声明 `workflowBootstraps: true`。`tools/check-workflow-matrix-sync.mjs` 会反向校验 workflow 的手工 bootstrap 与 `workflowBootstraps` 元数据一致。

`risk` 表示失败影响或回归风险，不表示运行频率；运行频率由 `cadence` 单独声明：`pr` 进入普通 PR/push quality gate，`push` 表示本地或 push 级聚合语义，`nightly` 必须与 `nightlyOnly: true` 一致，`release-manual` 必须与 `manualOnly: true` 一致。`requiredFor` 表示该 tier 计入哪个覆盖口径：`fast`、`production`、`release-final` 或 `none`。因此 production coverage 不会隐含 manual-only / nightly-only lane 已完成；release-final 可以单独要求 `release-manual` 证据。

Matrix 也声明 setup/cache 元数据：`requiresNode`、`requiresDotnet`、`requiresPlaywright` 表示运行时需求，`cacheProfile` 表示依赖缓存需求。`cacheProfile=frontend` 必须使用 `actions/setup-node` 的 npm cache，并固定 `cache-dependency-path: src/frontend/package-lock.json`；`cacheProfile=backend` 必须使用 `~/.nuget/packages`，key 固定由 `*.csproj`、`*.props`、`*.targets`、`global.json`、`NuGet.config` 共同计算；`full` 同时要求两者。Playwright tier 只安装声明的浏览器：`chromium` tier 只安装 Chromium，cross-browser tier 使用 `${{ matrix.browser }}`。

### Resource-aware scheduler 与断点恢复

每次 DAG 执行写入 `.tmp/test-runs/<run-id>/checkpoint.json` 与独立 tier 日志。checkpoint 记录运行模式、权威性、`sourceState`、输入指纹、依赖指纹、耗时、完成 tier 和首个失败点；`--resume` 只复用指纹仍匹配且必需产物未变化的成功 tier，源码、命令、shard 或关键环境变化只让受影响节点及其下游失效。tier 未显式声明 `cacheInputs` 时，runner 会按 backend/frontend/shared 范围推导输入；显式输入也会自动补入 matrix、coverage registry、共享 lane、run-once 与对应 Vitest 配置，避免“声明过窄”造成误复用。`--fresh` 不读取旧进度，checkpoint 标记 `authoritative=true`，是提交、CI 和 release evidence 的唯一有效模式。

首个 tier 失败后，scheduler 会终止仍在运行的子进程组并不再启动新节点；每个 tier 前后都比较 tracked worktree 状态、mode 与 index，测试若新增 tracked diff 即失败。fresh 运行会先清理该 tier 所拥有的 `.tmp`/coverage/test-result 产物并验证内容与 mtime provenance，旧文件不能掩盖 no-op producer。测试阶段只能校验 tracked generated manifest；需要更新 tracked 生成物时必须通过显式生成命令在测试前完成，测试本身不得重写。`executionKey` 表示同一测试集合，coverage variant 只有在 coverage ID 为目标普通 tier 的超集时才能通过 `supersedes` 替代普通执行；property、model、performance、runtime、security、protocol、migration、concurrency 与 release evidence 不允许被 coverage 隐式替代。

共享准备操作由 `tools/test/run-once.mjs` 按 namespace 和输入指纹执行一次。锁包含 owner token、PID 存活校验和 heartbeat；必需输出按内容状态验证，Wasm 使用完整 `public/wasm/`，认证 fixture 使用完整 auth 目录，release build 同时验证两个 index 输出。Playwright fixture 默认写入 `.tmp/fixtures/<namespace>/`；auth 目录固定 `0700`、cookie/storage-state 文件固定 `0600`，旧 `src/frontend/.playwright-fixtures/` 不得保留。fresh `production` / `release-final` 无论成功或失败都会在 scheduler 返回后删除默认 namespace 的 auth 目录，并写 `.tmp/release-evidence/sensitive-fixture-cleanup.json`；显式外部 `FSUSBLOG_FIXTURE_ROOT` 由调用方负责清理。

xUnit 通过 `tests/backend/xunit.runner.json` 固定 `stopOnFail=false`，单次运行会收集全部测试失败；filtered tier 先复用一次 `backend-filtered-build`，随后统一 `dotnet test --no-build`。每个 ordinary/special/filtered lane 都写入 `.tmp/test-results/backend/<lane>.trx`，retention audit 以稳定 `Class.Method` identity 汇总真实 p50、p95 与失败历史。所有使用 `PostgresSchemaMigrationFixture` 的测试类必须进入 `SchemaMigrationPostgresCollectionA/B` 之一；两个 collection 各自持有隔离 Postgres container，每个测试仍创建唯一数据库。`postgres-test-collections.json` 当前登记 45 个 fixture-backed class、289 个估算 case，checker 从源码重新发现 class 与 `Fact`/`Theory` case，拒绝漏 annotation、重复/遗漏 manifest 或 `estimatedFacts` 漂移。production union 从物理 `backend-tests` bundle 的实时 CPU 与内存配额生成互斥且穷尽的 testhost topology：默认 testhost 上限为 `min(max(2, floor(sqrt(cpuBudget))), cpuBudget, floor(memoryGiB / 1GiB), 12)`，再结合 discovered class/affinity unit、cold application/class startup penalty、Docker/PostgreSQL dependency weight 与独立 governance postlude 形成 machine-readable workload model；低于 2 CPU 或 2 GiB 时 fail closed。testhost 数、每 host processor 数和 rolling partition 数是三个独立维度：每个 host 至少保留 1 GiB，CPU 按商和余数（或诊断 weighted mode）分配并精确耗尽当前 admitted grant，partition 默认是 testhost 的两倍并受不可拆 planning unit 数限制。外层 grant 扩张时只在最新 CPU/内存余量内新增 slot，收缩到 active allocation 以下会 fail closed。`FSUSBLOG_BACKEND_PRODUCTION_SHARDS`、`FSUSBLOG_BACKEND_PARTITION_MULTIPLIER`、`FSUSBLOG_BACKEND_PROCESSOR_ALLOCATION_MODE` / legacy exact `FSUSBLOG_BACKEND_SHARD_PROCESSORS` 只用于诊断，summary 会记录公式、模型输入、候选 score、初始/潜在 topology 和 override 来源，不得把任何机器的 host 数写成 production 常量。高系统 load 不会把 testhost 静默降为单线程，资源冲突与内存门禁由外层 scheduler 负责。

`node tools/check-test-suite-convergence.mjs` 同时治理测试证据形态和历史 replacement。backend test 不得读取 production `.cs`、C++ header 或 performance SQL 后以字符串存在性/顺序充当行为证据；应让生产路径消费 `internal readonly` 契约，并通过 spy 调用顺序、实际执行 SQL、生成器 `--check`、TestHost 或隔离 PostgreSQL 验证可观察行为。删除映射只允许写入 `tests/test-retention-replacements.json`；baseline、post-baseline、retired tier 与 source-lock owner 路径只允许写入 `tests/matrix.yml.governance`。issue-local retention/convergence 文件不再参与当前治理，也不得重新引入。

跨语言编码规范只有一个 authority：[`development/coding-conventions.md`](development/coding-conventions.md)。它以 Microsoft .NET C# 约定为母规范，但外部 wire/ABI/database/third-party contract 与语言语法保持更高优先级。`static-governance` 执行 `node tools/docs/check-authoritative-development-docs.mjs` 和 7 类负向 fixture，一次聚合 AGENTS/CODEOWNERS/labeler/PR template 的失效路径、退休符号、命令/链接、style owner、formatter baseline、generated/vendor/fixture 分类及 external adapter 错误。

C# 执行层由根 `.editorconfig`、Roslyn build settings 与 `tools/dotnet/check-csharp-style.mjs` 共同负责。`static-governance` 运行 changed-file gate 和完整正反 fixture；full mode 对 tracked C# 文件使用透明 baseline，`strict-full` 是清空命名/XML debt 后的完成门，不是可以长期忽略的展示报告。纯机械迁移固定为三个 blame-ignore commit：`892489472e27c85d277fb98c2c35969851294b58` 负责 .NET 10 whitespace/初始 import pass，`b5c116cd54e7a0a86fd243059502a3e23f364074` 负责确定性 import 排序，`4839b4e1bc9f8c181fad14889414c729cba3108c` 负责 Roslyn 兼容的 root-namespace 分组；三者均只改 C# 格式。`IDE1006` 不自动批量 rename public/wire/ABI/database contract。文本 checker 不重复否定 Roslyn 接受的 continuation alignment、auto-property、pattern、initializer、alias import 与字符串内容；public contract type 和较窄的 protocol/codec/security public member 文档范围由 policy 分开声明。命令、阶段边界与实时 baseline 见 [C# style enforcement](development/csharp-style-enforcement.md)。

Backend configuration 只允许四个 authority：共享 `appsettings.json`、真实 `appsettings.Production.json`、最小 `appsettings.Development.example.json` 与 production operator 输入示例 `.env.production.example`。`static-governance` 执行 `node tools/configuration/check-appsettings-authority.mjs` 及 5 个聚合 fixture，拒绝重建完整 JSON example、development overlay 重复 base、production fail-closed value 非空、示例 secret 可用值或 consumer 回退到退休模板；覆盖顺序固定为 base < production overlay < `.env.production`/Compose environment < command line。

拓扑校准使用 `node tools/test/calibrate-backend-production-topology.mjs --fresh`；默认比较经机器 CPU、内存与 planning unit 裁剪后的 `2/4/6/8/12` testhost、`1.5/2/3` partition multiplier 和 uniform/weighted processor allocation。每个 candidate 至少独立执行三次完整 `./tools/test.sh production --fresh`；少于三轮、CPU 预算超过进程可见 CPU 或内存预算超过宿主总内存都会在执行前 fail closed。校准不能复用上一轮 pass、TRX、coverage、checkpoint 或 release evidence；完成后输出 `.tmp/diagnostics/backend-topology-calibration.json`，只允许把中位数/方差用于选择后续 topology，选出的配置仍须重新跑 fresh release validation。完整命令、指标定义、平台降级与销毁规则见 [`testing/backend-production-topology-calibration.md`](testing/backend-production-topology-calibration.md)。

审计、运维 readiness 与 PublicAOT artifact 测试按可观察职责拆分，不再由混合 `*ContractTests` 读取实现源码。审计证据分别由 `AuditLogStoreTests`（结构化落库、批写与 chain tail）、`AuditLogWriterWorkerTests` / `AuditFallbackWriterBehaviorTests`（失败降级与 durable fallback）、`AuditTamperEvidenceBehaviorTests`（canonical hash/MAC、固定长度校验、跨 culture chain ID）和 `AuditProjectionBehaviorTests`（PII disclosure 决策）拥有。运维证据由 `ProductionReadinessCoordinatorBehaviorTests` 验证并行启动、取消与多结果保留，`BackupRestoreScriptBehaviorTests` 通过临时 shell harness 实际调用 `pg_dump` / `pg_restore` 替身并覆盖连接串及阻断路径，`AdminOperationsBehaviorTests` 验证危险操作的 diff/MFA 策略和 typed confirmation。PublicAOT 的当前 ArticleDetail V4 文件写读、V3 只读兼容、30 秒内存 TTL、retired payload 拒绝和磁盘清理由 `ArticleDetailAedsArtifactStoreBehaviorTests` 负责；sidecar 与 cache invalidation 的可观察效果继续由 `PublicAotFileShellCacheTests`、`PublicAotDocumentServiceTests` 和 `PublicAotInvalidationTrackerTests` 负责。实现选择、SQL 形状与吞吐预算只由静态治理或 #1042 benchmark lane 证明，不回流为 source-string 单元测试。

### Frontend fast split

前端 fast gate 拆成独立 tier：`frontend-build`、`frontend-unit-shard`、`frontend-property-model-perf`、`frontend-runtime-contracts`、`frontend-static-governance`、`frontend-fast-summary`。`frontend-build` 只运行一次并上传 `src/frontend/dist/**` 与 `.tmp/frontend/frontend-build.json`；普通 Vitest unit 由 `coverage-frontend` 以同一 `executionKey` 覆盖执行一次，原 `frontend-unit-shard` 仅保留为无 coverage 的调试入口；property/model/perf 继续由独立 tier 执行，不会被 coverage 替代。`frontend-runtime-contracts` 单独覆盖 worker/a11y/binary/runtime/wasm checks；`frontend-static-governance` 单独覆盖前端静态治理，并把 `check-gate-integrity`、`check-test-matrix` 这类全局 static governance 留给 `static-governance` job，避免重复。

前端 blocking-prebuild 会在编译前执行 C# entrypoint ownership gate：`src/frontend/` 下禁止 C# source，其他 C# source 必须由最近的 `.csproj` 或完整 file-based app 声明拥有；generator 不得写死 `/tmp`/`/var/tmp`，生成 AEDS frame fixture 必须有唯一 generator、manifest 与稳定 `generate`/`check` 命令。`static-governance` 运行同一组负向 fixtures，确保一次扫描保留全部违规。完整 contract 见 [`testing/issue-1174-csharp-entrypoint-ownership.md`](testing/issue-1174-csharp-entrypoint-ownership.md)。

本地复现命令：

```bash
./tools/test.sh ci-tier frontend-build --no-deps
./tools/test.sh ci-tier frontend-unit-shard --no-deps --shard 1/2
./tools/test.sh ci-tier frontend-unit-shard --no-deps --shard 2/2
./tools/test.sh ci-tier frontend-property-model-perf --no-deps
./tools/test.sh ci-job fast-frontend-unit --fresh
./tools/test.sh ci-tier frontend-runtime-contracts --no-deps
./tools/test.sh ci-tier frontend-static-governance --no-deps
node tools/run-test-matrix.mjs aggregate fast-summary --dry-run
```

`--shard i/n` 会注入 `FSUSBLOG_TEST_SHARD_INDEX/TOTAL`，`RunFrontendUnitShardLane()` 将其转换成 Vitest `--shard=i/n`，只传给普通 `test:unit:fast` 调试入口。Vitest worker 数按 CPU、空闲内存和 load 动态计算，所有入口固定 `bail=0`，不接受最大失败数覆盖，以便单次运行收集完整失败集。每个 config 同时输出独立 JSON/JUnit 耗时报告。build、property/model/perf、runtime-contracts、static-governance 不随 unit 重复执行。

每个有效子 tier 都由 `run-test-matrix` 写入独立 `.tmp/release-evidence/jobs/<job-tier>.json` job summary。CI artifacts 为 `frontend-build`、一个包含 coverage 与 property/model/perf 的 `fast-frontend-unit`、`frontend-runtime-contracts`、`frontend-static-governance`；`fast-summary` 下载这些 artifacts 和 `fast-static-governance`/`fast-backend` 后运行 artifact-only aggregate。matrix validator 会拒绝缺少任一 frontend fast 子 tier、coverage 替代范围越界、或 `fast` 继续依赖旧 monolithic `frontend-fast`。

### Rights V3 test matrix

Rights V3 的完整验收矩阵由 `tools/test/lanes/rights-v3-test-matrix.sh` 承载，属于 `integration-runtime` 证据，不并入 fast gate。它会运行后端 schema migration、canonical hash、write path、当前 ArticleDetail V4 codec 与 V3 只读兼容、projector、proof pipeline、ArticleDetail artifact contract 和 preencoded artifact hot path 测试，再运行前端 V4/V3 decode、API/view contracts、admin editor flow、public article rendering、PublicAOT hydration 与 code-copy gating 的 Vitest 文件。

本地复现：

```bash
./tools/test.sh ci-tier rights-v3-test-matrix --no-deps
```

该 lane 成功后写入 `.tmp/release-evidence/rights-v3-test-matrix.json`。其中必须覆盖：ArticleDetail does not use a separate public rights endpoint、artifact-hit public read does not query rights tables、legacy ArticleDetail payload is rejected、legacy public article artifact is not accepted as V3，以及 preencoded ArticleDetail artifact hot path 性能门禁。schema migration 片段会启动 Docker PostgreSQL fixture；若本机缺少 Docker，应先补环境依赖再重跑，不应跳过该集成切片。

### Browser lane scaling policy

普通 correctness 与 browser execution 使用完全不同拓扑。`production-correctness` 不包含任何真实浏览器；`browser-contract` 是 release-final 唯一不可替代的浏览器发布契约。旧 Acceptance、视觉、UX、引擎差异、geometry/motion/focus、渲染性能、browser runtime resilience 以及迁出的 PoW/search/permission/zero-auth probe 由独立 diagnostics 入口串行执行，固定外层 worker `1`、retry `0`，不读取机器负载在内层扩容。

| Lane | Scale mode | Current policy | Artifact isolation | Worker policy |
| --- | --- | --- | --- | --- |
| `browser-contract` | one Playwright Library process | Router、auth、user/admin 状态机和 CRUD correctness 由 Vitest/API/PostgreSQL tests 承担；release-final 运行 5 个基线浏览器场景，step-up-ready fixture 再加入第 6 个 WebAuthn 场景 | `.tmp/browser-contract/receipt.json` | 固定 1 次 managed Chromium launch、5–6 个串行 BrowserContext、0 worker pool、0 shard、0 retry |
| `browser-diagnostics` | migrated runtime group + serial category catalog | scheduled/manual 先保留 PoW/search/permission/zero-auth browser risk，再运行 7 类 14 probes；各 probe 独立留证，最终一次性汇总全部失败 | `.tmp/browser-diagnostics-runtime/**` 与 `.tmp/browser-diagnostics/<run>/<category>/<probe>` | 固定 outer lane `1`、worker `1`、retry `0` |
| diagnostics `visual` | public + console + aggregate | 直属聚合当前 run 的两组 summary，不依赖已退役 CI shard job | public/console 目录与 aggregate summary | 固定 worker `1`；missing/skipped/stale fail closed |
| diagnostics `ux` | smoke + visual + boundaries + risk | 完整 planner/progress 保留；risk runner 只允许 diagnostics | 每个 mode/risk 独立 summary | 固定 worker `1`，无 persistent/elastic pool |
| diagnostics `cross-browser` | engine smoke | Chromium/Firefox/WebKit 只验证引擎差异，不重复后端业务规则 | probe log + Playwright output snapshot | 三引擎在同一 diagnostics 外层串行运行 |
| diagnostics `geometry-motion-focus` | isolated harness + archive integration | mobile motion/focus 优先使用免后端 harness；archive sticky/hash 保留真实应用 geometry | harness 与 archive evidence 分开 | 固定 worker `1` |
| diagnostics `performance` / `resilience` | renderer/AEDS/browser runtime | browser performance 与 correctness 性能 summary 分离；browser recovery 不阻断 HTTP/state-machine correctness | 每个 probe 独立 summary | 固定 worker `1` |

Acceptance parallelism decision（updated 2026-07-16）：`auth-flows.spec.ts`、`user-console.spec.ts`、`admin-console.spec.ts` 已退出浏览器层；对应 correctness 由 memory-history Router、mounted component、生产 API adapter 和隔离 PostgreSQL integration tests 并行承担。#1146 保留的 4 个真实 public browser risk 已收口到 [`testing/browser-contract.md`](testing/browser-contract.md) 的一个 hydration/history/reload 场景，并与 account/admin deep link、一次 article publish 和 Service Worker 组成 5 项基线 release contract；只有 immutable fixture 声明具备 step-up 注册前提时才加入第 6 个 WebAuthn 成功场景。入口直接使用 Playwright Library，不读取 CPU/memory/load，也不创建 worker pool 或 shard。迁移前 35 个场景及 31 条轻量映射见 [`testing/issue-1146-lightweight-acceptance.md`](testing/issue-1146-lightweight-acceptance.md)。

三个 UX 模式共享 `uxViewportPlan.mjs` 纯规划器：smoke 固定 `336` cases，visual 固定 `378` cases，boundaries 固定 `14 × 2 × 7 × 33 = 6468` cases。boundaries 以 `route + theme` 为稳定 group；每个 viewport 依次运行 media step，步骤间执行 `default → target → default` 的 focus、selection、window/inner scroll、probe 与临时 style 完整复位。该模型完整保留在 diagnostics，但执行拓扑固定一个 worker，不按 group 数或机器容量建立 inner pool。

progress 以稳定 group/step ID 写入 `.tmp/ux/runs/`，但 browser diagnostics 强制 `FSUSBLOG_UX_VIEWPORT_RESUME=0`，每次 run 只接受当前 source/build/namespace 的新 progress。Playwright 不配置 `maxFailures`，不会因为达到最大错误数而丢弃后续失败；同时固定 retry 0。`run-ux-viewport-playwright.mjs` 无论 Playwright 成功或失败都会写 current-run summary，并保留原始失败退出码。trace、截图、console/pageerror/request audit、路由、触控面积、overflow、主题与 content-boundary 断言全部保留。

三个 UX lane 都用同一 run namespace 的 release preview 承载浏览器访问，fixture 仍通过 debug backend 准备；preview 保留 production SSR nonce、redirect、真实 404、Trusted Types/CSP 与 integrity API 语义。lane 只预生成一个隔离 session fixture，并固定一个 browser worker；不存在根据资源降低/增加并发的 resolver。截图文件仍以 viewport/theme/route 命名并写入本次 probe 目录。

Session fixture policy：UX risk diagnostics 明确以 `--workers 1 --concurrency 1` 准备唯一 session，并设置 `FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1`，避免 Playwright global setup 重复准备。Playwright 的 `extraHTTPHeaders` 不会进入浏览器原生 WebSocket upgrade；Development/Test 的 notification preflight 因此把已校验的 `X-Fsus-Test-Session` 写入仅限 `/api/notifications/stream` 的 HttpOnly、SameSite=Strict session cookie，正式握手在 authentication 之前恢复同一 header。该桥接不在非隔离环境注册，不能替代生产认证 Cookie，也不能扩展到其他路由。

### Screenshot evidence tiers

截图检查在 diagnostics `visual` category 内拆成两个顺序 probe：`visual-public` 只运行公开页截图检查，输出 `.tmp/visual/public/**`；`visual-console` 只运行控制台截图检查，输出 `.tmp/visual/console/**`。两个 probe 都写入 `fsusblog.visual.screenshot-group.v1` summary，记录独立 `durationMs`、状态和 Playwright output dir。

随后 `visual` aggregate probe 直接消费同一 diagnostics run 的 public/console summary，运行 `tools/visual/aggregate-screenshot-evidence.mjs` 并生成 `.tmp/visual/summary.json` 和 `.tmp/release-evidence/visual-screenshot-summary.json`。它不再下载或依赖已退役的 `visual-public-playwright-*` / `visual-console-playwright-*` CI shard artifact；任一 current-run summary 缺失、stale 或失败都会让该 diagnostics category 失败。

CI 的安装步骤必须通过 `node tools/ci/run-stage.mjs --stage install -- ...` 执行，并把耗时合并到 `.tmp/release-evidence/jobs/<job>.json`。job summary 的 `failureStage` 只能是 `setup`、`restore`、`install`、`bootstrap`、`test`、`artifact`、`summary`，`stageDurationsMs` 会保留每个阶段的 wall-clock 耗时；因此 npm/Playwright install 失败、runtime bootstrap 失败、测试失败和 release evidence 汇总失败可以在 artifact 中区分。

Flaky 治理由 `tests/flaky.yml` 和 `tools/ci/check-flaky-registry.mjs` 控制。每个 quarantine 条目必须包含 `suite`、`test`、`issue`、`reason`、`expires`、`allowedRetries`、`owner`、`mode`、`classification`；过期条目会使 CI 失败。默认策略是不重试：unit、static governance、security、backend deterministic gates 与 Browser Contract 都不得 silent retry。Diagnostics 如启用有限 crash retry，只能针对明确 browser process crash，并逐 attempt 保留 test IDs、failure class 与 artifact；重试后通过只能是 `diagnostic-passed-after-infra-retry`，不同测试轮流失败必须是 `unstable-topology`。assertion/URL/data/visual mismatch 不重试。Benchmark/perf 噪声不得走通用 flaky retry，必须使用独立的 `benchmark-noise` 分类和性能 evidence。`release-final` 会使用 `--release-final` 模式重新校验 registry/evidence，并拒绝 Browser Contract retry、skip 或 critical quarantine 证据。完整分类见 [`testing/issue-1151-evidence-governance.md`](testing/issue-1151-evidence-governance.md)。

`coverage-gate` 与 `production-correctness` 是两个 independent required checks：coverage 负责阈值和合并覆盖率，production-correctness 负责 browserless 运行时风险 DAG；`production` 只是相同拓扑的兼容命令。`release-final` 在二者之上增加唯一 Browser Contract、strict coverage、changed-code coverage、critical module coverage、ordinary required-job completeness、live exposure、artifact digest binding 和 test-quality lint。browser diagnostics receipt 保持独立，不存在 visual skip 影响 correctness 的路径。

`load` 与 WebSocket pressure 检查会写入 `.tmp/perf/load-public-api.json` 和 `.tmp/perf/notification-stream-pressure.json`，release evidence 会把 `.tmp/perf/` 作为性能证据归档。默认参数来自 `tests/performance/perf-policy.yml`：HTTP load baseline 为 `concurrency=10`、`rounds=6`、`durationMs=30000`；WebSocket pressure 为 `connections=50`、`durationMs=30000`。

`tests/performance/perf-policy.yml` 是 load profile 的唯一策略源。`tools/test/lanes/load-profile.sh <profile>` 与 `runtime-evidence-probe.mjs load-profile` 必须从该文件读取 baseline / expected-peak / 2x-peak / burst 的 `concurrency`、`rounds`、`durationMs` 与预算阈值；只有显式环境变量 `FSUSBLOG_LOAD_PROFILE_CONCURRENCY`、`FSUSBLOG_LOAD_PROFILE_ROUNDS`、`FSUSBLOG_LOAD_PROFILE_DURATION_MS` 可以覆盖执行参数。每个 load profile summary 必须同时写入 `policy.file`、`profileName`、`declared`、`effective`、`thresholds`、`thresholdEvaluation`、`overrideSource` 与 `overrideSources`，release evidence 校验会拒绝没有解释的 policy/effective 不一致或没有 threshold 对照的 performance profile。`performance-evidence-summary` 只聚合 baseline、expected-peak、backend benchmark 与 capacity saturation reference，不消费 browser performance regression；browser performance 写入自己的 diagnostics summary。聚合状态保留各 ordinary producer 的真实 status，任何 failed 优先于 blocked，不能无条件写 `status:"ok"`。

### Performance saturation evidence v2

普通 load profile 继续负责回归与可用性，但不再具有容量结论权威。容量认证使用
`fsusblog.performance-saturation.v2`，其 route、topology 与阈值唯一来源仍是
`tests/performance/perf-policy.yml#saturationEvidence`。矩阵必须分别覆盖 L0 binary 的
identity/br/gzip/304/HEAD、静态与 nonce HTML、L1、L2、DB buffer cold/warm、
notification 1/100/1000 connections，以及浏览器 AEDS decode、public takeover 和
hydration long task；每条 route 都要分别产生 `kestrel-only` 与
`production-topology` 结论，禁止混成平均值。

`tools/perf/run-open-loop-load.mjs` 按固定到达时间表发请求，请求变慢不会降低 offered
load。每个 offered-load step 至少重复三轮；压力机 CPU 达到策略上限、schedule lag p99
超限或 dropped arrival 非零时，负载生成器自身被判为饱和，不能据此推断服务端拐点。
HTTP 原始结果与同一时间窗口的硬件/runtime/storage/network 指标分别产生，再由
`merge-saturation-measurement.mjs` 按 route、topology、offered RPS、repeat 和 source
digest 精确合并。开放环原始样本和系统指标必须各自写入 `startedAt`/`endedAt`，两个边界
相差超过 1 秒即拒绝合并，最终 sample 同时绑定两份输入的 SHA-256。DB/Redis 不适用的路径
仍写数值 `0`，不得写 `null`。
safe point 还必须同时通过全局 p99 250ms / p99.9 500ms 上限；具体 route 可以在后续
策略版本中收紧，但不得在报告内自行放宽。拐点只允许一个 limiting resource 进入
85%–95% 区间，其他资源必须仍低于 85%，否则结论因瓶颈不可解释而 blocked。

每个 sample 必须包含 cycles/instructions/IPC、branch/LLC miss、context switch、CPU
migration、syscall、allocation、response/wire bytes、process/container CPU、cgroup
throttling、managed heap/LOH/Gen0-2/GC pause、ThreadPool/active request/socket/FD、
Npgsql pool、Redis roundtrip、`pg_stat_statements`/blocks/WAL，以及压力机自身指标。
缺失任何字段时，builder 只生成带明确 blocker 的场景，不生成 nullable capacity
conclusion。

完整报告通过以下命令组装；`--require-ok` 只适用于确实完成全矩阵的认证运行：

```bash
node tools/perf/build-performance-saturation-v2.mjs \
  --identity /evidence/run-identity.json \
  --measurement /evidence/measurements/l0-binary-identity-kestrel.json \
  --measurement /evidence/measurements/l0-binary-identity-production.json \
  --output .tmp/perf/release-summaries/performance-saturation-v2.json \
  --expected-commit "$(git rev-parse HEAD)" \
  --expected-image-digest "$FSUSBLOG_EXPECTED_IMAGE_DIGEST" \
  --require-ok
```

`performance-evidence-summary` 会验证 full SHA、OCI digest、硬件/微码/内核/libc/cgroup、
runtime、代理/TLS、PostgreSQL/Redis、fixture 规模、独立压力机和网络路径。缺少 v2 报告
时聚合任务本身仍可完成，但 summary 必须是 `blocked`，明确表示没有容量结论；synthetic、
过期、错误 SHA/image、单点 1 RPS、重复方差超限或缺指标报告会被拒绝，而不是降级为旧 v1
结论。

性能证据默认采用项目内基线：single process、Kestrel-only、无 nginx、无 CDN、无 reverse-proxy cache、无代理压缩层计入结果。nginx/Caddy/CDN 可以作为生产部署层存在，但相关数据必须写入独立的 `optional_deployment_layer`，并标记 `counted_as_project_baseline=false`。

Backend QPS/perf artifact 必须包含以下 metadata。`backend-qps` collector 只产出静态实现证据和小样本 runtime probe，不得被解读为容量 benchmark；Docker/wrk 或 BenchmarkDotNet 性能脚本也必须保持同一 baseline 语义：

```yaml
performance_baseline:
  date: YYYY-MM-DD
  mode: kestrel-only
  process_count: 1
  reverse_proxy: false
  cdn: false
  response_compression_proxy: false
  native_aot: false
  ready_to_run: true|false|null
  tiered_pgo: true|false|null
  runtime: dotnet-10
  database: postgres version / local-or-remote / unknown
  redis: redis version / local-or-remote / unknown
  machine: cpu/memory/kernel / unknown

optional_deployment_layer:
  reverse_proxy: none|nginx|caddy|cloudflare|other
  proxy_cache: true|false
  proxy_compression: true|false
  counted_as_project_baseline: false
```

未来性能 issue / perf evidence checklist：

- 明确目标属于 `kestrel-only internal baseline` 还是 `optional deployment-layer`；未声明时默认前者。
- `backend-qps` summary 必须拆分 `staticEvidenceResults` 与 `runtimeMeasurementResults`：前者是 source guard，后者是 warm runtime probe；release evidence 不得把 static guard 的 RPS 字段当作容量结论。
- Soak 分为三种语义：`soak-short-runtime` / `release-soak-min` 是真实短时 runtime smoke，必须写 `.tmp/soak/short/summary.json`，并包含 `durationSeconds`、`sampleCount`、`latencyMs.p95`、`latencyMs.p99`、`errorRate`、`executionMode:"runtime"`、`countsAsReleaseFinal:true`，以及 `resourceMetricSummary.metrics[]` 或 `resourceMetricSummary.unavailableMetrics[].reason`；`soak-long-scheduled` 只写 72h/7d 计划证据，必须是 `status:"scheduled"`、`executionMode:"scheduled"`、`countsAsReleaseFinal:false`，不得作为 release-final completed evidence；`soak-long-evidence-import` 只有在设置 `FSUSBLOG_SOAK_LONG_EVIDENCE_FILE` 导入外部长跑证据时才允许 `status:"ok"`，否则使用 `FSUSBLOG_SOAK_REQUIRE_IMPORTED_EVIDENCE=1` fail-closed。
- `release-memory-leak-budget` 与 `release-open-handle-budget` 必须输出真实资源指标，summary 文件分别为 `.tmp/release-evidence/memory-leak-summary.json` 与 `.tmp/release-evidence/open-handle-summary.json`。每个 summary 的 `metrics[]` 不得为空；每个 metric 必须包含 `name`、`startValue`、`endValue`、`maxValue`、`delta`、`threshold`、`thresholdOperator:"<="`、`thresholdField:"delta"` 和 `status`。`status:"ok"` 只有在至少一个真实资源 metric 通过预算且没有 unavailable metric 时才允许写入；缺少指标必须写入 `unavailableMetrics[].reason` 并使 lane failed，阈值超限也必须 failed。默认阈值为 RSS delta `FSUSBLOG_RELEASE_RESOURCE_RSS_DELTA_THRESHOLD_BYTES=67108864`、FD delta `FSUSBLOG_RELEASE_RESOURCE_FD_DELTA_THRESHOLD=16`，本地无法从端口发现后端进程时用 `FSUSBLOG_RELEASE_RESOURCE_PID` 指定。
- `backend-qps-runtime-sequential` 是可选 warmed runtime measurement：必须在同一个 bootstrapped runtime 中按固定顺序执行全部 measured scenarios，并记录 runtime id / namespace、warmup duration、scenario order、per-scenario counters、machine metadata 和 `capacityConclusion.countedAsCapacity=false`。
- 每个 `backend-qps` runtime measurement 必须写入 request plan steps，包含 method、path、headers、expectedStatus、expectedContentType、expectedFrameType 与 fixturePrerequisite；probe 必须实际校验 status/content-type/AEDS frame type。
- 每个 `backend-qps` runtime measurement 必须写入 `measuredCounters`：requestCount、statusDistribution、bytes、cacheHitSignal 必须为 `ok`；DB/Redis/allocation/threadPool/dbGate/AEDS CRC 等尚未接入的计数器必须写 `unsupported`、`disabled`、`probe-failed` 或 `not-collected` 以及 reason，不能静默写 null。
- 每个 runtime probe 必须写入 `observabilityLevel` 与 `extendedObservability`。`extendedObservability.categories` 至少包含三类扩展字段：`managedRuntime`（托管运行时模式，例如 runtime、NativeAOT、ReadyToRun、TieredPGO）、`threadOrConnection`（线程或连接类读数，例如 probe concurrency、sampleCount、active handles）、`storageOrCacheLatency`（存储或缓存延迟，例如 cache-backed HTTP p95、Postgres ping、Redis ping）。每个字段都必须有 `status`；不可采集时必须写 `reason`。validator 会把三类均为 `ok` 的证据标为 `extended-runtime-evidence`，否则标为 `basic-runtime-evidence` 并要求缺失原因。
- QPS、latency、cache hit、compression 和 static file 结论不得混用 Kestrel-only 与代理层结果。
- 如果 `baseUrl` 指向 nginx/CDN/reverse proxy，必须在证据中保留 `optional_deployment_layer`，并另行说明代理缓存、压缩和 buffering 设置。
- 项目内优化 issue 不得把 CDN、nginx proxy cache 或代理压缩计为验收收益。

---

## 各层详解

### `fast` — 快速静态治理与单元测试

**触发时机**：本地提交前、PR 检查

**覆盖内容**：

- `tests/backend/Unit/` — 服务逻辑、工具函数、DTO 映射
- `PodContractValidation.AreAllPodModelsReferenceFree()` — POD 引用安全断言
- AEDS v2 帧头编解码逻辑（`AedsEncoder`、`AedsDecoderValidator`）：16-byte header、CRC16、payload length、unknown version 拒绝、v1 frame 拒绝
- compact POD round-trip：article list/detail/hot/category/tag/comment/stats 与损坏 payload 拒绝
- JWT 签发与校验逻辑（`JwtHelper`）
- 缓存键构建逻辑（`CacheKeyBuilder`）

**单独运行**：

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --filter "Category!=Integration" -v minimal
```

---

### `integration` — 服务端集成测试

**触发时机**：PR 检查、分支合并前

**前置条件**：

```bash
docker compose -f ops/development/dependencies.compose.yml up -d
# 等待 /health/ready 通过
```

**覆盖内容**：

- `tests/backend/Integration/` — 真实数据库 + Redis
- 端点级集成：文章 CRUD、评论流、分类/标签查询
- 缓存回填与失效（L1 + L2）
- 认证流程：注册 → 登录 → refresh → logout
- PoW 挑战-答案验证（Redis backed）
- 会话吊销语义

**单独运行**：

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --filter "Category=Integration" -v minimal
```

---

### `release` — 公开页与 AOT 测试

**触发时机**：Release 构建验证、生产部署前

**前置条件**：`http://127.0.0.1:8080` 可访问（Release 构建容器）

**覆盖内容**（主要通过 `npm run check:*` 系列）：

- `check:public-seo-smoke` — 公开页 SEO 标签（canonical、页面差异化纯文本 description、OpenGraph/Twitter/JSON-LD 图片一致性、feed discovery、JSON-LD `@graph` 中单一 `WebSite` 与正确 `WebPage`/`CollectionPage`/`BlogPosting`），并断言 noindex `/search` 不生成 `SearchAction`、任何 HTML 不生成 `meta keywords`
- `check:public-hydration` — AOT 首屏到 SPA hydration 无闪白，并核验文章详情 hydration/bootstrap 均携带 `relatedReading`
- `check:aot` — AOT 契约合规（`PublicAotShellEntryContract` 格式验证）
- `check:error-code-alignment` — 前后端错误码枚举一致性

`check:public-hydration` 中的 refresh hydration detector 会把匹配 Vue hydration 关键词的 `console.warn`、`console.error` 与 `pageerror` 统一视为 release-blocking failure；不得以 `PASS (n warning(s))` 形式放行 hydration warning。该 detector 每次运行都会写入 `.tmp/release-evidence/public-hydration-detector-summary.json`，schema 为 `fsusblog.public-hydration-detector.v1`，并包含 route、stage、browser、viewport、warnings/errors 与 detector canary 结果。release evidence manifest 会索引该文件；缺失或 `status != "success"` 会阻断 release closeout。

browser environment hydration matrix 会先对每个 cell 的精确 URL（包括本地 user/admin fixture query）轮询预期 `data-public-hydration-kind`，并把首次/最终 kind、HTTP status、attempts 与 duration 写入 `routeReadiness`。Development 环境仅允许 loopback 请求保留值为 `1` 的 `fsusLocalFixtureLogin` / `fsusLocalFixtureAdmin`，同时仍以不含 fixture 参数的 route identity 与 canonical 读写 AOT；production、非 loopback、未知 query 或非规范 `page` 继续执行公开分页 301。route readiness 只等待 cold AOT 变体就绪，不重试 hydration 断言；随后仍只执行一次受 script/auth gate 控制的 pre-hydration 与 hydration 验证，任何 hydration warning、DOM/auth/theme/storage/media 断言失败都会直接阻断 release。

Public hydration matrix 由 `tests/frontend/checks/public/public-hydration-matrix.registry.json` 统一声明，新增公开 AOT page kind 必须同步 registry，否则 `check-public-hydration-matrix-governance.mjs` 会因 manifest 覆盖漂移失败。三个 lane 的证据文件彼此独立，禁止在同一工作区先后覆盖：`public-hydration-fast` 输出 `.tmp/release-evidence/public-hydration-matrix-fast-summary.json`；`release` 在 #330-#335 summary 全部生成后以 `FSUSBLOG_REQUIRE_PUBLIC_HYDRATION_ARTIFACTS=1` fail-closed 校验并写正式合并摘要 `.tmp/release-evidence/public-hydration-matrix-summary.json`；`public-hydration-nightly` 输出 `.tmp/release-evidence/public-hydration-matrix-nightly-full-summary.json`，并保留 Firefox/WebKit、更多 state/clock/fixture/cache 组合的 off-critical-path shard 策略。

`public-hydration-smoke.mjs` 负责 sidecar 生命周期 smoke：新 AOT 页必须以 `sidecar-primary` 读取 `#fsus-aot-hydration-props[data-aeds-src]`，只有旧 artifact 允许记录 `inline-fallback`。它会 fetch raw `.aeds` bytes，校验 `application/vnd.fsus.aeds`、`public,max-age=31536000,immutable`，通过 Public AOT AEDS decoder 解码，并覆盖 Home、ArticleDetail、Archive、Filter、About、Privacy、Guidelines、Copyright。脚本写入 `.tmp/release-evidence/public-hydration-sidecar-summary.json`；release evidence 会语义校验 required page kinds、modeCounts 和 missing-sidecar canary。

Public AOT SSR worker reliability 由 `PublicAotSsrRuntimeStateTests`、`PublicAotBackfillSchedulerTests`、`PublicAotShellServiceTests`、`PublicAotRouteManifestTests` 和 `PublicAotNodeWorkerScriptTests` 覆盖。测试必须证明 worker timeout / malformed renderer response 会进入分类 counters，连续 worker failure 打开 circuit breaker，cooldown 后 half-open probe 成功才关闭，重复 route failure 会 quarantine 单 route，breaker 打开时公开读仍返回 stale AOT 或 SPA fallback。运行时诊断可用 `FSUSBLOG_BASE_URL=http://127.0.0.1:7568 node tools/operations/public-aot-health.mjs` 拉取 `/internal/public-aot/health`；若配置 `PublicAot:ManifestToken`，同时设置 `FSUSBLOG_PUBLIC_AOT_TOKEN`。

**Public hydration matrix 本地复现**：

```bash
./tools/test.sh ci-tier public-hydration-fast --no-deps
./tools/test.sh ci-tier release
./tools/test.sh ci-tier public-hydration-nightly --no-deps
```

---

### `production-correctness` / `browser-contract` — 轻量 correctness + 唯一 release 浏览器探针

**触发时机**：轻量 correctness 随常规测试执行；历史 `acceptance` tier 只进入 nightly diagnostics；`browser-contract` 仅在 browser-boundary PR、主分支 push、release-final 或显式本地验证中执行

**前置条件**：Router/组件/API 单测不需要完整服务；PostgreSQL integration 只需要隔离 fixture；Browser Contract 需要 #1078 immutable production build receipt、一个绑定 source commit/run/lane identity 的 run-scoped fixture namespace 与 frontend/backend runtime

**覆盖场景**：

- Router route/name/path、anonymous/user/admin、permission、guestOnly、redirect、403/404 和 deep link 使用 `createMemoryHistory()`；
- auth、message、admin workbench、passkey dialog 和 mobile/desktop DOM 分支使用 Vue Test Utils；
- AEDS mutation、工单、审核、文章发布、cache/audit side effect 使用 API/backend integration；
- Browser Contract 在一个 managed Chromium 中顺序执行 5 个基线场景：hydration/history/reload、account deep link、admin session invalidation、一次 article publish 与 Service Worker offline reload；step-up-ready immutable fixture 才确定性加入 WebAuthn virtual authenticator 成功场景。

Browser Contract fixture 固定为 `1 session / 1 concurrency`，只准备一个专用 PostgreSQL instance/schema、一个专用 Redis instance/namespace、一个普通 user、一个 admin 和一份 auth/storage manifest。producer 不读取 dynamic worker、live memory/grant 或 PostgreSQL PID headroom，也不逐 worker clone schema；请求其他拓扑、source identity 缺失或 prepare 失败时在读取旧 receipt/启动 Chromium 前 fail closed，禁止回退到共享 live `public` schema。场景只通过正式 fixture API 消费稳定 ID、URL 与 storage state，不直接执行 SQL、Redis 或 Docker。成功、失败、取消和 timeout 共用幂等 cleanup，receipt 分别记录 database/Redis/processes/files cleanup；container labels/ID 与 PID start-time/run identity 均须复核，cleanup failure 保留 recovery state 且不覆盖首个测试失败。完整契约见 [`issue-1149-browser-contract-fixture.md`](testing/issue-1149-browser-contract-fixture.md)。

**运行**：

```bash
npm --prefix src/frontend run check:acceptance:auth
npm --prefix src/frontend run check:acceptance:console
node --test tests/tools/acceptance-layer-migration.test.mjs
./tools/test.sh production-correctness
./tools/test.sh browser-contract
./tools/test.sh browser-diagnostics
```

`check:browser-contract` 不调用 `npx playwright test`。默认 9 分钟 process-group deadline；调用者必须提供完整且与 immutable receipt 一致的 `FSUSBLOG_TEST_SOURCE_COMMIT` / `FSUSBLOG_TEST_SOURCE_FINGERPRINT`。运行期 sealed fixture manifest 位于 `.tmp/browser-contract/fixtures/<namespace>/contract-fixture.json`，本机私有 trace/screenshot 写入 `.tmp/browser-contract/runs/<namespace>/`；仅显式 `anonymous` 场景可启用 raw trace，已认证与未知 role 都不启动 tracing。CI 只上传 `.tmp/browser-contract/receipt.json` 和 job summary，不上传 `fixtures/**` 或 `runs/**`。cleanup 成功后删除该临时 fixture root，cleanup 失败时保留私有 recovery state 供同 identity 重试。新一轮只替换固定 receipt，不会递归删除输出根或其他 run 的本地产物；receipt 保留 database schema、Redis namespace、稳定实体 IDs、source/build identity 和 lifecycle/cleanup 状态，不内联 raw trace/screenshot 内容。缺 immutable build/fixture、Chromium crash/disconnect 或任一 product/contract assertion 失败都会直接退出，且不会自动重试。

---

### diagnostics `visual` — 视觉回归

**触发时机**：nightly，或 UI 组件/样式变更后手动运行 diagnostics

**覆盖内容**：

- 深色模式 / 浅色模式截图比对
- viewport registry 来自 `tests/frontend/fixtures/ux-viewport-matrix.json`
- screenshot baseline 视口：`narrow-mobile` 360x780、`mobile` 390x844、`desktop` 1440x960
- smoke/boundary 额外覆盖 320x568、844x390、1024x900、1366x640、2560x1440、3440x1440 等极端尺寸
- 截图基线版本管理（`test-results/` 目录）

手动复现完整 visual category：

```bash
bash tools/test/lanes/browser-diagnostics.sh \
  manual --category visual --workers 1
```

确需更新 snapshot 时，应在同一 diagnostics source/build、字体与 managed browser 环境中显式运行对应 visual probe 的 update 流程并审阅像素差异；不得让 ordinary Production 自动改写基线。

---

### `security` — 安全场景测试

**触发时机**：认证/鉴权代码变更后、安全审计

**覆盖场景**：

| 场景 | 测试内容 |
| ------ | --------- |
| 匿名请求 | 公开端点可访问；私有端点返回 401 |
| 登录请求 | 有效 JWT 授权成功；过期 Token 返回 401 |
| Admin 请求 | admin 角色可访问管理端；普通用户返回 403 |
| PoW 验证 | 无 PoW 头的注册/登录请求被拒绝 |
| MFA 流程 | 启用 MFA 后登录触发挑战；恢复码单次有效 |
| Passkey 流程 | 注册上限（5枚）、断言失败处理 |
| 封禁用户 | `BannedUserMiddleware` 拦截写操作 |
| 会话吊销 | 吊销后的 Refresh Token 无法续签 |
| Binary 鉴权一致性 | `/api/binary/**` 端点自身声明并验证公开/登录/admin/PoW 边界 |
| 通知鉴权 | WebSocket 私人事件仅已认证连接接收 |
| CORS | 非白名单来源请求被拒绝 |
| 安全头 / Cookie | CSP、XFO、XCTO、Referrer-Policy、Permissions-Policy、auth/PoW no-store、`__Host-*` Cookie 属性 |

CSP style-attribute hardening 的 focused gate 包含 `check:security-consistency`、`cspStyleRuntime` unit、`WebApplicationCompositionExtensionsTests`、`PublicHotReadFastPathTests` 与 `CspReportEndpointsTests`。静态检查递归拒绝应用源码里的 HTML/Vue style attribute、render-function style prop 和直接 `element.style` mutation，只允许 `services/cspStyleRuntime.ts` 在 nonce stylesheet 的 `CSSStyleRule.style` 边界写声明。HTTP 检查必须证明 HTML policy 含 nonce、`'wasm-unsafe-eval'`、`style-src-attr 'none'` 与 report URI，而 binary/auth policy 不含 nonce 或 Wasm 编译权限。

release browser acceptance 在 Chrome、Firefox、Safari、Edge 分别覆盖匿名公开页、登录/account、admin、notification stream 与 binary fetch；页面正常加载期间不得产生意外 CSP violation。测试随后主动插入无 nonce script 与 `style="display:none"`，两者必须被阻止并分别产生 `script-src*`、`style-src-attr` violation。collector smoke 以 CSP media type POST 合法的脱敏 fixture 并期待 `204/no-store`；原始 URL、query 和 source sample 不得进入日志证据。
| 攻击矩阵 | CSRF 形态、伪造 Cookie/JWT、篡改 PoW、method override、路径穿越、超大 / 畸形 binary payload |
| ASVS / WSTG 矩阵 | `tools/security/check-security-matrices.mjs` 校验 `security/matrices/standards/asvs-v5.0.0.yml` 与 `security/matrices/standards/wstg-v4.2.yml` 的版本化 ID、代码/测试/证据路径和 owner |
| 供应链审计 | `tools/security/check-supply-chain-audit.sh` 对 NuGet 和 npm production dependencies 执行 high/critical vulnerability gate |
| SBOM | `tools/security/generate-sbom.sh` 从 NuGet lock files、`package-lock.json` 和 image digest 生成 CycloneDX 1.5 evidence |
| ZAP WARN 策略 | `tools/security/check-zap-warn-policy.mjs` 校验 `security/policies/zap-warn-policy.yml`，要求每个 WARN 有 owner、接受理由、修复期限和升级条件 |
| DAST | OWASP ZAP baseline 扫描本地前后端目标；authenticated DAST 在同一次 fresh runtime 中创建专属 user/admin 会话，并对 anonymous、user、admin、author-console 四类上下文执行主动变异请求；任一 5xx、越权成功、认证上下文失效或扫描器错误都会阻断发布 |
| 本轮本机暴露面 | `tools/security/check-local-runtime-exposure.mjs` 对本次 namespace 的 backend、frontend、release preview 执行真实 HTTP/安全头探针，读取实际 TCP listener，并通过 Docker inspect 确认 PostgreSQL/Redis host binding 仅为 loopback；写入 `.tmp/security/local-runtime-exposure.json`，不得跳过或复用历史结果 |
| 生产暴露面工具 | `tools/security/test-production-exposure-tools.sh` 用合成 DNS/firewall/live evidence 覆盖 prereq handoff/returned 脚本与 tar/find/xargs 依赖清单、evidence request schema、request `requiredEvidence`/`verificationCommands`/`handoffChecks`、request returned-evidence/returned-handoff verifier 与 closeout 命令、request currentStatus/nextActions/unblockPlan、firewall source sha256 生成/缺失/格式/原始文件摘要不匹配拒绝、handoff request 缺失 firewall source sha256 合同拒绝、status report requiredHosts/delegationDomains、live/DNS readiness `requiredHosts` 与 DNS delegation `delegationDomains` 字符串/数组形态、handoff request/status/manifest 对齐、request/status 域名漂移拒绝、request/status blocker 明细漂移拒绝、request requiredEvidence 路径漂移拒绝、request 缺失 handoff check 拒绝、request 缺失 blocker source 的 unblockPlan 拒绝、request 缺失 returned handoff closeout 命令拒绝、request 顶层 returned verifier 命令漂移拒绝、manifest request firewall source sha256 合同漂移拒绝、manifest request returned closeout command summary 漂移拒绝、manifest request unblockPlan summary 漂移拒绝、manifest blocker 明细漂移拒绝、manifest external exposure valid 漂移拒绝、manifest external exposure 组件状态漂移拒绝、request evidenceFiles 路径漂移拒绝、request/status artifact digest 漂移拒绝、manifest host/domain drift 拒绝、release bundle exposure artifact drift 拒绝、bundle artifact 非标准路径拒绝、manifest sha256 digest 校验、缺失 artifact 残留 digest 拒绝、handoff bundle 导出前校验、exporter 输出目录/tarball 自校验、tarball 解压前路径穿越和非普通 entry 拒绝、summary/operator checklist/returned-evidence manifest/README/校验和/tarball 生成、handoff bundle checker 目录/tarball 验证与篡改 returned manifest/README/artifact digest/symlink/archive path traversal/unsupported entry 拒绝、含 symlink 源 release evidence 导出失败、handoff summary unblockPlan、operator checklist unblockPlan、returned manifest unblockPlan 拒绝、returned handoff closeout 对完整 bundle 的 preflight 校验和篡改 operator checklist fail-closed、direct returned-evidence closeout 对父级 handoff bundle 的 preflight 校验和篡改 operator checklist fail-closed、returned expected manifest source metadata 与 unblockPlan sources/count/key/file/artifact/command 映射拒绝、returned evidence 目录验收与 symlink 拒绝、ok/blocked returned manifest 保留、returned request 与 expected manifest scope 缩窄拒绝、returned evidence 成功 closeout 与 missing expected manifest/blocked/缩窄 request/缩窄 manifest fail-closed、临时 fixture 路径拒绝、manifest request summary、complete closeout 自动生成并刷新 request、verifier、status report、失败写 blocked status report、早期失败仍刷新后续 evidence、成功 closeout 写出 `status=ok` |
| 回传 handoff 收口 | `complete-production-exposure-from-returned-handoff-bundle.sh` 覆盖空 returned-evidence 槽 fail-closed、目录输入成功 closeout、tarball + `.sha256` 输入成功 closeout、blocked tarball 输入 fail-closed 且保留解包后的 blocked status 证据、symlinked returned-evidence tarball 与 archive path traversal tarball 解压前拒绝、handoff bundle README/expected manifest 暴露一键 closeout 命令，并复用 returned evidence scope/verifier 规则 |

**DAST 依赖**：

- 本地和 CI 必须可运行 Docker。
- 默认镜像：`ghcr.io/zaproxy/zaproxy:stable`，可用 `FSUSBLOG_ZAP_IMAGE` 覆盖。
- 报告输出：`.tmp/security/zap/`，CI 会上传到 `quality-gate-artifacts`。
- ZAP WARN 级告警会保留在报告中；FAIL 级告警或扫描器错误会使 `security` / `production` 失败。
- authenticated DAST 由 `tools/security/run-authenticated-dast.mjs` 执行，只接受当前 namespace 的 loopback backend/frontend origin。它在 lane 私有 fixture 目录内直接创建专属认证会话，扫描结束即清理该目录；不读取历史成功状态，也不接受 `FSUSBLOG_AUTHENTICATED_DAST_EXECUTED` 之类的人工通过标记。权威证据写入 `.tmp/security/authenticated-dast/summary.json`。
- authenticated DAST 使用 Playwright API request context 并行覆盖四种身份，每种身份内部顺序发送认证、越权、SQL-like、XSS-like、template-like、malformed binary 与 hostile Origin 请求。扫描聚合全部失败，不配置最大错误数；目标仅限本机运行栈，不允许把生产或预发布地址作为扫描目标。
- local production 的本机暴露面证据始终执行，`status=ok` 只表示当前 fresh loopback runtime 的三个 HTTP listener、安全响应头及数据库/缓存 loopback binding 通过。该证据显式记录 `countsAsProductionCloseout=false`，不检查公网 DNS、云安全组或生产 HSTS，不能替代 release-final 的外部证据。

---

### `resilience` — 弹性测试

**覆盖内容**：

- **上传弹性**：分片上传中断后续传、过期上传清理
- **通知弹性**：慢消费者断开、断线重连游标恢复
- **停机弹性**：graceful shutdown drain、notification stream close、重启后 public/auth 恢复
- **搜索弹性**：Service Worker 离线搜索降级
- **Wasm 解码**：Binary 解码失败应暴露协议错误，不得回退到文本 API
- **AEDS v2 兼容边界**：服务端、TypeScript adapter、Worker 与 Wasm decoder 均拒绝 v1 frame；记录列表类响应 raw bytes 与 decode ms 基线，4 KiB 以内走主线程 decode，大包走 Worker/Wasm
- **Redis 短暂不可用**：L1 缓存兜底行为

notification slow-consumer drill 由 `tools/test/lanes/runtime-evidence-probe.mjs fault-injection` 执行：bootstrap 会配置 `FSUSBLOG_NOTIFICATION_DRILL_SECRET` / `NotificationStream__DrillSecret`，probe 使用 `POST /_fsus/testing/notification-stream/publish` 发布测试事件，同时打开正常连接、带 `drillSlowConsumer=1&drillQueueCapacity=32` 的慢连接和 cursor replay 重连。证据必须包含 `connectionCount`、`heartbeatFrameCount`、`businessFrameCount`、`deliveredFrameCount`、`droppedOrBackpressuredCount`、`reconnectSuccess`、`replayedEventCount`、`closeObserved`、`eventIds`、`routeKey`、`slowConsumerPolicy` 与 `finalHealthStatus=healthy`；只有心跳 smoke 不算完成。

graceful shutdown drill 同样由 `runtime-evidence-probe.mjs fault-injection` 执行。probe 会优先使用 `FSUSBLOG_BACKEND_CONTAINER_NAME` 做 `docker stop/start`；没有容器时使用当前 `FSUSBLOG_BASE_URL`/`ASPNETCORE_URLS` 端口的监听进程，发送 `SIGTERM` 后用同一开发环境变量重启 debug backend。证据必须包含 `shutdownRequestedAt`、`processStopResult.status=stopped`、`processStopResult.exitObserved=true`、`drainDurationMs`、`restartRecoveryDurationMs`、`livenessBefore.status=completed`、`livenessDuringShutdown.status=unavailable`、`notificationCloseObserved=true`、`notificationReconnectSuccess=true`、`publicReadRecoveryResult.status=completed`、`basicAuthRecoveryResult.status=completed`、`backgroundWorkerState.status=clean` 与 `finalHealthStatus=healthy`；只记录计划或 observed-only 状态不算完成。

disk/artifact storage write-failure drill 同样由 `runtime-evidence-probe.mjs fault-injection` 执行，case 名为 `disk-artifact-storage-write-failure`。probe 只在 `.tmp/fault-injection-storage/<namespace>/` 下创建临时 artifact 目录，将目标目录设为不可写，触发一次写入失败并分类为受控错误，然后恢复权限、验证写入恢复并清理目录。证据必须包含 `targetPath`、`expectedErrorClassification`、`writeFailureResult.status=expected-error`、`recoveryResult.status=completed`、`cleanupResult.status=completed`、`recoveryDurationMs` 与 `finalHealthStatus=healthy`；直接写生产目录、留下测试目录或只记录 observed-only 状态都不算完成。

data-scale lanes 必须生成真实、可查询、可清理的 fixture。`tools/data-scale/seed.sh` 按 `FSUSBLOG_TEST_NAMESPACE` 写入 namespace 前缀数据：`scale-xs=1/0`、`scale-s=100/1,000`、`scale-m=10,000/100,000`、`scale-l-nightly=100,000/1,000,000`（article/comment）。seed summary 必须包含 `declared`、`expected`、`observed`、`coverage`、`search`、`artifacts` 和 `durationMs`；`runtime-evidence-probe.mjs data-scale` 必须读取该 seed summary，并按同一 namespace 前缀复核 PostgreSQL 中 article、comment、category、tag、article_body、article_tag、root comment 和 nested comment 数量。声明值、seed 实测值、probe 实测值任一不一致都必须失败。`tools/data-scale/cleanup.sh` 只删除同 namespace/tier 前缀数据，并在 `cleanup.json` 中证明 remaining 为 0；不能用全库 truncate 或只丢弃 manifest 代替清理。每个 tier 必须把 release summary 写入 `.tmp/scale/release-summaries/<tier>.json`，禁止共享 writer；production 的 `data-scale-evidence-summary` 只有在 `scale-xs` 与 `scale-s` 两份输入齐全时才原子生成 `.tmp/release-evidence/data-scale-summary.json`，并保留两档完整实测与清理证据。

---

### `load` — 轻量并发压测

> 非性能基准，仅验证基础并发稳定性。

**覆盖内容**：

- 文章列表 / 详情并发读（baseline `concurrency=10`、`rounds=6`、`durationMs=30000`，源自 `tests/performance/perf-policy.yml`）
- Binary 链并发读
- WebSocket binary notification stream 多连接稳定性（`connections=50`、`durationMs=30000`）

**backend-perf / 性能基准**：

`backend-perf` 先并行完成 Release test/benchmark producer readiness 与治理，再在 machine-quiet `benchmark-window` 中执行 native verifier P99；`backend-benchmark-regression` 负责完整 BenchmarkDotNet 回归并输出 release evidence。共享 producer 在 scheduler 下绑定 source commit + worktree fingerprint，运行时生成的 backend log/cache 不会造成同轮指纹漂移；测试 reader 一律 `--no-build --no-restore`。该 lane 默认运行 `*HotPath*`：request audit/context、binary frame encode/PipeReader binding、notification shared fanout/frame pump、read-model projection、content filter、related scoring、stats projection 与 crawler/UA normalization。`tests/performance/backend-hotpath-budgets.json` 为唯一预算源；有诚实旧实现的场景按相同参数比较 mean/allocation ratio，没有可比旧实现的 PipeReader binding 与 frame pump 使用绝对 mean/allocation budget。

`tools/perf/check-backend-benchmark-regression.mjs` 必须读取 BenchmarkDotNet JSON 的实际 `Statistics.Mean` 与 `Memory.BytesAllocatedPerOperation`，逐预算生成 before/after measurement、失败原因和 release summary。缺基准、缺相同参数、缺 allocation 或超预算都必须使 lane 失败；禁止再用 report 数量或固定 `status=ok` 代替性能证据。数据库热路径另由 PostgreSQL AOP command counter 断言：stats 子端点各自只执行其窄查询，related-reading 冷 miss 有界且 memory hit 不访问数据库；并行路径使用真实 TCS/barrier 验证同时启动、失败、取消、超时和资源释放。

冷运行会按 HotPath benchmark class 分片，class 内的 baseline/current 与全部参数组合保持不可拆；每个 class 使用独立 OS 进程、独立 artifacts 目录和 BenchmarkDotNet in-process no-emit toolchain，仍使用 `Job.ShortRun` 的完整测量强度与各 class 的 `MemoryDiagnoser`。并发数取实时 `FSUSBLOG_STEP_*` / `FSUSBLOG_BUNDLE_*` grant、OS 可用 CPU、空闲/总内存的共同下限；Linux 会把进程允许且已授予的 CPU 动态划成互斥集合分给 worker，并将每个集合的实际大小传给 .NET runtime。所有 class JSON 汇总后只调用一次相同 budget checker，默认契约必须得到 8 个 class、18 个 benchmark method、22 个参数化 measurement，不能通过删 benchmark、缩 iteration 或改预算换取时长。

production 的完整 HotPath benchmark 作为 mixed performance window 的独立 cohort 与 baseline、peak、burst、notification、QPS 同窗执行。六个 cohort 只声明相对 CPU / memory weight，`run-mixed-performance-window.mjs` 从实时 step/bundle grant 生成总和不超过父 grant 的子 grant；benchmark 使用较高相对 memory weight，但 worker 数仍由子 grant 与实时主机内存共同求得，不设置固定 GiB/worker。mixed summary 必须绑定 window `startedAt` 之后生成的 8 份 class report、22 项 measurement、统一 checker 与 release summary 的 SHA-256；checker 真实失败必须保留为 failed cohort，不能被 fresh marker 改写为成功。

测试工具契约必须验证可观察行为：coverage 脚本使用 `--dry-run` 输出 schema，coverage collector/summarizer 使用 fixture report；`backend-trx-contract-dry-run` 在临时目录写入稳定 lane 名称的真实 `.trx`；viewport runner 通过注入 Playwright/summary 结果验证退出码，progress/summary 使用临时文件系统验证 current-run pointer、resume、并发原子写与陈旧产物隔离；data-scale/performance aggregator 和 release artifact restore 均以 mixed/stripped 下载布局的实际产物为准。matrix、workflow 与 package 接线由 `tools/check-test-matrix.mjs`、`tools/check-workflow-matrix-sync.mjs` 和 backend governance checker 的结构化解析集中验证，行为测试不得再读取 shell/workflow/其他测试源码匹配实现字符串。

`backend-qps` 是静态实现证据加小样本运行时探针，不是吞吐容量基准。collector 会先执行源码结构 guard，再对本仓库启动的 Kestrel 进程做少量 HTTP probe；证据中 `performance_baseline.mode=kestrel-only`，顶层 `capacityConclusion.countedAsCapacity=false`。如果要对 nginx/CDN/reverse proxy 做部署层对比，使用单独 artifact 名称（例如 `backend-qps-deployment-proxy-optional`），并保持 `optional_deployment_layer.counted_as_project_baseline=false`。

CI 将 `backend-qps` 拆为两个阶段：`backend-qps-collectors` 使用 matrix 并发运行 `backend-qps-*` collector tier，每个 collector 在独立 runner 中 bootstrap 本地 app stack 并只上传 `.tmp/perf/backend-qps/<mode>.json`；`backend-qps` aggregate job 等待 collectors 与 `integration-runtime`，下载 collector artifacts 后运行 `tools/test/lanes/backend-qps.sh aggregate`，统一写入 `.tmp/release-evidence/backend-qps-summary.json`。summary 必须包含 `evidenceModel=static-implementation-plus-runtime-measurement`、`staticEvidenceResults`、`runtimeMeasurementResults` 和非容量结论；collector 不再各自写 summary，避免并发覆盖；本地 `./tools/test.sh backend-qps` 仍通过 matrix DAG 先完成 bootstrap 和 collectors，再执行 aggregate。

`backend-qps-runtime-sequential` 不替代上述并发 collector。它在单个已经启动并完成 warmup 的 Kestrel runtime 中顺序运行 `backend-qps` 的所有 measured scenarios，用于观察同一 runtime / namespace 下的相对变化；summary 写入 `.tmp/release-evidence/backend-qps-runtime-sequential-summary.json`，`evidenceModel=warmed-runtime-sequential-measurement`。该 lane 标记为 nightly/optional，普通 PR 不强制跑完整 sequential measurement；release evidence 不得把来自不同 CI worker 的 collector RPS 当作横向容量对比来源。

CI 的 file-only checks 与 app-stack checks 必须分阶段：`cross-stack-contract` 只运行 `backend-api-integration` 与 `cross-stack-contract` 这类仓库文件/生成契约检查；`security-static-fuzz` 只运行 `wasm-fuzz-regression` 与 `contract-fuzz`；需要本地 app stack 的 `endpoint-depth-runtime`、`integration-runtime`、`security-runtime` 保持独立 job。新增检查时若 `services: []` 且 `requiresBootstrap: none`，优先放入对应 file-only job，不能塞回 runtime job。

`wasm-fuzz-regression` 必须先用 ASAN/UBSAN 编译实际 AEDS exports 并运行 handle epoch 合约，再以 libFuzzer 覆盖 reserve/decode/clear 与 stale token；随后在当前 fresh namespace 内同时加载本轮 `frontend-build` 生成的 `aeds_decoder_basic.wasm` 与 `aeds_decoder_speed.wasm`，按 scheduler 授予的 CPU 容量生成可复现种子并真实调用两套 Wasm arena decode 导出。每个 seed 的 success/error code、frame type、payload length/hash 必须一致，并验证 sensitive arena 清零及 payload handle 在 clear 后失效；仅写入计划、读取“已执行”环境标记或复用旧 run 的 fuzz summary 都不构成通过。权威证据必须包含 `executionSource=fresh-wasm-runtime`、非零 `seedsRun`、ABI、两套解码器 SHA-256、合并 identity digest 与可重放 seed plan。

`aeds-decode-budget` 必须读取同次构建的 `aeds-runtime-manifest.json` 和真实 basic/speed Wasm，记录 raw/gzip/br、load/compile、frame-size p50/p95/p99、MB/s/ns-per-byte、arena/reallocation/clear、memory pages 与 copy model。该 browserless evidence 是普通 `aeds-frame-cost` correctness/performance owner；Chromium/Firefox/WebKit 的 download/compile/instantiate、Worker transfer、hydration takeover、long task、tier selection/fallback rate 已迁到 scheduled/manual diagnostics。browser summary 的缺失、unsupported 或失败不阻断普通 correctness，也不能替代 decoder budget。不得用 TypeScript no-copy synthetic loop 代替任一真实 Wasm evidence。

server `aeds-frame-cost` 证据把 `structuralEvidence` 与 `measuredEvidence` 分开：copy count/bytes 明确标记为由旧双缓冲写路径和 `payload.Length` 推导的结构事实，不得伪装成硬件 counter；allocation、mean、p50/p95、方差与逐轮样本才是机器实测。实测必须在同一 Release benchmark/Core artifact set、同一 runtime/CPU/OS/GC/affinity 与同一 commit 上至少执行五轮，且 before/after 逐轮交替顺序；门禁使用 round mean 与 round p95 的中位数控制单个 scheduler outlier，同时保留 pooled arithmetic mean/p95、逐轮值和方差供诊断。`tests/performance/perf-policy.yml::aedsFrameCost` 是轮数、warmup、样本数、代表性场景及相对/绝对噪声带的唯一来源；`ArticleList10/50/100`、`ArticleDetailLarge`、`CommentCursor`、`ConversationDetail`、`PublicAotBootstrap` 全部受 allocation、mean、p95 门禁，`EmptySuccess` 只作 static-preencoded reference，`ApiError` 使用独立 tiny noise band。缺 identity、非 Release artifact、dirty source 或样本不足只能得到 `blocked/structural-only`；任一实测回退都使 overall `regressed`，不能被结构性 copy reduction 改写为 improved。完整 schema、结论表与排障见 [AEDS frame-cost evidence gate](testing/issue-1152-aeds-frame-cost-evidence.md)。

`PodBinaryCodec` batch allocation 证据使用独立 profiler 和 field-derived checker：ArticleList 覆盖 0/1/10/50/100 items、0/2/8 tags、三档字符串长度与 ASCII/CJK/mixed UTF-8 的 135 场景，并逐场比较五个候选的 wire bytes；ArticleDetail 对小正文保留 legacy 路径，只在达到实测阈值后直接写入 UTF-8 blob。backend unit 保留 differential、随机 UTF-8、overflow、pool 异常归还、并发和阈值边界；`static-governance` 只重放确定性的证据契约测试，不在 fast gate 重跑五轮 benchmark。结论只能声明 miss/background rebuild encode 的 Level M 分配与局部延迟，不得外推为 cache-hit QPS。完整复现实验、场景表和回退条件见 [PodBinaryCodec batch allocation evidence](performance-pod-binary-codec-batch.md)。

独立运行真实 BenchmarkDotNet：

```bash
cd FsusBlog.Core.Benchmarks
dotnet run -c Release
```

结果保存在 `BenchmarkDotNet.Artifacts/results/`。当前套件覆盖 AEDS/POD encode/decode、raw cache-hit defensive copy 与 readonly fast path、合成 search rebuild/query BM25 路径、Public AOT bundle encode/decode，以及上述 server hot paths；生产调高 runtime tuning 前必须把对应实测基准和 budget comparison 随发布证据保存，不得写“更快”而没有 measurement。

---

### `production` — production-ci-gate

`production` 是 PR/CI 的 production-ci-gate。它执行当前 production DAG 并校验 release evidence schema。local production profile 的 77 个逻辑 tier 全部必须来自本次 fresh 物理 bundle 执行，`security-authenticated-dast` 不再是 `summaryOnly` / `collected-blocked` 占位；其 summary 必须证明四类认证上下文的主动扫描真实执行且全部通过。外部生产暴露面等 release manifest 仍可能以 schema-valid `collected-blocked` 表达运维证据尚未回传，这不等于可以发布。

`static-governance` 同时执行 `tests/tools/release-id.test.mjs`、`tests/tools/release-manifest.test.mjs`、`tests/tools/deployment-slots.test.mjs` 和 `tests/tools/issue-1315-dotnet-release-metadata.test.mjs`。第一组校验唯一 `YYYYMMDDHHmmss-sha12` ReleaseId 权威、真实 UTC 日期、完整 commit/createdAtUtc 交叉绑定、单次 identity snapshot、非发布 sentinel、稳定 shell CLI、跨语言 fixture 与 C#/TypeScript 生成文件漂移；第二组创建不可覆盖的 `fsusblog.release-manifest.v2`，覆盖 commit/image/frontend/Wasm/toolchain 绑定、ReleaseId/createdAtUtc/commitSha 与 OCI tag/ref 不一致拒绝、SemVer 拒绝、V1 writer 拒绝及显式 rollback-only legacy reader、无现场 build 的 deploy dry-run、pull 后 RepoDigest 与 OCI release/commit 标签不一致阻断，以及 release evidence 中 runtime slot/commit/ref/digest 的一致性；第三组以临时本地 manifest/slot/rollout fixture 证明 manifest-first 身份传递，并拒绝 expected value 或 durable source identity 篡改；第四组验证 .NET Assembly/FileVersion 固定为技术版本 `0.0.0.0`、InformationalVersion/SourceRevisionId 与同一发布身份绑定，并在 Release publish 缺失或不一致时 fail closed。本地构建只能得到显式 `local-unversioned` metadata，不能据此生成可部署 manifest。生产启动与 readiness 的对应行为由 `ReleaseIdentityTests` 和 `ProductionStartupValidatorTests` 覆盖；缺少身份不能靠本地默认值进入 Production。

同一 tier 的 `tests/tools/deployment-slots.test.mjs` 使用临时持久状态和受控 Docker/health/port doubles 执行 blue/green 编排：两个 release digest 可同时存在于独立 project/container/loopback port，重复 start/stop 保持幂等，active slot 无法被 stop/替换，候选 health 失败、端口占用、损坏 digest 与资源不足都在不改变 active runtime 的前提下失败。测试还从 fsync + rename 状态文件模拟主机重启后的 active 恢复，并检查 Compose 只共享 uploads/DataProtection、隔离 AOT/log/data 且不再出现固定 `127.0.0.1:8080` 或公网绑定。

同一 tier 的 `tests/tools/gateway-switch.test.mjs` 覆盖受控 loopback upstream 生成器、临时文件中断不影响活动 include、Blue→Green→Blue 切换/回滚、持续公网请求零拒绝/零 5xx、dry-run 全配置预检、候选 readiness/identity 拒绝、staged config 拒绝、reload 失败自动恢复源槽、发布锁竞争、`switching` 重启后 source/target 确定性恢复，以及 previous release identity 漂移时拒绝回滚。切换测试还用独立 runtime state double 证明 source 精确 Active、target 精确 Ready Candidate、target CAS activation 在 reload 前发生、durable commit 后 source drain 完成；回滚前必须把已排空旧 release 作为新 Candidate 重启。成功证据必须与最终 manifest 的 slot/release/digest 一致，并含 target activation/source drain 的 sanitized lifecycle snapshot；失败证据保留真实失败阶段与恢复动作，不能把后续未执行的检查标成通过。

`DeploymentRuntimeStateTests` 是发布生命周期行为 owner：覆盖 Candidate 全门禁、错误 mode/generation fail closed、activate/drain identity-generation CAS 与幂等、进入中的普通 HTTP 完成而新请求被拒绝、异常/取消后计数归零、notification 与 background 独立计数、准确 drain blockers/timeout、SIGTERM 与主动 drain 复用同一路径，以及公共 readiness 不泄漏 release 拓扑。涉及匿名/登录/admin/notification/binary 的既有行为套件继续运行；发布状态只包围 HTTP/notification/background admission，不改变匿名/登录/admin 授权或 AEDS frame 编解码。

`ActiveReleaseFenceContractTests`、`notificationStreamRestartPolicy.test.ts` 与 `check-background-service-classification.mjs` 共同拥有 release fence：Redis CAS/read-back、active-singleton ticket、最后提交前 guard、1012 cursor/replay-miss 语义，以及全部 BackgroundService 的 singleton/idempotency/drain/replay 分类。分类器与 analyzer 一次输出全部错误，不设置最大错误数；xUnit 继续固定 `stopOnFail=false`。

`ActiveReleaseFenceAvailabilityTests` 覆盖 production startup 强制 durable-witness probe、Redis replica degraded 但 SQL 可读时允许启动、动态 5000ms/30s 窗口的第 6 次连续失败触发 `StopApplication()`、availability 配置范围与 hosted-service 启动顺序。该集合使用 fake clock，不以 30 秒真实 sleep 伪装时序验证。

`SchemaMigrationDdlPrimitivesTests` 覆盖 typed identifier / column definition、PostgreSQL / MySQL / SQLite provider、全部 DDL step kind、dry-run preview 与 descriptor transaction wrapper。MySQL/SQLite 生成结果必须逐项匹配 `tests/backend/Fixtures/schema-ddl-provider-snapshots.json`；非法 identifier、任意 column SQL、错误 DDL kind、多语句注入和注释逃逸均 fail closed。

Issue #1031 的工具测试按独立临时目录和 loopback ephemeral ports 并行运行：

- `release-rollout-state.test.mjs`：15-stage 顺序、rollout identity、failed-stage recovery 与 resume。
- `release-rollout-evidence.test.mjs` / `release-rollout-bundle.test.mjs`：attempt/stage/recovery seal、恰好六类 artifact、hash/size readback、symlink/path escape/第七 artifact 拒绝。
- `release-rollout-probes.test.mjs`：12 类持续流量、业务 5xx 明确分类、完整未截断错误、host/dual-slot/resource/reload/drain/reconnect/P95/P99 budgets。
- `release-traffic-probe-session.test.mjs`：真实 Cookie jar、login/refresh/protected chain、response/body/AEDS、跨 gateway in-flight hold 与 HMAC final binding。
- `release-migration-qualification.test.mjs` / `rehearsal-schema-qualification-probe.test.mjs` / `ReleaseSchemaQualificationEndpointsTests`：固定十场景、仓库 Test adapter、bridge/readiness guard、admin/rate-limit route contract 与完整错误聚合。
- `release-worker-normal-observer.test.mjs`：loopback start/status/finalize producer、rollout/drain/hash/identity 绑定、精确有序 normal 8-kind、拒绝 destructive 第九类事件与不截断错误。
- `release-worker-drill.test.mjs` / `release-worker-reconciliation.test.mjs`：normal 8-kind 与 destructive qualification 9-kind 分离、exactly-once、stale-generation=0、distinct fresh state binding。
- `release-asset-compatibility-probe.test.mjs` 与 Playwright `release-asset-compatibility.spec.ts`：N-1 index/hash/JS/CSS/Wasm/font/SW cache、双向 backend compatibility、applied GC 后零 404。
- `zero-downtime-rehearsal.test.mjs`：normal、explicit rollback、13-case post-switch fault、真实 process-group SIGKILL/resume 和跨模式错误聚合；记录型 fixture 不调用真实 Docker/网络。

真实零停机 rehearsal 的资源资格固定为 4 CPU、6144 MiB memory、10240 MiB free disk；2C/2G 只验证单槽兼容性，不运行 dual-slot overlap。Qualification 必须 teardown 后创建 distinct fresh normal rollout，目标 release/digest 相同而 rollout ID 不同；禁止历史 state、ledger、checkpoint 或 pass evidence 复用。

rehearsal plan 必须提供两个互不复用的 mode-0400/0600、32..4096-byte key：
`evidenceInputs.trafficBindingKey` 与
`evidenceInputs.assetBrowserBindingKey`。它们分别验证 traffic final binding 和真实
Chromium/SW/GC binding；验证只接受 key 路径，不把 secret 写入 artifact。迁移资格还
必须提供 `target.migrationServerDll` 以及
`migrationQualification.{scenarioTemplate,timeoutSeconds,expandMigrationId,backfillMigrationId,contractMigrationId}`。

| #1031 场景面 | 必须有的真实覆盖 |
| --- | --- |
| 匿名 | 首页、归档、文章、搜索、static 与公开 AEDS binary；部署连接错误和未标记 5xx 为 0 |
| 登录 | login、refresh、protected read、代表性 write 与 upload；Cookie jar 不把凭据写入 evidence |
| admin | health/control；migration bridge/readiness 只在 Test + explicit enable 下使用 `system.config` |
| notification stream | guest/auth 1012、cursor replay、replay miss full resync、业务 event ID 去重、slow-client drain |
| binary | AEDS magic/v2/header/flags/frame type/payload length/CRC16/byte budget 与可选 payload SHA-256 |

以上是待运行的 acceptance contract，不是当前通过声明。

执行顺序请以机器输出为准：

```bash
./tools/test.sh production-correctness --plan-only
```

当前高层顺序为：

1. `fast`：Debug build `-warnaserror`、服务端非集成测试、`vue-tsc`、前端 release build warning-as-error、静态治理脚本。
2. 强制 bootstrap：启动或重启 PostgreSQL、Redis、Debug 后端、Vite 前端、Release Preview。`fast` 会重新生成前端 release 资源并同步到后端 StaticWebAssets，production 门禁必须在这里重启运行时，避免旧进程继续服务上一代代码或静态资源。
3. 复用同一套运行环境执行 `release`、`integration`、`security`、browserless `frontend-render-structure`、`resilience`、`load` 与 `backend-qps`。Acceptance、PoW/search/permission/zero-auth browser probe、visual、UX full/risk、cross-browser、geometry/motion/focus、browser performance/a11y/resilience 都不在 production correctness 中执行。
4. 收集 release evidence 并运行 schema/semantic check；此处不使用 `--require-ok`。

Release rollout closeout 另外要求 `release-rollout.json` seal 15 stages 与 exactly six artifacts（public traffic、notification、asset compatibility、normal worker reconciliation、resource budget、fault injection），并要求 allowlisted `release-rollout-bundle/bundle-index.json` read-back。缺失、scheduled、hash drift 或 qualification ledger 冒充 normal 均保持 blocked。

```bash
./tools/test.sh production-correctness
```

真实浏览器诊断另行执行，不存在 Production visual skip 开关：

```bash
./tools/test.sh browser-diagnostics
```

diagnostics failure 只改变该 diagnostics receipt；不得把它写入 Production correctness status，也不得用 Production 通过冒充 diagnostics 已执行。

完成后检查：

```bash
curl -fsS http://127.0.0.1:8080/health/ready
```

失败时优先查看：

- `.tmp/acceptance/*.log` — 后端、Vite、preview 启动日志
- `src/frontend/test-results/playwright/` — Playwright trace / screenshot
- GitHub Actions 的 `quality-gate-artifacts` artifact

GitHub Actions 中普通 `Quality Gate` 负责 PR 以及 `main`/`master` push correctness；独立 `Browser Diagnostics` workflow 只由 schedule/workflow_dispatch 触发。普通 lane 的资源仍由 matrix scheduler grant 管理；diagnostics 是显式例外，外层与所有浏览器内层都固定 `workers=1`、`retries=0`，不按机器负载扩张。diagnostics workflow checkout FsusUI 到 run-local 目录并通过 alias 消费 source/theme dist，不发布 FsusUI 或修改 registry/lockfile。

#### Backend affected-test selection

`Quality Gate / Fast Backend` 现在固定 `FSUSBLOG_TEST_SELECTION=full`：`coverage-backend` 与普通 `backend-unit` 共享 `executionKey`，coverage 成功时替代同一批普通 non-integration unit，避免执行两遍但不缩小覆盖。`tools/dotnet-affected-tests.sh` 仍保留为本地或显式 PR diagnostic 入口；它不参与权威 coverage-backed CI 凭证。

ordinary coverage 明确排除 `Integration`、`ApiIntegration`、`Concurrency`、`Performance`、`Property`、`GoldenContract` 与 `SecurityStateMachine`；其中 API integration、auth state machine、concurrency、property、golden 各自只运行一次并同时输出 Coverlet JSON 与 Cobertura。六个 collector 共用 `backend-coverlet-instrumentation` 互斥资源，最终按源码位置和 JSON branch identity 做精确 union，再执行 backend coverage gate。旧 `backend-chaos` 与 `backend-concurrency` 使用完全相同的 `Category=Concurrency` 选择，已由后者替代；fault/race coverage ID、runtime summary 和 mergeable coverage 均保留，nightly soak/performance 不受该替代影响。

`tools/dotnet-affected-tests.sh` 的 changed-file 规则保持保守：

- 无变更或只改前端、文档、非 backend 路径时，记录 `selection=affected effective=skip` 并跳过 non-integration backend tests。
- `src/backend/`、`src/shared/`、`src/core/`、`tests/backend/`、solution/build props、`global.json` 等 backend/shared/core/test 或构建输入变更时，升级为 `selection=affected effective=full`。
- 鉴权、安全、权限相关路径，例如 `Infrastructure/Auth`、`BannedUserMiddleware`、`JwtHelper`、`Infrastructure/Security`、`Modules/Endpoints/Auth`、`src/shared/Contracts/Security` 以及 backend auth/security 测试变更，会记录 `reason=auth-security-sensitive` 并运行完整 non-integration backend tests；fast-backend 的独立 auth state-machine tier 仍照常运行。

显式使用 affected diagnostic 时，日志必须同时显示请求策略和最终策略：`RunBackendUnitLane()` 输出 `backend-unit selection=affected|full`，affected 脚本输出 `effective=skip|full` 与 `reason=...`。

#### Backend build parallelism

`backend-fast` 的 .NET build 默认仍使用 deterministic safe mode：`FSUSBLOG_DOTNET_BUILD_PARALLELISM=safe`，等价于 MSBuild `/m:1`。这保留本地 debug、release/manual full gates 与保守排障路径的单 worker 行为。

PR fast-backend 可以通过 GitHub repository variable `FSUSBLOG_DOTNET_BUILD_PARALLELISM` opt in 并行 build；支持值为：

- `safe` 或 `1`：使用 `/m:1`。
- `auto`：使用 `/m`，由 MSBuild 按 runner CPU 自动选择并行度。
- 大于 `1` 的整数：使用 `/m:N`。

`RunFastBackendLane()` 在 build 前输出 `dotnet-build parallelism=<mode> arg=<msbuild-arg>`，用于确认 CI 实际选择的模式。无效值会直接失败，避免静默回退到未知并行度。

Benchmark 记录口径：在同一个 runner、同一个提交、同一份 NuGet cache 状态下分别运行 `FSUSBLOG_DOTNET_BUILD_PARALLELISM=safe ./tools/test.sh ci-tier backend-fast --no-deps` 与 `FSUSBLOG_DOTNET_BUILD_PARALLELISM=auto ./tools/test.sh ci-tier backend-fast --no-deps`，记录 wall-clock、退出码、重跑次数和是否出现非确定性失败。默认值只能在至少两轮 CI fast-backend 对比都显示 `auto` 无新增 flake 且明显降低 wall-clock 后再从 `safe` 提升；在此之前只通过 repo variable 对 PR fast gates opt in。

当前本地单轮 build benchmark（2026-06-15，same checkout，warmed NuGet cache after first run）：

| Mode | MSBuild arg | Wall-clock | Exit | Flake signal |
| --- | ---: | ---: | ---: | --- |
| `safe` | `/m:1` | 53s | 0 | none observed in one run |
| `auto` | `/m` | 12s | 0 | none observed in one run |

这组数据只证明并行 build 在当前机器可用；它不是提升默认值的依据。CI 默认仍是 `safe`，直到 PR fast-backend 在 GitHub runner 上积累至少两轮 `safe`/`auto` 对比和 flake 记录。

#### Root CI setup 与 fail-fast 诊断

`validate-matrix` 是 Quality Gate 的根作业。它先运行：

```bash
node tools/run-test-matrix.mjs preflight
```

`preflight` 会创建并验证 `.tmp/`、`.tmp/release-evidence/`、`.tmp/gate-logs/`、`.tmp/env/`、`.tmp/docs/`，确认 test matrix、workflow、runner 脚本和 Git metadata 可用，并写出 `.tmp/gate-logs/preflight.json`。本地排查 CI 根失败时先运行同一条命令；如果失败，修复该输出里的缺失目录、权限或 matrix 错误后再看下游测试。

`ci-plan` 必须使用 `--out` 写文件：

```bash
node tools/run-test-matrix.mjs ci-plan --format github-actions --out .tmp/ci-plan.json
```

不要用 shell 重定向写 `.tmp/ci-plan.json`，因为缺失父目录时会在脚本外失败，错误信息不可操作。`production-summary` 会把非成功作业分成 earliest root non-success jobs 与 downstream fan-out：前者是应优先修复的真实根失败，后者通常是上游失败导致的 skipped/cancelled，仍然会让门禁失败，但不应被误判为通过。

#### Release evidence 与 job summary

每个 matrix tier 执行时都会更新对应 CI job 的机器摘要：

```text
.tmp/release-evidence/jobs/<job-id>.json
```

摘要使用 `fsusblog.ci.job-result.v1`，包含 `status`、`failureStage`、`rootCause`、`tierIds`、`artifacts`、`localReproduction`、`commit`、`runId` 和 `attempt`。普通 CI matrix shard 继续使用稳定 job id / artifact 名称；唯一普通真实浏览器 job 是不分片的 `browser-contract`。其 CI artifact 只上传 Browser Contract receipt 与 job summary，不上传可能含会话信息的 `fixtures/**` 或 `runs/**`。visual、UX 与 cross-browser 不再作为普通 correctness job summary。Browser Diagnostics 使用自己的 run/category/probe receipt 和统一 workflow artifact，不能混入 Production required-job 列表。

失败后先看 `production-summary` 的 root failure 分组；若对应 job summary 已下载，它会附带 `failureStage`、`rootCause`、`reproduce` 和 summary artifact 路径。完整发布证据在 `.tmp/release-evidence/<release-identity>/manifest.json`，其中 `artifacts.jobSummaries` 指向收集到的 `job-summaries/` 目录。`release-evidence` 在 CI 中会校验 required job summary 是否存在、schema 是否正确，以及 matrix 声明的生成型 artifact/evidence 是否由对应 job 上传。

### `release-closeout` — release-closeout-gate

`release-closeout` 只用于最终发布收口，必须要求 release evidence manifest 为 `collected-ok`：

```bash
./tools/test.sh release-closeout
tools/operations/check-release-evidence-manifest.mjs --require-ok
```

`collected-blocked` 是合法的 CI 证据状态，但不是可发布凭据。dry-run backup restore、dry-run smoke、manual-only smoke checklist、未执行 authenticated DAST、零 seed Wasm fuzz、observed-only fault injection 和空 short soak 都必须保持 blocked/scheduled，不能写成最终发布通过。

### `release-final` — final publish credential

`release-final` 是唯一最终发布凭据。它是 `tests/matrix.yml` 中的 first-class tier，但标记为 `manualOnly`，不会作为 PR/push Quality Gate 的默认 job。发布候选必须显式运行：

```bash
./tools/test.sh release-final
```

`release-final` 会从同一个 matrix DAG 派生执行路径，并在 `release-closeout` 之外额外强制：

- `coverage-gate-strict`：backend line >= 85、backend branch >= 75、frontend line >= 75、frontend branch >= 65、changed-code line >= 90，critical backend module branch >= 90 或有批准例外。
- `production-correctness`：完整 browserless correctness closure 必须先通过。
- `browser-contract`：只允许一个消费 immutable production build 的 managed Chromium job，固定 worker/session/concurrency 1、零 shard、零 retry；release-final 聚合器自身保持 `requiresPlaywright: none`。
- release runtime lanes：admin console、auth flow、authoring flow、private preview 与 error boundary 使用 Vitest/API/static contract 绑定 release artifact；真实 RBAC browser negative path 已迁入 diagnostics。
- release AOT lanes：generation 与 static asset digest coherence 作为 browserless release evidence；真实 consumption/browser fallback 属于 diagnostics。
- release load/scale/stability lanes：peak、burst、scale-m、soak-min、memory leak budget、open handle budget、critical mutation slice。
- strict evidence：manifest 必须为 `collected-ok`，live exposure/firewall/DNS evidence 必须存在，backup restore 必须是 real drill，post-deploy smoke 必须是 deployed endpoint 自动覆盖，authenticated DAST/Wasm fuzz/fault injection/short soak 必须真实执行，job summary 必须覆盖 production-correctness 与其他 required correctness jobs。独立 browser diagnostics receipt 不进入该 correctness required-job 集合。
- artifact binding：`tools/release/check-release-final.mjs` 要求 manifest commit、job summary commit 与 `sha256:` image digest 一致。
- AEDS Wasm cross-stack：普通 `aeds-frame-cost` 在 `frontend-build` 后串行绑定 server frame cost 与 basic/speed artifact/compile/decode/copy/memory budget；server summary 必须同时具有独立 structural copy reduction 与同 SHA/Release artifact 的 authoritative allocation/mean/p95 结论，缺 identity、超噪声带回退或字段驱动结论不一致时保持 blocked/failed。这些 browserless summary 缺失或不满足预算时保持 blocked。真实浏览器的 speed 选择、basic 故障回退、transferable Worker 与 load/long-task 指标属于 diagnostics，只作独立可观测 evidence，不阻断或放行 correctness manifest。
- test-quality lint：`tools/ci/check-test-quality.mjs` 阻断无断言测试、HTTP 200-only 弱断言和关键路径 snapshot-only 测试。

`production-correctness`（以及兼容别名 `production`）可以证明 browserless PR/CI 风险矩阵没有已知阻断；`release-closeout` 可以证明当前 manifest 已收口；只有同时包含单 Browser Contract 的 `release-final` 可以作为发布候选通过的最终凭据。

---

## 测试洁净性约定

详见 `tests/backend/TESTING.md`。

核心约定：

1. **无状态污染**：每个集成测试用例使用独立的数据库事务，测试后回滚
2. **默认固定本地端口**：当前本地 acceptance/bootstrap 默认使用 3000/7568/8080/5432/6379 与固定容器名前缀，可通过环境变量覆盖；在 #51 的动态端口与 namespace 完全落地前，不保证同机多套 acceptance 并行
3. **无真实 IO 在单元测试中**：数据库、Redis、文件系统访问全部通过接口 Mock
4. **测试隔离**：`fast` 层测试不依赖任何运行中的服务
5. **失败即停**：CI 中任一层失败会阻断下游层；下游 skipped 会由 `production-summary` 归类为 downstream fan-out，不视为成功

---

## 关键测试场景矩阵

所有 API 变更必须覆盖以下场景：

| 场景 | 对应测试层 |
| ------ | ----------- |
| 匿名公开读（Binary / Wasm） | release, resilience |
| 作者资产库 admin-only 边界、重建、复用、孤儿清理 | fast, acceptance, resilience |
| 作者分析 dashboard、搜索关键词/来源路径/404 聚合、RUM ingestion/dashboard/隐私边界 | unit, acceptance, telemetry privacy |
| 登录用户写操作 | integration, acceptance, security |
| Admin 管理操作 | acceptance, security |
| Admin-only 私有预览、SEO/质量发布前检查、warning override 审计、匿名拒绝、feed/sitemap 不暴露 | unit, acceptance, security attack matrix |
| 评论待审队列、批量审核、误判恢复、封禁联动、公开只读 approved | unit, acceptance, security attack matrix |
| Markdown/frontmatter 单篇导出、全站内容包、导入恢复 revisions | unit, authoring restore smoke |
| OpenTelemetry trace/metrics/log correlation、OTLP 开关、无 PII tag 白名单 | unit, readiness smoke |
| WebSocket 实时推送 | integration, resilience |
| AOT 首屏 hydration | release, acceptance |
| Binary 错误帧 / 解码失败 | resilience |
| AEDS v1 拒绝 / v2 CRC16 / compact payload | fast, resilience |
| PoW 前置验证 | security |
| 会话并发吊销 | security |
| 零停机 rollout：匿名主页/归档/文章/搜索/static/Binary，登录/refresh/protected write，admin health/control，notification 1012/replay/full-resync/slow drain，上传，N/N-1 asset/SW，normal worker exactly-once | static-governance, acceptance, resilience, production |

## 单作者博客新增门禁

本轮单作者博客能力的窄门禁：

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter "FullyQualifiedName~ArticlePublicationTests|FullyQualifiedName~PublicAotDocumentComposerTests|FullyQualifiedName~SchemaMigrationRegistryTests|FullyQualifiedName~AuthoringWorkflowServiceTests"
cd src/frontend && npx vitest run --config vitest.config.ts ../../tests/frontend/unit/api/authoring.test.ts
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter "FullyQualifiedName~AuthoringWorkflowServiceTests|FullyQualifiedName~CommentServiceValidationTests"
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter "FullyQualifiedName~ObservabilityTests|FullyQualifiedName~ServiceCollectionExtensionsTests|FullyQualifiedName~ProductionHealthTests|FullyQualifiedName~ScheduledPublishWorkerTests|FullyQualifiedName~UnifiedCacheTests"
npm --prefix src/frontend run check:security:attack-matrix
npm --prefix src/frontend run check:acceptance:auth
npm --prefix src/frontend run check:acceptance:console
npm --prefix src/frontend run check:pwa-offline-policy
npm --prefix src/frontend run check:pwa-offline-smoke
npm --prefix src/frontend run check:subscription-privacy
npm --prefix src/frontend run check:subscription-smoke
npm --prefix src/frontend run check:public-distribution-contract
npm --prefix src/frontend run check:public-seo-smoke
npm --prefix src/frontend run check:distribution-version-coherence
npm --prefix src/frontend run check:telemetry-privacy
tools/operations/backup-restore-drill.sh
tools/operations/test-backup-restore-drill-fixture.sh
FSUSBLOG_SMOKE_DRY_RUN=1 tools/operations/post-deploy-smoke.sh
tools/operations/collect-release-evidence.sh
tools/operations/test-release-evidence-fixture.sh
tools/operations/cleanup-retention.sh
```

这些检查覆盖文章公开可见性、SEO discovery/JSON-LD、分发版本一致性、schema migration registry、OpenTelemetry collector 开关与无 PII tag 白名单、AI provider 默认关闭、PWA 私有路由不缓存、RUM 不采集私有页与敏感字段、备份/烟测/证据/保留期脚本。这里的 backup restore 与 post-deploy smoke dry-run 只验证脚本调度，会写入 `status=scheduled`，不能作为发布收口证据。完整发布必须回到 `./tools/test.sh production-correctness` 与 `./tools/test.sh coverage-gate`，再由 `./tools/test.sh release-final` 追加唯一 Browser Contract 并生成最终发布凭据；`./tools/test.sh production` 仅作兼容别名保留。

作者 AI 辅助的静态门禁为 `npm --prefix src/frontend run check:author-ai-assist`，覆盖 admin-only endpoint、actor audit、provider review config、编辑器接线和文档同步。后端行为由 `AuthoringWorkflowServiceTests` 覆盖默认 disabled 与 provider-enabled review-blocked 分支。

## Security domain 静态门禁

`node tools/security/check-security-domain-layout.mjs` 先聚合校验安全域目录、policy metadata、
ZK contract/provenance 分类与 hash bindings、静态 evidence classification、runtime selection 和
旧 flat path；`node tools/security/check-security-matrices.mjs` 再按 declarative catalog 校验六份
矩阵。聚焦回归为 `node --test tests/tools/issue-1170-security-domain-layout.test.mjs`。这些检查只证明
仓库契约自洽，不替代匿名、登录、admin、notification stream 和 binary 的运行时安全测试。

## Production correctness 风险清单

`production-correctness`（以及兼容别名 `production`）必须同时满足：

- 编译、类型检查、Vite build 均为 0 warning / 0 error。
- 所有运行时 API 响应均为 AEDS frame；错误、鉴权拒绝和异常兜底统一为 `ApiError`。
- Binary frame 必须为 AEDS v2，header 长度 16 字节；v1 frame 不允许被服务端、Worker 或 Wasm 接受。
- `/api/binary/**` 在公开读、匿名拒绝、admin 拒绝场景下状态与 AEDS error frame 一致。
- `check:distribution-version-coherence` 覆盖文章生命周期状态：draft、scheduled、archived 必须只在 admin 状态列表和 admin detail 可见，published 才能进入 public list/detail、feed、sitemap、related-reading、PublicAOT 与 search index；delete/restore/permanent-delete 继续验证回收站语义。
- `BlogDistributionArtifactTests` 使用真实 PostgreSQL 创建 55 篇公开文章和私有负例，解析最终 RSS/JSON Feed/sitemap XML，证明 Feed 保持 50、sitemap 全量、正文更新时间一致、空站不伪造当前时间、诊断计数来自产物，并用 45,001 URL fixture 验证 sitemap index/子文档容量边界。`PublicOriginPolicyTests` 与 lifecycle production case 覆盖配置、持久 SEO 和 artifact origin 冲突 fail-closed。
- `PublicAotDocumentServiceTests` 覆盖无摘要 Markdown 到纯文本、Unicode/entity/句子安全截断和不同页面 description；`PublicAotDocumentComposerTests` 覆盖页面 schema 类型、单一 `WebSite`、封面/回退图的 OG/Twitter/JSON-LD 一致与无 keywords；`articleDetailMetadata.test.ts` 覆盖可见发布时间、实质更新时间及无重复更新时间。分发测试继续证明 sitemap/Feed 使用相同的 `article_body.updated_at`，评论和浏览量变化不能改变它。
- PoW、MFA、Passkey、session refresh/revoke/logout、RBAC 权限矩阵均无绕过。
- 安全头、CORS、auth/PoW no-store、Cookie 安全属性、畸形 AEDS frame、notification stream 握手失败和攻击矩阵均无绕过。
- OWASP ZAP baseline 不得产生 FAIL 级告警；报告必须保留为发布门控 artifact。
- WebSocket 通知握手、匿名 PoW、重连 cursor、AOT hydration、搜索、上传和轻量并发 correctness 门控全部通过；视觉结果由独立 diagnostics receipt 陈述，不并入本清单。
- Markdown 代码高亮必须保持 Shiki 输出质量，但 highlighter 只能在实际代码块渲染时懒加载；`FSUSBLOG_VITE_WARN_AS_ERROR=1 npm --prefix src/frontend run build` 不允许出现 chunk size warning。
- 前端资源大小预算由 `npm --prefix src/frontend run check:asset-size-budget` 执行，默认限制客户端 `dist` 总量 80 MiB、单 JS 900 KiB、普通单 CSS 600 KiB、完整应用 CSS 680 KiB、单 Wasm 220 KiB，并输出 `.tmp/frontend/asset-size-budget.json`。

---

## 参见

- [development.md](development.md) — 本地环境搭建
- [operations.md](operations.md) — 发布门控与滚动更新
- `tests/backend/TESTING.md` — 洁净性约定完整版
- `tools/test.sh` — 测试入口脚本
