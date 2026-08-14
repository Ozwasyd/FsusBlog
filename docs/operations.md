# FsusBlog Operations Runbook

## Adaptive responsibility scheduling

Inspect `GET /api/ops/cluster/nodes` with an independent admin principal carrying
`system.config`. The `scheduler.unassigned` list means no current healthy,
network-reachable node advertises a required capability. `adaptive-reassigned` is
expected after node failure or a material post-cooldown score improvement;
rapid alternating owners indicates that membership inputs or policy thresholds need
repair.

The admin page `/user/manage/cluster` shows nodes, responsibility state, lease/checkpoint
summary, takeover events and cluster health. The JSON route intentionally omits checkpoint
payloads and network addresses.

For a local incident, call the protected node-state operation with `draining` and wait
for responsibility leases to release or expire; use `maintenance` while the node must
remain excluded, then `alive` after repair. Each mutation requires independent admin
`system.config`, fixed-IP limiting, trusted same-site origin and a one-use
`X-Fsus-Mfa-Proof`. To stop placement without restarting request-serving nodes, call the
scheduler operation with `enabled=false`; the next reconcile deactivates local leased
responsibilities while anonymous, login, admin, notification-stream and binary paths
remain available. Re-enable only after membership and capability coverage recover.

Never clear fencing counters or force another node to bypass a live lease. The expired
lease action is deliberately a no-op while the authoritative expiry is in the future;
Redis TTL may already have removed the lease before the action runs. A mode change back
to `single` is only for the next process generation.

## Module invocation degradation

`module_route_unavailable` means no healthy node currently advertises the required
capability; `module_backpressure` means the bounded remote-call budget is full; and
`module_circuit_open` means repeated remote failures opened the contract circuit.
Drain the unhealthy target or remove its active responsibility and let another healthy
node take the assignment. New requests recover after membership and capability health
return; the circuit probes again after its open interval, so request-serving nodes do
not need a restart. Durable queue consumers may be paused without discarding messages.
Do not bypass the owner contract, redirect writes to another module's tables, or switch
a running multi-node process to the in-memory `single` authority.

## Upload session expiration cleanup

Upload-session cleanup only enumerates the expiration-bucket index; it does not sweep every directory below the session root. If an old orphan is found, quarantine or remove that exact path through an operator-reviewed maintenance action and repair the missing index producer. The cleanup worker may be paused without restarting request-serving nodes, but the unbounded root sweep must not be restored. Production closeout keeps the release-cycle and read-only residual-scan evidence in `tests/evidence/backend/runtime-fallback-milestones.json`; absent external observations remain `deferred-unverified`.

## Release Gate

Before publishing a production image:

```bash
./tools/test.sh production-correctness
# Historical compatibility alias for the same browserless authority:
./tools/test.sh production
```

`production-correctness` is the browserless production-ci-gate; historical `production` depends only on that authority and remains a compatibility alias. It runs fast validation, static governance, frontend/backend unit/property/model checks, SSR/AOT/HTTP contracts, API/DB/cache integration, browserless security/resilience/load/backend-QPS checks, frontend render-structure checks, and release evidence schema validation. Its complete dependency closure installs no Playwright browser and starts no Chromium. In particular, it does not run legacy Acceptance, visual, cross-browser, UX viewport, or browser render-pressure suites. A passing production-ci-gate means no compile warnings, no TypeScript/Vite warnings, no browserless runtime console errors or warnings, no API/Binary/WebSocket/AOT contract drift, and no blocker security or workflow regressions in the encoded browserless risk matrix. It may still produce a schema-valid `collected-blocked` release evidence manifest while external production evidence is pending.

`browser-contract` is the only real-browser correctness tier. At the release boundary, and conditionally for `main` / `master` pushes or browser-boundary PRs, it consumes the immutable production build receipt and runs one managed Chromium with one controller/session, no shard, and no retry. `production-summary` and `release-evidence` do not wait for it. Scheduled/manual `browser-diagnostics` separately owns Acceptance, visual, UX viewport, cross-browser, renderer-pressure/performance, and browser-runtime resilience evidence; diagnostics failure remains visible but cannot be rewritten as either a production correctness pass or failure.

`release-closeout-gate` is separate and must run `tools/operations/check-release-evidence-manifest.mjs --require-ok` or `./tools/test.sh release-closeout`. Only `collected-ok` is a release credential.

The same browserless gate is enforced by GitHub Actions `Quality Gate` on pull requests, pushes to `main` / `master`, and manual dispatch. CI requires `GITHUB_PACKAGES_TOKEN` for the private `@ozwasyd` npm package. Ordinary correctness jobs do not install Playwright; the single Browser Contract fixes its worker/concurrency at one, while scheduled/manual diagnostics remain under their separate workflow and matrix policy.

## Coverage Gate

Coverage is enforced as a separate hard gate:

```bash
./tools/test.sh coverage-gate
```

This gate collects backend + frontend coverage, merges reports, and enforces both merged and backend-only thresholds. Frontend collection defaults its local Vitest thresholds to `0` so the artifact step cannot fail on files outside the curated gate denominator; the hard threshold is applied after merge. Current defaults are merged line/branch/method `35%/20%/30%` and backend line/branch/method `75%/55%/95%` for the scoped coverage set (overridable via `FSUSBLOG_COVERAGE_*` env vars).

If VSCode integrated terminal picks an older Node than expected, run:

```bash
bash ./tools/node/check-node24-env.sh 20
bash ./tools/node/fix-vscode-node24.sh 24
```

Then restart VSCode and rerun the gate.

On failure, collect:

- `.tmp/acceptance/*.log` for the shared browserless runtime bootstrap
- `.tmp/browser-contract/receipt.json` for the single correctness browser boundary
- `.tmp/browser-diagnostics/` and `src/frontend/test-results/playwright/` only for scheduled/manual diagnostics
- GitHub Actions `quality-gate-artifacts`

For Docker packaging and slot inspection:

```bash
export GITHUB_PACKAGES_TOKEN=...
./tools/deployment/slot-status.sh
./tools/deployment/slot-preflight.sh \
  --slot green \
  --release-manifest build/releases/<release-id>/release-manifest.json \
  --env-file .env.production
```

`slot-preflight.sh` 对 manifest 选中的精确 `repository@sha256:<64 lowercase hex>` 执行 fail-closed 镜像运行时契约。它先 pull 目标 digest，再 inspect OCI labels：`io.fsusblog.build.vcpkg-commit` 必须是完整 40 位小写 Git SHA，`io.fsusblog.runtime.node=required`、`io.fsusblog.runtime.npm=forbidden`；`profile-id`、catalog/profile digest、base family、RID、single-file、R2R、PGO、QuickJIT、Server GC、GC heap-count/hard-limit mode 与精确百分比、ThreadPool 与 topology labels 必须完整并受同一 profile digest 约束。R2R 可以由受控 startup profile 启用，不再被错误地全局固定为 false。随后 preflight 以临时容器执行 `command -v node`，并证明 `npm` 不存在。可变 tag、无效 digest、pull/inspect 失败、profile 漂移、musl/glibc 不匹配、Node 缺失或 npm 存在都会在 Compose candidate 启动前终止；持久化 active slot 不变，也不会启动 candidate。

Runtime profile qualification seals container-visible CPU/memory identity plus physical-core/SMT and NUMA topology. The executor must echo the observed target cpuset, not only the requested plan. Auto-balanced allocation changes with the named mode: physical-core placement chooses one thread per core; NUMA-local keeps the target in one observed node and the load generator disjoint. Hidden topology is explicitly `unavailable` with a reason, and a single visible NUMA node is `not-applicable`; neither state may be replaced with synthetic topology evidence. The runner classifies only `physical-core-only` or `numa-local` as hardware-unsupported, and only when the sealed topology proves the corresponding capability absent. Evidence v2 records the full required `catalogProfileIds`, the actually scheduled `profileIds`, and a bounded `unsupportedProfiles` reason; their union must exactly cover the catalog before status can become `complete`. Build, gate, measurement, timeout, cleanup, or executor failures remain failed attempts and can never be relabeled as unsupported.

单独诊断同一契约时使用 `bash tools/deployment/image-runtime-contract.sh '<repository>@sha256:<digest>'`。该命令会实际 pull/inspect/run 目标镜像，不是离线 Dockerfile 检查；失败后应重新构建并推送修正后的新 digest，再生成新 manifest，禁止用 tag 覆盖或跳过 preflight。

### Runtime/publish profile qualification

运行前先用 `check-runtime-publish-profiles.mjs` 验证 catalog。资格测试必须使用同一 commit、数据 fixture、目标机、cgroup/cpuset、代理/TLS、PostgreSQL 和 Redis 配置；load generator 与 target CPU 必须隔离。不要把跨机器结果拼成三轮，也不要把 acceptance 环境的 burst-derived ThreadPool minimum 当生产默认值。

