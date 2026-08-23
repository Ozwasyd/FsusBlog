# FsusBlog Production Deployment

## Topology

Production is a single-host Docker VPS deployment with two fixed application slots:

- `fsus-app-blue` / Compose project `fsusblog-blue`: complete ASP.NET Core + frontend + AEDS notification stream + Node SSR runtime on `127.0.0.1:8081`.
- `fsus-app-green` / Compose project `fsusblog-green`: the same monolith on `127.0.0.1:8082` with an independent release identity.
- PostgreSQL: external service reachable from the Docker network.
- Redis: external service reachable from the Docker network.
- Host Nginx/OpenResty: TLS, HTTP/2, request size policy, and reverse proxy to exactly one active loopback slot. Atomic gateway switching is handled separately from slot startup.

The app container owns only application runtime state. Persistent state is kept in PostgreSQL, Redis, and Docker volumes:

- shared `${FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME}`: migrated durable storage mounted at `/app/storage` (`FSUSBLOG_SHARED_STORAGE_ROOT=/app/storage/shared` → `PublicAssetRoot`/`PrivateAssetRoot`; instance temps under `/app/storage/instances`)
- shared `${FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME}`: DataProtection keyring under `/app/data-protection/keyring`; both slots keep `ApplicationName=FsusBlog`
- slot-local `fsusblog-aot-cache-{blue|green}`: public AOT shell cache under `/app/wwwroot/aot-cache`
- slot-local `fsusblog-logs-{blue|green}`: rolling Serilog files under `/app/Logs`
- slot-local `fsusblog-data-{blue|green}`: derived runtime data and fallback files under `/app/data`
- shared `${FSUSBLOG_SHARED_RELEASE_DERIVED_VOLUME}` mounted at `/app/release-derived`: release-id-scoped `public-aot`、`public-hot`、`search`、`ssr`、`precompressed` 与 generated manifest generations
- host append-only `${FSUSBLOG_RELEASE_ASSET_STORE}/releases` mounted read-only at `/app/release-assets`: one immutable child per release for frontend、Wasm、font 与 Service Worker compatibility

## Backend coverage evidence

Production Fresh 的 backend test partitions 只保留 Coverlet JSON 作为 canonical raw coverage。每个 partition 同目录的 `coverage.identity.json` 绑定 run ID、source commit/fingerprint、raw SHA-256、module 和 normalized source universe；`.tmp/coverage/backend/production/universe.json` 是本轮 expected shard 清单。缺 shard、重复目录、错 run/source、错 module/source 或损坏 raw 都必须在 merge 前 fail closed。

合并后 `.tmp/coverage/backend-merged/coverage.json` 是权威结果；`coverage.cobertura.xml` 与 `Summary.json` 只从该内存中的 merged result 各生成一次。coverage threshold、changed-code coverage 和 release-final evidence 读取同一 `Summary.json`，不能回退到任一 shard 的 Cobertura 或重新合并附件。`migration-evidence.json` 记录迁移前后 coverage bytes、attachment 数、parse count 和 merge CPU；这些数值只用于优化观察，不是 correctness 或固定时间门禁。

不重启降级路径是停止当前验收轮次、保留全部 raw shard evidence 并切回上一已验证 commit 重新运行 Fresh；不得在运行中跳过 sidecar/universe 校验，也不得用旧 Summary 冒充当前 source 的 evidence。该 coverage 工具链不修改应用 runtime、API、鉴权、notification stream 或 binary transport。

## Production Fresh 磁盘 admission

Production Fresh 在获取 repository exclusive lease 后，先从
`config/testing/production-disk-demand.json` 解析 selected physical DAG 的磁盘需求。需求按
canonical filesystem identity 合并，不按路径重复使用 free bytes；run output、production
build、OS temp、Docker storage/volume 和本轮 dependency-cache growth 必须全部可解析。Docker
volume 或 filesystem identity 不可确认时 fail closed。

host-local reservation authority 位于 repository `.tmp`、run output、build root 与 cache holding
root 之外。receipt 绑定 run/candidate、repository lease owner、完整 process start/command
identity、plan digest 和 producer declaration digest。同一 filesystem 上的并发 Production run
先扣除已有 active reservation；PID 存在、mtime 变旧或未来 GC 可释放空间都不能回收或抵扣
reservation。

reservation seal 之前不得终止 runtime/container、删除 output/checkpoint/log、迁移 cache、创建
build root、启动 managed GC 或 physical producer。每个 producer 启动前重新检查 live headroom；
external capacity loss 或实际增长超过声明会停止后续 admission、终止本轮 process tree并保留
partial evidence。success、failure、timeout 与 cancel 都必须写 release receipt；释放失败使本轮
不合格。`--plan-only` 只打印 demand plan，不获取 reservation或执行 mutation。

不重启回退路径是停止当前 Fresh、封存 failure/release receipt并保留旧 evidence；修正容量或
estimator declaration 后用新 run ID 重跑。不得通过删除历史 evidence、cache 或临时启动 GC
让失败中的同一 run 续命。

PostgreSQL, Redis, uploads, DataProtection and the read-only ZK host mounts are controlled shared inputs. Release-derived output may share one volume only because every writer is confined to its immutable `releaseId` subtree and publishes multi-file generations through staging + atomic pointer replacement; deleting the shared root or another release is forbidden. Instance temp/runtime/log state stays slot-local. Materialized assets are append-only and are served as `/release-assets/<releaseId>/...`; derived output is served as `/release-derived/<releaseId>/...`. `UseReleaseScopedStaticAssets` registers `UseFsusReleaseAssets` and `UseFsusReleaseDerivedArtifacts` before the generic SPA fallback, and Production startup fails when either root setting is missing. This serving boundary does not prove that a release was materialized or retained: rollout compatibility, applied GC and N/N-1 probes must still gate closeout independently. Neither slot publishes a wildcard/public host port.

The generic static middleware and the Release SPA template locator bind directly to the configured physical `WebRootPath`. This keeps `index.html`, its hashed assets, local Release acceptance and container runtime readers on the same root as mutable search-index writers even when the host environment is named Development; a source-tree dist or source-first static-web-assets composite provider must never shadow or cross-version a newly published bundle, `index.bin` or `index.manifest.aeds`. Explicit source-template preference remains a development-only path.

Before the first dual-slot start after the asset-topology cutover, stop writes, run `node tools/storage/migrate-public-assets.mjs --confirm-stop-writes --source <legacy-illustration-dir> --public-root <PublicAssetRoot>`, verify the inventory report, then set `FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME` to the migrated durable volume name. The Compose file has no fallback volume name and no `/app/wwwroot/uploads` mount; startup fails closed when the legacy WebRoot uploads directory still contains entries. Create the DataProtection shared volume once, copy the current keyring into it while the old instance is quiescent, and set `FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME` to that exact name. Confirm the key files are present from a read-only temporary mount before starting either slot. Set `FSUSBLOG_RELEASE_ASSET_STORE` to the durable host append-only store and retain N-1 for the declared compatibility window; configure `FSUSBLOG_SHARED_RELEASE_DERIVED_VOLUME` without reusing a slot-local volume name. Never initialize an empty keyring or clear asset/derived roots during overlap, because existing sessions, old frontends and rollback releases must remain readable.

Runtime fallback retirement is tracked as six independent, fail-closed milestones rather than inferred from source deletion. The executable owner and truthful external-evidence state are recorded in `tests/backend/runtime-fallback-evidence.json` and `tests/backend/runtime-fallback-milestones.json`; each item points to its current operations, security, migration or Public AOT authority and to a narrowly retained historical release note. Production closeout must attach the exact release/migration/count evidence required by each milestone. A missing observation remains `deferred-unverified` and must not be converted into a pass from an old issue comment, a local test, or the absence of a legacy symbol.

Release identity and container storage paths are runtime wiring, not static values in `.env.production`. `slot-start.sh` passes the selected manifest to `deploy-production.sh`; validation derives `FSUSBLOG_RELEASE_ID` from that manifest and exposes its host path only through the transient `FSUSBLOG_RELEASE_MANIFEST_HOST_PATH`. Compose mounts that exact file read-only at `/app/release-manifest.json`, sets `FSUSBLOG_RELEASE_MANIFEST_PATH=/app/release-manifest.json`, and sets `FSUSBLOG_RELEASE_DERIVED_ROOT=/app/release-derived` over `${FSUSBLOG_SHARED_RELEASE_DERIVED_VOLUME}`. Do not override those three container values in the private env file: the release ID, mounted manifest and `<releaseId>` derived subtree must remain one identity.

## Required Configuration

Copy `.env.production.example` to a private `.env.production` and replace every `CHANGE_ME` value. Configuration precedence is `src/backend/appsettings.json` < `src/backend/appsettings.Production.json` < environment variables supplied by `.env.production`/Compose < command-line arguments. Keep real secrets outside tracked JSON and example files; the existing fail-closed startup validation remains authoritative.

Required variables:

- `EXTERNAL_DB_HOST`
- `EXTERNAL_REDIS_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `REDIS_PASSWORD`
- `Jwt__SecretKey`
- `Jwt__KeyVersion`
- `Jwt__RotationWindowDays`
- `FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1`
- `FSUSBLOG_ZK_PROD_ENABLED=true`
- `FSUSBLOG_ZK_CONFIG_DIR`
- `FSUSBLOG_ZK_SECRET_DIR`
- `FSUSBLOG_ZK_NATIVE_VERIFIER_LIB=managed:mcl`
- `FSUSBLOG_ZK_VERIFYING_KEY_HASH`
- `FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST`
- `FSUSBLOG_ZK_VERIFYING_KEY_MANIFEST`
- `FSUSBLOG_ZK_GROTH16_VERIFYING_KEY`
- `FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_ID`
- `FSUSBLOG_ZK_ISSUER_PUBLIC_KEY`
- `FSUSBLOG_ZK_ISSUER_PRIVATE_KEY`
- `FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH`
- `SITE_BASEURL`
- `CORS_ALLOWED_HOSTS`
- `APP_ALLOWED_HOSTS`
- `FIDO2_SERVER_DOMAIN`
- `REVERSE_PROXY_KNOWN_PROXIES` or `REVERSE_PROXY_KNOWN_NETWORKS`
- `FSUSBLOG_RELEASE_ASSET_STORE`
- `FSUSBLOG_SHARED_RELEASE_DERIVED_VOLUME`

Production validation rejects default JWT secrets, missing/development JWT key versions, duplicate or weak previous keys, rotation deadlines outside `Jwt__RotationWindowDays`, placeholder secrets, empty Redis passwords, missing or disabled `FSUSBLOG_ANONYMOUS_IDENTITY_MODE`, HTTP CORS origins, non-HTTPS `SITE_BASEURL`, wildcard `AllowedHosts`, and missing reverse-proxy trust configuration. Use the two-phase blue/green procedure in [JWT signing-key rotation](security/jwt-key-rotation.md); an old token without `kid` is accepted only when an explicit bounded migration deadline is configured. The production compose file defaults `FSUSBLOG_ANONYMOUS_IDENTITY_MODE` to `1` and `FSUSBLOG_ZK_PROD_ENABLED` to `true`; keep both explicit in the private env file for auditability. ZK-Prod stays fail-closed until real trusted setup manifests, verifying key, issuer keys, root bootstrap evidence, and release smoke evidence are present. Image/Wasm artifact creation has a separate build-time gate, `FSUSBLOG_ZK_PRODUCTION_ENABLED=0` by default: false setup readiness omits prover key outputs without weakening runtime readiness, while `=1` accepts only fully hash-bound v5/layout6 ceremony inputs and fails before compilation otherwise. Retired circuit-specific key material cannot be supplied as a build argument or restored by repository tooling. Invalid production validation marks `/health/ready` as `503`; operators can inspect the detailed degraded state through `/api/ops/health/ready-detail`.

The legacy-named `VisitLog__IpPseudonymization__CurrentEpoch` / `CurrentKey` ring remains required only for security-log callers during migration; aggregate read analytics does not create or persist an IP pseudonym. `HumanReadProof__Dedup__CurrentKey` remains the independent read-proof root: domain-separated derivation produces only a one-minute rate-limit partition and a 15-minute article/site dedup token. Do not put root material in compose YAML, image layers, process arguments, release evidence, or backup config snapshots.

`SITE_BASEURL` is projected into `Seo__BaseUrl` by the production compose file and is the authoritative public origin. Startup compares it with the persisted `Seo_BaseUrl` value and rejects a non-placeholder mismatch as `public_origin_conflict` before AOT/search initialization. Release smoke must compare AOT canonical/OG/JSON-LD, every sitemap location, robots `Sitemap:`, RSS/Atom links, and JSON Feed home/self/item URLs against that one origin. For a no-restart incident fallback, keep the application slot drained and make the edge proxy serve/normalize Feed and sitemap from the last verified same-origin artifacts; never rewrite only one distribution surface to another origin. Correct the environment/persisted value, then start and validate a replacement slot before activation.

`FSUSBLOG_ALLOW_INSECURE_STARTUP=true` is a local diagnostics escape hatch only. It must not be used for normal deployment and cannot bypass security-critical validation failures for JWT secrets, wildcard `AllowedHosts`, missing reverse-proxy trust, or HTTP production origins.

DataProtection keys are persisted by default under `FSUSBLOG_DATA_ROOT/data-protection-keys`; override with `DataProtection:KeyRingPath` or `FSUSBLOG_DATA_PROTECTION_KEY_RING` when running multiple instances or using a mounted secrets volume. Keep `DataProtection:ApplicationName=FsusBlog` consistent across rolling deployments so protected MFA/session payloads remain readable during restart and rollout windows.

Set `FSUSBLOG_BACKUP_ROOT` to a persistent backup volume and mount an RSA public key as `FSUSBLOG_BACKUP_RECIPIENT_FILE`. `tools/operations/backup-site.sh` writes only authenticated `.tar.gz.fsbenc` site packages there; it fails closed instead of emitting plaintext when recipient validation, encrypted key-ring inspection or envelope encryption fails. The matching mode-0600 private `FSUSBLOG_BACKUP_IDENTITY_FILE` belongs only in the offline disaster-recovery secret domain, never the application/shared-data/backup volume. `/user/manage/ops` reports the latest database/uploads/DataProtection/config/package/drill artifact status. Keep `FSUSBLOG_DATA_ROOT`, uploads, AOT cache and search artifact paths stable across image rollouts so restore packages can be replayed on a new host without path guessing.

Rotate backup recipients only after a new-recipient package and isolated restore drill pass; retain every previous identity until all packages encrypted for it expire. A site-package drill must restore at least current+previous encrypted Data Protection generations and prove the corresponding PFX custody window. Backup failure does not require an application restart: keep the active slot/ring/database unchanged, repair recipient or identity custody, then retry in isolation. See [Site Backup Envelope Encryption](security/site-backup-envelope.md).

## Capacity Certification

生产容量不能从 localhost smoke、BenchmarkDotNet mean、CDN 命中或代理缓存命中推导。
发布物只有在 `.tmp/perf/release-summaries/performance-saturation-v2.json` 通过
`fsusblog.performance-saturation.v2` 验证后，才能声明 route-specific safe operating RPS。
缺少报告不是隐式通过；release evidence 将容量状态记录为 `blocked`。

生产 topology 的负载必须从独立压力机发起，并为压力机与服务进程配置不重叠的 CPU
affinity；校验器会展开 Linux cpuset ranges，`0-7` 与 `4-11` 也会因实际重叠而拒绝，而不只
比较字符串是否相同。identity 文件必须绑定 full commit SHA、不可变 image digest、CPU/核心/SMT/微码、
内核/libc/container runtime、cgroup quota/memory/cpuset、完整 `DOTNET_*` 环境摘要、
OpenResty/TLS 配置摘要、PostgreSQL/Redis 版本与配置摘要、fixture 数据规模、压力机身份和
网络路径。Kestrel-only 使用同一发布物与 fixture，但绕过代理/TLS 的机制基线必须写入独立
topology，不能覆盖生产结论。

示例开放环采样命令如下；真实 rates 必须逐级跨过拐点，不能把示例数字当作生产默认值：

```bash
node tools/perf/run-open-loop-load.mjs \
  --url https://fsus.blog/api/binary/article/hot/5.aeds \
  --route-id article-hot \
  --topology production-topology \
  --header 'Accept: application/octet-stream' \
  --header 'Accept-Encoding: br' \
  --rates 500,1000,1500,2000 \
  --duration-ms 60000 \
  --repeats 3 \
  --output /evidence/load/article-hot-production.json
```

在完全相同的时间窗口采集 `perf stat`/eBPF、.NET runtime counters、cgroup、socket/FD、
Npgsql pool、Redis command latency 与 `pg_stat_statements`，写成
`fsusblog.saturation-system-metrics.v2` 后使用
`tools/perf/merge-saturation-measurement.mjs` 合并。任一采集器不可用时保留原因并让对应
scenario blocked；不得填零冒充采集成功。只有资源达到策略定义的饱和区间、队列在 safe
point 不增长、p99/p99.9 与错误/超时率通过、压力机未饱和且多轮方差通过时，报告才输出
`limitingResource`、`saturationPointRps` 与带余量的 `safeOperatingRps`。

回退不需要重启应用：容量报告只控制发布证据和运营上限，不改变请求路径。报告异常、过期
或与当前 image 不匹配时，删除/隔离该 evidence，并恢复到上一个已验证发布物的 route-specific
限流值；在新报告通过前保持容量状态 `blocked`，不要从旧硬件结果外推。

## Build And Deploy

```bash
export GITHUB_PACKAGES_TOKEN=...
FSUSBLOG_FINAL_PUSH=1 \
FSUSBLOG_FINAL_IMAGE_REPOSITORY=ghcr.io/example/fsusblogapp \
  ./tools/build-final-image.sh

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

Build and production deploy are deliberately separate. `tools/build-final-image.sh` requires exactly one explicit mode: `FSUSBLOG_FINAL_PUSH=1` builds `imageRepository:<release-id>`, pushes it, resolves the registry digest and atomically creates `build/releases/<release-id>/release-manifest.json`; the same release path cannot be overwritten. `FSUSBLOG_FINAL_LOCAL_ONLY=1` builds a local diagnostic/performance image and never emits a deployable manifest. Production rejects `latest`, `final-current`, an untagged repository, a missing registry digest, or a tag that is not exactly `imageRepository:releaseId`.

The release manifest schema is `fsusblog.release-manifest.v2`. The build captures one canonical identity snapshot at startup and passes its exact `releaseId`, full `commitSha` and `createdAtUtc` to the Docker tag/build arguments, OCI version/revision/created labels, frontend build ID, .NET publish metadata and manifest writer. V2 rejects any cross-field mismatch: `releaseId` must equal `UTC14(createdAtUtc)-commitSha[0..12]`, `imageTag` must equal `imageRepository:releaseId`, and `imageRef` must equal `imageRepository@imageDigest`. It also binds the frontend Vite manifest hash, Wasm `SHA256SUMS` hash, repository-local ZK review manifest hash, schema compatibility min/max release, .NET/Node/Docker versions and Dockerfile digest. It contains no credentials. CI retains this file with the image; deployment rejects a host-side ZK review manifest whose hash differs from the immutable release, and image retention must keep every manifest-selected rollback digest for the configured rollback window.

New builds and the atomic writer accept only V2; they never upgrade or rewrite an old file. `fsusblog.release-manifest.v1` is available only through `readLegacyReleaseManifestV1` or `check-release-manifest.mjs --legacy-rollback true` for an explicitly selected existing N-1 rollback artifact. This compatibility path is marked `legacy` and `rollbackOnly`, is not a release/build input, and must be removed after every V1 N-1 artifact has expired from the supported rollback window. During that window an operator can select the retained immutable V1 digest without restarting or rewriting the manifest; any attempt to use it through the normal V2 reader fails closed.