矩阵 evidence 可以在中断后保留 `partial` checkpoint；继续时向同一参数集传 `--resume-from <evidence>`。resume 会核验 commit、fixture、hardware、profile manifest、catalog、硬件不支持清单、profile 顺序、轮数、cooldown 与完整 schedule，只跳过已经成功的 schedule key，并对缺失或失败 key 追加新 attempt。硬件能力变化后不得 resume 旧证据，必须在新 hardware identity 下重跑。`runs` 是不可删减的全量 attempt history：失败记录必须位于同 key 的最终成功之前；complete artifact 要求每个 schedule key 恰有一个最终成功，comparison 只汇总这些成功样本。只有 `check-runtime-publish-evidence.mjs` 在非 `--allow-partial` 模式通过的三轮 artifact 才能进入选型。完整运行必须传入站点 policy，且必须保留 `auto-balanced`：executor 从当前进程可见 cpuset/quota/memory 与 topology 动态分配 target/loadgen，并把 resolved CPU count、GC modes/percent、ThreadPool mode、topology mode 传给仓库 stage adapter。adapter 再调用 site plan 的 direct executable，并要求每个 stage 返回同一 identity 的结构化结果；build、gate、NativeAOT parity、fault/load fixture 与 measurement payload 均以 digest receipt 绑定。measurement 必须回读实际 cpuset/cgroup/runtime settings，并在 `resourceStress` 中给出 allocation burst、GC pressure、适用时的 OOM/recovery，以及 active/candidate/snapshot/SSR/other 精确相加的 blue/green memory breakdown。默认完整矩阵覆盖所有无 `conditionalAdmission` 且当前硬件可执行的必测 profile；`physical-core-only` / `numa-local` 只有在 sealed hardware 明确不支持时才进入 `unsupportedProfiles`。NativeAOT 仍单独跑 partial experiment并要求 feature/security parity。失败 profile 必须保留错误。选型记录同时引用 startup 与 steady-state conclusions、逐 route median/CV、pairwise/Pareto、variance/materiality、JIT/GC/LOH/ThreadPool/migration/IPC、power、resource stress 与 fault/recovery；startup-only profile 不得替换 throughput 默认。收集 release evidence 时，matrix 的完整 commit SHA、sealed selected profile 和两个非零 digest 必须与 release identity 一致。collector 会复制并计算 `runtimePublishMatrix` sha256；manifest checker 与 release-final 会重新读取 bundle 内的普通非 symlink 文件，任何缺失、路径逃逸、摘要漂移、错误 SHA、错误/零 profile digest 或未选型状态都 fail closed。

回退始终选择 registry 中仍保留的旧 profile immutable digest，并按正常 rollout 生成新的单调 generation。不要修改现有 image labels、manifest 或 mutable tag。若只撤销 evidence-derived ThreadPool minimum，恢复 `runtime-default` 的部署设置并重启对应 retained image；确认 ThreadPool queue/starvation、context switches、RSS 与 p99.9 恢复后再继续 rollout。

## Rollout

### 唯一入口与资源前提

生产发布、显式回滚和中断恢复都从 `tools/deployment/release-rollout.sh` 进入。除一次性空状态 bootstrap 与故障诊断外，不直接调用 `slot-start.sh`、`gateway-switch.sh` 或 `deploy-production.sh`。先运行 `slot-status.sh` 确认 durable state 为 `stable` 且 `activeStateConsistent=true`，再选择 CI 生成且 registry 仍保留的 immutable manifest。

零停机资格下限来自 `config/deployment/zero-downtime-resource-policy.json`：4 CPU cores、6144 MiB total memory、10240 MiB free disk。双槽合计预算是 360% CPU / 4608 MiB memory，临时磁盘 8192 MiB，并至少采集 10 个 overlap samples。2C/2G 只允许单槽运行，不能执行 overlap 或宣称零停机；`slot-preflight.sh` 的较低 pull/start guard 也不能替代这一资格门禁。

把 exactly one `Authorization: Bearer ...` 或 `Cookie: ...` header 保存到 root-readable mode-0400/0600 regular non-symlink file。认证 storage state 同样必须为 0400/0600；secret 不得进入命令行、证据、issue comment 或 shell trace。

```bash
export FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE=/run/fsus/deployment-admin-header
export FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN=https://fsus.blog
export FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL=https://fsus.blog/health/ready

./tools/deployment/release-rollout.sh \
  --rollout-id deploy-<release-id>-<unique-suffix> \
  --release-manifest build/releases/<release-id>/release-manifest.json \
  --env-file .env.production \
  --slot-state-file /var/lib/fsusblog/deployment/slots.json \
  --rollout-state-file /var/lib/fsusblog/deployment/rollouts/<rollout-id>/state.json \
  --evidence-root /var/lib/fsusblog/deployment/rollouts \
  --backup-restore-evidence .tmp/operations/backup-restore-drill.json \
  --migration-server-dll /app/FsusBlog.Server.dll \
  --production-build-receipt .tmp/ci-production-build/receipt.json \
  --traffic-scenario /run/fsus/release-traffic-scenario.json \
  --notification-auth-storage-state /run/fsus/notification-auth-state.json \
  --asset-compatibility-scenario /run/fsus/asset-compatibility-scenario.json \
  --worker-ledger /run/fsus/worker-normal-ledger.json \
  --fault-injection-evidence /run/fsus/fault-matrix.json \
  --public-url "$FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL" \
  --admin-header-file "$FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE" \
  --control-origin "$FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN" \
  --asset-store /var/lib/fsusblog/release-assets \
  --dry-run
```

Dry-run 必须显示 exact source/target release、digest、slot、generation、state path 和 ordered stages。确认后去掉 `--dry-run`，使用同一个全新 `rolloutId` 和相同输入运行；已存在 state 必须使用 `--resume`，不能覆盖。

### 15 阶段与断点恢复

完整顺序固定为：

`manifest-validate -> capacity-preflight -> backup-restore-gate -> expand-migration -> asset-materialize -> candidate-start -> candidate-readiness -> candidate-smoke -> compatibility-smoke -> gateway-switch -> source-drain -> active-fence -> public-verify -> source-stop -> release-evidence`

每次 attempt 的 command stdout/stderr、开始/结束时间、exit code、SHA-256 和 bytes 都写入 mode-0600 stage evidence。已成功阶段不可重复；失败阶段先进入 `recovery_required` 并执行 stage-specific compensation。安全关键 gate 没有 skip 参数。

宿主进程被 SIGTERM/SIGKILL 或异常退出后，先读取 state，不从头跑：

```bash
node tools/deployment/rollout-state.mjs read \
  --state /var/lib/fsusblog/deployment/rollouts/<rollout-id>/state.json

./tools/deployment/release-rollout.sh \
  --resume \
  --rollout-id <same-rollout-id> \
  --rollout-state-file /var/lib/fsusblog/deployment/rollouts/<rollout-id>/state.json \
  --release-manifest build/releases/<release-id>/release-manifest.json \
  <the-same-runtime-input-options>
```

Resume 会验证 manifest 与 durable target 一致，采用仍存活且 command line/path anchor 匹配的 probes，把没有终态 evidence 的 orphan running stage 封存为 interruption failure，再执行该阶段的明确 recovery。它只跳过有 sealed success evidence 的阶段。Terminal state、另一 rollout ID、另一 release/digest 或历史 pass artifact 均不能复用。

### 切流、fence、排空与存储

Gateway stage 使用 `--defer-source-drain`：先 CAS-activate target、atomic reload 并提交 traffic state，但保留 source 可恢复。随后 active-fence stage 用 release/slot/generation/digest 做 Redis CAS，revoke source，再 read-back target owner。所有 active-singleton worker 在领取 lease 后还必须在不可逆提交前执行 `IActiveReleaseCommitGuard.EnsureCurrentAsync`；旧 generation 即使仍在运行也不能提交 scheduled transition、outbox effect、crawler snapshot、cleanup delete、projection checkpoint、PublicAOT finalize 或 upload deletion。

Public verification 同时运行持续 12-class traffic、notification reconnect/replay、N/N-1 asset/Service Worker、resource budget probes。Source drain 先发送 1012 restart，再并行排空 HTTP、notification、background claims、article-view、hot-stats、audit/admin-audit、visit、RUM、security/challenge audit、public-hot、ArticleDetail AEDS、PublicAOT backfill 与 upload cleanup。任一 pending、timeout 或 error 都保留在 blockers，不能手写 success。

`asset-materialize` 在 candidate start 前验证 sealed CI receipt 的完整 schema、source/worktree、producer/toolchain、input、domain、path/size/SHA-256 与 seal，并在首次写 store 前要求 image-extracted source 与 receipt frontend domain 精确同集，再把 manifest-selected frontend/Wasm/font 文件写入 append-only `<asset-store>/releases/<releaseId>`；同路径不同 hash fail closed。它生成 inventory，要求 receipt frontend artifact、inventory 与实际 materialization 精确同集，并安装只读 `spa-manifest-descriptor.json` 与 `production-build-receipt.json`。Compose 和 `slot-start.sh` 只接受当前 release 下这两个 canonical authority 路径。`UseReleaseScopedStaticAssets` 在 SPA fallback 前服务 `/release-assets/<releaseId>/...` 与 `/release-derived/<releaseId>/...`，Production 缺 root setting 会拒绝启动。Applied GC 必须先持久化 retention state，保护 N-1 `retention-window`，再由 old-asset probe 于 GC 后复读所有旧 URL。Release-derived writers 只写自己的 release subtree，并通过 generation publisher 原子更新 pointer；不得 clear shared root 或另一个 release。

这里的运行时接线不能手工拆开：manifest 校验生成 `FSUSBLOG_RELEASE_ID`，主机侧 manifest 路径只暂存在 `FSUSBLOG_RELEASE_MANIFEST_HOST_PATH` 供 Compose 只读挂载；容器内固定读取 `FSUSBLOG_RELEASE_MANIFEST_PATH=/app/release-manifest.json`，并以 `FSUSBLOG_RELEASE_DERIVED_ROOT=/app/release-derived` 访问 shared derived volume。三者必须指向同一 release identity；不要把它们写死在 `.env.production`，也不要让容器读取另一个 manifest 或 derived root。

Comment mutation outbox 在 `/api/ops/health/ready-detail` 的 `runtime.commentMutationOutbox` 暴露 backlog、failed、poison、oldest age、累计 processed 与最近错误；`fsus.comment_outbox.*` 指标覆盖吞吐、失败、积压、最老延迟和死信。poison 非零会把 runtime readiness 标为 degraded。处置时可通过 reloadable 配置把 `CommentMutationOutbox:Enabled=false` 暂停新 claim（评论权威事务继续写 pending，不丢事件），修复依赖或 poison 根因后恢复为 `true`；不得删除 checkpoint 或把未知副作用手工标成 completed。完整步骤见 [`architecture/comment-mutation-outbox.md`](architecture/comment-mutation-outbox.md)。

### 强流量、资产 HMAC 与 migration qualification

唯一 rollout 入口必须同时取得两个独立私钥文件：

完整 `release-rollout.sh` invocation 除 manifest、migration、notification、worker、
resource 与 fault 参数外，必须包含以下四项（这里只列参数片段，不是第二个可执行入口）：

```text
--traffic-scenario /run/fsus/release-traffic-scenario.json
--traffic-binding-key-file /run/fsus/secrets/traffic-binding.key
--asset-compatibility-scenario /run/fsus/release-asset-browser-scenario.json
--asset-browser-binding-key-file /run/fsus/secrets/asset-browser-binding.key
```

两个 key 都必须是 0400/0600 regular non-symlink、32..4096 bytes，且不得与 admin
header、Cookie/storage-state 或彼此复用。traffic artifact 与 asset/browser artifact
分别由 dedicated verifier 进行 HMAC readback；`--resume` 不得因文件已存在就跳过验证。
key 错误或 evidence 漂移会阻断 closeout，但不要求重启应用：切流前保持 source，切流后
按 durable recovery 恢复 source gateway/fence，并使用新的单调 generation。

私有 rehearsal plan 的强字段为：

| 区域 | 字段 | 约束 |
| --- | --- | --- |
| traffic | `evidenceInputs.trafficBindingKey` | private key file，32..4096 bytes |
| asset | `evidenceInputs.assetBrowserBindingKey` | 独立 private key file，32..4096 bytes |
| migration binary | `target.migrationServerDll` | target manifest 对应的精确 Server DLL |
| migration scenario | `migrationQualification.scenarioTemplate` | 固定十场景模板 |
| migration timeout | `migrationQualification.timeoutSeconds` | 60..1800 |
| migration IDs | `expandMigrationId` / `backfillMigrationId` / `contractMigrationId` | safe immutable IDs |

rehearsal 自动物化并执行十场景：旧 Active + Expand、双槽并发读写、Backfill
pause/checkpoint/resume、missing Expand 503、回滚窗口拒绝 Contract、Contract 后不可回滚
marker、advisory-lock timeout、数据库断连、partial failure/resume、history checksum +
unknown record。repository adapter 只接受
`ASPNETCORE_ENVIRONMENT=Test` + `FSUSBLOG_ROLLOUT_REHEARSAL=1`；应用 bridge/readiness
route 还要求 `SchemaMigration:QualificationEnabled=true`、admin `system.config` 与
`fixed_ip`。生产配置保持 false。

### Normal 与 destructive qualification

正常 production rollout 只接受 worker reconciliation v2 `mode=normal`：八类 durable work、graceful drain、target exactly-once、zero stale-generation commit。Forced-source/SIGKILL 是独立 Test topology qualification，不得嵌入 normal source drain：

Dry-run 审核完成后，在真实 rollout 旁路启动 normal observer；它等待 durable state 到达 `candidate-start`，通过 loopback admin action 驱动/观察八类真实 pending，并在 `source-drain-gate.json` 通过后独占写出传给 rollout `--worker-ledger` 的账本。plan 的 `baseUrl` 必须是精确 loopback origin，admin header 仍只从 0400/0600 regular non-symlink file 读取：

```bash
node tools/deployment/release-worker-normal-observer.mjs \
  --plan /run/fsus/release-worker-normal-observer-plan.json \
  --rollout-state /var/lib/fsusblog/deployment/rollouts/<rollout-id>/state.json \
  --source-drain /var/lib/fsusblog/deployment/rollouts/<rollout-id>/evidence/source-drain-gate.json \
  --admin-header-file "$FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE" \
  --out /run/fsus/worker-normal-ledger.json \
  --run-id normal-<rollout-id> \
  --start-stage candidate-start \
  --timeout-ms 900000
```

Observer 的 start/status/finalize 响应必须绑定 rollout ID、source/target release/digest/slot/generation，显式 `destructive=false`，且保持精确有序八类事件；第九类 forced-source event、静态 pass JSON、qualification ledger、提前于 drain 的 final observation 和截断错误列表都会失败。

不要把上述 `release-worker-normal-observer.mjs` 与 `release-worker-observer-service.mjs` 混为一体。前者是正常 rollout 旁路观察器；后者只由 `zero-downtime-rehearsal.sh` 在隔离 `Test` 拓扑中按 deploy/rollback/resume、qualification、fault 和 SIGKILL/resume 阶段临时启动。演练脚本复制私有 `workers.observerEnvFile` 到 mode-0600 service root，以独立 process group 监听 loopback，并在成功、失败、中断恢复和 teardown 时停止该服务；提前退出或无法停止都会使演练失败。生产不得设置 `ASPNETCORE_ENVIRONMENT=Test`、`FSUSBLOG_ROLLOUT_REHEARSAL=1`、`FSUSBLOG_WORKER_OBSERVER_ENABLED=1` 或任何 `FSUSBLOG_WORKER_OBSERVER_*`，也不得把该服务注册成常驻 daemon。

```bash
tools/deployment/zero-downtime-rehearsal.sh \
  --plan /run/fsus/zero-downtime-rehearsal-plan.json \
  --mode all
```

Qualification 使用九类 ledger 和 file handshake，完成后 teardown；随后必须创建 fresh normal rollout，使用不同 rollout ID、相同 target release/digest。Qualification v2 hash-binds qualification control、ledger、resource policy、reconciliation 与 distinct normal state。不得在 production source container 上强杀，不得把 qualification ledger 当 normal ledger，也不得复用历史 state/evidence。

### Evidence bundle 与 closeout

Final evidence 只允许六类 artifact：`publicTraffic`、`notificationStream`、`assetCompatibility`、`workerReconciliation`、`resourceBudget`、`faultInjection`。它必须 seal 15 stages、全部 attempts 与 recoveries，随后 read-back verify。收集时设置：

```bash
export FSUSBLOG_RELEASE_ROLLOUT_EVIDENCE=/var/lib/fsusblog/deployment/rollouts/<rollout-id>/evidence/release-rollout.json
tools/operations/collect-release-evidence.sh
```

Collector 通过 `collect-release-rollout-bundle.mjs` 只复制 final evidence、15-stage command evidence、sealed recoveries 和六类 hash-bound artifacts，生成 `release-rollout-bundle/bundle-index.json`。需要单独导出时可运行：

```bash
node tools/operations/collect-release-rollout-bundle.mjs \
  --input "$FSUSBLOG_RELEASE_ROLLOUT_EVIDENCE" \
  --output /run/fsus/handoff/release-rollout-bundle
```

目标目录必须不存在；symlink、path escape、seal 后漂移、未引用文件或第七类 artifact 均失败。Release manifest 的 `evidenceSummary.operations.releaseRollout` 及 bundle semantic check 必须为 `ok`，但这仍不替代真实 DNS/firewall/live exposure 和 `--require-ok` closeout。

### 风险、无需重启回退与场景覆盖

- 切流前失败：source 保持 Active，停止 candidate；修复输入后以同 state resume，或在明确 terminal outcome 后使用新 rollout。
- 切流已激活但未 commit/未过 post-switch gates：恢复 source include，以新的单调 generation 重启/激活 source，并 CAS-drain target；无法证明两者时保留 `rollback_required`。
- Traffic 已 commit、source drain 失败：保持 target Active，阻断 closeout并处理旧 inactive source；不自动反向切流。
- Expand/Backfill：保留 N/N-1 bridge；Backfill 只暂停 durable token，不需要重启。Contract 执行前可停止命令；Contract 执行后只能隔离写路径并恢复 verified backup，不能靠 image rollback 重建数据。
- Asset/derived 异常：停止 applied GC、继续保护 N-1，重建当前 release generation；不得恢复 mutable `current` 路径或删除 active/previous release。

Traffic scenario 和 release acceptance 必须覆盖：匿名主页/归档/文章/搜索/static/Binary；登录、refresh、protected read 与 write；admin health/control；notification stream 1012 reconnect、cursor replay、replay miss full resync、slow-client drain；上传以及 AEDS Binary frame。部署 502/503/504、未标记 5xx、连接失败、timeout 和 aborted in-flight 都是发布错误；只有明确 `X-Fsus-Error-Class: business` 且 error code 在 scenario allowlist 中的业务 5xx 可单独分类。

## Comment Length Policy

评论长度由后台“匿名评论策略”统一控制，默认 `1000` 字符 / UTF-8 `4096` bytes。管理员可在 `/user/manage/moderation/anonymous-policy` 把上限提高到最多 `3000` 字符 / UTF-8 `12288` bytes；提交需要 admin-sensitive step-up，服务端会写高价值审计并触发现有 anonymous comment policy cache invalidation。