`tools/deployment/release-rollout.sh` is the only supported production rollout entry. Run the exact command first with `--dry-run`, review its immutable source/target identity and ordered plan, then rerun without `--dry-run` using the same new `rolloutId` and paths. It owns the host lock and 15 durable stages: `manifest-validate`、`capacity-preflight`、`backup-restore-gate`、`expand-migration`、`asset-materialize`、`candidate-start`、`candidate-readiness`、`candidate-smoke`、`compatibility-smoke`、`gateway-switch`、`source-drain`、`active-fence`、`public-verify`、`source-stop`、`release-evidence`. `asset-materialize` validates the exact sealed CI receipt, writes the append-only release tree, and installs the immutable descriptor and retained receipt before Compose starts the candidate. Each attempt records mode-0600 stdout/stderr metadata and SHA-256-bound stage evidence. There is no safety-gate skip flag. A switching rollout must provide `--challenge-kind-target-map <json>` (or `FSUSBLOG_CHALLENGE_KIND_CUTOVER_TARGET_MAP`) plus `--perception-v3-release-target <json>`、`--perception-v3-pool-manifest <json>` and `--perception-v3-policy-version <id>` (or their `FSUSBLOG_PERCEPTION_V3_*` equivalents). After the provisional gateway switch, `source-drain` closes source issuance and waits for all in-flight work before acquiring the exact target authorization fence required by the endpoint. It then durably marks the irreversible boundary, calls the generic retired-kind cleanup and the one-shot V3 cutover with distinct rollout-stable operation IDs, writes mode-0600 receipts, runs their semantic verifiers, and binds backend, frontend AOT, V3 contract/schema/pool/policy and static assets to the same target identity. The later `active-fence` stage verifies those completed prerequisites, revokes source ownership and durably marks rollout activation; therefore cleanup is complete before activation. Drain/fence failures before the destructive marker may roll back. Once marked, recovery is only `resume-release-activation-same-cutover`: target remains selected, old source rollback is forbidden, and a lost local receipt is recovered with the same backend operation ID.

`slot-start.sh`、`gateway-switch.sh`、`deploy-production.sh`、online Expand、asset materialize/GC and fence/restart helpers are rollout-owned internal operations. `deploy-production.sh` rejects calls without the internal slot marker; `slot-start.sh` accepts the rollout marker or the explicit one-time empty-state bootstrap only. Direct helper commands in later sections are diagnosis/bootstrap protocol references, not an alternative production release procedure. The lower-level deploy validates and starts only the manifest-selected `repository@sha256` image, checks RepoDigests and OCI revision/version labels, and uses Compose `--no-build --pull always`.

Before any candidate Compose start, `slot-preflight.sh` calls `tools/deployment/image-runtime-contract.sh` with that exact immutable image reference. The helper rejects mutable tags and malformed or non-lowercase digests before invoking Docker, then pulls the selected digest, inspects its OCI labels and runs two container probes. A valid final image must publish a full 40-character lowercase `io.fsusblog.build.vcpkg-commit`, `io.fsusblog.runtime.node=required`, `io.fsusblog.runtime.npm=forbidden`, and the complete named runtime-profile label set described below; profile values must match the immutable release manifest. `node` must resolve inside the final image and `npm` must not. Pull/inspect failure, any label/profile mismatch, missing Node or present npm fails preflight before candidate start and leaves the persisted active slot untouched. Recovery is a newly built and pushed immutable digest plus a new manifest; there is no runtime override or skip flag.

If the host or orchestrator dies, do not start a new rollout and do not rerun from stage one. Inspect the recorded state and resume the same identity:

```bash
./tools/deployment/release-rollout.sh \
  --resume \
  --rollout-id <same-rollout-id> \
  --rollout-state-file /var/lib/fsusblog/deployment/rollouts/<rollout-id>/state.json \
  --release-manifest build/releases/<release-id>/release-manifest.json \
  <the-same-runtime-input-options>
```

`--resume` adopts matching live probes, turns an orphaned running stage into immutable interruption evidence, completes only a stage whose sealed evidence proves success, performs the stage-specific recovery, and skips already completed stages. A terminal or identity-mismatched state is never reusable; start a new rollout ID only after the previous state reaches an explicit terminal outcome.

The slot entrypoint starts every production container with `FSUSBLOG_DEPLOYMENT_MODE=candidate` and a positive generation derived from durable slot state, then waits for that slot's direct `/health/live` and `/health/ready` probes before atomically recording success. A ready candidate is not active: it reports `canReceiveTraffic=false`, cannot claim global background work and rejects notification stream handshakes until the host performs an exact release/slot/generation activation. Candidate deploy, identity or probe failure removes only the candidate Compose project and never runs a command against the persisted active project. Repeating start with the same healthy manifest returns `already-running`; repeating stop for an absent inactive slot returns `already-stopped`. `slot-stop.sh` always rejects the persisted active slot.

Slot state defaults to `/var/lib/fsusblog/deployment/slots.json` (override with `FSUSBLOG_SLOT_STATE_FILE`). It records `activeSlot`, each slot's release ID/digest/project/container/loopback endpoint/last successful start/deployment generation, a top-level monotonic `runtimeGeneration`, and the last start/stop/switch/rollback result. Runtime generation reservation is fsynced before Compose start and is never reused after a failed attempt; it is distinct from traffic `switchGeneration`. Writes use a mode-0600 temporary file, file `fsync`, atomic rename and directory `fsync`. After a host or Docker restart, run `slot-status.sh`; `activeStateConsistent=false` blocks further candidate work until the persisted active slot and actual container are reconciled. On first adoption only, after verifying the gateway's current upstream, initialize the state with:

```bash
node tools/deployment/slot-state.mjs set-active \
  --state /var/lib/fsusblog/deployment/slots.json \
  --slot blue \
  --kind bootstrap
```

This records existing truth; it does not switch gateway traffic.

## Atomic Gateway Switch And Rollback

The normal release path reaches this protocol only through stage 10 of `release-rollout.sh`. The direct commands below document first adoption, diagnosis and the rollout-owned recovery primitive; do not use `gateway-switch.sh` as a second production rollout entry.

Install `ops/gateway/production-openresty.conf` as the complete host configuration and let it include `/etc/openresty/fsusblog/active-upstream.conf`. The include is not operator-authored text: initialize it exactly once from the already verified active slot, then validate the complete configuration before reload:

```bash
node tools/deployment/gateway-control.mjs initialize \
  --slot blue \
  --active /etc/openresty/fsusblog/active-upstream.conf
openresty -t -c /etc/openresty/nginx.conf
openresty -s reload -c /etc/openresty/nginx.conf
```

`initialize` is idempotent only for the same slot and refuses to overwrite a different active slot. Subsequent traffic changes must go through the locked switch command. Set `FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL` to the real HTTPS `/health/ready` URL; both the loopback response and the public response must expose the expected `X-Fsus-Release-Id` and `X-Fsus-Release-Slot` headers. Put exactly one admin `Authorization: Bearer ...` or `Cookie: ...` header in a mode-0400/0600 host file, export its path as `FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE`, and set `FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN=https://<production-host>`; the helper sends it only to `127.0.0.1:<slot-port>` and evidence never includes it.

```bash
tools/deployment/gateway-switch.sh \
  --to green \
  --release <release-id> \
  --image-digest sha256:<64-hex> \
  --dry-run

tools/deployment/gateway-switch.sh \
  --to green \
  --release <release-id> \
  --image-digest sha256:<64-hex>
```

The command holds the same host lock as slot start/stop, checks that the durable source runtime is exact `Active` and the immutable target runtime is exact `Ready` `Candidate`, probes target loopback readiness/release headers, verifies the public URL still serves the source, renders only the configured `127.0.0.1:8081` or `:8082` line, runs `openresty -t` against a staged full config, fsyncs the files and parent directories, atomically renames the include, validates the installed config, CAS-activates the target before reload, performs graceful reload, probes the target through public and loopback paths, and only then commits `activeSlot`, `previousSlot` and `switchGeneration`. It then CAS-drains the source and waits for `drained=true`; source drain failure leaves the already-committed target active and fails closeout rather than rolling public traffic back after commit. A failed config test changes nothing. A failure after target activation but before commit restores, validates and reloads the source include and drains the target before marking the transition failed; if either recovery cannot be proven, state remains `rollback_required`.

Rollback never resolves a tag and never guesses a slot:

```bash
tools/deployment/gateway-rollback.sh --dry-run
tools/deployment/gateway-rollback.sh
```

It uses the persisted previous slot/release/digest and the same target identity, readiness, activation, atomic install, reload and source-drain path. Because a successfully retired instance remains Draining, first restart the retained previous manifest in the inactive slot so it becomes a fresh Ready Candidate; rollback never reactivates a draining process. It does not downgrade the database. Keep both releases schema-compatible for the rollback window.

After a host restart or interrupted shell, inspect without mutation first, then recover:

```bash
tools/deployment/gateway-recover.sh --action inspect
tools/deployment/gateway-recover.sh --dry-run
tools/deployment/gateway-recover.sh
```

For `switching` or `rollback_required`, recovery compares the durable pending source/target identities, current controlled include, both direct runtimes and public release headers. If the target is already public and healthy it commits the target; otherwise it prefers a healthy recorded source and aborts the pending transition after restoring source traffic. If neither immutable release is healthy, it reports `blocked` and leaves state untouched for manual runtime repair. Never delete `slots.json` or hand-edit the include to escape recovery.

Every switch, rollback and recovery writes a mode-0600 JSON record plus `latest.json` under `FSUSBLOG_GATEWAY_EVIDENCE_DIR`. `tools/operations/collect-release-evidence.sh` requires that evidence to be semantically successful and to match the release manifest's final slot, release ID and image digest. A normal transition additionally records sanitized source-before, target-before, target-after-activation and source-after-drain snapshots; closeout requires target activation and a complete, non-timed-out source drain. Evidence contains identities, bounded counters, booleans, timing, failure stage and recovery action, not credentials, request data or the complete OpenResty configuration.