回退无需重启：把策略改回 `1000/4096` 后，新的公开署名和强匿名评论立即按该策略校验；已发布评论不做字符串截断，展示层仍按渲染高度默认折叠长评论。无论策略如何调整，评论 Markdown 禁用图片、raw HTML、危险链接、LaTeX 和 Mermaid 的安全边界不变，创建 frame 仍受 16 KiB payload 上限保护。

## Rights V3 Public Artifact Cutover

ArticleDetail AEDS embeds the Rights V3 snapshot and proof summary in the detail payload. Current writers emit `ARD4`/version 4 and the file store accepts both current V4 and read-compatible `ARD3`/version 3 artifacts; retired pre-envelope ArticleDetail files remain invalid compatibility inputs.

Use the full deployment runbook in [rights-v3-cutover-runbook.md](rights-v3-cutover-runbook.md) for backups, the exact no-compat order, verification, and operator checks. This section is only the short operational summary.

Use the admin cache action endpoint for the remaining cutover sequence:

1. Before candidate start, require the rollout's read-only compatibility check to prove the Rights V3 schema and legacy-artifact cleanup descriptors are already present in migration history. The automatic `expand-migration` stage runs only currently classified online Expand work; it does not replay the legacy Rights V3/cleanup descriptors. A pre-protocol database missing them must first complete the isolated legacy bootstrap/restore runbook and then enter the online protocol.
2. Run `recompute-article-rights` to replace migration sentinel hashes and create any missing latest-revision rights snapshot.
3. Run `rebuild-article-detail-aeds-v3` with no `articleId` to rebuild all public ArticleDetail artifacts in batches with bounded parallelism. Supplying `articleId` rebuilds one article.
4. Run the existing PublicAOT rebuild path after ArticleDetail artifacts have been rebuilt by the historically named action into current V4 output (with V3 read compatibility), so HTML/hydration inputs converge on the same rights payload.

Rollback is image and database-backup based. Do not roll back by re-enabling retired pre-envelope ArticleDetail reads or by adding a separate `/article/{id}/rights.aeds` endpoint; a partial rollback would let anonymous reads serve a payload shape that current V4/V3 decoders must reject.

## Daily Checks

- `docker ps` health status is healthy.
- `/health/ready` returns public minimal readiness JSON with `status=ready` and `checkedAt`. The public probe is served from a 5 second single-flight readiness snapshot so high-frequency orchestrator checks do not run PostgreSQL, Redis and RiskControl deep probes on every request; use `/api/ops/health/ready-detail?forceRefresh=true` when an operator needs an immediate deep refresh.
- `/api/ops/health/ready-detail` `checks.release` must equal the selected release manifest for `releaseId`, `releaseSlot`, full `commitSha`, `imageRef` and `imageDigest`. Any `release_identity_invalid` result blocks traffic; correct the manifest/environment binding or redeploy a retained digest, without changing a mutable tag in place.
- `/api/ops/health/ready-detail` runtime startup snapshot shows expected `schemaMigration` / `accountSubjectHashInvariant` / `searchIndex` / `cacheInitializer` / `aotDiskCache` / `bootstrapRollback` task states for the current rollout. The snapshot is sourced from `StartupRuntimeState.CreateSnapshot()` and is independent from PublicAOT/AEDS payloads. In production the resolved migration runner is read-only compatibility; verify its runtime result together with `OnlineSchemaCompatibilityRuntimeState` rather than treating the historical `non_compensable` task label as proof that a mutation ran. `accountSubjectHashInvariant` must report `physical_projection_complete` before candidate traffic is enabled; `cacheInitializer` reports either `no_entries` or the number of rollback entries it can restore. The same runtime block exposes `scheduledPublish` with `lastPublishedCount`, `lastFailedCount`, `dueBacklog` and `lastError`; non-zero failures mean due scheduled articles remain queued for the next worker tick and should be investigated before release closeout.
- `/api/ops/health/ready-detail` includes `observability` with service name/version, ActivitySource, Meter and whether OTLP export is enabled.
- `/api/ops/health/ready-detail` includes `riskControl` with active policy, last-known-good policy, Redis consume-once and challenge provider registry state. If this check fails, keep the candidate out of traffic; write-class challenge paths fail closed, while public-read degradation must follow the active policy rather than bypassing RiskControl.
- `/api/ops/health/ready-detail` includes `deployment` with release/slot/mode/state/generation, `canReceiveTraffic`, `canClaimBackgroundWork` and the drain snapshot. Any Candidate not exactly Ready, any Draining/Stopped/Failed state, or a generation mismatch blocks switch/closeout.
- Disk usage for Docker volumes and container logs is below alert thresholds.
- PostgreSQL connection usage leaves headroom for migrations and backups.
- Redis memory and eviction policy are within expected bounds.
- WebSocket binary notification stream connection count matches expected traffic and does not grow without release.

## Observability

OpenTelemetry is enabled in-process by default and uses `FsusBlog.Server` as the custom `ActivitySource` / `Meter`. ASP.NET Core, outgoing HTTP, runtime, Npgsql, WebSocket notification metrics, cache operations, PublicAOT render source, search rebuild/query and scheduled-publish worker timings are recorded with bounded `fsus.*` tags only.

The separately registered `FsusBlog.HttpTransport` meter adds `fsus.http.transport.request.count` with bounded `fsus.http.protocol` and `fsus.http.route_class` tags, plus one `fsus.http3.startup.count` sample with startup status and prerequisite fallback reason. H3 attempts and handshake failures that never produce an HTTP request are client-side signals; collect them with the local probe instead of inventing server request metrics. The probe also records H2/H3 p50/p95/p99, throughput, errors and process CPU/RSS. See `docs/testing/http3-local-equivalent-experiment.md`.

DI graph health is part of the same telemetry boundary. `/api/binary/author/ops/health` exposes the admin-only `dependency-graph` row, while `fsus.di.graph.registration_count`, `fsus.di.graph.captive_dependency_count` and `fsus.di.graph.opaque_factory_count` expose graph size and validation coverage. A non-zero captive count prevents a new candidate from building; do not bypass it. `di.scope` activities prove the begin/end boundary for instrumented hosted-service DbContext scopes. The safe rollback is to leave the current active slot serving traffic, fix the offending registration or scope ownership, and rebuild the candidate; changing a scoped service to singleton or disabling `ValidateScopes` is not an accepted recovery.

OTLP export is off by default. Enable it by setting either `Observability:ExporterEnabled=true` with `Observability:OtlpEndpoint=http://collector:4317`, or the standard `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable. Requests return `X-Fsus-Trace-Id`, and Serilog/audit request context uses the same trace identifier for log correlation. Do not add raw route parameters, request/response bodies, cookies, tokens, IP addresses, usernames or email addresses as OpenTelemetry attributes.

## SLO Alerts

Production SLO definitions are machine-readable in `config/observability/slo.yml`; `tools/operations/check-slo-definition.mjs` verifies availability, error-rate, p95/p99 latency, WebSocket reconnect success, AOT hit rate, search rebuild success and scheduled publish delay objectives before the release gate proceeds.

The release SLO fixture is executable:

```bash
tools/operations/check-slo-alert-fixture.mjs
```

It writes `.tmp/operations/slo-alert-fixture.json`. With no argument it uses an embedded synthetic incident and asserts that every required alert can fire. A production or CI fixture can be passed as the first argument; it should include `/api/ops/health/ready-detail` JSON, `notificationStream.slowDisconnectsLast5m`, security status report data, `security.authRefreshFamilyRevokeWindowsLast5m` from the bounded refresh-replay metric window, `security.authRefreshCookieWriteFailedLastMinute`, and optional thresholds such as `authRefreshCookieWriteFailedLastMinute`.

| Alert | Impact | Investigation entry | Rollback or degradation action |
| ------- | -------- | --------------------- | -------------------------------- |
| `ready_degraded` | Candidate traffic switch and release closeout are blocked. | `/health/ready` status, `/api/ops/health/ready-detail`, runtime startup tasks, scheduled publish snapshot, app logs. | Keep traffic away from the candidate image or switch back to the previous image tag. |
| `db_latency_high` | Cache misses, authoring writes, reads and migrations can stall behind PostgreSQL pressure. | `/api/ops/health/ready-detail` `checks.postgres.latencyMs`, DB concurrency gate snapshot, slow SQL logs, PostgreSQL connection usage. | Reduce public traffic, pause non-essential writes/background work, then rollback if latency started with the deploy. |
| `redis_latency_high` | L2 cache, WebSocket notification backlog replay and cache-control fanout can become slow or stale. | `/api/ops/health/ready-detail` `checks.redis.latencyMs`, Redis memory/eviction policy, network path and command latency. | Keep the app out of new traffic until Redis recovers; allow public fallback only after readiness is healthy. |
| `risk_control_not_ready` | Challenge enforcement can no longer prove active/LKG policy, provider registry or Redis one-time consumption. | `/api/ops/health/ready-detail` `checks.riskControl`, structured `security challenge * failed` logs, `fsus.security.*` metrics. | Keep traffic away from the candidate, restore policy snapshots/provider registration/Redis, and only re-enable write-class challenge paths after readiness is healthy. |
| `aot_backfill_failed` | Public pages may fall back from server AOT shells to SPA rendering and lose first-load performance. | `runtime.startup.tasks.aotDiskCache`, PublicAOT worker logs, AOT cache directory permissions, `aotBackfill.failuresLastHour` if exported by the collector. | Disable one-shot AOT cache cleanup, keep SPA fallback enabled, and rerun backfill after fixing renderer or filesystem failures. |
| `search_rebuild_failed` | Search results and distribution version coherence can be stale after article mutations or deployment. | `runtime.startup.tasks.searchIndex`, `search.rebuildFailuresLastHour`, search artifact directory and `SearchIndexService` logs. | Restore previous search artifacts or previous image, keep public reads online, and rebuild the index before closeout. |
| `notification_stream_disconnect_spike` | Notification streams can miss live updates and increase replay pressure for authenticated/admin clients. | `fsus.notification_stream.slow_disconnects`, `/api/ops/health/ready-detail` `runtime.notificationStreamConnections`, gateway websocket buffering and slow consumer logs. | Lower gateway traffic or reconnect pressure, preserve polling/fetch fallbacks, and revert gateway changes that introduced buffering. |
| `cache_registry_missing_scan` | Cache prefix invalidation has fallen back to Redis keyspace scan because registry membership is missing or stale. | `fsus.cache.operation.count` with `registry_missing_scan_recovered` / `registry_missing_scan_empty` / `registry_missing_scan_failed`, Redis `cache:registry:*` sets, `RemoveByPrefixAsync` warnings, cache governance catalog. | Treat repeated fallback as degraded cache-control behavior; rebuild registry through normal writes or clear the affected family during low traffic. Failed scans require Redis connectivity and ACL investigation before promotion. |
| `auth_refresh_family_revoke` | A stale refresh token reached an active ordinary-session family and the atomic replay guard revoked it. Any value above zero in the five-minute window is security-significant. | `fsus.auth.refresh.family_revoke_window_count`, `fsus.auth.refresh.family_revoke_count`, bounded auth audit categories and deployment/client retry timing. Never export refresh token, session id or device fingerprint values. | Do not disable family revoke. Block closeout, clear ordinary user sessions if replay is systemic, and keep independent admin principals, public reads and notification reconnect available during investigation. |
| `auth_refresh_cookie_write_failed` | More than the configured number of refresh rotations in one minute could not verify or stage their Cookie response. | `fsus.auth.refresh.cookie_write_failed_count`, process restarts, response aborts, PostgreSQL connectivity and the client single-retry outcome. Never export token, Cookie or session values. | Block promotion and drain the unhealthy instance through the gateway without restarting healthy instances. Keep family revoke enabled; ordinary clients may re-authenticate while public reads, independent admin access and notification reconnect remain available. |
| `public_hot_read_sensitive_bypass` | A sensitive API namespace reached the PublicHotRead early classifier boundary; the request still bypassed L0 and continued through the normal authentication/authorization pipeline. | `fsus.hotread.classifier.sensitive_bypass`, `public-hot-read-sensitive-prefix-bypass` warnings, production gateway sensitive-prefix locations. | Hot-reload `PublicHotRead:Enabled=false`, keep the normal endpoint pipeline online, inspect gateway/request routing, and re-enable only after the counter remains zero. |
| `public_hot_read_retiring_pressure` | A reader keeps one or more retired immutable snapshots alive, so a new publication exceeded the bytes budget or an explicitly configured count/deadline guard. | `fsus.public_hot.retiring.bytes`, `fsus.public_hot.retiring.evictions`, PublicHotRead lifecycle history and current snapshot version. | Pause snapshot rebuild/publication and let readers drain; if pressure persists, hot-reload `PublicHotRead:Enabled=false` so anonymous and binary reads use the normal cache/endpoint path. Do not delete live-reader tracking or restart healthy instances merely to hide the pressure. |
| `public_hot_read_sanity_fallback` | The active snapshot exceeded `MaxSnapshotAge`, a selected binary/HTML artifact failed its process-local HMAC, or a DB transition is still protected by a revocation fence, so L0 stopped serving untrusted bytes. | `fsus.hotread.sanity.fallback`, `public-hot-read-snapshot-update-failed` / `public-hot-read-snapshot-warmup-failed`, `public-mutation-fence-recovery-cycle-failed`, `public-mutation-fence-recovery-enqueue-failed`, active `TransitionPending` tombstones, advisory-lock owner state and update queue depth. | Keep the canonical endpoint path online for sanity fallbacks; active tombstones intentionally remain 410. Inspect DB/outbox/revocation convergence and let the scope-bound advisory-lock recovery prove the writer ended before rebuilding. Hot-reload `PublicHotRead:Enabled=false` if ordinary fallbacks persist, but never delete a tombstone, disable revocation, or raise `MaxSnapshotAge` merely to hide stale data. |
| `public_hot_delivery_obligation_failed` | A PublicHot rebuild exhausted bounded retry or reached a terminal failure, so readiness and release qualification are blocked while the last verified snapshot remains available. | `/api/ops/health/ready-detail` `publicHotRecovery`, the retained Redis obligation record and its bounded attempt evidence, target/published generations, failure kind and next eligibility. | Restore the failed dependency, then invoke the protected `public-hot-rebuild` action or restart the affected instance to replay the retained obligation. Do not delete or rewrite the obligation, mark a recovered attempt clean, or enable unbounded retry; hot-reload `PublicHotRead:Enabled=false` only when the canonical endpoint path is the intended no-restart degradation. |
| `public_aot_memory_cache_eviction` | The bounded Public AOT memory tier reached its dynamic or configured count/bytes/deadline; repeated evictions can increase file reads but do not remove disk artifacts. | `fsus.public_aot.memory_cache.evictions` by `fsus.reason`, `fsus.public_aot.memory_cache.resident_bytes`, container memory limit and AOT file-cache hit diagnostics. | Lower AOT memory limits to protect the process or raise them only within the container budget. The safe degradation is file-cache/SPA fallback; invalidation and disk artifact ownership remain enabled. |
| `security_blocker` | Production release is blocked by DAST, attack matrix, permission matrix or exposure evidence failures. | `.tmp/security/zap`, attack/permission matrix output, `.tmp/security/production-exposure-status.json` blockers. | Do not promote; keep the previous image and gateway config until every security blocker has passing evidence. |

## Backups

Use the site package script as the normal single-author backup entrypoint:

```bash
FSUSBLOG_BACKUP_RECIPIENT_FILE=/etc/fsusblog/backup-recipient.pem \
  tools/operations/backup-site.sh
```

The package includes PostgreSQL (`database.dump`), uploads, the already X.509-wrapped DataProtection keyring, redacted config, AOT cache and search artifacts. The only published output is a mode-0600 `.tar.gz.fsbenc` authenticated envelope (AES-256-GCM with RSA-OAEP-SHA256 key wrapping); the command never falls back to a plaintext archive. Set `FSUSBLOG_BACKUP_ROOT` to the production backup volume and keep the RSA public recipient outside that volume. The script accepts `FSUSBLOG_POSTGRES_URL`, `DATABASE_URL`, or `ConnectionStrings__DefaultConnection`; PostgreSQL values may use libpq URL style such as `postgresql://fsusblog:secret@db.internal:5432/fsusblog`, Npgsql style such as `Host=db.internal;Port=5432;Database=fsusblog;Username=fsusblog;Password=secret`, or libpq keyword style such as `host=db.internal port=5432 dbname=fsusblog user=fsusblog password=secret`. In the Npgsql form, `Username=`/`Password=` are database connection string keywords, not `Admin:Username`/`Admin:Password` application identity settings. The script redacts config keys matching secret/password/token/key/connection/string before packaging. Redis is a cache/control-plane dependency; restore uses a fresh empty Redis unless infrastructure policy provides a separate Redis persistence layer.

Restore is explicit and non-destructive unless `--confirm` is supplied:

```bash
FSUSBLOG_BACKUP_IDENTITY_FILE=/run/dr-identity/backup-identity.pem \
  tools/operations/restore-site.sh --backup backups/fsusblog-site-YYYYmmddTHHMMSSZ.tar.gz.fsbenc --dry-run
FSUSBLOG_BACKUP_IDENTITY_FILE=/run/dr-identity/backup-identity.pem \
  tools/operations/restore-site.sh --backup backups/fsusblog-site-YYYYmmddTHHMMSSZ.tar.gz.fsbenc --confirm
```

The restore script authenticates/decrypts before extraction, verifies the manifest recipient, all artifact digests, encrypted Data Protection XML and generation count, then restores PostgreSQL, uploads, keyring, AOT cache and search artifacts and writes a JSON report. The identity must be a mode-0600 regular non-symlink private PEM; it remains in the offline disaster-recovery secret domain. Sanitized config is extracted for operator review; secrets must be supplied from the target environment, not from the package.

Run a repeatable backup/restore rehearsal before treating the production closeout gate as complete:

```bash
tools/operations/backup-restore-drill.sh
```

By default the script runs in dry-run mode and writes `.tmp/operations/backup-restore-drill.json` with `status=scheduled`. That is useful for runbook rehearsal and exits successfully, but it is never a release closeout credential. A real drill must provide PostgreSQL, Redis, upload, AOT cache and search index backup paths, restore them into an isolated PostgreSQL/Redis/backend stack, then smoke anonymous public pages, admin login, Binary API, search and WebSocket notifications before recording RPO/RTO:

```bash
FSUSBLOG_DRILL_MODE=real \
FSUSBLOG_POSTGRES_BACKUP=backups/fsusblog-postgres.sql \
FSUSBLOG_REDIS_BACKUP=backups/fsusblog-redis.rdb \
FSUSBLOG_UPLOADS_BACKUP=backups/fsus-uploads.tar.gz \
FSUSBLOG_AOT_BACKUP=backups/fsus-aot-cache.tar.gz \
FSUSBLOG_SEARCH_BACKUP=backups/fsus-search.tar.gz \
  tools/operations/backup-restore-drill.sh
```