The certified zero-downtime host floor is defined by `config/deployment/zero-downtime-resource-policy.json`: **4 CPU cores, 6144 MiB total memory and 10240 MiB free disk**. During overlap the two app slots together must stay within 360% CPU and 4608 MiB memory, temporary disk within 8192 MiB, and the probe must capture at least 10 dual-slot samples. The same evidence enforces OpenResty reload <= 2 seconds, drain <= 60 seconds, notification reconnect <= 5 seconds, and active-traffic P95/P99 impact <= 25%/35%. A 2C/2G host is supported only as a legacy single-slot profile; it is not certified to run overlapping Blue/Green instances or claim zero downtime.

`slot-preflight.sh` retains lower configurable pull/start guards (`FSUSBLOG_SLOT_MIN_AVAILABLE_MEMORY_MB`、`FSUSBLOG_SLOT_MIN_FREE_DISK_MB`、`FSUSBLOG_SLOT_IMAGE_PULL_RESERVE_MB`) so diagnostics fail before touching the active slot, but those knobs do not lower the zero-downtime certification floor. `release-resource-probe.mjs` is the final authority for the rollout evidence. Per-slot Compose limits remain configurable through `FSUSBLOG_SLOT_MEMORY_LIMIT`、`FSUSBLOG_SLOT_MEMORY_RESERVATION`、`FSUSBLOG_SLOT_CPU_LIMIT` and `FSUSBLOG_SLOT_CPU_RESERVATION`; lowering them must not be used to turn a 2C/2G overlap into a passing release.

### Strong evidence inputs and isolated qualification

The production rollout requires two independent evidence-binding secrets in addition
to the admin/session material:

```text
--traffic-binding-key-file <0400-or-0600 regular non-symlink file>
--asset-browser-binding-key-file <0400-or-0600 regular non-symlink file>
```

Each key must contain 32..4096 bytes. The traffic key HMAC-binds the complete HTTP
observation chain, session/AEDS assertions, gateway hold and rollout-state hashes.
The asset-browser key HMAC-binds the controlled Chromium binary, N-1 manifest,
Service Worker/cache observations, applied GC evidence and complete compatibility
report. Keys are per-run private inputs; values never enter the plan, stdout or
release artifact. A completed artifact is reusable on `--resume` only after its
dedicated verifier recomputes the HMAC with the same rollout ID and scenario.

`zero-downtime-rehearsal-plan.template.json` references these files as
`evidenceInputs.trafficBindingKey` and
`evidenceInputs.assetBrowserBindingKey`. It also requires
`target.migrationServerDll` and
`migrationQualification.{scenarioTemplate,timeoutSeconds,expandMigrationId,backfillMigrationId,contractMigrationId}`.
Worker reconciliation additionally requires a private 0400/0600
`workers.observerEnvFile` and one materialized
`workers.<deploy|rollback|resume>.observerServicePlan`. The plan binds the
repository-owned loopback observer service to the same origin used by the normal
observer and explicitly allowed by the destructive drill; it supplies real isolated
Test PostgreSQL, Redis, container identity and protected runtime-control inputs, not
precomputed pass fields. The rehearsal owns the service process group and stops it
on success, failure, qualification teardown, SIGKILL/resume and fault teardown.
`release-worker-observer-service.mjs` is therefore a phase-scoped rehearsal helper,
not the normal production observer or an always-on production daemon. It starts only
with `ASPNETCORE_ENVIRONMENT=Test`, `FSUSBLOG_ROLLOUT_REHEARSAL=1` and
`FSUSBLOG_WORKER_OBSERVER_ENABLED=1`; these fields and all `FSUSBLOG_WORKER_OBSERVER_*`
values belong to the isolated Test rehearsal and must not be copied into a production
env file.

Migration qualification runs a distinct Test topology with the repository-owned
`rehearsal-schema-qualification-probe.mjs`. Its application bridge endpoints are
mapped only when the environment is exactly `Test` and
`SchemaMigration:QualificationEnabled=true`; both still require admin
`system.config` and `fixed_ip`. Production keeps the setting false, so the routes do
not exist. Qualification failure leaves the source Active and tears down the
candidate topology. Expand/Backfill can pause and resume without restarting the
active application. A completed Contract writes `rollbackCompatible=false`; after
that boundary an old-image gateway rollback is forbidden and recovery is
backup/forward-fix based.

Do not use `.env.production.example` directly to start production. It is only safe as the source for a private operator-owned `.env.production` and for `docker compose config` structure checks.

`config/deployment/production-compose-environment.json` is the complete
machine-readable inventory for every `${...}` interpolation in
`ops/docker/docker-compose.production.yml`. The current Compose surface contains
60 unique variables: each is bound to its actual non-empty Compose default,
explicitly classified as `must-set-at-deploy`, or, only where empty has defined
semantics, classified as `optional-empty`. The contract also records whether the
release pipeline or the private operator environment owns the value and documents
the deployable value shape. Validate inventory, defaults, documentation and the
effective stop-grace duration together:

```bash
node tools/deployment/check-production-compose-environment.mjs
```

The compose file binds Kestrel to `127.0.0.1:${FSUSBLOG_SLOT_PORT}:8080`, resolved to blue `8081` or green `8082` by the slot scripts. Do not use `8081:8080`, `8082:8080` or any wildcard host binding; only the host gateway owns the public entrypoint.

`.github/workflows/production-image-verification.yml` is the non-publishing image
verification lane. Pull requests touching `ops/docker/**` or `ops/gateway/**` build
the musl final image through `tools/build-final-image.sh`; scheduled and manual runs
build both `throughput-musl` and `throughput-glibc`. Each image must pass its native
Docker HEALTHCHECK, the canonical AEDS v2 runtime smoke including
`/api/binary/article/*`, and a real SIGTERM stop with exit code zero before the
Compose `stop_grace_period`. The companion contract job validates this environment
inventory and runs `openresty -t` against the complete
`ops/gateway/production-openresty.conf` using an immutable OpenResty image. The lane
resolves the public FsusUI build source from
`config/testing/fsusui-baseline.json`, builds its locked theme and WASM artifacts
with the Dockerfile's immutable `fsusui-build-tools` stage, and passes the clean
checkout through the source-bound `local-git-alias` input. It sets local-only
image output and never pushes a registry artifact.

## Health Checks

- `GET /health/live`: process/Kestrel liveness only; safe for Docker healthcheck; returns `application/json`.
- `GET /health/ready`: public readiness for rollout probes; returns only `status` and `checkedAt` with HTTP `200`/`503`.
- `GET /api/ops/health/ready-detail`: protected readiness detail for operators; requires admin principal `audit.read` permission and includes the non-sensitive release identity (`releaseId`, slot, commit, immutable image ref/digest), configuration, PostgreSQL, Redis, public webroot/index, Public AOT SSR worker resources, DB gate snapshot, notification stream connection count, typed startup runtime snapshot, scheduled publish worker snapshot (`lastPublishedCount` / `lastFailedCount` / `dueBacklog`), public hot-read snapshot state/version/error metadata plus resident/raw/compressed/HTML/index/object/LOH/overlap budgets, and RiskControl/perception-sealed@v2 gates for AEAD key rotation, active/LKG policy, provider registry, Redis consume-once, mode, and performance-budget warnings. Resource readiness only includes files or workers consumed by the current runtime; an unowned optional database must not block promotion. A missing or inconsistent production release identity makes readiness fail closed before traffic promotion.
- `GET /api/ops/deployment/status`: admin `system.config` plus loopback-only lifecycle snapshot, including generation, in-flight HTTP, notification connections, background claims, queue blockers and last failure.
- `POST /api/ops/deployment/activate|drain`: admin `system.config` plus loopback-only CAS operations; body must match the running release ID, slot and generation. Repeats are idempotent, mismatches return 409, and every attempt writes high-value audit.
- `GET|POST /api/ops/deployment/fence/status|acquire|revoke`: the same loopback + `system.config` boundary; acquire binds release/slot/generation/image digest in one Redis CAS, and source revoke cannot revoke a newer owner.
- `POST /api/ops/deployment/fence/challenge-kind-cutover`: the same protected boundary accepts only the complete numeric set 3/10/13 and the one authoritative numeric-to-wire fingerprint, binds the operator-supplied map by that irreversible fingerprint, and runs only while the exact release/slot/generation is active. Preflight and closeout independently recompute the fingerprint from target JSON; the durable idempotent receipt stores envelope counts and an identifier-set digest rather than raw envelope identifiers.
- `POST /api/ops/deployment/fence/perception-character-v3-cutover`: acquiring the target fence does not by itself expose V3. The release rollout supplies the generated contract/AEDS target, exact active pool manifest and current policy version to one protected command. The endpoint validates them while closed, closes issuance, idempotently retires old V3 state, rechecks the fence, persists a hashed non-sensitive receipt and reopens only after the exact receipt passes the runtime smoke check. Every later V3 issue/verify revalidates receipt, pool, policy, schema and fence; cache failure, mixed release material, fence loss, a missing/malformed marker, or an invalid production slot fails closed. Retry uses the same operation id and never repeats mutation accounting or leases an artifact. Only explicit Development/Testing runtimes bypass the deployment marker.
- `GET|POST /api/ops/deployment/notification-stream/restart/**`: the same trusted-host boundary; ordered restart closes source connections with 1012, preserves valid cursors, and records replay-miss full-resync evidence without exposing event bodies.

`FSUSBLOG_DRAIN_TIMEOUT_SECONDS` defaults to 45 seconds. `FSUSBLOG_STOP_GRACE_PERIOD` defaults to 60 seconds and must remain greater than the application drain deadline. Active drain and SIGTERM share the same coordinator: readiness becomes 503 immediately, new ordinary/notification/background work stops, entered work and registered buffers finish, then the host may stop the inactive container. `ReleaseDrainParticipantRegistry` invokes article-view、hot-stats、notification、audit/admin-audit、visit、RUM、security/challenge audit、public-hot、ArticleDetail AEDS、PublicAOT backfill and upload cleanup participants in parallel with their bounded deadlines; any pending count, timeout or participant error remains a blocker. A timeout is not success; preserve evidence, keep the new target active, and repair or explicitly terminate the old inactive slot under the incident procedure.