The real mode starts disposable restore containers, copies upload/AOT/search artifacts into an isolated webroot, starts a restored backend on `FSUSBLOG_DRILL_BACKEND_PORT` (default `5180`), verifies `/`, admin login, `/api/binary/article/list/home/1/5.aeds`, `/search/index.manifest.aeds` and WebSocket notification heartbeat, then removes the temporary stack unless `FSUSBLOG_DRILL_KEEP_WORK=1` is set. The drill also writes `backup-restore-manifest.json` with the allowed restore set, rebuild-required state and sanitize-before-restore classes, then runs the anonymous residue gate and writes `backup-restore-anonymous-residue.json`. The gate covers PostgreSQL legacy identity/raw-IP columns, Redis legacy user/session/cache keys, public search payloads, AOT/static artifacts, uploads manifests and the repository-wide historical residue checker. Any P0 residue blocks the drill; P1/P2 findings remain visible as warnings for release policy escalation. Release evidence requires `status=ok`, `mode=real`, concrete RPO/RTO values, all restore/smoke checks above, `anonymous-residue-gate:ok` and a clean residue report; a dry-run or partial drill keeps the manifest blocked.

Destructive schema Contract steps additionally use [`docs/schema-migrations/destructive-rollback-window-proofs.json`](schema-migrations/destructive-rollback-window-proofs.json). Before running Contract, confirm its registry inventory is current, the referenced commit has passed the 30-day window, N/N-1 qualification is green, and the quarterly backup/WAL/cross-region restore evidence is real rather than `scheduled`. An open window is not an override request: leave compatibility structures in place and retry after the window/evidence closes. See [the rollback-window runbook](schema-migrations/destructive-rollback-window.md).

When the source is a site package generated by `backup-site.sh`, pass it directly; the drill unpacks database/uploads/AOT/search and starts Redis with an empty data directory:

```bash
FSUSBLOG_DRILL_MODE=real \
FSUSBLOG_SITE_BACKUP_PACKAGE=backups/fsusblog-site-YYYYmmddTHHMMSSZ.tar.gz.fsbenc \
FSUSBLOG_BACKUP_IDENTITY_FILE=/run/dr-identity/backup-identity.pem \
  tools/operations/backup-restore-drill.sh
```

Site-package drills require at least two encrypted Data Protection generations so current/previous protector rollback remains demonstrable. Backup recipient rotation, identity retention and the no-restart failure path are defined in [Site Backup Envelope Encryption](security/site-backup-envelope.md); an envelope failure leaves the active runtime untouched and must be retried after custody/configuration repair.

The admin UI surfaces backup and drill status in `/user/manage/ops`; cache/AOT/search/sitemap status and manual rebuild controls live in `/user/manage/cache`; data drift checks, diff preview and safe fix application live in `/user/manage/integrity`.

Authoring-level content export is a lighter recovery path for editorial mistakes, not a replacement for database and upload backups. `GET /api/binary/author/articles/{articleId}/export` returns one Markdown document with frontmatter and base64url metadata; `GET /api/binary/author/content/export` returns a JSON package of all article exports. The metadata preserves category id, tag ids, cover URL, article status, scheduled publish time and revision records. Restore through `POST /api/binary/author/articles/import`; use `publish=false,preserveRevisions=true` for parity restores, or `publish=true` only when intentionally bringing the restored article online immediately.

## Migration Recovery

Before a production migration, create a site package and keep the package path with the deployment note. Production `serve` resolves `ServeSchemaCompatibilityRunner` and performs a read-only compatibility check; it must not acquire the migration advisory lock, create control tables or execute a descriptor. The rollout's `expand-migration` stage is the only automatic mutation and invokes `run-online-migrations.sh --phase expand` before candidate start. Backfill is an explicit resumable control-plane command. Contract is never selected by startup or candidate rollout and requires its own evidence plus separate `--confirm-destructive`. Large table migrations must include a batch plan, post-migration data check, and restore command in the release note. The minimal local preflight for migration-sensitive work is:

```bash
dotnet build src/backend/FsusBlog.Server.csproj --no-restore
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore
tools/operations/backup-restore-drill.sh
```

Legacy PostgreSQL upgrades from the 2026-05-17 profile are documented in `docs/database-migration.md`. When a real legacy dump is available, run:

```bash
FSUS_LEGACY_20260517_DUMP_GZ=.tmp/db_blog_20260517000000fjyfe.sql.gz \
  tools/db/verify-legacy-upgrade-20260517.sh
```

The verifier restores the dump into the schema migration integration test container, runs `SchemaMigrationRunner.RunAsync()` twice, and checks content, messaging, visit-log, refresh-token cleanup, length alignment and migration-history idempotency.

Online changes follow [Online Database Migration Protocol](online-database-migration.md) and [Online Migration Operations](online-database-migration-operations.md). Expand remains compatible with N/N-1 and rolls back by keeping the additive schema. Backfill pauses at its durable token without restarting the web process. Before Contract, stop the explicit command and keep the bridge; after destructive Contract, code rollback cannot recreate removed data, so isolate the affected write path and restore the verified backup into an isolated database before selecting a compatible release/database pair. Never edit migration history or progress rows to force readiness.

### Retired runtime fallback milestones

The operator evidence map for upload-session root sweep, subscription HMAC cutover, article-content finalize, plain-cookie read removal, AOT sidecar hash, and one-time artifact-clear migration is `tests/evidence/backend/runtime-fallback-milestones.json`. Each item links its focused runtime test and records external release/migration/count observations separately from repository facts. The current rules live in this runbook, `docs/security.md`, `docs/database-migration.md`, and `docs/architecture/public-aot-artifact-storage-boundary.md`; no issue-level summary or per-pass release note is an authority.

Run the focused retirement owner during unified validation, but keep absent production observations `deferred-unverified`. No local source scan or historical GitHub claim may stand in for current release IDs, migration-history rows, exact database counts, or deployed-control absence. Roll back by selecting the previous compatible image/database pair or pausing the affected external action; do not restore any retired request-time fallback.

`/user/manage/integrity` is the post-migration drift check for article bodies/revisions, taxonomy references, comment chains, sessions and assets. Do not mark a migration complete while it reports unresolved error-severity checks unless the sealed release evidence documents the accepted manual repair.

## Supply Chain

Run the baseline dependency and build-chain scan before promotion:

```bash
tools/security/check-supply-chain-audit.sh
tools/security/generate-sbom.sh
```

The supply-chain script verifies npm and NuGet lock files, runs `dotnet list package --vulnerable --include-transitive`, runs production `npm audit --omit=dev --audit-level=high`, and checks documented security-sensitive backend dependency versions. The SBOM and audit summary are copied into release evidence when available.

## Author AI Assist

Author AI assist is an admin-only authoring tool and stays local by default. The endpoint writes `author-ai-assist` audit records and returns provider state to the editor so the author can see whether suggestions came from local fallback or an explicitly reviewed provider path.

| Setting | Required value for external provider |
| --------- | -------------------------------------- |
| `Authoring:AiAssist:Enabled` | `true` |
| `Authoring:AiAssist:Provider` | non-`local` provider id |
| `Authoring:AiAssist:AllowExternalProvider` | `true` |
| `Authoring:AiAssist:ExternalProviderReviewed` | `true` |

If any switch is absent, the response remains `externalProviderAllowed=false` and no unpublished draft content is sent outside the server process. A release that enables a real external provider must include security review evidence and an audit smoke showing the actor id, operation, provider mode and external-allowed flag in the audit payload.

## Post Deploy Smoke

After deployment, run the smoke runbook against the release preview or production URL:

```bash
FSUSBLOG_SMOKE_BASE_URL=https://fsus.blog tools/operations/post-deploy-smoke.sh
```

The smoke records automated `verifiedCoverage` for anonymous public pages, feeds, sitemap, robots and health probes. It also carries a `manualChecklist` for admin login, Binary API, notification stream, upload and Passkey/MFA follow-up, but checklist entries do not count as automated coverage. Use `FSUSBLOG_SMOKE_DRY_RUN=1` for local documentation-only verification; it writes `status=scheduled` with a `dry-run` blocker. Real release evidence must come from the deployed endpoint with `status=ok`, `dryRun=false`, no blockers and all required automated coverage present.

## Release Evidence

测试证据先按 `correctness`、`browser-contract` 与 `diagnostic` 分层。普通 PR 和 `production-correctness` 必须保持零浏览器。九个 release logical domain 各自生成独立 projection receipt；`release-final` 额外消费一个 source/build/digest 绑定的 Browser Contract receipt，并只从其中精确的七份 correctness projection receipt 读取历史发布断言。RBAC negative 与 AOT consumption 两份独立 diagnostic projection receipt 不是 target-only closeout evidence，也不能改变 Production Summary。所有 projection consumer 均不回读 producer artifact 或执行 fallback。nightly/manual diagnostics 使用独立 receipt、artifact 与 retention。浏览器安装/launch/crash/disconnect、runner OOM/PID/FD exhaustion 和 fixture/bootstrap failure 记为 `infra-failure`，不能伪装成产品断言，也不能通过整套自动重试变成 clean pass。release-domain 集合与回执边界见 [`testing/release-domain-projection-ledger.md`](testing/release-domain-projection-ledger.md)，操作与回退顺序见 [`testing/issue-1151-evidence-governance.md`](testing/issue-1151-evidence-governance.md)。