Public-hot drain uses the full quiescence snapshot instead of a single queue count: the participant reads queued items, in-flight batches, active projectors, store state, pending and failed terminal obligations, published generation, pending revocations and active background claims in one atomic observation, records the requested drain generation, and completes only after two consecutive observations spaced at least one worker scheduling tick both satisfy quiescence with the same published and target generation. Any field that is unavailable, negative, unknown or collector-failed blocks; the timeout receipt lists every blocker with its exact current value. Before the first observation the participant reports `public_hot_activity_unavailable`; while any blocker remains it reports `public_hot_not_quiescent` with per-field blockers (for example `store-state=Building`, `published-generation=5<requested-drain-generation=7`, `active-background-claim-count-for-public-hot=1`). Each active worker batch holds an exact in-flight lease and a `DeploymentRuntimeState` background claim that are released in `finally` on success, cancellation or failure, so a `queued-count=0` state is never treated as drained while debounce、projector、publish or revocation completion is still running.

Active-singleton workers receive an active-release execution ticket through `IBackgroundWorkerLease`. `IActiveReleaseCommitGuard.EnsureCurrentAsync` rechecks that ticket immediately before irreversible transitions, outbox effects, crawler snapshot publication, each cleanup delete chunk, process-governor reset, projection checkpoint, PublicAOT atomic publication and upload deletion. PostgreSQL is the durable witness and Redis is a monotonic, rebuildable mirror; losing ownership or detecting same-generation witness divergence cancels the commit boundary instead of allowing an old source to finish a stale side effect. This is an application safety boundary, not a replacement for database idempotency or the final worker reconciliation evidence.

Health checks are an ops JSON protocol. They do not emit PublicAOT bootstrap frames or AEDS binary payloads, so rollout probes can evolve independently from public-page payload changes.

Readiness refreshes are cached by the short TTL snapshot layer. A fresh readiness check fans out PostgreSQL, Redis, RiskControl and runtime probes with `Task.WhenAll`; RiskControl consumes the Redis consume-once result from the readiness Redis path instead of starting its own duplicate Redis health probe. Configuration validation is served from `IConfigurationHealthSnapshot`, which runs `ProductionStartupValidator.ValidateCore` at startup and refreshes every 30 seconds in the background. Operators can separate slow dependencies with `fsus.readiness.check.elapsed` plus `fsus.readiness.postgres.elapsed`, `fsus.readiness.redis.elapsed`, `fsus.readiness.risk_control.elapsed` and `fsus.readiness.runtime.elapsed`.

Redis readiness pings the same process-owned `ConnectionMultiplexer` used by distributed cache, unified cache and direct Redis consumers. Host composition and Redis startup share one lazy `ConnectAsync` task, so a worker resolved before `RedisMultiplexerHostedService.StartAsync` does not create a second connection. A transient disconnect must remain on that instance and use its internal reconnect loop; readiness stays degraded until the shared connection recovers, and no health/cache path creates a replacement socket pool. During shutdown, drain traffic and let hosted workers stop before the root `ServiceProvider` disposes the multiplexer once. If startup connection creation fails, keep the candidate out of traffic and roll back to the previous release; do not bypass the failure with a synchronous secondary connection.

perception-sealed@v2 startup validation and readiness fail closed when `Security:PerceptionSealedToken:CurrentKeyVersion` is missing, points at a missing key, or its `Security:PerceptionSealedToken:Keys:{version}` value is not a 32-byte hex/base64/base64url key. There is no compatibility key fallback. Performance-budget warnings in ready-detail are advisory rollout signals; they do not mark public `/health/ready` down unless a hard dependency gate fails.

Use the candidate slot's direct readiness plus release headers before switching traffic; never probe the retired single-slot `127.0.0.1:8080` endpoint:

```bash
curl -fsS -D - -o /dev/null http://127.0.0.1:8082/health/ready
```

## SLO Alert Closeout

Before promoting a candidate release, generate the SLO alert fixture:

```bash
tools/operations/check-slo-alert-fixture.mjs
```

The default synthetic fixture proves that the alert definitions for readiness degradation, PostgreSQL latency, Redis latency, AOT backfill failure, search rebuild failure, notification stream slow-disconnect spikes and security blockers are still executable. For production evidence, pass a JSON fixture built from the current `/api/ops/health/ready-detail` response, the latest notification stream slow-disconnect metric window and `.tmp/security/production-exposure-status.json`.

Traffic promotion is blocked while any `critical` alert is firing. `warning` alerts require an operator note in the release evidence manifest explaining impact, investigation result and the chosen rollback or degradation action. The detailed runbook and per-alert actions live in `docs/operations.md`.

## Capacity Baseline

The default per-slot Compose limits retain a practical single-slot profile, but a certified overlapping Blue/Green rollout requires the host floor documented above: 4 CPU cores, 6144 MiB total memory and 10240 MiB free disk. A 2C/2G host may run one slot only and must not enter the zero-downtime overlap path. Within that boundary:

- Kestrel serves static frontend assets directly.
- L1 memory cache and Redis L2 absorb public hot reads.
- Public hot-read L0 serves preencoded `.aeds` snapshots ahead of the normal pipeline; misses and not-ready responses are `no-store` and must be watched through `/api/ops/health/ready-detail` runtime metadata. All `PublicHotRead:Max*` memory values use bytes; zero selects container-limit-derived defaults. A rejected candidate never replaces the current snapshot. To reduce pressure without restart, first lower br/gzip expected client share or raise `MinCompressionSavingsPercent`, then reduce `MaxArticleResidentBytes`/`MaxArticleFrames` and request `public-hot-rebuild`; cold article detail continues through the normal versioned cache path. Roll back by restoring the previous values and rebuilding. Do not disable CSP, risk gates or invalidation, and do not raise limits beyond the Blue/Green overlap cgroup budget.
- DB concurrency gate protects PostgreSQL during cache misses and DB-heavy background jobs such as read-aggregate flush, scheduled publish and PublicHot rebuild.
- Article mutations, including scheduled-publish status flips, write `article_mutation_outbox` in the same DB transaction as the primary row change; the dispatcher replays cache/search/AEDS/PublicHot/notification stream side effects with bounded retry after a crash or inline side-effect failure.
- Human-read writes are batch-compacted directly into article/hour, daily event-type and four-bucket dwell aggregates. No event row or route sequence is persisted; `sys_visit_log` and its reconciliation worker are retired. During incident rollback, set `HumanReadProof:Mode=paused` rather than recreating the event table.
- Notification stream backlog multi-target writes are pipelined and local fanout runs from a bounded queue; frames remain bounded per connection and slow consumers are disconnected.
- Upload-session expiration scans run in `UploadSessionCleanupWorker`, not on init/status request paths.
- Content-filter dictionary reloads are serialized through one reload queue to coalesce file watcher bursts.
- Docker log rotation caps container stdout/stderr growth.
- Ordinary traffic slots have `DOTNET_DbgEnableMiniDump=0`, `COMPlus_DbgEnableMiniDump=0`, `DOTNET_EnableDiagnostics=0`, core soft/hard ulimit `0`, `cap_drop: ALL`, and `no-new-privileges:true`. `check-production-network-baseline.sh` rejects any enabled dump switch or unlimited core policy. For an approved incident, reproduce on an isolated, non-public replica and write only to an encrypted, access-audited, short-retention destination; do not override the active/candidate slot.

For larger machines, override compose resource limits and DB/Redis pool settings with a production override file. Do not raise DB concurrency without checking PostgreSQL connection limits.

## Runtime Tuning

Host runtime tuning is deployment-driven. The application does not mutate startup-sensitive `DOTNET_ReadyToRun`, `DOTNET_TC_QuickJitForLoops`, or `DOTNET_TieredPGO` after `WebApplication.CreateBuilder(args)`, because the CLR can read those switches before app code runs. The authoritative catalog is `tools/runtime-profiles/runtime-publish-profiles.json`; do not create an unnamed combination in a workflow, Compose override or shell session.

The catalog deliberately includes musl/glibc, PGO on/off, R2R on/off, single/multi-file, independent `gc-cpuset` and `gc-explicit-hard-limit` controls, runtime-default/evidence-derived/overprovisioned-negative-control ThreadPool, and SMT/physical-core/NUMA-local topology variants. Each named control is validated against `throughput-musl`: glibc may change only its coupled base-family/RID pair, while R2R, multifile, PGO, QuickJIT, each GC axis, ThreadPool, physical-core and NUMA controls may change only their declared axis. The explicit GC control carries its reviewed percentage in the named profile; its effective byte limit is derived from process-visible memory and must equal that percentage exactly. `throughput-musl` remains the default until sealed same-SHA evidence selects another profile. `threadpool-evidence-derived` stores no guessed minimum: the executor must bind the selected value to starvation/queue evidence. The negative control is never a production candidate.

The sealed hardware identity derives logical CPU and memory capacity from the minimum container-visible cpuset/quota/cgroup limit instead of host totals, and records visible physical-core count, threads per core, SMT sibling groups, and NUMA node CPU lists. Missing CPU or NUMA sysfs data is recorded as `unavailable` (or single-node `not-applicable`) with a reason, never as invented topology. `auto-balanced` is profile-aware: SMT keeps physical-core sibling groups together, `physical-core-only` selects one logical CPU per core, and `numa-local` keeps the target inside one visible node while assigning a disjoint load generator. Measurement receipts report the observed target cpuset; a result is rejected when the receipt violates the named placement. Evidence v2 distinguishes capability absence from execution failure: only a missing physical-core topology or unavailable/not-applicable NUMA topology may produce a sealed `unsupportedProfiles` entry. The complete artifact binds the full required catalog and requires scheduled plus unsupported profile IDs to cover it exactly; a build, gate, cleanup, timeout, or measurement failure remains a failed run.

Validate and resolve a profile before building:

```bash
node tools/runtime-profiles/check-runtime-publish-profiles.mjs
node tools/runtime-profiles/resolve-runtime-publish-profile.mjs \
  --profile throughput-musl \
  --format lines

FSUSBLOG_RUNTIME_PROFILE_ID=throughput-musl \
FSUSBLOG_FINAL_LOCAL_ONLY=1 FSUSBLOG_FINAL_PUSH=0 \
./tools/build-final-image.sh
```

`build-final-image.sh`, `build-native.sh`, the Docker build, OCI labels and a newly created release manifest all consume the same catalog/profile digests. The toolchain is independently immutable: .NET runtime `10.0.10`, SDK `10.0.302` and Node `24.17.0` default to patch-specific Alpine 3.23/Noble or Bookworm references pinned by manifest digest. `FSUSBLOG_DOTNET_*` and `FSUSBLOG_NODE_*` overrides are reserved for intentional servicing updates; each family must replace its complete version/digest set together. Node comes from the pinned `node-runtime-musl` or `node-runtime-glibc` stage rather than the distribution package manager, so the SSR runtime cannot silently differ between libc variants. The Wasm builder also puts that copied `/usr/local/bin/node` before the Emscripten image's bundled Node, and asserts the pinned version before it builds artifacts. The build passes every pin into Docker, then inspects the completed image and rejects a missing or mismatched .NET runtime, SDK, Node version, base reference/digest, base family, RID, publish flags, GC count/hard-limit modes, ThreadPool mode or topology mode before local handoff or push. It also executes the finished image to require the pinned `node --version` and absence of `npm`. Provenance is recorded in `io.fsusblog.runtime.dotnet-version`, `io.fsusblog.build.dotnet-sdk-version`, `io.fsusblog.runtime.base-image*`, `io.fsusblog.build.sdk-image*` and `io.fsusblog.runtime.node-*` labels. This prevents host cache state or a floating base tag from contaminating comparisons. A mutable tag, a locally edited profile with a stale digest, or any label/profile mismatch fails before candidate start.

The matrix runner uses a repository executor adapter so environment-specific credentials and load-generator placement never enter the catalog. The executor receives a mode-0600 request containing the exact profile, commit, fixture, hardware/cgroup digest, round and position, and must return all correctness/security/release gates plus L0, L1, L2, DB miss, notification and AOT/SSR measurements:

```bash
export FSUSBLOG_RUNTIME_MATRIX_PLAN=/run/fsus/runtime-publish-executor-plan.json
node tools/runtime-profiles/run-runtime-publish-matrix.mjs \
  --executor tools/runtime-profiles/execute-runtime-publish-profile.mjs \
  --output /var/lib/fsusblog/runtime-matrix/evidence.json \
  --commit-sha "$FSUSBLOG_COMMIT_SHA" \
  --fixture-id production-data-v1 \
  --rounds 3 \
  --cooldown-ms 30000 \
  --selection-policy /run/fsus/runtime-publish-selection-policy.json

node tools/runtime-profiles/check-runtime-publish-evidence.mjs \
  --evidence /var/lib/fsusblog/runtime-matrix/evidence.json \
  --expected-commit-sha "$FSUSBLOG_COMMIT_SHA" \
  --expected-profile-id throughput-musl \
  --expected-profile-manifest-digest 'sha256:<catalog-digest>' \
  --expected-profile-digest 'sha256:<profile-digest>'
```

The executor plan follows `tools/runtime-profiles/runtime-publish-executor-plan.example.json`; the repository-owned adapter in that plan reads the direct site commands from `tools/runtime-profiles/runtime-publish-site-plan.example.json`. Its `auto-balanced` isolation resolves the process-visible cpuset and topology at execution time and applies the selected SMT/physical-core/NUMA policy before dividing disjoint target/load-generator sets; it fails closed when the named placement cannot be proven. Do not replace it with host-wide or hand-written CPU numbers. Site commands are regular non-symlink executables, never shell snippets, and must emit the structured stage result for cleanup-before, build, correctness, security, release, measurement and cleanup-after. The adapter hashes the executable, arguments and result into a same-identity receipt; measurement receipts additionally bind the payload, fault plan and load fixture digests. The selection policy follows `tools/runtime-profiles/runtime-publish-selection-policy.example.json`; copy it outside the repository, set explicit absolute budgets, name the reviewed candidate and choose either `select-candidate` or `retain-baseline`. A full matrix without this policy is rejected instead of leaving an operator-only `unselected` placeholder. The default full matrix includes every required profile and deliberately excludes profiles with `conditionalAdmission`; NativeAOT is run as a separate partial experiment and can enter comparison only after its dedicated build, feature-parity and security-parity stages pass with the same built feature-set digest. A rejected NativeAOT prototype must remain rejected evidence, never a failed required-axis run or a feature-reduced success. The measurement adapter receives resolved cpuset count plus exact GC percentage, ThreadPool and topology modes in `FSUSBLOG_RUNTIME_*`; it must write its payload to `FSUSBLOG_RUNTIME_MEASUREMENTS_OUTPUT`, and the repository executor rejects a receipt whose observed settings, cpusets or cgroups drift.

Every site command receives `FSUSBLOG_RUNTIME_STAGE_RESULT_OUTPUT` and a private `FSUSBLOG_RUNTIME_STAGE_ARTIFACT_ROOT`. The result uses `fsusblog.runtime-publish-stage-result.v1` and points only to relative artifacts below that root. Artifacts use `fsusblog.runtime-publish-stage-artifact.v1` and carry the exact run identity: build emits an image-bound artifact manifest plus feature set; correctness/security/release emit named passing checks; NativeAOT parity emits passing public-artifact checks plus the built feature-set digest; measurement emits the required fault-plan and six-route load-fixture artifacts. Missing, stale, failed, symlinked, escaping or unknown-field artifacts are rejected before a receipt is written. Do not supply precomputed gate/parity/fault/load digests in the stage result; the repository adapter computes them from the actual files.

The runner rotates order between rounds, measures cooldown itself, records failed profiles instead of dropping them, checkpoints partial evidence atomically and binds results to the same hardware/cgroup/cpuset identity. A complete artifact requires every hardware-applicable catalog profile exactly once per round for at least three rounds and a hardware-bound reason for each inapplicable topology profile. Supplying an unsupported profile explicitly fails before execution; a hardware/capability change also invalidates resume. Every scheduled profile must pass all three gates, all six route classes, startup/ready/warmup, failure/recovery, JIT/GC/LOH/ThreadPool/migration metrics and per-route cycles/instructions/validated IPC. `resourceStress` additionally proves allocation burst and GC pressure, records hard-limit OOM outcome/recovery when applicable, and reconciles blue/green peak bytes to active slot, candidate slot, public snapshots, SSR workers and other memory; a single unaccounted overlap number is rejected. Every successful result also binds the final image digest, actual .NET runtime, builder SDK, runtime/SDK base-image digests, Node version, publish flags, GC modes and target memory. Complete evidence emits separate startup and steady-state conclusions. A startup-purpose profile with only startup gains remains named evidence and cannot replace the throughput default. Pairwise/Pareto output is descriptive only: sealed selection still rejects route regression, excessive variance, missing absolute budgets, unproven ThreadPool tuning and negative-control candidates.

To bind a completed matrix into release evidence:

```bash
export FSUSBLOG_RUNTIME_MATRIX_EVIDENCE=/var/lib/fsusblog/runtime-matrix/evidence.json
export FSUSBLOG_RUNTIME_PROFILE_ID=throughput-musl
export FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST=sha256:<catalog-digest>
export FSUSBLOG_RUNTIME_PROFILE_DIGEST=sha256:<profile-digest>
tools/operations/collect-release-evidence.sh
```

The collector validates complete matrix evidence before copying it and fails if its commit SHA or sealed selected profile/digests differ from the release environment; `partial` is diagnostic only. It records the copied file as `artifacts.runtimePublishMatrix`, hashes it in `artifactDigests.runtimePublishMatrix`, and marks the release evidence blocked when the matrix is absent. Both release-evidence checkers reopen that exact in-bundle regular file and reject a missing matrix, digest mismatch, wrong commit, zero or mismatched release-profile digest, or a complete matrix without a sealed production selection.

Deployment/runtime configuration remains useful for an executor-controlled run, but it is not an alternate profile definition:

```json
{
  "RuntimeTuning": {
    "ReadyToRun": "1",
    "QuickJitForLoops": "1",
    "TieredPGO": "1",
    "ThreadPool": {
      "Enabled": false,
      "MinThreadsPerCpu": 0
    }
  }
}
```

The default project metadata remains throughput/TieredPGO-first with `PublishReadyToRun=false`; Docker and native builds override publish properties only from a validated named profile. A NativeAOT experiment is not silently enabled by adding a property to this catalog. It requires a separate minimal public-artifact prototype and must pass full security/feature-parity rejection gates; unsupported MVC, SPA, reflection, notification or administration features cannot be deleted to make it compile.

The startup log line `Runtime tuning effective values` records profile ID and both digests, runtime identifier/framework, observed Server GC, container-visible processor count and GC memory ceiling, GC count/hard-limit modes and configured startup values, startup-sensitive CLR knobs as `*Observed`, ThreadPool mode/minimums and topology mode. ReadyToRun, QuickJitForLoops and TieredPGO remain `false` for in-process applied because app code cannot reliably mutate them after process start. `tools/operations/collect-release-evidence.sh` also records the effective `DOTNET_*` values and rollback instruction. Promotion rollback is an immutable rebuild/redeploy of the previously selected named profile; a ThreadPool-only operational rollback may restore runtime-default and restart the same retained image, but must not rewrite the release manifest or OCI labels in place.

Toolchain pins are part of the release input. The Docker wasm builder pins Emscripten by image digest and vcpkg by `VCPKG_COMMIT`; bump both in the Dockerfile in the same commit as the rebuild evidence.

## Gateway Notes

The host gateway must:

- use `ops/gateway/production-openresty.conf` as the production baseline,
- load exactly one controlled `server 127.0.0.1:8081;` or `server 127.0.0.1:8082;` from `/etc/openresty/fsusblog/active-upstream.conf`; never place an arbitrary host/port or a fixed `127.0.0.1:8080` server in the main config,
- reject unknown Host values with the default server,
- terminate TLS and forward `X-Forwarded-*` headers only from the configured trusted proxy path,
- expose only `80/tcp` and `443/tcp` publicly,
- keep Redis and PostgreSQL on private network/security-group reachability only,
- rate-limit login/admin/global request paths,
- apply `fsus_auth_limit` to `/api/binary/auth/**` and `fsus_admin_limit` to `/api/binary/admin/**` plus `/api/binary/author/**`, so AEDS auth/admin routes do not fall through to the global public-read budget,
- deny hidden files and backup/archive files,
- disable buffering for `/api/notifications/stream`,
- keep upload limits explicit,
- proxy `/health/live`, minimal `/health/ready`, and admin-protected `/api/ops/health/ready-detail`,
- preserve immutable caching headers generated by Kestrel for hashed assets.

If OpenResty/Nginx runs on the same host, keep `REVERSE_PROXY_KNOWN_PROXIES=127.0.0.1`. If it runs from a private gateway subnet, set `REVERSE_PROXY_KNOWN_NETWORKS` to the exact CIDR. Never use `0.0.0.0/0` or a public subnet as a trusted forwarded-header source.

Before treating the external network exposure checklist as complete, run the live probe from a network that can resolve the production DNS:

```bash
FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
tools/security/write-production-exposure-evidence-request.sh

FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json \
FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE=.tmp/security/production-exposure-live.json \
tools/security/complete-production-exposure-closeout.sh
```

The evidence request command writes `.tmp/security/production-exposure-evidence-request.json` with the required host set, root delegation domains, port policy, expected firewall evidence file, DNS/live/status artifact paths, operator input commands, direct closeout command, returned evidence verifier/closeout commands, returned handoff closeout command and release evidence command. It also includes `requiredEvidence` entries for every closeout artifact, standard release artifact names, `verificationCommands`, `handoffChecks`, `currentStatus`, `blockers`, source-specific `nextActions`, and an `unblockPlan` that groups each blocker source with its expected artifacts and commands when a status report is available. It is an operator handoff artifact, not a passing signal. The complete closeout command writes the same request package automatically, then checks local tool prerequisites, runs the production network config baseline, checks DNS delegation, verifies firewall/security-group policy evidence, checks production DNS readiness, generates live exposure evidence, verifies that evidence, writes a fresh status report, and only treats closeout as complete when that status is `ok`. When closeout writes a fresh status report, it refreshes the request package again so release evidence contains the latest blockers. If `FSUSBLOG_CLOUD_FIREWALL_SOURCE` is set, complete closeout first normalizes that cloud export into `FSUSBLOG_FIREWALL_POLICY_EVIDENCE`; if `FSUSBLOG_COLLECT_HOST_FIREWALL_POLICY=1` or `FSUSBLOG_UFW_STATUS_FILE` is set, it first collects host-firewall evidence from UFW. Both paths immediately run the shared firewall verifier before DNS readiness and live probing.

For a narrower operations check, run `tools/security/check-production-dns-delegation.sh`, then `tools/security/check-production-dns-readiness.sh`, then `tools/security/check-production-exposure-live.sh`. DNS delegation writes `.tmp/security/production-dns-delegation.json` and checks whether each root production domain has NS/SOA answers from public resolvers plus NS delegation from TLD authoritative nameservers. DNS readiness writes `.tmp/security/production-dns-readiness.json` by default and fails if any required production host lacks local resolver resolution or an A/AAAA answer from every configured public resolver. The live exposure script requires production DNS resolution, verifies public reachability for `80/tcp` and `443/tcp`, rejects public reachability for `22/tcp`, `6379/tcp`, `5432/tcp`, and `8080/tcp`, and checks HTTPS plus `Strict-Transport-Security`. Set `FSUSBLOG_LIVE_HOSTS` to the complete production host list before final closeout, or let `tools/security/collect-production-hosts.sh` derive it from production env values including `SITE_BASEURL`, `Seo__BaseUrl`, `CORS_ALLOWED_HOSTS`, `APP_ALLOWED_HOSTS`, and Fido2/WebAuthn domain/origin settings. The host collector rejects wildcards, localhost values, IP literals, and malformed hostnames, so final closeout is always scoped to real production DNS names. Live evidence records that list as `requiredHosts`, DNS readiness records the same host set as `requiredHosts`, and DNS delegation records root domains as `delegationDomains`; the verifier/status report/production closeout chain accepts generated space-delimited fields or operator-supplied JSON arrays for those fields, and rejects evidence that omits the field or lacks any required host/domain. Set `FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE` to persist a JSON evidence file for release notes or production closeout. The evidence records local resolver results plus public A/AAAA checks against `1.1.1.1` and `8.8.8.8`; override that list with `FSUSBLOG_DNS_RESOLVERS` if release policy requires a different resolver set. Live evidence must include `generatedAt` and is valid for 24 hours by default; override with `FSUSBLOG_PRODUCTION_EXPOSURE_MAX_AGE_SECONDS` only for an explicit release policy exception.

After generating or receiving evidence, run `tools/security/report-production-exposure-status.sh` to write `.tmp/security/production-exposure-status.json`. The status report is read-only: it runs the firewall policy verifier and live evidence verifier against the configured evidence files, requires live evidence `requiredHosts` to cover the complete production host list, requires fresh DNS readiness evidence for every production host, requires fresh DNS delegation evidence for every root production domain, normalizes string or JSON-array `requiredHosts`/`delegationDomains` evidence fields, records the complete production host list plus delegation domains, and emits `status=ok` only when every evidence chain has no blockers. When blocked, the JSON `blockers` array keeps release notes and handoff actions aligned with the exact missing proof, such as absent firewall policy evidence, live evidence missing a production host, absent or stale DNS readiness/delegation evidence, missing DNS, unproven closed ports, missing HTTPS, or missing HSTS.

Before handing off release evidence, run `tools/security/check-production-exposure-handoff.sh .tmp/release-evidence/<release-identity>/manifest.json`. The handoff checker confirms the request package, status report and manifest agree on status, validity, blocker count, blocker sources, blocker details, required hosts and delegation domains, every blocker source has a next action and an `unblockPlan` entry, request `requiredEvidence` covers every configured evidence file with standard artifact names, request keeps the firewall raw source sha256 requirement enabled, request `verificationCommands`/top-level command fields/`handoffChecks` include direct closeout, returned evidence verification, returned evidence closeout, returned handoff closeout, release evidence collection and handoff verification, manifest `externalExposure.request` preserves the request required-evidence keys/count, unblock plan sources/count, firewall source sha256 requirement flags, verification command names/count, returned closeout command count and closeout command fields, manifest `externalExposure.blockers` exactly matches the status report, request `evidenceFiles` point at the configured firewall/live/DNS/status source files, the bundle contains copied request/status/live/DNS/firewall artifacts under standard file names matching those source files, those artifacts match their sha256 digests in the manifest, manifest component statuses for firewall policy, DNS readiness, DNS delegation and live exposure match the configured source evidence, and evidence paths are not fixture `/tmp/tmp...` paths. Exported handoff bundles include `operator-checklist.json`, a machine-readable blocker-source checklist that must match request `unblockPlan`, artifact names and closeout commands. Bundle README files are checked too: they must retain the standard returned evidence filenames, verifier/closeout commands, operator checklist reference and blocked-closeout warning. The exporter self-checks both the generated directory and tarball before reporting success. Archive members are rejected before extraction if they use absolute paths, `..` traversal, or unsupported entry types such as symlinks and special files. Bundle and returned evidence directories must not contain symlinks, so closeout never follows an operator-supplied link outside the verified evidence tree. Exported returned-evidence manifests preserve source manifest/request sha256 metadata plus returned `unblockPlan` sources/count, evidence key, evidence file, artifact and command mappings; returned closeout requires `expected-evidence-manifest.json` and rejects a manifest that loses or rewrites that plan before production closeout.

Firewall/security-group policy evidence is a small JSON file consumed by `tools/security/verify-production-firewall-policy-evidence.sh`. The verifier expects a fresh `generatedAt`, a supported `evidenceSource.kind`, an `evidenceSource.sourceSha256` digest for the raw firewall export, a non-empty `appliesToHosts` list, and an `ingressRules` array. Supported source kinds are `aws-security-groups` and `ufw-status`; prefer the repo normalizer/collector because they write the source metadata automatically. When `evidenceSource.sourceFile` or `evidenceSource.statusFile` is readable on the current machine, the verifier compares `sourceSha256` against that raw file before checking rules. Complete closeout and the standalone closeout verifier pass the same required host set into the firewall verifier, derived from `FSUSBLOG_LIVE_HOSTS`, production env values, or live evidence `requiredHosts`; every required host must appear in `appliesToHosts`, so unrelated policy exports cannot satisfy final closeout. The verifier requires public `tcp/80` and `tcp/443` allow rules, rejects any other public TCP allow rule including `fromPort`/`toPort` ranges and all-protocol rules, rejects any non-private non-web port, rejects public `tcp/22`, and requires every SSH rule to declare `sourceType` as `fixed-management-ip`, `vpn`, or `private-management-network`. A `fixed-management-ip` SSH source must be a single host CIDR (`/32` or `/128`), while `private-management-network` must be a private source range. Redis `tcp/6379` and PostgreSQL `tcp/5432` must come only from private sources; fixed public CIDRs are rejected for database/cache and other non-web ports. SSH remains allowed only through `fixed-management-ip`, `vpn`, or `private-management-network` source types. Firewall policy evidence is valid for 24 hours by default; override with `FSUSBLOG_FIREWALL_POLICY_MAX_AGE_SECONDS` only for an explicit release policy exception.

Use a real cloud security-group or host-firewall export as the source for that JSON, then normalize it to this shape. `tools/security/production-firewall-policy.evidence.example.jsonc` is a documentation-only template with placeholders and comments; do not pass it to the verifier, and do not synthesize passing evidence for final closeout.

On a production host that uses UFW as the host firewall, the repo can collect and verify the normalized evidence directly from `ufw status`:

```bash
FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json \
FSUSBLOG_FIREWALL_SSH_SOURCE_TYPES='203.0.113.4/32=fixed-management-ip,10.0.0.0/24=vpn' \
tools/security/collect-host-firewall-policy-evidence.sh
```

The collector refuses inactive UFW, requires explicit `tcp/80` and `tcp/443` allow rules, parses both IPv4 and `(v6)` UFW rows, records the raw UFW status sha256 in `evidenceSource.sourceSha256`, rejects generated evidence that the firewall policy verifier would reject, and requires SSH sources to be classified as `fixed-management-ip`, `vpn`, or `private-management-network`. Private RFC1918/loopback/ULA sources are classified as `private-management-network` automatically; public SSH source CIDRs must be mapped with `FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE` or `FSUSBLOG_FIREWALL_SSH_SOURCE_TYPES`.

For AWS EC2 security groups, export the active production group and normalize it before final closeout:

```bash
aws ec2 describe-security-groups --group-ids sg-0123456789abcdef0 > .tmp/security/aws-security-groups.json
FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json \
FSUSBLOG_FIREWALL_SSH_SOURCE_TYPES='203.0.113.4/32=fixed-management-ip,10.0.0.0/24=vpn' \
tools/security/normalize-cloud-firewall-policy-evidence.sh .tmp/security/aws-security-groups.json
```

The normalizer currently supports the `describe-security-groups` JSON shape, auto-detects that format, writes the same normalized evidence schema with the raw export sha256, and immediately runs `verify-production-firewall-policy-evidence.sh`. A non-private database/cache rule, non-private extra-port rule, public SSH, wide public range, all-protocol public rule, stale evidence, source digest mismatch, or missing required host still fails through the shared verifier.

```json
{
  "generatedAt": "2026-05-17T13:54:00Z",
  "evidenceSource": {
    "kind": "aws-security-groups",
    "sourceFile": ".tmp/security/aws-security-groups.json",
    "sourceSha256": "REPLACE_WITH_SHA256_OF_RAW_EXPORT"
  },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "fromPort": 80, "toPort": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "fromPort": 443, "toPort": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "fromPort": 22, "toPort": 22, "source": "203.0.113.4/32", "sourceType": "fixed-management-ip", "action": "allow", "purpose": "ssh-management" }
  ]
}
```

Local production security always runs `tools/security/check-local-runtime-exposure.mjs` against the current fresh namespace. This verifies real loopback listeners, backend security headers, and loopback-only PostgreSQL/Redis Docker bindings, and writes `.tmp/security/local-runtime-exposure.json`; its schema explicitly says it does not count as production closeout. When `FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE` is set, `./tools/test.sh security` separately runs `tools/security/verify-production-exposure-evidence.sh` after a successful external live probe. That verifier rejects incomplete DNS evidence, reachable forbidden ports, missing HTTPS/HSTS, and `FSUSBLOG_LIVE_TARGETS` pre-cutover evidence for final closeout.

CSP rollout monitors structured `FsusBlog.CspReport` counts by directive/disposition/blocked-resource category; alerts and dashboards must not ingest raw report bodies or URLs. A candidate is not promoted when normal public, auth/account, admin, notification-stream or binary browser flows produce `style-src-attr` violations. If only public L0 is affected, hot-set `PublicHotRead:Enabled=false` to fall back to the regular document path. Otherwise reactivate the preceding verified Blue/Green slot through deployment control. This is the no-restart rollback; never recover by restoring `style-src-attr 'unsafe-inline'`, adding general `'unsafe-eval'`, removing the report collector, or weakening PoW/risk/security headers.

After the firewall, DNS readiness/delegation, live evidence, and status report verifiers pass against the real production domains, verify closeout with:

```bash
FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json \
tools/security/verify-production-exposure-closeout.sh .tmp/security/production-exposure-live.json
```

The closeout verifier refuses to report success unless the firewall policy verifier, live evidence verifier, DNS readiness evidence, DNS delegation evidence and status report all succeed with `status=ok`. Prefer `tools/security/complete-production-exposure-closeout.sh` for the final release closeout because it runs every prerequisite in order. If one evidence step fails, the complete closeout script still attempts later DNS readiness/live/status checks before exiting, so release evidence can archive the freshest blocker set without marking the production closeout gate complete. When closing from a returned full handoff directory, tarball, or its nested `returned-evidence/` directory, the returned closeout path first verifies the original handoff bundle metadata before reading returned evidence, so a tampered operator checklist, summary, checksum or expected manifest cannot close the production closeout gate even if the returned JSON files are otherwise valid.

`tools/security/check-production-network-baseline.sh` runs `tools/security/check-production-exposure-prereqs.sh` and `tools/security/test-production-exposure-tools.sh` by default. The prereq check verifies required shell tools and executable scripts before a live closeout attempt. The local self-test uses synthetic evidence to prove public SSH or Redis/PostgreSQL firewall policies are rejected, failed DNS evidence cannot pass closeout, pre-cutover target evidence is rejected for final closeout, the status report captures firewall, DNS readiness, DNS delegation, and live blockers, the handoff checker rejects fixture `/tmp/tmp...` evidence paths unless tests explicitly allow them, the complete closeout script writes a blocked status report on failed evidence, DNS delegation failure still refreshes later DNS readiness/live evidence before exit, and valid firewall plus DNS readiness/delegation plus live evidence produces an `ok` production exposure status.

If the gateway is ready before DNS cutover, `FSUSBLOG_LIVE_TARGETS=fsus.blog=203.0.113.10,www.fsus.blog=203.0.113.10` can probe a concrete address while preserving Host/SNI. That pre-cutover probe is useful for operations rehearsal, but it does not satisfy the final production-domain checklist until public DNS resolves. HSTS `includeSubDomains` or preload should only be enabled after every production subdomain is HTTPS-clean.

## Post Deploy Evidence Loop

For the single-author blog release flow, keep these artifacts with the release:

```bash
FSUSBLOG_SMOKE_BASE_URL=https://fsus.blog tools/operations/post-deploy-smoke.sh
FSUSBLOG_RELEASE_ROLLOUT_EVIDENCE=/var/lib/fsusblog/deployment/rollouts/<rollout-id>/evidence/release-rollout.json \
  tools/operations/collect-release-evidence.sh
```

The final rollout evidence must seal the exact 15 ordered stages plus exactly six named artifacts: `publicTraffic`、`notificationStream`、`assetCompatibility`、`workerReconciliation`、`resourceBudget` and `faultInjection`. Stage attempts, recoveries and all six artifacts are SHA-256/size bound. The collector invokes `collect-release-rollout-bundle.mjs` to copy only those allowlisted files into `release-rollout-bundle/` and writes `bundle-index.json`; unreferenced files, symlinks, path escapes, seal-time drift and a seventh artifact are rejected. For an isolated handoff, the same bundler can be invoked directly against the final `release-rollout.json`, but the output directory must not already exist.

Normal production evidence accepts only `fsusblog.release-worker-reconciliation-evidence.v2` with `mode=normal`: eight durable worker kinds, graceful source drain, target ownership and zero stale-generation commits. A forced-source/SIGKILL worker drill is **not** a normal rollout stage. Run it only as an isolated Test-topology qualification through `tools/deployment/zero-downtime-rehearsal.sh --plan <private-plan> --mode normal|all`; teardown that topology, then run a fresh normal rollout with a distinct rollout ID but the same target release/digest. Qualification v2 must hash-bind its nine-kind ledger, resource policy and the distinct fresh normal state. Never kill the production source container to manufacture normal evidence, and never reuse a qualification ledger as the normal ledger.

The smoke output belongs in `.tmp/operations/post-deploy-smoke.json`; the evidence collector writes `.tmp/release-evidence/<release-identity>/manifest.json`. A complete identity namespace binds the release ID, full commit SHA and image digest; timestamp-only output is diagnostic. The manifest may be `collected-blocked`; in that case `evidenceSummary` is the release-blocking record and must show the missing rollout bundle, image digest, firewall policy, DNS, live exposure or other invalid evidence directly. Placeholder outputs are explicit blockers: backup restore dry-runs write `status=scheduled`, smoke dry-runs write `status=scheduled` with a `dry-run` blocker, and manual smoke checklist items do not replace automated `verifiedCoverage`. The collector also copies `production-exposure-evidence-request.json` when present and summarizes its current status, blocker count, blocker sources, next action sources, unblock plan sources/count, required hosts, delegation domains, verification command names/count, returned closeout command count and closeout command fields under `evidenceSummary.externalExposure.request`, so the release artifact records exactly what external inputs and closeout paths were requested. These files complement, but do not replace, `tools/security/complete-production-exposure-closeout.sh`: external production exposure is complete only when real DNS delegation/readiness, firewall/security-group evidence, HTTPS/HSTS and live forbidden-port checks all pass for the production host set.

Closeout levels:

| Evidence | Responsibility |
| --- | --- |
| coverage, ZAP, authenticated DAST, Wasm fuzz, attack matrix, permission matrix, supply-chain audit, SBOM, load result, final zero-downtime rollout/bundle, fault injection, short soak | CI/release-depth forced before release evidence collection |
| image digest, DNS readiness/delegation, firewall policy, live HTTPS/HSTS/forbidden-port exposure, post-deploy smoke, real backup restore drill and SLO alert replay | release closeout required before promotion |
| retention cleanup | scheduled operations drill, copied into release evidence when available |

Run `tools/operations/check-release-evidence-manifest.mjs .tmp/release-evidence/<release-identity>/manifest.json` before treating a manifest as a release credential. Use `--require-ok` only for final promotion, because local CI can legitimately produce `collected-blocked` while waiting for external production evidence. The checker semantically verifies the release artifacts above; a file with `status=ok` is still blocked if it is a dry-run, skipped active scan, zero-seed fuzz run, observed-only fault drill or empty soak.