Collect machine-readable release evidence after gates and smoke:

```bash
tools/operations/collect-release-evidence.sh
```

The collector writes `.tmp/release-evidence/<release-identity>/manifest.json` and copies available security, operations, coverage, doc sync and gate-log evidence. With `FSUSBLOG_RELEASE_ID`, a full commit SHA and an image digest, the namespace binds all three identities; a timestamp-only namespace is a blocked diagnostic fallback, not a publishable release credential. Set `FSUSBLOG_RELEASE_MANIFEST`, `FSUSBLOG_RELEASE_ID`, `FSUSBLOG_RELEASE_SLOT`, `FSUSBLOG_RELEASE_ENVIRONMENT` (defaults to `production`), `FSUSBLOG_COMMIT_SHA`, `FSUSBLOG_IMAGE_REF`, `FSUSBLOG_IMAGE_DIGEST`, `FSUSBLOG_RUNTIME_MATRIX_EVIDENCE` and the three `FSUSBLOG_RUNTIME_PROFILE_*` identity values from the deployed manifest before collection. The collector embeds the validated manifest plus runtime slot as `releaseIdentity`; the sealed v2 manifest records the target environment and derives target topology from that slot and the selected runtime profile. A missing field or release/commit/ref/digest mismatch keeps `evidenceSummary.image.releaseIdentityStatus` failed and the evidence `collected-blocked`. The manifest status is `collected-ok` only when required evidence is valid; otherwise it is `collected-blocked` and `evidenceSummary` records which evidence is missing, scheduled or blocked. `collected-blocked` is schema-valid for production-ci-gate diagnostics, but it is not publishable; a missing runtime matrix is additionally rejected by the semantic checker rather than accepted as a complete blocked bundle. The collector and manifest checker semantically parse critical evidence instead of trusting file presence: release identity must match the outer commit and image digest, the sealed runtime matrix must match the release commit/profile and its collected sha256, backup restore must be a real drill, post-deploy smoke must not be dry-run, authenticated DAST must execute an active scan, Wasm fuzz must run at least one seed, fault injection cases must be injected, and short soak must report positive duration, sample count and p95. Production closeout remains fail-closed: DNS delegation/readiness, firewall policy and live exposure must come from the real production environment before production exposure closeout can close, and release-closeout-gate must run with `--require-ok`.

The manifest is also the security evidence index for the release. It records DAST/ZAP output, `attack-matrix.json`, `permission-matrix.json`, production exposure status, production exposure request, firewall policy evidence, DNS readiness, DNS delegation and live exposure evidence. `evidenceSummary.externalExposure.valid=false` is a valid release-blocking artifact state, not a promotion signal. `evidenceSummary.externalExposure.request` summarizes the request package status, blocker count, current blocker sources, next action sources, unblock plan sources/count, required hosts, delegation domains, required evidence keys, firewall source sha256 requirements, handoff check count, verification command names/count, returned closeout command count and closeout command fields so operators can triage from the manifest before opening the full request JSON. `artifactDigests` records sha256 digests for copied production exposure artifacts so a handed-off bundle can be checked without trusting the current working tree; firewall policy evidence also carries `evidenceSource.sourceSha256` for the raw cloud or UFW export used to generate the normalized policy. If an artifact is absent, its digest must also be `null`. Missing external evidence is represented as `null` in `securityEvidenceIndex` while the blocker detail remains in `production-exposure-status.json`; do not replace that with synthetic passing firewall or DNS data.

Evidence levels are intentionally split:

| Evidence | Level | Gate |
| --- | --- | --- |
| coverage summary, ZAP, authenticated DAST, Wasm fuzz, attack matrix, permission matrix, supply-chain audit, SBOM, load result, fault injection, short soak | CI/release-depth forced | `tools/test.sh production` and `tools/operations/check-release-evidence-manifest.mjs` |
| image digest, post-deploy smoke, real backup restore drill, SLO alert replay, DNS readiness/delegation, firewall policy, live exposure | release closeout | `tools/operations/collect-release-evidence.sh` records `collected-blocked` until real evidence is present |
| retention cleanup | scheduled drill | `.github/workflows/daily-operations-checks.yml` plus release evidence copy when a release run provides the artifacts |
| historical raw-IP lifecycle | monthly production-audit drill | `.github/workflows/monthly-ip-anonymization-scan.yml` plus a passing `fsusblog.ip-anonymization-report.v1` artifact |

When `tools/security/complete-production-exposure-closeout.sh` fails, it still writes `.tmp/security/production-exposure-evidence-request.json`, tries to refresh later DNS readiness/live evidence, writes `.tmp/security/production-exposure-status.json` when possible, refreshes the request package with `currentStatus`, `nextActions` and `unblockPlan`, and leaves the closeout status blocked. The request package includes the direct closeout command plus returned-evidence and returned-handoff closeout commands so an operator can continue from either a filled `returned-evidence/` directory or a returned handoff tarball. `unblockPlan` groups every blocker source with the blocker count, exact expected artifact names, evidence file paths and commands needed to produce or verify that source. Run `tools/security/write-production-exposure-evidence-request.sh` before handoff when you only need the request package without live probing. Run `tools/operations/collect-release-evidence.sh` after a failed closeout attempt to preserve that request, the blocked status, and the DNS readiness/delegation, live exposure and firewall evidence files that were available.

Run `tools/security/check-production-exposure-handoff.sh <manifest.json>` before sending the evidence bundle outside the repo. This verifies the request, status report and manifest request summary are aligned across status, blocker count, blocker sources, required hosts, delegation domains, next actions, unblock plan sources/count, required evidence keys/count, firewall source sha256 requirement flags, handoff check count, verification command names/count, returned closeout command count and closeout command fields. It also verifies the request includes `requiredEvidence`, `verificationCommands` and `handoffChecks` for direct closeout, returned evidence verification, returned evidence closeout, returned handoff closeout, release evidence collection and handoff verification; checks that `unblockPlan` covers every blocker source with artifact names, commands and blocker counts; checks that the manifest bundle contains copied request/status/live/DNS/firewall artifacts under the standard in-bundle file names; checks that those files match the configured source files when the source files exist; checks that each copied artifact matches its manifest sha256 digest; and rejects request paths that point at temporary self-test evidence.

To hand the blocked production exposure state to an external operator, export the already-verified release manifest as a self-contained handoff directory and archive:

```bash
tools/security/export-production-exposure-handoff-bundle.sh .tmp/release-evidence/<release-identity>/manifest.json
```

The exporter runs the handoff checker first, copies the release evidence directory, writes `handoff-summary.json`, writes `operator-checklist.json`, writes `returned-evidence/expected-evidence-manifest.json`, writes `SHA256SUMS`, self-checks the generated directory, then creates `.tmp/security/production-exposure-handoff/<timestamp>.tar.gz` plus a tarball checksum and self-checks the archive before reporting success. The summary preserves blockers, unblock plan, next actions, required evidence, verification commands, returned closeout command coverage and firewall source sha256 requirements; the operator checklist preserves the same blocker-source checklist, returned artifact names and closeout commands in a short machine-readable file for external operators; the returned-evidence manifest records source manifest/request sha256 metadata, the exact standard filenames, required hosts, delegation domains and returned-evidence subset of the unblock plan the operator must satisfy. Verify the exported directory before sending it out:

```bash
tools/security/check-production-exposure-handoff-bundle.sh .tmp/security/production-exposure-handoff/<timestamp>
```

The bundle checker accepts either the exported directory or the `.tar.gz` archive, verifies the archive `.sha256` by digest so the archive can be moved with its checksum file, verifies `SHA256SUMS`, checks the copied release manifest artifact digests against bundled files, and rejects unsafe archive member paths, unsupported archive entry types, symlinks, and any handoff summary, operator checklist, README or returned-evidence manifest whose unblock plan, required hosts, delegation domains, standard evidence filenames or closeout commands no longer match the request and handoff summary. It is still a blocked handoff artifact until real DNS/firewall/live evidence makes `complete-production-exposure-closeout.sh` pass.

When an operator returns the standard evidence files, validate that returned directory before attempting production closeout:

```bash
tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>
```

The returned directory can be the bundle's `returned-evidence/` directory after the operator fills in the real JSON artifacts. It must contain `production-firewall-policy.json`, `production-dns-readiness.json`, `production-dns-delegation.json` and `production-exposure-live.json`. The verifier derives the current production host/domain scope from `FSUSBLOG_LIVE_HOSTS` or the production env source, validates `expected-evidence-manifest.json` when present, rejects any returned request or expected manifest that narrows that scope, and rejects an expected manifest whose source metadata or returned `unblockPlan` sources/count, evidence keys, evidence file basenames, artifact names or commands no longer match the required returned file set. It then points the existing firewall, DNS, live evidence and status reporter at that directory. It refreshes `production-exposure-status.json` and `production-exposure-evidence-request.json` in place, collects a release evidence manifest for the returned files, and runs the handoff checker against that manifest. It exits non-zero while the returned evidence is still blocked, but leaves the status, request and manifest artifacts behind for the next handoff cycle.

After returned evidence validates as `ok`, complete production closeout from that same returned directory or from a returned handoff bundle:

```bash
tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>
tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>
```

Both closeout commands require `expected-evidence-manifest.json`, rerun returned evidence verification, then invoke the normal production closeout verifier against the returned live evidence and status report. The direct returned-evidence closeout also detects when the provided directory is `returned-evidence/` inside a full handoff bundle and preflights that parent bundle before it verifies returned files. The handoff-bundle command accepts either the whole handoff directory or a returned `.tar.gz` with adjacent `.sha256`, verifies the full bundle first when release evidence, `SHA256SUMS` or `handoff-summary.json` are present, locates `returned-evidence/`, requires the expected evidence manifest, and then delegates to the returned-evidence closeout. That full-bundle preflight catches rewritten release evidence, summary, operator checklist, README and expected manifest metadata before any returned file can complete production closeout, regardless of whether the operator passes the whole bundle or only its `returned-evidence/` directory. They refuse to report success while the returned status is blocked. If a returned tarball fails after extraction, the wrapper preserves the extracted evidence under `.tmp/security/production-exposure-returned-handoff/` by default so the blocked status/request artifacts can be inspected after the temporary extraction directory is removed.

## Retention Cleanup

Use dry-run cleanup to verify retention behavior before deleting local artifacts:

```bash
tools/operations/cleanup-retention.sh
```

The retention script records intended cleanup for release/security evidence, coverage, upload sessions and historical AOT/search files. Runtime `LogCleanupService` separately enforces database retention for visit logs, RUM metrics, ordinary audit logs, and `anonymous_credential_issuance_audit` rows older than 90 days. It must not delete article-referenced assets or the only copy of audit/security evidence required by the current release. `/api/binary/author/assets/orphans` still removes only zero-reference `asset_library_item` projection rows. Physical files under `/uploads/illustration/` are handled separately by `ArticleAssetCleanupWorker`: current articles, server drafts and retained revisions are recorded in `article_asset_reference`; an asset receives a 24-hour queue grace period only after all source rows disappear, and the consumer rebuilds and rechecks references under a per-URL advisory lock immediately before its idempotent local delete. See `docs/architecture/article-asset-reference-lifecycle.md`.

Upload asset file deletion is opt-in and guarded. Set `FSUSBLOG_RETENTION_SCAN_UPLOAD_ASSETS=1` only with a non-empty `FSUSBLOG_RETENTION_REFERENCED_ASSETS` file containing `/uploads/illustration/*` URLs; referenced files are counted as `assetGuard.protectedReferencedAssets` and are never deleted. The fixture test `tools/operations/test-retention-cleanup-fixture.sh` proves an old referenced asset survives while an old unreferenced fixture asset is removed.

When rotating `Moderation:RegionPolicy:IpHashKey`, old `comment_region_compliance.submit_ip_hash` values cannot be recomputed because raw IPs are not stored. Run `tools/security/rotate-region-ip-hash-pepper.sh` after deploying the new pepper to invalidate old hashes. The tool defaults to dry-run and requires `FSUSBLOG_CONFIRM_REGION_IP_HASH_ROTATION=INVALIDATE_OLD_REGION_IP_HASHES`; set `FSUSBLOG_REGION_IP_HASH_ROTATION_DRY_RUN=0` only after checking the row count.

## Disk Hygiene

- Serilog file logs are retained by app settings.
- Docker stdout/stderr logs are rotated by compose `json-file` options.
- AOT cache is a named volume; clean it during maintenance only after confirming public fallback still works.
- Do not commit `.env`, logs, coverage, Playwright outputs, local probes, or temporary build spillover.

## Incident Recovery

- JWT rotation mismatch: stop traffic promotion and route traffic back to the prepared previous blue/green slot; do not restart it or enable key try-all. Confirm current/previous `kid` coverage and bounded deadlines with [JWT signing-key rotation](security/jwt-key-rotation.md), then redeploy the candidate and repeat cross-slot ordinary/admin probes.

- App fails liveness: inspect container logs, then restart the app container.
- App fails readiness only: inspect `/api/ops/health/ready-detail` to distinguish DB, Redis, config, or resource failure.
- DB pressure: lower public traffic at the gateway, check DB concurrency gate detail, and inspect slow SQL logs.
- Redis outage: keep the app isolated from new traffic until readiness returns; public hot paths may degrade without L2 cache.
- WebSocket pressure: inspect readiness runtime detail and logs for slow consumer disconnects.

## PerceptionCharacterV3 stop and recovery

正式切换只能由 `release-rollout.sh` 在 `source-drain` 的 active-release fence 内调用
`invoke-perception-character-v3-cutover.mjs`。输入必须是当前构建生成的
`perception-character-v3-release-target.json`、candidate 实际加载的 immutable pool
`manifest.json` 与当前 RiskControl `PolicyVersion`；禁止手工调用 endpoint、分步开放 marker，
或复用通用 challenge-kind operation id。命令先写 mode 0600 receipt，再要求
`status=activated`；同一 operation id 重试只读取 durable mutation/receipt。receipt 只含数量、
digest 与 release/slot/generation/contract/schema/policy/pool 绑定，不含 challenge ID、answer、
token、media、IP、device 或 user material。

1. 热更新 `Security:PerceptionCharacterV3:Resources:AllocationsEnabled=false`，并从 RiskControl policy 移除 `perceptionCharacterV3`；前者让下一次 planner decision 立即按 action disposition queue/fail closed，后者停止新的 ordered assignment，均无需重启。
2. 对 active envelope 调用 binary cancel/revocation；确认 audit 中 terminal state 为 `revoked`，不要删除 Redis key 或重置 attempts。
3. renderer/Redis/crypto 故障时保持公开 `unavailable`，不得切到退休 challenge、JSON 或本地进程内 attempt state。
4. key ring 故障使用独立 V3 token/answer ring 的上一有效 version 修正 secret 后滚动重启。两个 ring 的任何 key material 都不得相等；未知旧 version 的 active token保持 fail closed。

切换后的无重启回退只有上述 allocation disable 与移除 V3 policy 两种路径；不得恢复旧 pool
generation、旧 parser/codec/state reader、旧前端资产或旧 contract feature flag。active fence、
receipt、marker、pool 或 policy 任一不一致时保持 V3 closed，其他明确配置的 challenge kind、
authentication、admin、notification stream 与 binary API 继续按各自策略运行。

恢复 allocation 前检查 active generation 的 visual/audio/total ready、watermark、leased/burned、revocation/corruption、minute/rolling-hour lease 与 exact-byte egress budget；不要通过删除 operation fence、burn marker 或 budget key制造“可用容量”。离线补充只在低于 high watermark、无 CPU/memory/I/O/latency pressure 时按单次 entries/bytes 上限执行，失败的 staging generation 不得替换 active generation。

部署 resource-planner candidate 前必须用当前离线 builder 生成带 additive `artifactBytes` 的 manifest v1 generation，并让 candidate 指向该 generation；旧 runtime 会忽略 additive 字段，因此仍可回切。candidate 不接受缺少 exact-byte metadata 的旧 generation，不能用 ciphertext length 或上线后解码估算补齐。

匿名 device authority 的 Redis keys 与 challenge state 同属 fail-closed 基础设施；不要只清理 device lease 或 IP→device 映射中的一侧。cookie 丢失时同一 pseudonymous IP 复用权威租约，伪造 UUID 不会自动创建新 bucket。spoken atlas 由 embedded JSON 提供，startup 完整性失败时不得回退到 runtime TTS、Morse、索引音调或 V2 audio。

spoken atlas 的可复现输入是 `perception-character-v3-spoken-atlas-source.json` 与仓库内 `tests/fixtures/security/perception-character-v3-spoken-atlas-source-wav/*.wav`：逐 symbol 固定 SSML、spoken label、eSpeak source-WAV hash、resampled PCM hash/length；独立 golden 文件再绑定 source manifest 与最终 atlas 的 SHA-256。常规验收执行 `node tools/contracts/generate-perception-character-v3-spoken-atlas.mjs --check`，完全离线读取受控 WAV，重新 trim/resample 并逐层比对 PCM 与最终 atlas，不要求本机安装 TTS。只有明确更新权威语音源时才使用 eSpeak NG **1.51** 执行 `--regenerate-source --espeak-ng <path>`；脚本固定 `-m -v en-us -s 135 -p 45 -a 150` 并重写 WAV/source/output/golden，随后必须审阅所有 binary/hash 变化。

本地验收先运行 `tools/test/perception-character-v3-redis-fixture.sh`，它使用一次性 Redis 7 container 验证并发 correct/incorrect、两次上限、replay、expiry、revoke、binding substitution 与 unavailable fail-closed；随后运行 targeted backend suite 和 protocol vector generator `--check`。
## Host-local Production capacity reservation

FsusBlog 与同主机上的 FsusUI Production run 必须配置同一个
`FSUS_PRODUCTION_CAPACITY_AUTHORITY_ROOT`。该目录必须位于各 repository、`.tmp`、run output、
build root 和 cache holding root 之外，并由当前操作账号独占。authority unavailable、journal
digest 不符、owner identity 不完整或 filesystem identity 不明确时，不得先清理现场再重试。

恢复 unfinished reservation 时核验 PID start identity、executable/command digest、run/candidate、
repository lease以及完整 process tree/Windows Job Object。owner 已终止但仍有 descendant 时继续
阻塞；只有完整 tree 零残留时才能原子归档为 aborted。不得按 PID、进程名或 mtime 猜测回收。

容量故障不需要重启应用：停止当前 Production Fresh，保留 checkpoint、logs、partial evidence
和 host-local failure/release receipt，补充主机容量或修正 authoritative estimator，然后用新
run ID 执行。禁止删除历史 evidence/cache、启动 GC 或扩大 reservation 来延续已经发生
external-capacity-loss / estimator-under-declared 的 run。
