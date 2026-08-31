# 测试策略

## Bounded channel delivery contracts

`config/testing/bounded-channel-delivery-contracts.json` 是生产 C# source 中 bounded channel 的唯一 delivery contract catalog，schema 为 `config/testing/bounded-channel-delivery-contracts.schema.json`。`tools/governance/bounded-channel-contracts.mjs` 会解析 direct factory、包装 factory 与间接 factory owner，并以 `source file + containing type + assigned slot` 形成稳定 discovery key；catalog 与 discovery 必须双向 exact，不能用 wildcard、Markdown inventory 或遗漏项 baseline 放行。

每项 queue 必须声明 `required`、`best-effort`、`coalescible`、`replayable` 之一，并绑定 writer、reader、drain、fallback、failure semantics、evidence、proof test、successor disposition 与 implementation owner。class-specific proof 由 checker fail closed：`required` 需要 durable/replay source，`best-effort` 需要不涉及 security/audit/correctness 的产品证明，`coalescible` 需要 commutative/monotonic proof，`replayable` 需要 executable source/postcondition。`FullMode=Wait` 与 `TryWrite` 并存时必须解释 queue-full disposition。PublicHot 条目只引用 #1629、#1630、#1631，不复制 delivery/recovery/drain 逻辑。

Focused validation：

```bash
node tools/governance/bounded-channel-contracts.mjs
node --test tests/tools/bounded-channel-contracts.test.mjs
```

## Media shape authority

`config/testing/media-shape-catalog.json` 是唯一 closed/versioned MediaShapeCatalog。它分别登记 JPEG、PNG、SVG、WebP 的 MIME、extension、magic 与独立 codec fact owner，固定六种 aspect contract、十类 consumer applicability、十个 canonical positive shapes 和八个 single-fault negative shapes。catalog 只保存 AssetId-compatible generator digest refs，不保存 absolute path、public URL、storage path 或第二份 asset ledger；`no-cover` 明确不产生 bytes、URL 或默认图片。`tools/test-fixtures/media-shape-catalog.mjs` 对 catalog 与每个 shape 的 content digest、矩阵完整性、format/MIME/extension、orientation/alpha/dimensions、single-fault、consumer isolation 和唯一 authority 做独立 fail-closed 验证。

`tools/test-fixtures/media-positive-generator.mjs` 离线生成真实 JPEG、PNG 与安全 SVG bytes，并加载 repository-pinned WebP bytes；独立 parser 从 bytes 重算 magic、MIME/extension、dimensions、EXIF orientation、alpha、byte digest 与 decoded semantic digest。`tools/test-fixtures/canonical-media-asset-store.mjs` 只用 canonical UUID AssetId 与 run-owned storage key 物化 fixture，ledger 绑定 owner namespace、bytes 和 metadata；相同 run 幂等复用前必须重验 digest，不同 run 保持独立 AssetId 但共享相同 media content identity。`no-cover` 只产生 explicit-null receipt。generator 不访问网络、系统 codec/font 或 public root；cleanup 只处理 receipt-owned records。0、1、1000 assets 与 1200x900 large raster 均由 focused test 验证 CPU、RSS 和 disk 上界。

## Media negative corpus

`config/testing/media-negative-corpus-plan.json` 是媒体 negative fixture 的唯一计划权威，schema 为 `config/schemas/media-negative-corpus-plan.schema.json`。runner `tools/test-fixtures/media-negative-corpus.mjs` 只接受由 canonical positive generator 签发、状态为 `verified` 的 `fsusblog.media-positive-asset-receipt.v1` 与对应 bytes；它不生成 positive shape、不拼装 AssetId，也不把 negative record 写入 canonical profile、scale、AOT 或普通 image library。

八类 case 固定为 missing、corrupt header、truncated、MIME-extension mismatch、unsupported、zero-byte、oversized dimensions 与 unsafe path。每类只有一个独立 fault condition 和唯一 reason code，attempt 固定为一次且不允许 clean-success retry。oversized case 只改 PNG IHDR 并重算 CRC，在 metadata admission 阶段拒绝，不分配巨大 bitmap；unsafe-path case 在任何 filesystem I/O 前终止且 receipt 不保存危险或 absolute path。每次 materialization 使用与 positive root 物理隔离的 fresh run-owned directory，独立 verifier 重算 case/receipt digest、single-fault、bytes、reason/status、resource safety 与 positive-root before/after digest。

端到端测试从 MediaShapeCatalog 选取 `png-alpha`，经 canonical generator 与 AssetId store 取得 verified receipt/bytes，再派生全部八类 negative case，并核验 positive ledger 与 bytes root 在运行前后完全不变。其余单元测试仍以最小 sealed receipt 定位单一拒绝条件，但不作为端到端验收替代品。

## Runtime state-domain catalog

`config/testing/runtime-state-domain-catalog.json` is the sole runtime-state access authority. Domains must come from `config/testing/runtime-state-domain-registry.json`; executable runtime steps declare reads, writes, deletes, invalidations, creates, resets, predecessors, postconditions, and machine-verifiable source/test evidence. Coordination-only steps use `stateAccess: none`. The catalog is exact in both directions against `runtimeSteps()` and its validator runs as matrix governance; neither scheduler, lane scripts, nor documentation may keep a second conflict table. Runtime bundle producers write source/run-bound reset receipts after observing their real postconditions, and every `resetBefore`/`resetAfter` consumer verifies the receipt identity plus observation digests before proceeding.

## Fixture mutation and exact-recovery qualification

`tools/test-fixtures/mutation-recovery/` is the only test-only semantic observation,
mutation and same-profile recovery authority. It consumes the verified current
`fsusblog.fixture-receipt.v2`, the sealed producer plan and
`config/testing/fixture-mutation-envelope-catalog.json`; it never copies expected
fixture values from producer source. A snapshot request binds run/source/profile,
catalog and receipt digests, temporal context, provider, service generation and the
observed backend/database/Redis runtime identity. The observer streams receipt-owned
entities, relations, outbox rows, exact Redis TTL/generation, media byte digests and
API/service projections together with explicitly catalogued nonowned sentinels into
content-addressed bounded shards.
The observer must stream records in canonical semantic-key order; duplicate or
out-of-order input fails instead of being accumulated and resorted in memory.

Every observed field has one closed disposition: `semantic`, `execution-identity`,
`location`, `diagnostic-volatile` or `secret-redacted`. Semantic timestamps bind a
#1730 role; volatile process/location facts do not affect equality; protected values
retain only presence, type and digest. Unknown dispositions and unclassified fields
fail closed. Comparison reports missing/extra records plus field, relation, version,
TTL, byte and projection changes. Mutated state must contain at least one declared
drift and no other or nonowned drift; after reprepare, semantic diff must be empty,
not merely row-count-equal.

The five provider adapters resolve semantic roles to one exact receipt-owned target.
Database ports receive only a closed operation ID and parameter values; Redis ports
receive exact keys and never a wildcard; filesystem targets are relative to a
verified real fixture root and reject symlink, junction or reparse escapes. Each
single-fault attempt writes an append-only digest-bound journal holding redacted
target references and a recovery reference, never SQL, user text, secret material or
absolute paths. Duplicate attempts fail instead of extending TTL or applying damage
again.

`runMutationRecovery` fixes the sequence to verified prepare, baseline snapshot,
single mutation, expected-only diff, canonical reprepare with the identical sealed
profile plan, then exact recovery comparison. The backend PID/start identity and
database/Redis generations must remain unchanged. The runner has no restart,
container recreation, global cleanup/reset, cache flush, manual repair or retry
capability. Cancellation or failure restores only the active test-owned before-state;
if that restore fails, the thrown failure retains an explicit recovery obligation.
The independent receipt verifier rejects identity drift, missing cases, retry,
forbidden operations and evidence tamper. Static governance is enforced by
`tools/governance/check-fixture-mutation-recovery-governance.mjs`.

FsusBlog 采用机器可读测试 DAG。`tests/matrix.yml` 是唯一测试拓扑源，`tools/run-test-matrix.mjs` 负责 `preflight` / `validate` / `list` / `plan` / `run` / `ci-plan` / `evidence-plan`，`tools/docs/generate-testing-docs.mjs` 是唯一测试文档 producer，`tools/test.sh` 是唯一公开 shell 入口并代理到 runner。lane 脚本只能执行一个已由 matrix 声明的叶节点；共享 shell 文件是 source-only 能力库，不得包含 tier 分派、依赖关系或另一个命令清单。后端 profile、mutation、security static/runtime 和 cross-stack static/runtime 都由 matrix 或 production bundle 投影到同一组叶节点，不能通过兼容 alias 再建一套拓扑。

`config/testing/fsusui-baseline.json` 是本地与 CI 测试消费 FsusUI source/theme
的唯一 commit authority。Quality Gate、Browser Diagnostics、本地 identity
验证和截图 evidence 都必须绑定该文件的同一完整 SHA；workflow 只能在 checkout
FsusBlog 后由 `tools/test/fsusui-baseline.mjs` 导出该 SHA，不得保留 workflow-local
pin、环境默认 pin 或 package-only 测试 fallback。每个 frontend lane 在执行前都通过
Git common directory 解析 local source，并复用同一 identity verifier 检查 clean
worktree、完整 commit 与生成后的 theme dist。

`behavior-doc-static-admission` 是所有候选测试、构建、服务、容器和浏览器之前唯一且无条件的 BehaviorDoc 静态准入节点。它使用 `executionClass: static-governance`、`fixtureProfile: none`，不启动数据库、runtime、Vitest 或 Playwright；节点依次复用 BehaviorCatalog、DocClaim schema/parser、ImplementationOwner、当前 extractor registry、generated section checker、prose verifier 和 staleness mutation fixtures 的既有 authority。四个 compiled-assembly extractor 只消费本轮 content-addressed minimal contract build 的精确 receipt，禁止读取 ambient `bin/obj`。同一 source/worktree/toolchain 的并发准入通过原子 owner lock 选出唯一 publisher，在 per-run staging 完整构建后原子发布；后继 run 只有在 receipt、source closure、project 和 observation digest 全部重验通过后才可复用，损坏或遗留 cache 必须重建。任一 missing、duplicate、stale、warning、partial 或 source/build identity 漂移都直接失败。

准入 receipt 绑定 run、commit、FactObservation worktree fingerprint、toolchain、catalog/claim/extractor/renderer digest、owner 结果、全部 fact observation、minimal build、generated/prose/mutation 结果和 `candidateSpawnCountBeforeReceipt: 0`，并以 `contentDigest` 封存；同一 admission artifact 同时发布被主 receipt 逐项 digest 绑定的 implementation-owner、DocClaim parse/verification、generated-section 和 fact-observation companion receipts，后继 authority 不得从不存在的平行 `.tmp` producer 目录猜测这些输入。本地 Production Fresh runner 先取得同一 candidate/run 的 repository lease 和 capacity reservation，再在 reservation live guard 内生成并校验该 receipt；BehaviorDoc cache 命中与未命中都按 catalog 中的 worst-case build/staging/retention demand 预留，不得消耗 safety headroom，host temp demand 同时覆盖 process-unique DocClaim staleness mutation fixture repositories。admission 完成后必须用 lease 的同一 `snapshotSourceState` authority 重取 commit/worktree fingerprint 并精确匹配，不能直接比较 BehaviorDoc extractor 的另一套 fingerprint；漂移在 cleanup 和 producer 前 fail closed。receipt 仍先于 cleanup、candidate output root 和 scheduler child spawn，随后在每个 physical bundle admission 前重验 source/worktree/digest。非 Fresh 本地 profile 保持无 capacity authority 的静态准入顺序。GitHub Actions 通过独立 prerequisite job 生成同一 artifact；每个候选 job 必须使用 `.github/actions/consume-behavior-doc-admission` 下载并验证 producer 输出后才可调用 `tools/test.sh`。docs-only、source-only 和其他 smart-gate 计划都不能省略该节点，package script 也不得直接暴露其内部 authority 形成旁路。

Content lifecycle 的 current-run terminal evidence 由 `tools/docs/content-doc-exactness.mjs`
生成：generated claim 与 prose claim 分开计数，prose 必须逐项 verified，closed mutation roster 中
scheduled/rollback/restore/delete/visibility/moderation/privacy/outbox 及治理退化类必须全部
killed，missing/extra/conflict/stale/residue 必须为零。`verify` 不信任 terminal 自报数字；本地与
CI 都显式传入 admission、prose、generated、content observation、mutation 五类 component，重算
rows、authority digests、ledger closure 与最终 seal 后才接受。

`production-correctness` 与 `production` 在 scheduler、runtime cleanup、cache/.tmp 清理、磁盘 reservation、namespace 准备或 producer spawn 前，必须取得以 canonical repository root 和 `production-fresh` 为键的仓库级独占 lease。candidate identity 绑定本轮真实 commit、worktree fingerprint、profile target tier 与固定 `production-fresh` namespace；owner process/start/executable/command 与 Unix process group 或 Windows Job Object authority 复用 scheduler verifier。Windows 必须在 acquisition 前证明 named Job member query 可用，release 时对稳定双快照中的每个成员收集完整 process identity，除 owner 外仍有成员或 query 不可验证都不得释放。第二个 Fresh 对可验证 owner fail-fast 且文件、进程、container、port 与 spawn 均零变化；owner 损坏或无法验证时 fail closed。stale reclaim 与 heartbeat/finalize 使用 owner token、content digest CAS；lease 只在 producer descendants、postflight、证据封存和 cache 恢复结束，写入 terminal receipt 后释放。

Fresh cache preservation 在取得上述 lease 后、任何新 `.tmp` cleanup 或 producer spawn 前，先扫描 common Git directory 中、按 canonical repository root 隔离的 durable transaction journal。事务状态只允许 `prepared`、`evacuating`、`evacuated`、`fresh-root-cleared`、`restoring`、`restored`、`committed`、`aborted`、`recovery-required`；每次 journal 写入执行 file fsync、atomic rename 和 parent-directory fsync，每次 cache rename 同步 fsync source/holding parent。holding 固定在物理 `.tmp` 同文件系统的外部 sibling，并只登记现有四项 cache allowlist（Emscripten、dependency、.NET data cache、run-bound build roots）。只读 terminal `test-runs` 不是可复用 cache，不得 rename 到 holding；cleanup 通过 exact path 原地跳过并在删除前后复核 tree digest、mode、uid/gid 与目录 identity，保证 run B 不删除、移动、chmod 或改写 run A 的已封存 correctness evidence。除此以外的 TRX、coverage、summary、checkpoint 与 correctness output 不得登记。恢复只读取 journal 中的 exact original/holding path，不按 PID、mtime 或目录名猜测，并逐项复核 tree digest、mode、uid/gid、symlink/hardlink 边界和 #1675 owner identity；holding tamper、未知/损坏状态、目标重建、条目缺失、跨文件系统 rename、fsync 不可用、磁盘满或权限失败全部写入 `recovery-required` 并在 cleanup/spawn 前 fail closed。`committed`/`aborted` journal 作为 terminal receipt 保留 pre/post digest、动作、crash injection point 和 final state；cache 后续合法变化不会被旧 terminal receipt 冻结。

Production Fresh 的 correctness run root 固定为 `.tmp/test-runs/<runId>/outputs/`，并登记 `bundles`、`reports`、`coverage`、`release-evidence`、`runtime`、`logs`、`artifacts` 与 `summary` 分区。实际 producer 只写 `outputs/attempts/attempt-NNNN/` 下的同名完整分区；Fresh 固定创建 `attempt-0001`，resume 只能追加下一个 attempt，旧 attempt 先只读封存且 digest 不变。成功 preflight 与 postflight runtime-cleanup receipt 都由 `scheduler/runtime-cleanup` 写入当前 attempt 的 `runtime/runtime-cleanup-receipts/`，并与 `runtime/runtime-cleanup.json` 共同纳入该 owner 的 output inventory；尚未创建 output attempt 的 blocked preflight 则只在 `.tmp/test-runs/<runId>/preflight/runtime-cleanup/` 保存 write-once receipt，并把 early summary 写入同一 run 的 `preflight/summary.json`。Fresh scheduler 启动时仍清除旧 checkpoint、tier log 与其他 scheduler-owned state；一旦本轮 `production-fresh-output-authority.json` 和 `outputs/` 已初始化，reset handshake 必须按精确名称与 file/directory 类型保留这两个 run entry，缺失、symlink、类型漂移或 resume 复用该 handshake 都 fail closed，禁止递归删除整个已初始化 run root。`.tmp/release-evidence` 与 `.tmp/local-production/summary.json` 不得作为 Production Fresh correctness 输出。每个 physical producer 在执行前后只对其声明的精确 owner roots 核对 output delta，并把并发的其他 owner 输出留给各自 receipt 与终态 aggregate；bootstrap parallel wave/status 临时文件只能按精确生命周期路径删除，任意其他 removal 仍 fail closed。producer receipt 记录 runId、attemptId、producerId、outputRoot、排序后的 relativeOutputs、逐文件 digest 和 inventory digest，receipt 与 bundle finalizer output 也必须有显式 governance owner。终态 aggregate verifier 遍历完整 attempt，失败 bundle 的 partial receipt 同样进入完整 inventory；未声明文件、重复 owner、路径逃逸、任一祖先或中间 symlink 及跨 run 引用一律 fail closed。共享诊断/cache 不得保存 correctness 结果、coverage、TRX、summary 或 release evidence。

Scheduler 在任何 physical producer 或 projection-only resume 写入前，为历史全局 correctness 路径建立只读空 guard，并在 terminal inventory 前核对目录 identity、metadata 与空目录状态；因此临时全局写入后搬运、只迁 summary、或为全局 correctness 文件建锁都会失败。guard observation 本身写入当前 attempt 的 producer receipt 链。physical producer、projection、observation 或 aggregate verifier 任一失败和取消都仍通过 `finally` 只读封存当前 attempt；下次 resume 只能创建新 attempt。

Static governance Node contract 的 resident host 隔离分类与 frontend
structure producer-receipt join 见
[`testing/static-governance-resident-hosts.md`](testing/static-governance-resident-hosts.md)。
pure/file 检查共享 host，lifecycle 与 destructive rehearsal 保持独立进程；
最终性能结论仍必须来自同 source 的三轮 Production fresh，不得由局部验收替代。

Browserless integration/security/resilience runtime probe 的 source/run-bound
scenario catalog、常驻 Node host、identity/reset barrier、独立 result、取消
partial evidence、同机三轮 before/after 指标与即时 per-CLI 回退见
[`testing/runtime-scenario-host.md`](testing/runtime-scenario-host.md)。wall time、
CPU、Node process 与 connection setup 只用于性能观察，绝不参与 correctness。

## 可执行数据测试治理

可执行数据约束必须由真实 owner test 和中央事实源共同表达，不使用 issue 文档充当测试清单：

- `tests/backend/Fixtures/backend-test-requirements.json` 声明后端能力与直接测试 owner；
- `tests/coverage-registry.json` 声明 coverage 语义和最低证据要求；
- `tests/matrix.yml` 声明执行 DAG、资源和 artifact；
- `tests/test-retention-replacements.json` 记录删除或合并时的 replacement 证明。

数据库 fixture 必须保留生产字段语义、约束和安全版本。例如 recovery-key limiter 由对应 service/contract tests 证明 attempt/window/lockout；subscription fixture 保留 `user_id`、`public_handle`、`hash_version` 和 proof 校验；demo seed 只能生成开发数据且不能绕过 production schema。security-state fixture 只通过 Development/Test composition root 调用 production risk、blacklist、credential、nullifier、issuance audit 和 cache ports；每次请求绑定 exact run、namespace、profile 与 semantic temporal context，以私有 owner ledger 做 independent observation、partial-failure recovery 和 exact cleanup，禁止阈值覆盖、Redis scan/flush 或 global reset。静态文本检查不能替代事务、并发、幂等、迁移失败或 `WebApplicationFactory` 行为测试。

`auth-session` 是 user/MFA/WebAuthn/session/admin capability 的唯一
`transaction-fixture` owner。它按 run、namespace 与 semantic role 为互斥状态
派生独立 identity，只编排受限后端 lifecycle ports；Node producer 不连接
PostgreSQL/Redis、不签 JWT，也不拥有 ban、risk、PoW 或 credential issuance
状态。Passkey capability 必须经过 production FIDO validation 与受控
authenticator，不存在 accept-any 分支。普通 producer receipt 只保留 public
identity/state/digest 与 read-model postcondition；token、MFA secret、recovery
material 和 authenticator private material 不进入 receipt 或日志。每个结果还必须
通过独立 `/api/local/auth-fixture/verify` read port 绑定完整 receipt digest，
partial 或 self-reported observation 不发布 verified receipt。

需要同一 capability 的多个独立 identity 时，consumer producer 必须在自身
normalized port 的 `identityRoleRequests` 声明
`ownerProducerId`、`consumerProducerId`、`role` 与其 catalog-declared
`capabilityId`。当前只允许分配 `auth.user.active` 与
`auth.admin.full-permission`；orchestrator 把所有 planned consumer request 一次性交给
`auth-session`，并将排序后的完整 request list 纳入 auth plan digest。prepare
阶段输出 `fsusblog.fixture-identity-prepare-reference.v1`，明确标为
`verified: false`；consumer 不得改写 owner 或自行构造 fallback identity。verify
阶段取得 auth-session 的 sealed `ProducerReceipt` 后，调用
`projectVerifiedIdentityReferences` 生成 consumer-scoped
`fsusblog.fixture-identity-references.v1`。每个 verified reference 绑定
prepare-reference digest、producer-result digest 与 `sourceReceiptDigest`，且只能投影
该 consumer 预先声明的 role。

`auth-session` 是 user/MFA/WebAuthn/session/admin capability 的唯一
`transaction-fixture` owner。它按 run、namespace 与 semantic role 为互斥状态
派生独立 identity，只编排受限后端 lifecycle ports；Node producer 不连接
PostgreSQL/Redis、不签 JWT，也不拥有 ban、risk、PoW 或 credential issuance
状态。Passkey capability 必须经过 production FIDO validation 与受控
authenticator，不存在 accept-any 分支。普通 producer receipt 只保留 public
identity/state/digest 与 read-model postcondition；token、MFA secret、recovery
material 和 authenticator private material 不进入 receipt 或日志。每个结果还必须
通过独立 `/api/local/auth-fixture/verify` read port 绑定完整 receipt digest，
partial 或 self-reported observation 不发布 verified receipt。

需要同一 capability 的多个独立 identity 时，consumer producer 必须在自身
normalized port 的 `identityRoleRequests` 声明
`ownerProducerId`、`consumerProducerId`、`role` 与其 catalog-declared
`capabilityId`。当前只允许分配 `auth.user.active` 与
`auth.admin.full-permission`；orchestrator 把所有 planned consumer request 一次性交给
`auth-session`，并将排序后的完整 request list 纳入 auth plan digest。prepare
阶段输出 `fsusblog.fixture-identity-prepare-reference.v1`，明确标为
`verified: false`；consumer 不得改写 owner 或自行构造 fallback identity。verify
阶段取得 auth-session 的 sealed `ProducerReceipt` 后，调用
`projectVerifiedIdentityReferences` 生成 consumer-scoped
`fsusblog.fixture-identity-references.v1`。每个 verified reference 绑定
prepare-reference digest、producer-result digest 与 `sourceReceiptDigest`，且只能投影
该 consumer 预先声明的 role。

Account messaging fixture 的 capability 与 owner authority 分别是 `config/testing/messaging-fixture-inventory.json` 和 `config/testing/messaging-fixture-ownership.json`。唯一 Node producer `tools/test-fixtures/producers/account-messaging-producer.mjs` 必须消费 `auth-session` 发布的 exact prepare identity references 与 sealed temporal-role artifact，再经 development-only、loopback/secret-gated composition root 调用真实 message command、outbox fan-out、notification stream、query 和 cache 路径；禁止 direct SQL seed、first-row discovery、sleep/random ordering、mock stream 或 structural fallback。verify 阶段必须把同一组 prepare references 绑定到 `auth-session` sealed ProducerReceipt 的 verified projection，不得在 prepare 阶段预声明 verified 或伪造 receipt digest。空 inbox/notification 必须由独立 empty identity 证明 exact zero，不能用过滤隐藏旧资料。

Prepare 结果逐 capability 绑定 database/API/cache/outbox/stream 的 exact observation，并只在 cleanup receipt 中携带本轮 namespace 拥有的 entity/key IDs；普通 artifact 不保存 message body、cookie、session、token 或 notification payload。verify 必须重新读取服务状态并拒绝 count-only 或 warning success，cleanup 只能删除 receipt-owned 身份。`node tools/test/check-messaging-fixture-governance.mjs` 生成 source-bound cleanup 与 terminal acceptance receipts；只有 owner closure、mutation cases、parallel/rerun isolation、consumer parity 和 privacy 全部 accepted 且 warnings 为零时才通过。

测试删除、重命名、合并、参数化、拆分或 support move 必须通过 `node tools/test-replacement-transaction.mjs plan|verify|apply` 形成单一事务：它同时封存 before/after canonical test ID、source/framework/runtime/platform/fixture、production symbol、assertion、requirement、coverage、tier、quality 与 retention 维度，并原子更新 source、retention ledger、backend requirement、coverage registry、matrix 和 generated testing docs。任一路径或事后验证失败必须回滚全部文件，仅成功后产生 sealed receipt；`check-diff` 在治理 lane 中阻断没有事务的 discoverable test/case 移除。没有等价可执行断言时，只能对每个旧 case 和 assertion 显式记录 `retired` disposition，不得用文档、fixture 文件存在性或历史 evidence 替代测试。

性能测试资产统一放在 `tests/performance/`，不再保留旧短名测试根。`browser-contract` 是 release correctness 的最小浏览器契约，而 `browser-diagnostics` 是 scheduled/manual 的诊断集合；两者的命令、artifact 和结论互不替代，diagnostics 失败不能伪装成 correctness 通过，contract 通过也不能覆盖 diagnostics 的独立风险报告。

`tests/coverage-registry.json` 是 matrix `coverage[]` 的机器可读索引。每个 coverage id 必须声明 `description`、`owner`、`risk`、`evidencePaths`、`assertionType`、`failClosedRule` 和 `minimumRequirement`；`description` 必须描述实际覆盖语义，不能保留 `Coverage contract for ...` 这类模板句，`minimumRequirement` 必须写明最低可接受断言或 evidence 形态，不能只重复 tier 类型。`tools/run-test-matrix.mjs validate` 会拒绝未注册的 coverage id、未被对应 tier artifact/evidence 声明的 evidence path、未使用的 registry id，拒绝只指向 unit/property 测试文件却标成非 `unit` 的明显 assertionType 错配，也会拒绝 `runtime` / `browser` / `perf` / `fuzz` / `mutation` 类型只指向静态 docs/source 文件的条目。该 registry 不替代测试本体，只把“这个 coverage 标签由什么证据证明”变成 fail-closed 合同。

<!-- fsus-doc-claim
claimId: test-asset-audit-reconciliation.coverage-entry-count
behaviorId: test-asset-audit-reconciliation
claimType: generated-section
generatedSectionId: testing.coverage-entry-count
render: scalar
-->
<!-- FSUSBLOG-GENERATED:BEGIN testing.coverage-entry-count -->
261
<!-- FSUSBLOG-GENERATED:END testing.coverage-entry-count -->

`config/testing/content-shape-catalog.json` 是 Unicode、script、正负 eligibility
与 content consumer applicability 的唯一可编辑 `ContentShapeCatalog`。
`tools/testing/content-shape-catalog.mjs` 从当前
`ArticlePublicationValidator`、`CommentLimits` 和 comment binary endpoint 生成并核对
`config/testing/content-field-contracts.generated.json`；测试不得另抄 article/comment
字符或 UTF-8 byte 上限。production 的“字符”计数语义固定为 .NET UTF-16
`string.Length`，byte 计数固定为 `Encoding.UTF8.GetByteCount`，generator 另行记录
Unicode scalar 与 grapheme statistics，但不得拿它们替换 production 判定。当前 comment
的 1000 UTF-16 unit 上限会先于 4096-byte 上限约束所有合法 Unicode 文本，因此 byte
boundary case 仍是独立 dimension evidence，而不是伪称为可单独达到的整体正向输入。

`tools/test-fixtures/content-shape-generator.mjs` 只接受 shape ID、field ref、固定 seed、
generation version 和可选 boundary case ID，并从 catalog code-point recipe 纯函数生成 exact
bytes、normalization 前后统计和 digest；correctness 路径禁止 wall clock、runtime random、
ASCII byte proxy、`all-unicode` catch-all 或 per-test generator。zero-width/bidi 只属于
negative shape；普通 positive profile 不得消费。ContentShape authority digest 已进入
FixtureVariant plan 与 FixtureReceipt 使用的 fixture catalog digest，所以 locale、production
field contract、schema 或 catalog 改变都会使旧 corpus identity 失效。本层不生成
Markdown/search expected facts、不迁移 consumer，也不把全文写入默认 receipt/log；全文只应
存入 run-owned fixture artifact。

私有文章预览浏览器验收由 matrix leaf `article-private-preview` 唯一拥有，不再附带在
`check:spa:routes`。`tools/test/lanes/article-private-preview.sh` 只连接 Debug
frontend/backend，经 FixtureOrchestrator 准备
`acceptance-representative` admin/session fixture，并固定 managed Chromium、
session isolation、一个 worker 和零 retry。package 入口
`check:article-private-preview` 不能接收 spec、grep、shard 或 worker 参数，只运行
`tests/frontend/e2e/acceptance/article-private-preview.spec.ts`；artifact 固定写到
`src/frontend/test-results/playwright/article-private-preview`。该 spec 必须通过真实
AEDS preview 响应证明 current source completion、在途表单变化后的 stale response
拒绝、复杂 Markdown activation 与 hostile markup containment，并保留 wide-light 和
mobile-dark 的 rendered evidence。它属于 scheduled/manual browser diagnostics，
不能替代 `browser-contract` correctness，也不能被通用 route acceptance 的结果代替。

生产 XSS conformance 由 `production-xss-fast` 与 `production-xss-release` 两个 matrix
leaf 共同拥有。两者直接加载本地 FsusUI alias 的 test-only corpus，禁止复制 payload
清单或要求发布 FsusUI 包；fast 每个顶级类别取一个代表 case 并只跑 managed Chromium，
release 消费完整人工 corpus 并并行运行 Chromium、Firefox、WebKit。它们复用同一
Release frontend、Kestrel、PostgreSQL snapshot 和 browser worker，覆盖禁用 JavaScript
的 AOT DOM、hydration、SPA 导航、About、评论持久化/重载和 admin 私有预览，并把
`corpus ID × surface × browser × phase` 写入唯一 `matrix.json`。任一脚本执行、外部
请求、导航/窗口/下载、危险 DOM、CSP 或 Trusted Types 观测均 fail closed。

普通 PR 使用 smart gate：`plan-pr-risk` 始终运行并生成 `.tmp/pr-plan.json` 与 `.tmp/release-evidence/pr-smart-gate-summary.json`，fast lane 与 backend-qps sentinel 默认保留，Production、release、load、resilience 等 correctness lane 只在 changed paths、coverage id 或显式 full gate 命中时运行。backend/frontend coverage 已并入对应 fast `ci-job`，并通过 `supersedes` 替代同一 `executionKey` 的普通 unit 执行；跳过必须写入 skip evidence，不得 silent skip。`production-correctness` 的完整依赖闭包固定为零浏览器、零 Playwright、零 browser resource、零 session schema；release-final 通过 evidence-only 绑定通用单 Chromium `browser-contract` 与专用 Chromium/Firefox/WebKit `production-xss-release`，两者都不成为 production scheduler edge。其他 Acceptance、visual、UX full/risk、geometry/motion/focus、browser a11y/performance/resilience 以及 search/PoW/permission/zero-auth browser probe 只由 scheduled/manual diagnostics 运行。完整拓扑见 [`testing/issue-1150-browserless-ci-topology.md`](testing/issue-1150-browserless-ci-topology.md)，receipt、flaky 与迁移治理见 [`testing/issue-1151-evidence-governance.md`](testing/issue-1151-evidence-governance.md)。

`run-deterministic-command.mjs` invocation 必须显式声明 `--execution-class correctness|diagnostic` 与 `--producer-id`。`config/testing/producer-execution-class-contract.json` 是 matrix `evidenceClass` 到 execution class 的机器可读映射：默认 correctness 与 browser-contract 都要求 producer、scheduler run 和 source identity，diagnostic 恒定不可 qualification。correctness 在 child spawn 前要求 `FSUSBLOG_TEST_RUN_ID`、`FSUSBLOG_TEST_SOURCE_COMMIT`、`FSUSBLOG_TEST_SOURCE_FINGERPRINT`，缺任一字段以 `contract.missing-run-identity` 失败且零执行；它不生成 local、timestamp 或 latest fallback。diagnostic 也必须显式选择，才可 direct 执行，并恒定输出 `qualificationEligible=false`，不得发布 correctness projection。

Correctness Playwright 的 browser/rendering identity 由
`config/testing/playwright-browser-identity-policy.json` 与
`tools/test/playwright-browser-identity.mjs` 唯一管理。普通 Playwright config、
`browser-contract` 与 `production-xss-release` 都只使用
`@playwright/test` 当前 lockfile 安装的 managed browser；不搜索系统 PATH、macOS
Applications 或 `/usr/bin/google-chrome`，也不接受
`PLAYWRIGHT_*_PATH` 覆盖。plan 在 launch 前绑定 browser name/version/revision、
canonical absolute executable path 与 SHA-256、Playwright package/catalog、完整
launch args，以及 font/locale digest、locale、device scale、headless rendering、
color scheme 和 software GPU mode；launch 后重新 hash binary 并要求 browser version
及整个 actual identity 与 plan exact match。managed browser 缺失、binary/revision/path/
args/rendering 漂移都在 correctness evidence admission 前 fail closed。host browser 只可
存在于 diagnostic identity，固定 `qualificationEligible=false`，不能升级成 correctness
或 `browser-contract` evidence。Local、CI、published/local FsusUI 模式共用这份 policy；
各机器的绝对安装路径可以不同，但同一 run 的 planned/actual path 必须完全相同，且
revision、binary digest 与 Playwright catalog 必须一致。

correctness 的 execution envelope 由 `config/testing/test-execution-envelope-policy.json` 与 `config/testing/test-execution-envelope-applicability.json` 唯一定义；每个非 diagnostic producer 必须按 execution class 恰好映射一次。runner 只继承固定 locale/timezone、`PATH`、显式 `--env` allowlist 与 run/source/temporal identity，并在 spawn 前对实际 executable 的 absolute path、realpath、version 和 SHA-256 与 plan 做 exact-match；secret 只记录 presence、type 和 digest。每个 attempt 拥有独立的 HOME、TMP、npm、NuGet、dotnet 与 tool cache root，并在 success、failure、timeout 或 cancel 后只删除本轮 owned root；路径 realpath/symlink 逃逸会在 spawn 前 fail closed。

correctness network 默认 deny，Linux 为每个 attempt 加载 systemd `IPAddressDeny=any` / `IPAddressAllow=localhost`，仅让 catalog 中由当轮 service envelope 封存的 loopback port 成为合法 endpoint；同时以 Landlock 将 repository/toolchain 设为只读、只允许 run-owned roots 与显式 `--output` 路径写入。`strace` observation 封存 connection、DNS、proxy/certificate 输入和 denial，planned/actual endpoint 不精确一致就拒绝该 evidence；隔离或 observation 不可用时不降级执行。build/restore transfer 是独立 phase，不属于 correctness network allowlist，也不能用后续成功覆盖 correctness 中的下载尝试。

acceptance 五项 service 的版本、image digest、topology、port/network namespace 与 resource limit 以 `config/testing/test-execution-service-catalog.json` 为唯一目录。PostgreSQL/Redis 只接受目录中的 digest-pinned local image；bootstrap 不在 test phase pull image，缺少时直接失败，应先在独立 restore/preparation 阶段预载。bootstrap 将实际 roster 写到 `FSUSBLOG_TEST_SERVICE_ENVELOPE_FILE`，runner 仅在 planned/actual 全字段一致时接受。

每个 correctness attempt 在 child 启动前写入 planned execution envelope，postflight 聚合 env/executable、browser/rendering、service/topology、directory/filesystem、network 与适用 host facts 后封存 `fsusblog.test-execution-envelope-receipt.v1`。`tools/test/verify-execution-envelope.mjs --plan <plan> --receipt <receipt>` 以独立路径验证当前 policy/catalog/receipt-schema identity、applicability 完整性、planned/actual exact match、精确 fragment/self digest 集与 run/source/attempt identity；只有 catalog 明确标记 `not-applicable` 的 domain 才能携带对应缺省理由。仅在该验证通过后，同一 envelope/receipt digest 才能绑定 producer receipt、temporal replay plan 与 release evidence。
测试执行 replay 的 qualification producer 闭包由
`config/testing/replay-qualification-producers.json` 唯一声明。xUnit 适配器通过
`xunit.runner.utility` front controller 取得真实 assembly、collection 与 test-case
inventory，并在父 runner 派发前封存 collection-preserving queue；每个 slot 是独立 OS
child，child 必须在调用 xUnit `Run` 前回报真实 PID、collection 和 test-case admission。
Vitest 适配器通过 `vitest list --json` 取得 inventory，以 test file 为不可拆 atom 建立
repo-owned lane；controller PID 与 `setup.ts` 从真实 pool process 回报的 PID 都进入 actual。
Playwright 适配器只使用公开 `--list --reporter=json` 与 `--test-list` 接口建立 N 条
repo-owned lane，每条 lane 固定一个 runner worker，并保留真实 `workerIndex`、
`parallelIndex`、outcome 与 browser artifact。三者都禁止从完成顺序、默认 worker 数或
父进程推断 admission/worker identity；replay 只消费已封存的 plan 和 queue，不重新
discovery、replan 或动态偷取工作。

`tools/test/run-replay-qualification.mjs` 是唯一会启动 qualification producer 的入口。
`--family framework` 对 xUnit、Vitest、Playwright 分别执行 1、2、planned worker
topology 的首次运行与全新进程 replay；`--family randomized` 从
`config/testing/random-stream-consumers.json` 自动计算 property/model/perf/fuzz
consumer closure，并对相同三种 topology 重建并核对派生 stream。两族都必须覆盖
inventory 声明的 filesystem enumeration、reported CPU/load、parent environment、
framework default worker、worker restart 与 completion timing 扰动，且 source、run、
plan、actual 和 receipt digest 完全绑定。标准收口顺序如下；两族必须在没有中途 source
修改的同一 `run-id` 下生成：

```bash
node tools/test/run-replay-qualification.mjs --family framework --run-id <run-id> --root-seed <seed256> --output-dir .tmp/test-runs/<run-id>/framework
node tools/test/run-replay-qualification.mjs --family randomized --run-id <run-id> --root-seed <seed256> --output-dir .tmp/test-runs/<run-id>/randomized
node tools/test/aggregate-replay-qualification.mjs --framework .tmp/test-runs/<run-id>/framework/framework.json --randomized .tmp/test-runs/<run-id>/randomized/randomized.json --out .tmp/test-runs/<run-id>/replay-qualification.json
node tools/test/verify-replay-qualification.mjs .tmp/test-runs/<run-id>/replay-qualification.json
```

aggregate 与 verifier 只能读取命令行显式指定的 family/result/plan/actual/receipt，并从
canonical inventories 独立重算 exact closure；它们不得扫描 `latest`、启动 producer、
补写缺失证据或把 diagnostic/recovered 结果提升为 qualified。聚合成功只表示所有真实
producer 的原始引用与扰动覆盖完整，不替代这些 producer 的执行。

Qualification 时间权威与业务/测量时钟分离由 `config/testing/temporal-policy.json`、`config/testing/temporal-context.schema.json` 与 `tools/test/temporal-context.mjs` 承载：唯一 temporal context 绑定 source/run/producer、固定 UTC business epoch、timezone/culture 与 immutable call-site ledger digest；plan/actual/receipt 必须 exact match，`generatedAt` 只进入 artifact metadata 且不进入 semantic outcome digest。Business wall clock 通过后端 `TestTemporalContext` / `TimeProvider` 与 Node `createBusinessWallClock` 注入并只允许显式推进；monotonic measurement 继续使用 `performance.now` / `process.hrtime.bigint` / `Stopwatch` 真实推进。

`config/testing/temporal-shape-catalog.json` 是 fixture semantic temporal role 和边界 shape 的唯一、闭合且版本化权威；不得再新增第二份 timestamp 情景表、私有 epoch 或 producer-local offset。`tools/test/temporal-role-resolver.mjs` 只从 producer-bound temporal context 和该 catalog 纯函数解析 exact millisecond UTC/local/offset/business-state，并为 Node、.NET、PostgreSQL 与 browser 输出同一 content digest 的投影；跨运行时 consumer 只验证并消费 artifact，不重算 offset。显式 advance 只改变 business-wall role，不改变 monotonic clock；same-timestamp ordering 和 out-of-order occurred/arrival 必须按 catalog tie-breaker/invariant 验证。`tools/test/check-temporal-shape-governance.mjs` 独立拒绝第二权威、未登记 role、私有 wall clock、sleep 和 SQL interval 重算。

`config/testing/temporal-producer-bindings.json` 与 `tools/test/temporal-producer-bindings.mjs` 对 fixture consumer inventory 和真实 producer execution boundary 做 exact closure；`tools/test/verify-temporal-producers.mjs --kind catalog` 是 static-governance 的 fail-closed 入口。`FixtureOrchestrator` 为每个已计划 producer 派生 producer-specific context，producer child、backend/PostgreSQL adapter 或 browser 必须回传 actual observation；orchestrator 以真实 producer output 生成 semantic digest，并把 plan/actual/context/output digest 写入最终 `ProducerReceipt`。`tests/frontend/support/session-fixtures.mjs` 当前同时出现在 auth-session 与 security-state 的既有 implementation inventory 中；temporal ledger 对该物理 source 只登记一次，并要求其中的业务时间来自显式 fixture business epoch，artifact `generatedAt` 单独归类且不进入 semantic outcome。

canonical correctness runner 在 child spawn 前注入 context，由 child observer 回传 actual，而不是由父进程复制 plan；run-bound physical receipt 的 output state 同时进入 temporal outcome digest，epoch/locale 改变时不得误复用旧执行。`tools/test/write-temporal-context.mjs` 为 browser-contract 生成 run/source-bound context；Playwright config 与 library runner 同时绑定 `locale` 和 `timezoneId`。browser runtime 读取 `navigator.language` 与 `Intl` timezone，backend 解析并 exact-match `FSUSBLOG_TEMPORAL_CONTEXT_JSON`，PostgreSQL connection session 设置并回读 `TimeZone` 与 `fsusblog.test_business_epoch_utc`；三类 actual 合并后才可产生 browser temporal receipt。

`tools/test/check-wall-clock-governance.mjs` 从 fixture inventory 与 producer execution-boundary catalog 计算完整扫描闭包；ledger 少一个或多一个 source、漏分一个 clock call、混用 business/measurement clock 都失败。`tools/data-scale/seed.sh` 的业务时间字段读取 session-injected fixed epoch，duration/generatedAt 仍分别属于 measurement/artifact。TTL/expiry correctness 使用 injected `TimeProvider` 推进，timeout 与 duration 保持真实 monotonic clock。UTC midnight、leap day、month/year、DST forward/backward、scheduled/expiry/retention boundary 与 out-of-order 只在 `temporal-shape-catalog.json` 声明；测试在独立 Node runtime 中执行各 timezone/culture shape，并通过真实 correctness child 对 host `TZ` 与 wall-clock offset 做扰动，业务 timestamp 始终保留在 semantic digest。

`config/testing/temporal-domain-producer-inventory.json` 限定本阶段迁移的 auth/session、security 和 account-messaging producer，并把每个持久化字段、consumer 和 semantic role 做 exact mapping。`FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON` 和 `FSUSBLOG_TEMPORAL_ROLE_ARTIFACT_DIGEST` 是 child/.NET ingress；receipt 只保留 producer/role/state/invariant/digest 绑定，不复制绝对 instant 或 secret。该三类 producer 不得再读取 `Date.now` / `DateTime.UtcNow`、不得用随机 microseconds 打破并列、不得通过 sleep 证明 expiry，PostgreSQL adapter 也不得用 interval 重算 role。

generic runner、scheduler 与 Release Reliability driver 的 physical execution termination 只通过 `tools/test/physical-execution-process-tree.mjs` 进入。Linux 在可验证的 transient systemd cgroup 中同时保留 run-owned process group，因而 `setsid`/daemonized descendant、继承输出 FD 和端口持有者仍受同一 control-group authority 收容；authority 不可用时在业务 child spawn 前 fail closed。macOS 使用独立 process group；Windows 通过 creation-suspended、assign-before-resume 的原生 Job Object adapter，并启用 kill-on-close。`SIGINT`、`SIGTERM`、`SIGHUP`、上层 `AbortSignal`、action deadline、producer failure 与 runner exit 汇入同一个 idempotent cancellation path；第一个原因保持 `firstFailure`，重复取消只计数，containment、terminal wait 和日志 finalization 的后续错误进入 `cleanupFailures`，不能覆盖首因。

action deadline 只来自 `config/testing/release-reliability-lifecycle-action-registry.json`，数值不由 driver、catalog 或 physical policy 重算；`config/testing/physical-execution-process-policy.json` 只拥有 TERM grace、force-kill、pipe-close 和连续 zero-member observation。取消后 executor 停止新 spawn、转发 graceful signal、等待 grace、强制终止剩余树、在有限期限内关闭 stdout/stderr pipe，再以稳定连续空观察证明 authority 为 zero-members。每个 action 的 outer executor 写一个 sealed process-tree receipt；reset-after child 只通过显式路径读取 measurement action 的 raw receipt并保存最小 binding，independent verifier 再次读取原始 bytes，不能由 lifecycle producer 重封或补写。父进程退出、PID start identity 漂移、成员收集失败、pipe 不关闭、迟到 evidence 或稳定零成员未证明都不能产生 success。receipt 保留 bounded stdout/stderr、总字节数、capture truncation、`logComplete`、`logTruncationReason`、`forcedPipeClose`、逐进程 start/executable/command identity、containment authority、signal/exit 与 terminal fence；partial log 是诊断证据，但不能覆盖首次失败或被解释为完整日志。

测试瘦身只允许基于机器证据推进。`static-governance` 的 `test-assets` phase 会先且仅先运行一次 `tools/check-test-retention.mjs`，完整写入 matrix 声明的 canonical `.tmp/release-evidence/test-retention-audit.json`，再让 lifecycle 与 test-asset audit 通过 `--audit-input` 消费同一份 source/run-bound artifact；二者不得在该 phase 内启动第二次 retention scan 或生成 lane-local 输入。CI 直接执行这个 canonical tier，不再在 tier 之后补跑另一套 test-asset audit。standalone lifecycle 或 audit 仍可自行生成诊断 retention，但不能成为 release authority。audit 不再用文件名、大小或 regex `assertionEstimate` 作决策；它对 canonical `testCaseEstimate` 中的每个 case 消费 inventory、resolved oracle facts、quality outcome、production owner、requirement、coverage 与 matrix tier，归类为 `must-keep`、`conditional`、`review-candidate`、`replaceable-candidate`、`obsolete-candidate` 或 `blocked-quality`。风险名称只能触发 `review-required-risk-name`，不能自动提升或删除；无法解析的 oracle 或质量失败必须阻断 replacement，不得生成 `behavior:<name>` 占位断言。每个 case 保存 framework、runtime boundary、production symbols、tier 调用次数、p50/p95、coverage/requirement IDs、resolved assertion targets、quality violations、失败历史、唯一证据与 replacement IDs；没有计时或历史样本时必须显式记录证据缺失，不能伪造为零。`catalogSnapshot` 同时保存 matrix tier/artifact/evidence、coverage registry、backend requirement catalog 与 release-evidence 路径及其源文件 SHA-256。producer 元数据记录 `runId`、`sourceState` 与 `generatedAt`；矩阵内执行自动继承 `FSUSBLOG_TEST_RUN_ID`，而 standalone audit 的 `runId=null` 只能用于诊断。只有 coverage registry、resolved assertion、critical mutation slice 与 matrix/requirement/release-artifact 维度均不下降，且 replacement transaction 为每个旧 test ID 和 assertion 给出存活 replacement 或显式 retirement，才允许变更。

权威 before snapshot 固定为 `tests/test-retention-before.json`。它由删测前的完整 audit 压缩生成，绑定当时的完整 commit 与 tracked worktree fingerprint，并内嵌 backend/frontend/merged coverage 基线和 `backend-mutation` / `release-mutation-critical-slice` scope identity。仓库一旦存在该文件，capture 命令会拒绝向任何路径再次捕获 before。若从已保存的 clean audit 迁移，`--audit-input` 会先验证 matrix、coverage registry、requirement catalog 与 coverage baseline 和该 audit commit 完全一致。后续历史 replacement 条目只作为前序声明被继承；当前删除必须由 lifecycle registry、post-baseline manifest、replacement ledger 与 suite-convergence 正负测试持续证明，不再生成一次性的 optimization campaign 报告。

local production 的 backend union 由 `tools/test/run-backend-production-shards.mjs` 执行。脚本先用 `Category!=Integration&Category!=Performance&Fixture!=LocalRedis` 发现本轮全部测试，再按完整测试方法名生成确定性、互斥的分片；每个分片使用同一次 fresh build 的独立 DLL 复制，避免 Coverlet 并发插桩同一文件。成功条件不是“两个命令均返回 0”，而是各 TRX 的逐方法用例计数与 discovery 完全一致、所有 outcome 均为 `Passed`。每个分片只生成 Coverlet JSON 与紧凑 identity sidecar；sidecar 绑定 run/source fingerprint、raw digest、module/source universe。只有 shard universe 完整且 binding 一致，才允许合并权威 Coverlet JSON，并从内存中的 merged result 一次性生成最终 Cobertura 和 Summary。`.tmp/dependency-cache/dotnet` 只保存 NuGet/.NET 工具依赖缓存，可跨 fresh 保留；编译输出统一写入 `.tmp/build/<run-id>`，新 fresh run 通过新根获得空状态，TRX、coverage、checkpoint 与 release evidence 仍逐轮重建，不能作为历史结果复用。布局、锁与 GC 契约见 [`testing/issue-1069-run-bound-production-builds.md`](testing/issue-1069-run-bound-production-builds.md)。

同一 run 的物理 artifact 内容摘要由单一、source-bound 表生成，bundle member 与 logical tier 通过 artifact ID 引用复用；表最终副本和自身 content digest 一并进入 release evidence/checkpoint。缓存只用 inode/size/mtime/ctime 等判定是否需要重新读取，权威值始终是内容 SHA-256 或确定性目录树 fingerprint。详见 [`testing/issue-1070-production-artifact-digest-table.md`](testing/issue-1070-production-artifact-digest-table.md)。

逐测试稳定性与耗时使用 `fsusblog.test-observation-artifact.v1` run-local projection。`tools/test-observations/cli.mjs adapt` 将 TRX、Vitest JSON、Node TAP 或 Playwright JSON report 映射到同一 schema；每条 observation 都绑定 canonical test ID、suite/framework/partition、outcome、duration、failure signature、source commit、worktree fingerprint、test/source closure digest、runner identity、run/attempt/evidence class 和原 report SHA-256。原 producer report 始终是权威 evidence，ledger 不复制完整 report，也不改变任何 correctness pass/fail 结论。聚合器会在可用时重新哈希 producer reference，并拒绝 record/artifact 间 source、closure、run、runner 或 producer binding 不一致。

本地历史目录只接受按 artifact content digest 幂等追加的 normalized artifacts；`rebuild` 可在删除 `index.json` 后重建按 test ID 的 P50/P95、outcome count 与 signature count。空目录返回 `coldStart=true`，历史缺失不阻断当前 correctness。默认显式 compaction policy 为 180 天或最多 2,000 个 run artifact，取更严格边界；compaction 只删除本地 projection artifact 并使派生 index 失效，绝不删除 producer report。仓库不提交个人机器历史。完整字段、命令与 failure normalization 规则见 [`testing/evidence-projection-contract.md`](testing/evidence-projection-contract.md#per-test-observation-ledger)。

同一 phase 且依赖已满足的 ready set 可使用 `fsusblog.test-matrix.priority-score.v1` 做确定性启动排序。只有 test ID 与唯一 source-closure digest 完全匹配且样本足够的 ledger 才参与；changed-source、risk、失败概率/签名、预计耗时与有限 wave aging 均写入 checkpoint breakdown。任何 cold/mismatch/undersampled 输入整组退化到既有 `startupAdmissionOrder`。该分数不改变 dependency、phase、exclusive/service、CPU/memory、maxParallel、exact-once、最终 test union 或 evidence owner；`FSUSBLOG_TEST_DYNAMIC_PRIORITY=0` 可关闭用于本地对照。完整模型、fixture 与回退规则见 [`testing/evidence-projection-contract.md`](testing/evidence-projection-contract.md#source-bound-ready-set-priority)。

flaky 重复采样使用完全独立的 observation-only lane：`tools/test-observations/flaky-observer.mjs` 只执行 `--test-id` 或版本化 candidate manifest 显式列出的测试，每次 attempt 都启动新进程并记录 seed、source commit、worktree fingerprint、runner/producer identity、duration、outcome、failure signature 与 raw evidence digest。分类固定为 `stable-pass`、`stable-fail`、`outcome-inconsistent`、`signature-inconsistent`、`environment-failure` 或 `insufficient-samples`。该 evidence 永远声明 `affectsCanonicalCorrectness=false` 与 `satisfiesReleaseCorrectness=false`；后续通过不能覆盖 correctness 首次失败。仓库 candidate registry 的任何改动都是普通受审配置变更，observer 不会自动 quarantine、跳过测试或改写 `tests/flaky.yml`。命令与校验说明见 [`testing/evidence-projection-contract.md`](testing/evidence-projection-contract.md#isolated-flaky-observation-lane)。

production scheduler 的 reserved/granted 资源不能替代实际利用率。fresh 运行会生成绑定 run/source/checkpoint/bundle summary 的 canonical CPU、RSS、I/O、动态 grant 积分、等待分类及 collector 开销证据；失败运行也保留 partial evidence。指标定义、平台降级和采样误差见 [`testing/issue-1071-production-resource-utilization.md`](testing/issue-1071-production-resource-utilization.md)。

Linux production 可把动态 grant 映射为 run-bound cgroup v2 与 Docker/OCI CPU、memory、pids 边界；bundle entry 在归组后才恢复执行，动态扩缩会立即更新控制文件。无 controller/delegation/rootless 权限时 `auto` 明确降级并写 evidence，`strict` fail closed，`off` 可完整回滚。策略、平台合同和清理语义见 [`testing/issue-1072-production-resource-enforcement.md`](testing/issue-1072-production-resource-enforcement.md)。

Production 的 unit/property/model Vitest 使用单次权威 test catalog、确定性 immutable partition 和 live grant rolling host；grant 扩张可增加 host，收缩只停止新 admission，不再为 coverage universe 冷启动无测试进程。exact-once、隔离输出、coverage 与证据合同见 [`testing/issue-1073-production-vitest-rolling-hosts.md`](testing/issue-1073-production-vitest-rolling-hosts.md)。

rolling host 直接调用 lockfile 内的 Vitest entry。catalog 与独立 zero-hit coverage universe 先形成 source/toolchain/config-bound immutable transform base；普通 host 只运行 base view + 私有 journal delta，summary 记录 base/delta bytes、clone mode、journal/merge traversal 和规范化 coverage hit-map digest。带 `@fsusblog-vitest-host max-workers=1` 的实测 import-sensitive 文件会进入单文件、独占单 worker partition，但仍属于同一 authoritative catalog 和 exact-once universe。JSON/JUnit 在 coordinator 内轻量合并，blob 保留为原始证据，不再为 merge 启动 Vitest。详见 [`testing/issue-1387-rolling-vitest-cache-and-coverage.md`](testing/issue-1387-rolling-vitest-cache-and-coverage.md)。

Production `runtime-browser` 已停止声明或动态解析 counted `chromiumLane`，也不再生成 browser admission evidence。#1150 后该兼容 bundle 实际只承载 browserless runtime/database correctness，普通 correctness 中不存在窄 browser acceptance。固定单 browser admission 只属于 release `browser-contract` 或 nightly/manual diagnostics 外层。退役边界与回退合同见 [`testing/issue-1074-runtime-browser-counted-slots.md`](testing/issue-1074-runtime-browser-counted-slots.md)。

视觉、UX viewport、cross-browser、geometry/motion/focus、browser a11y、真实 renderer/AEDS browser performance 与 browser resilience 已建立独立 diagnostics 目录和 scheduled/manual workflow。每类独立保留 summary/artifact，runner 固定一个外层 worker、内层 worker 1、0 retry 且无 dynamic inner pool，聚合全部独立失败，并把 browser crash/OOM/launch failure 标为 infra；这些 evidence 不改变普通 correctness 结论。跨浏览器执行进一步由版本化 capability-risk catalog 拆分为 Chromium primary correctness、三引擎 capability delta 和保留 nightly/release producer 身份的 full matrix，详见 [`testing/browser-capability-risk-budget.md`](testing/browser-capability-risk-budget.md)。geometry 类的 menu motion/focus 使用本地 FsusUI source/dist isolated harness，archive sticky/hash 仍明确标为 release-preview integration。权威目录、local alias/no-publish 规则、轻量替代与 #1074 适用边界见 [`testing/issue-1148-browser-diagnostics.md`](testing/issue-1148-browser-diagnostics.md)。

Production 物理 bundle 将启动保底与稳态目标分开：`startupMinCpuUnits`、`startupMemoryWeight` 和 `startupPriority` 只决定首次 admission，`minCpuUnits` 与常规权重决定启动后的扩容。继续支持 4 CPU，以 `1/1/1/1` 启动四个关键 bundle；5 CPU 的额外槽按启动优先级确定性给 backend，形成 `build/backend/frontend/runtime = 1/2/1/1`。公平顺序、内存门禁、checkpoint grant history 与回退合同见 [`testing/issue-1075-production-startup-grants.md`](testing/issue-1075-production-startup-grants.md)。

Frontend isolated perf 不再等待整个 `build-static` summary。它是 contention-aware 的功能性预算 smoke，在同一 frontend weighted DAG 中只依赖当前 run 的 `frontend-build-ready` 与 `vitest-settled`；前者校验 source/build-layout/producer/artifact digest，后者由 rolling runner 全部 host 退出并封存 transform cache 后产生。`runAfterSettled` 只表示 join 等待所有 dependency terminal state，不是 `ignoreDependencyFailure`：join 的显式 terminal outcome、receipt、dependency-outcome digest 和 evidence digest 必须一致；任一 failed/timed-out/internal-error dependency 使 join failed，只有 cancelled 时 join cancelled，缺 receipt/outcome 则 fail closed。普通下游只接受 scheduler success，失败后的 cleanup/finalizer 必须被显式声明且不得产生 correctness、coverage 或 performance success。精确 barrier、失败/取消传播和 admission evidence 见 [`testing/issue-1076-frontend-perf-readiness.md`](testing/issue-1076-frontend-perf-readiness.md)。

长生命周期 command manifest 与 shell collect pool 在每轮 child admission 前重读同一份 run-bound resource grant。增长不等待当前 wave 清空，收缩只暂停新 admission；CPU、memory 与 nested Node worker 配额均从当前 parent grant 分割，entry environment 无权覆盖这些边界。写任务只按 `ownedOutputs` 或命名资源的真实冲突排序，不再使用全局 write 锁；failure、cancel 与 execution deadline 都保留 partial evidence。动态/固定调用边界、内存 class、回退和证据 schema 见 [`testing/issue-1077-live-grant-command-pools.md`](testing/issue-1077-live-grant-command-pools.md)。

Production child 输出使用单一异步 raw byte log，并以 sequence、stream identity、monotonic timestamp 和 byte range index 重建 combined/stdout/stderr 视图。raw/index writer 共享 backpressure，writer error fail closed；console tee 是显式、有界且可降级的派生 sink。normal/failure/cancel/forced kill 均先 flush 已接收 bytes，再在 checkpoint/bundle member 中引用 raw/index/pipeline evidence，避免 per-chunk `appendFileSync()` 和完整 payload 双写。详见 [`testing/issue-1082-async-log-pipeline.md`](testing/issue-1082-async-log-pipeline.md)。

`runtime-browser` bootstrap 返回后，backend、debug frontend、release preview、PostgreSQL 与 Redis 不再从资源账本消失。bootstrap 原子发布绑定 run/namespace、原始 grant、精确五服务 roster、PID start time 或完整 container ID+created time 的 resident inventory；scheduler 重新派生每项 reservation，并让普通 admission、动态扩容、等待分类和 cgroup scope 都先扣除 live resident usage。`performance-evidence` 必须通过跨进程 lock 消费一次性、generation/digest/health 绑定的 handoff receipt；错 run、错 namespace、PID/container 复用、stale、并发或 double consume 均 fail closed。restart generation 替换前重新对账 cgroup/OCI 并刷新 enforcer；退出仅在身份确认消失后返还容量，pending cleanup 保留 pid/env/runtime handle 供 stale cleanup 重试。完整账本、回收与回退合同见 [`testing/issue-1080-resident-resource-leases.md`](testing/issue-1080-resident-resource-leases.md)。

UX risk matrix 已退出 Production，并成为 diagnostics-only probe。runner 固定一个外层 browser lane、一个 Playwright worker 和一个 CLI/session；它拒绝普通 production 调用，不读取 live free-memory/load 扩张 worker，也不再消费 persistent/elastic pool。完整 risk plan、progress 与多错误聚合仍保留在独立 diagnostics evidence 中。退役的 #1084 pool 与当前替代边界见 [`testing/issue-1084-persistent-ux-browser-pool.md`](testing/issue-1084-persistent-ux-browser-pool.md)。

Public HTML production/acceptance 门禁把未知路由、无效动态 identity、不存在或不可公开的 article/category/tag 验证为首响应真实 404；provider/DB gate 临时故障验证为 503 + `Retry-After`，仅有明确永久删除语义时才允许 410。负响应必须 GET/HEAD 状态与关键头一致、noindex/no-store、无成功 canonical/OG/BlogPosting/SPA script，并证明没有 AOT backfill。尾斜杠只允许 301 到无尾斜杠 canonical。测试矩阵与回退边界见 [`testing/issue-1085-public-route-real-status.md`](testing/issue-1085-public-route-real-status.md)。

fresh local production 先只读解析 source/candidate 与 selected physical DAG，获取 repository lease，并按 canonical filesystem 获取 host-local capacity reservation；reservation seal 前 runtime/container/output/cache/build-root/GC/producer mutation count 必须全部为零。seal 后才从 PID/env、run-once 以及 `.tmp/test-runs/*/checkpoint.json` 的 scheduler run/namespace tracking 清理旧 acceptance namespace，并向 setsid 进程组发送终止信号。即使所有 tracking 文件已丢失，同一 preflight/postflight pipeline 仍按 canonical repository root、executable/command/start identity、process group/Job/cgroup、environment/build root、open port 与 container ownership labels 发现 backend、release preview/Vite、Public AOT/SSR/HotRead worker、production descendant 和 compiler/server descendant。每个候选只分类为 `owned-orphan`、`active-owned-other-run`、`external-not-owned` 或 `identity-unverifiable`；active 判断先读取 #1675 Production Fresh lease，再复用 scheduler owner verifier，且只按完整 live identity 排除当前 lease controller。只有 `owned-orphan` 进入统一 physical process-tree termination，其他 active/unverifiable 候选在 producer spawn 前 fail closed，外部资源保留。容器必须具有 canonical repository digest、run/namespace、bundle/step、完整 ID 和 created time；名称匹配没有删除 authority。preflight 和 postflight 以相同参数复用该 pipeline，并在动作后重新扫描；任何 owned/unverifiable runtime 残留、collector/inspect 异常、tracked process tree 未确认零残留、container label/ID 漂移或 resident lease cleanup 未完成都会阻止 Fresh。每项 receipt 保留完整观察字段、分类理由、动作和 post-observation，后续 output cleanup 不会抹掉首次失败证据。容量不再使用固定 4 GiB 阈值，而是绑定 producer declarations、并行 peak、terminal retention、rollback/recovery 与 uncertainty；每个 high-disk producer spawn 前重新测量 live headroom。managed acceptance 进程继承 256 MiB 单文件写入上限，schema-migration PostgreSQL fixture 删除容器时同时删除匿名 volume。五类 acceptance 服务使用低于 Linux 默认 ephemeral range 的互斥 `20000–29999` 端口区间；Vite 使用 `--strictPort`，禁止 Docker 随机映射竞态导致 preview 静默漂移到未声明端口。

Acceptance public fixture 通过 author cache action 执行逐 article output-cache invalidation 与 `public-hot-rebuild`，不得对共享 runtime Redis 执行 `FLUSHDB`。同一 Redis 同时承载 active-release fence、Public AOT worker lease、run-bound coordination 与业务缓存；全库清空会让 fixture 后失效的公开壳层失去重建 worker，并把正常安全头检查误报为 503。fixture bootstrap 必须保留这些运行期租约，只刷新自身写入影响的缓存域。

UX risk matrix 只接受 browser diagnostics catalog 调用，并要求 `FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS=1`、`FSUSBLOG_PLAYWRIGHT_WORKERS=1`、`FSUSBLOG_UX_VIEWPORT_WORKERS=1`、diagnostics config 与 0 retry。它使用一个 CLI、一个 managed Chromium、一个 prepared fixture session，拒绝普通 Production 调用、resume、persistent worker、elastic pool 和基于 CPU/free-memory/load 的动态扩张。risk plan 内可继续执行的独立 case 会一次性汇总错误；失败截图、error context、progress 与 summary 保留在 run/category/probe namespace。旧 #1084 pool 的 worker lifetime/process-count 优化证据不再是当前验收要求。

mobile-landscape chrome 检查只审计主内容和 footer 之外的全局 header/nav；可换行的 footer 导航属于滚动内容，不按固定 chrome 高度误报。账户全局 header 在 `max-height: 520px` landscape 下把 inner block padding 收紧到 `0.5rem`，并从完整 desktop action row 切换到 mobile actions，确保 150–200% zoom 时仍保留足够内容高度且不会横向溢出。

local production correctness 以 `./tools/test.sh production-correctness` 从 shell 入口到最终 runtime cleanup 完成的真实 wall-clock 作为优化观测；`./tools/test.sh production` 保留为同一 browserless 拓扑的兼容别名。fresh 清理、capacity preflight、namespace prepare 和 run-owned build-server cleanup 全部计入。`config/testing/correctness-budget-policy.json` 是 direct/scheduled correctness 的唯一预算来源；每个纳管 producer 显式声明 measurement window（或 `not-applicable` reason）、preparation/post-measurement upper bound、termination grace、producer execution、tier scheduler 与 profile global budget，并满足完整和式与逐层不等式。direct `production-correctness` / `production` / `release-final` 不再把 tier `budgetMs` 清空；observe-only 仍必须有 hard safety budget。timeout 精确分类为 preparation、measurement、post-measurement、termination、scheduler 或 global，并进入 candidate identity/checkpoint/receipt；policy digest 改变时旧 successful attempt 不得恢复为当前执行。所有 deadline/cancel 统一调用 physical process-tree termination 并稳定证明零残留。

bundle 内同一 wave 的独立步骤不会在首个失败后停止调度，而是受 CPU/内存约束继续执行并在 wave 结束时聚合全部错误。step DAG 仅阻断依赖已失败节点的下游，其他独立分支及其下游继续运行；多个分支失败时统一以 `AggregateError` 报告，单个失败保持原错误对象。这样一次运行能暴露多个互不依赖的问题，同时不会在前置条件已经失败时伪跑依赖项。

`privacy-zk-comment-matrix` 拆成跨物理束的 run-bound 阶段：prebuild 只直接执行 comment privacy boundaries、author-mode retirement、public revocation、privacy build、ZK artifact/source ownership、unlinkability 及其正负 fixture；matrix/CI/workflow 消费 `matrix-governance` 的本轮 receipt，security matrix、OpenAPI 与 frame schema 消费 `frontend-static-governance` 的本轮 receipt，且 projection 同时校验 run/source/assertion/artifact digest。无消费者的 `FSUSBLOG_ZK_MCL_NO_BUILD` 和额外 Debug backend build 已删除。`frontend-tests` 随后从本轮 backend production TRX 与主 Vitest JSON fail closed 投影 functional receipt；MCL P99 不在 frontend 的普通并发负载中重跑，而由后置 `performance-evidence` 消费同 run 的 contract/functional receipts，在独占 `benchmark-window` 中只执行唯一 benchmark case，最后由 finalize 同时校验 contract、functional、benchmark 三份 receipt 并生成 canonical matrix artifact。Wasm prover bundle使用固定 entry order、epoch mtime、numeric owner 与无 gzip 时间戳的可重复归档，manifest 校验的是该确定性 SHA-256。cross-stack 导出的 AEDS OpenAPI 由矩阵生成器写入 canonical 输出，.NET 原生 OpenAPI 只写入独立 runtime 目录作构建验证，不得覆盖 AEDS 快照。

`production-build-artifacts` receipt 绑定当前 v5 circuit/setup/config 与 `comment-privacy-build-contract.mjs`。默认 fail-closed build 不包含 `comment-privacy-prover.zkey` 或其 public manifest；这表示 ZK 功能关闭，不表示用占位 key 通过 gate。只有显式 production ZK build 才把这两个文件加入 Wasm artifact contract，并在编译前校验完整 ceremony/transcript/artifact SHA。正向测试使用临时 hash-bound v5 fixture，负向测试必须覆盖 setup 未就绪、旧 circuit/layout 与 artifact digest 漂移；测试不得生成或下载真实 ceremony key。

Production build artifact 的 canonical 输出目录由 producer 通过同文件系统原子 rename 接管并原位封存，不再执行 build output 到 payload 的目录复制；原路径只保留指向封存 domain 的只读引用。大型 backend runtime、test runtime、frontend dist 与 Wasm 目录因此不读取或重写文件内容；generated contracts 直接写入最终 domain。全部 writer 关闭后，producer 只生成一次 `receipt.artifacts` digest table，以临时文件加 rename 原子发布 receipt，并清除 payload 文件与 receipt 的写权限。

Local Production Fresh 的 namespace `--prepare-env-only` 只规划动态端口和环境，不消费 CI production artifact receipt。attempt-bound `FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT` 只注入物理 `build-static`；其 `production-build-artifacts` 步骤封存唯一 receipt 后，原子发布绑定 run/source/build-layout/attempt/receipt digest/producer 的 `production-build-artifacts-ready` marker。`runtime-browser` 的 bootstrap 必须同时等到 backend、frontend 与该 marker，并只读核验 receipt 和 payload 的 seal；不得 materialize、repair、fallback build 或发布第二份 receipt。

只读 consumer 直接引用封存目录，因此 SPA 与 backend wwwroot 可绑定同一 `frontend-dist` entry，不重复物化 hashed assets、AEDS 或 Wasm。`copy-before-write` domain 依次尝试强制 reflink、预授权 overlay、带 copy-up 的 hardlink writable layer，最后才普通 copy。当前 runtime 没有 mount/copy-up provider 时必须把 overlay 与 hardlink layer 记作 unsupported；禁止用会污染 source 的裸 hardlink。evidence 包含每次尝试、fallback reason、`copiedBytes`、`reflinkedBytes`、`referencedBytes`、digest traversal count 与 materialization wall time。下载边界执行一次物理 tree digest 校验；同一 materialize 调用中的多个 logical mapping 只引用同一 digest table entry，不按 destination 重散列。

consumer lease 原子写入 `<artifact-root>.state/consumers`。相同 run/consumer identity 再次 acquire 是 resume refresh；完成或 cancel 使用 `release` 写明原因。GC 只回收超过 stale threshold 且没有 active lease 的合法 receipted artifact，active lease 不因时间阈值被误删。污染负向 fixture 会修改 writable consumer 并重新读取 immutable source；source/toolchain/build-input 任一 identity 漂移都 fail closed。可审计 lifecycle 命令为 `production-build-artifacts-cli.mjs acquire|release|gc`。

三轮同机 benchmark 同时建模 frontend 的 SPA/wwwroot 双 consumer 与 writable test runtime；它不把不支持的 reflink 记作成功：

```bash
node tools/ci/benchmark-production-build-materialization.mjs \
  --rounds 3 --bytes 8388608 --out .tmp/release-evidence/jobs/production-build-seal-cow.json
```

回退不需要重启：保留 receipt 与 immutable source，writable consumer 在同一次 materialize 内切换到带 evidence 的 ordinary copy。若引用路径与调用方不兼容，只将该 mapping 标为 writable 触发隔离物化；不得解除 source 写保护、跳过 digest 或跨 identity 复用。

lane-local collect executor 会等待全部独立子任务结束后聚合失败，不因首错 kill peer。security 的 matrix、ZAP policy、SBOM、supply-chain 与 network baseline 静态检查并行；共享安全 fixture/runtime state 的 API、认证、权限、攻击矩阵、notification stream、a11y 与 DAST 保持有序执行，但每个失败只记入汇总，后续检查和必要 reset 继续执行，最后一次性报告全部失败。跨 lane 的依赖、取消和资源 admission 仍只属于 matrix scheduler。

测试资产变更使用持续治理入口，不再依赖一次性 before/after campaign CLI、固定 tier 数量或 wall-clock target：

```bash
node tools/check-test-lifecycle.mjs
node tools/check-test-retention.mjs
node tools/check-test-suite-convergence.mjs
node tools/run-test-matrix.mjs validate
node tools/check-browser-test-migration.mjs
```

mutation 使用仓库锁定的 Stryker.NET `4.14.2`。nightly `backend-mutation` 从 solution 根发现 Core/Server 可变项目，读取 `config/testing/mutation/default.json` 的项目根相对 glob，保留 Core/security/binary/cache/service 全范围并写入 `.tmp/mutation/backend`；`release-mutation-critical-slice` 从 `src/core` source-project context 启动，以 `tests/backend/FsusBlog.Server.Tests.csproj` 为 test project，读取 `config/testing/mutation/critical.json` 中经审阅的 AEDS v2 wire-frame 核心 `Algorithms/AedsEncoder.cs`，并只选择直接覆盖该范围的 `AedsEncoderTests`，写入 `.tmp/mutation/backend-critical`。两者均继续保留，changed-critical 能力不承担退役任一既有 lane 的 authority。

`backend-mutation-changed-critical` 已收敛为自动、按 behavior、逐 mutant 的 per-behavior mutation qualification producer：`tests/matrix.yml` tier 声明 `cadence: pr`、`requiredFor: production`，不再允许 `manualOnly`、`requiredFor: none` 或 `release-manual`。版本化 `config/testing/mutation/changed-critical-domains.v1.json` 声明 mutation domain 的 repo-root source patterns、test owners、risk 和 mutation policy；`config/testing/mutation/behavior-mutation-owners.v1.json` 与事实抽取 registry 派生 C# implementation-owner closure。`scope=release` 必须运行四个 required release behaviors（binary-api-aeds-contract、authentication-session-permission、configuration-error-security-policy、article-comment-lifecycle-outbox）的全部 required critical mutants，零 manual-only/changed-only 遗漏；`scope=pr` 按 changed closure 选择受影响 behaviors，但 docs、binding receipt、BehaviorCatalog、mutation tooling、governance checker 与 matrix 等 governance-sensitive 路径变化时仍触发完整 required closure，不能以 source implementation 未改为由跳过。selector 输入 changed paths、source commit 与 worktree fingerprint，从 BehaviorCatalog、#2185 behavior-test bindings 与 implementation-owner receipt 派生 exact mutants/test commands，计算 closure digest；无相关关键变更时只写结构化 empty selection/run evidence，不创建 Stryker 物理进程。

所有 Stryker authority 都绑定实际 semantic mutant inventory，而非仅保存 count 或 raw report digest。每个 canonical mutant ID 只由 repository-relative source file、完整 source digest、operator、精确位置、original/replacement digest 稳定派生；source digest 必须覆盖 report 中未 trim、未规范化换行的完整 source string，original 必须直接按同一 string 的原始 `LF` / `CRLF` offset 切片，replacement digest 必须区分空字符串、空白和非空文本。缺失或非 string replacement 与合法空 replacement 是不同状态。operator 必须命中从仓库锁定的 Stryker.NET `4.14.2` producer 源码审阅出的有限 allowlist，verbose trace 也必须包含唯一且完全匹配的 `Stryker starting, version: "4.14.2"` 记录；producer 版本或 operator 未知时 fail closed。Stryker raw mutant ID 仅作为同一物理 run 的 report-to-trace join key，绝不能把数组下标或 raw ID 当作 canonical identity。authority 的 `plannedMutantIds`、`executedMutantIds` 与各 terminal status 集合必须排序、唯一且互斥；每个 planned mutant 恰好进入一个 terminal 集合。`inventoryDigest` 绑定完整 inventory，`executionMatrixDigest` 绑定 mutant-to-status/test execution matrix，因此 report 数组重排不改变语义 digest，而相同 count/score 的不同 mutant、source、replacement 或 test relationship 必然改变 digest。

`release-mutation-critical-slice` 还使用 `config/testing/mutation/inventory-retention.json` 作为唯一的 planned inventory baseline 和 retirement ledger。它把 baseline mutant IDs 的不可变 digest、最小 planned/executed 数量、required operator/source region，以及 `Ignored`、`CompileError`、`NoCoverage` 的独立占比上限绑定到实际 authority。baseline 中消失的 mutant 必须逐项提供非泛化 reason code，并提供 replacement mutant IDs 或实际 executed proof test IDs；`refactor` 不是有效 reason，source refactor 必须给出 exact old-to-new mapping。新 mutant 可以直接加入本轮 inventory，绝不自动改写 baseline。lane 在 authority 后运行 `node tools/test/check-mutation-inventory.mjs --authority .tmp/mutation/backend-critical/authority.json`，原子写入 `inventory-retention.json`；其 candidate identity 同时绑定实际 inventory digest、policy digest 和 retirement ledger digest，因此高 score 无法补偿 inventory、operator 或 source-region 的退化。

authority 从 raw report 的 `testFiles[*].tests` 建立唯一 raw GUID 到真实 fully-qualified test name 的映射；每个 `coveredBy` / `killedBy` GUID 都必须解析，inventory 同时保留 raw GUID/FQN binding，`executedTestIds` 只使用真实 FQN 并据此核对 `test-case-filter`，配置字符串不能填补空缺执行事实。`Killed`、`Survived`、`Timeout` 的 `durationMs` 必须来自同一 verbose trace 中严格配对的 `Runner ... Testing` batch 与 terminal `Test run for` 时间戳，batch 内每个 raw mutant 共享该次实测时长并绑定 `traceBatchId`；`Ignored` / `NoCoverage` 使用 `durationMs: null` 与 `durationState: "not-executed"`，`CompileError` 使用 `durationMs: null` 与 `durationState: "not-reported-for-compile-error"`，不得伪造 `0`。authority 同时保留 raw report/trace digest、完整 trace batch inventory 与 batch digest。unknown status/operator、缺 source/location/replacement/test identity、重复 raw/canonical ID、缺失/重复/额外/乱序/未终止或反向时间戳 trace batch、executed mutant 的空 duration、NoCoverage 伪装为 executed、实际 source 超出 `mutate` scope，或 trace report path/filter/terminal score 与本轮 report/config 不一致都 fail closed。

changed-critical authority 进一步绑定 source/worktree identity、catalog/selection/generated config、mutate file list、test filter、closure digest，以及每个 physical source-project run 的 raw report/trace、完整 inventory/terminal sets/test identities/trace batches/digests，并以同一规则聚合全局 inventory。旧 report 或 trace bytes、错误 source identity、catalog/config drift 或非空 closure 的零 executed mutants 均由 `tools/test/changed-critical-mutation-evidence.mjs` validator 拒绝；surviving mutants 继续显式保留供处置，不能被 line coverage 或测试数量替代。per-behavior producer `tools/test-matrix/produce-behavior-mutation-qualification.mjs` 执行本轮 clean source/worktree/build/test plan，消费本轮 #2185 bindings 与 #2186 behavior-test evidence（cross-run/main/latest 一律拒绝），按 behavior 记录每个 mutant 的 mutant ID、source owner/location、expected killed test IDs/kinds、actual raw result、killed/survived/error/timeout、attempt/provenance 与 content digest，并封存既有 #1751 `fsusblog.mutation-evidence-receipt.v1` schema 的 qualification receipt（不建立第二格式）。独立 verifier `tools/test-matrix/verify-behavior-mutation-qualification.mjs` 重新派生 selector、bindings、raw results、mutant coverage 与 qualification，任何 survived/error/timeout/missing/duplicate/multiple/0-result、selector/binding/source drift、tamper、global score pass、history reuse、mutant allowlist 或 manual override 都逐 behavior fail closed；missing tool/runtime/input 只输出 canonical producer command 并失败，绝不降级 manual approval 或 warning success。required tests 必须实际运行且 clean-first-attempt，skipped/blocked/diagnostic/recovered 测试不能 kill 资格。static governance `tools/governance/check-behavior-mutation-governance.mjs` 禁止 manualOnly required behavior、requiredFor none、global score pass、history reuse、mutant allowlist 与 manual override，并已接入 repository governance authority 与 static-governance lane。调用方必须提供 `FSUSBLOG_CHANGED_CRITICAL_PATHS_FILE`、`FSUSBLOG_TEST_SOURCE_COMMIT`、`FSUSBLOG_TEST_SOURCE_FINGERPRINT`、`FSUSBLOG_TEST_RUN_ID`、`FSUSBLOG_BEHAVIOR_OWNER_RECEIPT`、`FSUSBLOG_BEHAVIOR_TEST_BINDINGS`、`FSUSBLOG_TEST_PLAN` 与 `FSUSBLOG_BEHAVIOR_TEST_EVIDENCE`，并按 `FSUSBLOG_MUTATION_SCOPE=pr|release` 执行 `./tools/test/lanes/backend-mutation-changed-critical.sh`。`tests/tools/fixtures/changed-critical-mutation-smoke.json` 提供 authentication 与 canonical-rights 两个非 AEDS domain 的本地物理 smoke 输入。该过滤器不得扩展到依赖 `.tmp` release evidence 的无关治理测试，fresh 清理后的 mutation discovery 仍必须自足。critical 运行不能用 full 历史输出替代；solution mode 也禁止用 `project` 键错误地把 test-project 路径固定为被测项目。三者保持 `Debug` configuration，并由 mutation runner 导出专用 MSBuild 标记 `FSUSBLOG_MUTATION_BUILD=1`；由于该版本在 .NET 10 下无法回滚 ASP.NET OpenAPI XML source generator 的 checksum interceptor，`FsusBlog.Server.csproj` 仅在该标记存在时移除 generator analyzer，普通 Debug/Release 的 OpenAPI 行为及业务 mutate scope 不变。阈值由各 config 或 catalog 的 `thresholds.{high,low,break}` 声明，动态输出通过受支持的 `--output` CLI 参数指定；authority producer 额外启用 `--log-to-file --verbosity trace`，固定 critical tier 原子写入 `.tmp/mutation/backend-critical/authority.json`。配置不得重新加入旧版顶层 `threshold-*` 或 `output` 键，solution-context mutate path 不得带 `src/` 前缀；`backend-test-governance` 会 fail closed。

OpenAPI analyzer 的 build-path identity 只从 Central Package Management 取值：`Directory.Packages.props` 必须唯一绑定 `Microsoft.AspNetCore.OpenApi` `10.0.9`，不得再用同 package ID 的 `Update`、`VersionOverride` 或 child metadata 建立第二 authority。`FsusBlog.Server.csproj` 的对应 `PackageReference` 必须是唯一 `Include`，不得声明 `Update`、`Version` 或 `VersionOverride`，且必须精确保留 attribute `GeneratePathProperty="true"`。缺失、错版、重复 central entry 或 project-local version authority 都由 `backend-test-governance` fail closed。

`test-lifecycle` 为每个 Node test file/test ID 解析唯一 physical owner 与 execution category；projection 与 summary 不得执行 producer，unowned 或重复 owner 直接失败。`test-retention` 和 `suite-convergence` 共同校验 test/assertion/coverage universe、replacement chain 与 source identity；matrix validator 校验动态拓扑而不冻结 tier 数量。Browser test isolation 由 `check-browser-test-migration.mjs` 持续扫描，禁止 E2E 直接控制 SQL、Redis、Docker 或子进程。性能耗时只进入 scheduler/benchmark 的本轮证据，不再作为测试是否保留或是否 obsolete 的依据。

旧 `ux-viewport-canary-parity` tier 依赖不完整的历史失败签名，已从 active matrix、release evidence 和测试 inventory 中删除；缺失的历史材料不得由当前全绿结果或 tier 预算推断。当前 viewport diagnostics owner 由 `ux-viewport-smoke`、`ux-viewport-boundaries`、`ux-viewport-visual` 与 risk probe 组成，`ux-viewport-plan-progress` 作为 browserless planner/progress correctness replacement 保留。`ux-viewport-summary.json` 只陈述 diagnostics 本轮实际完成数、失败数、plan fingerprint 与 mode artifact，不参与 release correctness closeout，也不得读取 legacy runner 或伪造 parity 结论。

`coverage-threshold` 会分别校验 merged、backend-only 和 frontend-only coverage。默认 frontend 阈值与常规 merged gate 保持保守一致：`FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD=35`、`FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD=20`、`FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD=30`；PR/push 可以通过这些环境变量临时调高或降低，但 release evidence 会把 `coverage.frontend` 单独展示，避免 frontend 退化被 merged totals 掩盖。

---

## 层级总览

## Load / soak HTTP route oracle

`config/testing/runtime-http-route-contracts.json` 是 load/short-soak binary route 的唯一 machine-readable contract。probe 只能以 `routeId` 发起请求，禁止裸 path 或 `status < 400` 成功判断；每个完整成功 sample 绑定 catalog digest，并精确验证 status、禁止 redirect、normalized Content-Type、AEDS header length/CRC/frame type、body bounds 与非 error frame。contract 失败样本保留 failure kind，但绝不进入 latency percentile；catalog 与运行 routeId 集合必须双向 exact match，unknown route 在请求前失败。

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

`ci-job <job>` 按 `ciJob` 聚合运行该 Actions job 里的 required matrix tiers；`ci-tier <tier>` 运行单个 tier，默认包含它的 matrix 依赖，可继续传 `--no-deps` 或 `--shard i/n`。权威 CI/release 运行必须显式传 `--fresh`；`--resume` 只复用仍为 clean success 且指纹匹配的产物，checkpoint 已记录 failure/cancelled 时必须以新 run ID 启动独立执行，不能重跑失败 tier 取得绿色。`--max-parallel N` 可人工收紧并发。每个 tier 执行前都会在日志里打印对应的本地复现命令。完整 tier 与 CI job 对照见 [testing.generated.md](testing.generated.md)。

`ci-fast` 是 fast workflow 的本地闭环入口：它从 `fast-summary` 的 aggregate reachability 与同一份 `ci-plan` 递归取得 setup/producer jobs，按 job 依赖拓扑执行 matrix validation、BehaviorDoc admission 和所有 producer，最后调用 artifact-only `fast-summary`。它不维护第二份 job 清单；`ci-fast --plan-only` 会打印本次解析出的完整顺序。`ci-production` 仍运行 `production` correctness DAG，`ci-release-final` 仍只执行 evidence-only finalizer；后两者不会隐式重跑 producer，以保持 current-run evidence 与最终凭据的独立边界。

`executionDependsOn` 是唯一的调度 DAG；`requiresEvidenceFrom` 只声明 projection / summary 消费的 typed receipt，不会调度或执行 producer。summary tier 必须显式绑定 `commandKind`、`summaryAuthority`、精确有序的 `summaryInputs` 与 `outputReceiptSchema`，由 aggregate / receipt planner 统一生成 runner 与文档命令。`validate` 还会通过隔离的 Ajv 2020 validator 对 `tests/matrix.yml` 的解析结果执行 `tests/matrix.schema.json`，缺少 required 字段或重新使用已退休的 tier `dependsOn` 都会 fail closed；首次本地验证先运行 `npm --prefix tools/test-matrix/schema-validator ci --ignore-scripts --no-audit` 安装 lockfile 固定的 validator。

Matrix 同时声明调度元数据：`phase` 表示 CI DAG 阶段，`cost` 表示预期耗时，`resourceClass` 标识主要资源（如 `browser`、`database`、`benchmark`），所有逻辑 tier 与本地物理 bundle 都只声明无量纲 `cpuWeight`、`memoryWeight` 和保证可运行下限的 `minCpuUnits`，不得写入机器绝对 `cpuUnits` / `memoryGiB`。`parallelizable` / `shardable` 表达语义能力；只有不可并行、不可分片时才保留 `maxParallel=1` / `defaultShards=1`。scheduler 不按整个 phase 预先切碎机器：每个 admission wave 都只对当时 ready 的 tier 结合 active reservation、`os.availableParallelism()` 和实时 free memory 重新分配 grant，单一 ready tier 因而可以拿满剩余容量；worker、Playwright 与 .NET processor 都以该实际 grant 为上限。`exclusiveResources` 声明互斥写入或共享服务，`requiresBootstrap` 标明是否依赖本地 runtime bootstrap；benchmark 噪声隔离通过 `benchmark-window` 表达，包含真实 P99/BenchmarkDotNet 测量的 logical tier 同时不可与其他 tier 并行，lane 内编译与治理准备必须先结束。benchmark runner 按 `STEP > TIER > BUNDLE > host` 读取动态 grant，不使用某台机器的固定并发数。

Matrix 的可选 topology metadata 只描述“同一 FsusBlog 程序、同一发布物”的测试运行态，不代表固定服务拆分。字段缺失时统一解释为 `runtimeMode=single`、`nodeCount=1`、`artifactStorage=local`、`coordinationStore=none`、`clusterScenario=none`、`clusterBootstrap=none` 与空 `clusterFixtures`，所以现有 single mode tier 行为不变。多节点 tier 必须显式选择 `static-role` 或 `adaptive`、`homogeneous` bootstrap、具体 `clusterScenario`、`shared-volume` artifact storage 和 Redis coordination，并同时声明 `shared-postgres`、`shared-redis`、`shared-artifact-storage` fixture；其 `services` 必须包含 PostgreSQL/Redis，且必须有现有 `requiresBootstrap` 来源。validator 会拒绝缺 fixture、store/service 不一致、single mode 多节点或只有 HTTP 服务数量而没有同构拓扑声明的 tier。runner 将解析后的值传为 `FSUSBLOG_TEST_RUNTIME_MODE`、`FSUSBLOG_TEST_NODE_COUNT`、`FSUSBLOG_TEST_ARTIFACT_STORAGE`、`FSUSBLOG_TEST_COORDINATION_STORE`、`FSUSBLOG_TEST_CLUSTER_SCENARIO`、`FSUSBLOG_TEST_CLUSTER_BOOTSTRAP` 与 `FSUSBLOG_TEST_CLUSTER_FIXTURES`，后续 fixture 不应再次猜测默认值。two-node fixture 仍只能通过 env、`nodeId`、`baseUrl` 区分节点，不得生成第二个业务发布物。

`homogeneous-two-node-fixture` tier 是上述 contract 的最小可运行入口。`tools/test/lanes/homogeneous-two-node-fixture.sh` 只构建一次 backend DLL、只准备一组 PostgreSQL/Redis 与 shared artifact root，然后由 `tools/test/homogeneous-two-node-fixture.mjs` 用同一个 artifact 启动 node A/B。两个进程使用不同 `FSUSBLOG_TEST_NODE_ID`、loopback `baseUrl`、data/log 路径，但共享连接身份、artifact root、runtime mode、app artifact digest 与 frontend asset identity。fixture 等待两个 `/health/live` 均返回 `live`，原子写入 `.tmp/fixtures/<namespace>/homogeneous-two-node/cluster-summary.json` 后停止子进程；summary 只记录共享基础设施指纹，不写连接串或凭据。模块 API 可被后续 convergence/handoff/notification 测试复用并自行控制 `stop()` 生命周期。该 tier 是同一程序的双节点测试夹具，不是第二个业务发布物，也不引入 reverse proxy。

Public AOT lease 的聚焦回归位于 `PublicAotBackfillLeaseTests`、`PublicAotArtifactStoreBoundaryTests`、`PublicAotBackfillSchedulerTests` 与 `PublicAotSsrRuntimeStateTests`。双节点模拟必须让两个独立 `PublicAotBackfillLease` 实例共享同一个 lease store，并断言同一 route/asset/session 同时只有一个 holder；随后推进受控时间越过 TTL，证明第二节点可接管且旧 holder 的迟到 release 不能删除新 token。单机用例必须断言 local handle 不调用 cache port。artifact store 用例在 active-release commit guard 回调后切换 frontend asset version，证明最后一道校验拒绝 stale write。lease contention/loss 与 quarantine-before-acquire 只计协调 drop，不得增加 renderer/circuit failure；公开请求仍由既有 shell tests 证明 cold miss 返回 SPA fallback 而不等待 backfill。

外层 matrix scheduler 与 bundle 内 weighted DAG 对 `exclusiveResources` 使用同一集合交集语义：active step 和当前 admission wave 已选 step 都只锁住自己声明的资源名。`build-output` 不会阻止无资源声明的静态检查或使用 `benchmark-window` 的独立步骤；两个写同一输出目录、同一 benchmark window 或同一数据库写窗口的步骤仍严格串行。coordination-only step 不占 CPU/内存且禁止声明资源锁。发生冲突时 bundle 日志写出 `exclusiveResource`、`heldBy` 与 holder state，资源在成功或失败 settle 后都由 active record 删除，独立失败继续聚合。

Release Reliability 的七个 single-scenario diagnostic tier 不自行拥有 scheduler 数值。`config/testing/release-reliability-scenario-catalog.json` 中每个 scenario 的 `scheduler` 与 `schedulerTimeoutPolicies` 是唯一 authority，`tools/test-matrix/generate-release-reliability-scheduler-projection.mjs` 将 resource class、CPU/内存权重、minimum CPU、exclusive/countable resources、并行上限、cost 与 outer timeout 投影到 `tests/matrix.yml`；matrix validation 对字段和 profile digest 逐项 exact match。完整 `release-reliability-fresh` 在外层全局 nonparallel，内部只按 catalog 顺序运行；每个 scenario 启动前重新读取 outer scheduler 的 actual grant、验证 `minCpuUnits` 并将 sealed grant receipt 纳入 scenario result。排他等待证据必须同时记录具体 resource 与 holder，不能只记录泛化的 capacity。

本地 fresh production 的五个物理 bundle 只保存相对资源意图。time zero 的 build、backend、frontend、runtime 都声明启动 CPU `1`，启动 memory weight 为 `3/4/2/5`、优先级为 `3/4/3/4`；稳态 `minCpuUnits` 为 `2/2/1/1`，后置 performance 为 `1`。启动 admission 先按 priority、critical-path deadline weight、稳定 ID 排序，再在实时 CPU/free memory 内成波放行，因此不受 YAML 数组顺序影响。4 CPU 机器首波得到 `1/1/1/1`；5 CPU 的额外槽按启动优先级给 backend，形成 `1/2/1/1`；更多 CPU 仍从机器资源和相对策略计算，并在 sibling 结束后继续扩容。runtime 内两个 build marker 等待节点是零 CPU / 零内存协调节点，bootstrap-free contract/security 可以在等待期间使用实时 grant。核心数、free memory 或 reserve 变化时，解析结果和各 bundle 内部 worker 数随之变化；无法满足启动保底时记录 `waiting-for-startup-capacity`，低于 profile 的 4 CPU 支持下限则在执行前 fail closed。

全局 `static-governance` 装入 `frontend-tests`；privacy contract receipt 由 frontend 生成，project-functional/input verification 则在早启动的 `performance-evidence` 中消费 exact backend/frontend coverage 与 frontend build marker。logical `privacy-zk-comment-matrix` member 仍只登记一次并绑定 benchmark/finalize canonical artifact。`runtime-browser` 的物理依赖为空，time0 同时等待两个 marker 并执行 bootstrap-free security/contract；只有两个 marker 都成功时才允许 bootstrap，伪造、过期、缺失或 digest 漂移的 marker 一律 fail closed。`performance-evidence` 同样没有整个 backend/runtime/frontend bundle 的入口依赖：coverage merge 与 deterministic compression 按精确 marker 提前，runtime consumers 稳定且 #1080 resident handoff 被一次性消费后，才在该 bundle 内并行运行隔离 namespace 的 `data-scale-xs` / `data-scale-s`，随后 evidence summary 与 fault injection 收口。五个 timed profiler 还必须等待三类 producer quiet marker；quiet marker 仅在对应 physical summary、member receipt、artifact digest 与 resource evidence 全部原子落盘后发布。所有 performance step 都标记 coordination/preparation/measurement/post-measurement phase，v2 deadline evidence 拒绝 profiler 互相重叠或与 preparation/finalize 噪声重叠；只有 measurement step 持有 `benchmark-window`。完整合同见 [`testing/issue-1081-performance-evidence-marker-dag.md`](testing/issue-1081-performance-evidence-marker-dag.md)。五个 bundle 不保存固定 CPU、GiB 或 worker 数：scheduler 每次从在线 CPU、实时 free memory、bundle 相对 workload 权重与语义最小 CPU 重新计算 grant；矩阵权重仅描述工作量比例。production 不把性能目标传成 scheduler 或 bundle deadline，直接 correctness aggregate 也不执行逻辑 tier 截杀。scheduler 将本轮 grant 传为 `FSUSBLOG_BUNDLE_CPU_BUDGET` 和 `FSUSBLOG_BUNDLE_MEMORY_GIB`，bundle runner、backend union、frontend Vitest 与 build-static command manifest 都从该运行时配额派生并发，不得从 8 核示例或历史运行反推固定 worker 数。

`frontend-static-governance` 与 `frontend-runtime-contracts` 的命令组由 `tests/matrix.yml.commandGroups` 唯一声明，不再维护 lane-local JSON manifest。local production 仍使用 `blocking-prebuild`、`concurrent`、`postbuild`、`isolated`、`final` 显式阶段；每个有效命令必须声明 reason、consumed inputs、owned outputs、dependencies 与动态资源/互斥资源。命令 runner 每次从 matrix 重读同一份声明，阶段内部使用 settled failure aggregation，独立命令不会因首个失败而静默跳过。

Production 的 ordinary unit/property/model Vitest 进程与后置 perf 进程共享 Vitest filesystem module transform cache，但不共享 controller、worker、module graph、mock/global state、测试结果或 coverage。cache 位于 `.tmp/test-runs/<run-id>/frontend-vitest-transform-cache/`，由 source commit/worktree fingerprint、Node/Vitest/Vite 版本、完整 Vitest 配置输入 digest、`NODE_ENV`/`VITEST_MODE`/`VITE_*` 环境以及 production project identity 共同寻址；因此不能跨 fresh run 或不同输入复用。ordinary 进程完全退出并把 lifecycle 从 `ordinary-active` 封存为 `ordinary-ready` 后，独立 perf runner 才可打开 cache；中断/失败会删除 module cache 并写 `failed` 状态，身份清单损坏或漂移 fail closed，单个缺失/损坏 transform entry 则安全删除并由 Vite 重建。Vitest 会把 coverage provider 的 transform 决策纳入 cache key，而 V8 coverage 本身不改写源码；perf 因此只启用 `transform-cache-key-compatibility` no-op provider 来选择相同 key，它不启动 profiler、不收集 payload、不写 coverage，也不进入 ordinary coverage merge。perf 仍只写 canonical `production/perf-isolated.json`，额外的 `production/perf-isolated-timing.json` 记录 hit/miss/write、修复计数、process startup、time-to-first-test、wall-clock、ID exact-once/disjoint 与 coverage 未变化证明；关闭 cache 的回退路径是让 production config 不接收两项 `FSUSBLOG_VITEST_TRANSFORM_CACHE_*` 环境，独立 perf 语义不变且无需重启服务。

`phase` 是可执行 DAG 契约：任一 tier 的 `executionDependsOn` phase 必须小于等于该 tier phase，`tools/run-test-matrix.mjs validate` 会拒绝 phase 倒挂。`requiresBootstrap != none` 也必须有明确来源：matrix 执行依赖链能到达 `bootstrap`，或 tier 自身声明 `selfBootstraps: true`，或由 GitHub Actions job 手工先跑 bootstrap 并在 tier 上声明 `workflowBootstraps: true`。`tools/check-workflow-matrix-sync.mjs` 会反向校验 workflow 的手工 bootstrap 与 `workflowBootstraps` 元数据一致。

`risk` 表示失败影响或回归风险，不表示运行频率；运行频率由 `cadence` 单独声明：`pr` 进入普通 PR/push quality gate，`push` 表示本地或 push 级聚合语义，`nightly` 必须与 `nightlyOnly: true` 一致，`release-manual` 必须与 `manualOnly: true` 一致。`requiredFor` 表示该 tier 计入哪个覆盖口径：`fast`、`production`、`release-final` 或 `none`。因此 production coverage 不会隐含 manual-only / nightly-only lane 已完成；release-final 可以单独要求 `release-manual` 证据。

Matrix 也声明 setup/cache 元数据：`requiresNode`、`requiresDotnet`、`requiresPlaywright` 表示运行时需求，`cacheProfile` 表示依赖缓存需求。`cacheProfile=frontend` 必须使用 `actions/setup-node` 的 npm cache，并固定 `cache-dependency-path: src/frontend/package-lock.json`；`cacheProfile=backend` 必须使用 `~/.nuget/packages`，key 固定由 `*.csproj`、`*.props`、`*.targets`、`global.json`、`NuGet.config` 共同计算；`full` 同时要求两者。Playwright tier 只安装声明的浏览器：`chromium` tier 只安装 Chromium，cross-browser tier 使用 `${{ matrix.browser }}`。

### Resource-aware scheduler 与断点恢复

每次 DAG 执行写入 `.tmp/test-runs/<run-id>/checkpoint.json` 与独立 tier 日志。checkpoint 记录运行模式、权威性、`sourceState`、输入指纹、依赖指纹、耗时、完成 tier 和首个失败点；`--resume` 只复用指纹仍匹配且必需产物未变化的成功 tier，源码、命令、shard 或关键环境变化只让此前成功但已失效的节点及其下游重新执行。任一 tier 已失败或取消的 checkpoint 不得 resume；scheduler 在 producer spawn 前拒绝该 run，后续诊断或修复验证必须使用新的 run ID，并保留旧 failure。每次 resume 都为当前调用重新建立 source/run-bound BehaviorDoc admission；只有这一本次调用的认证 receipt 可以作为专用 current-run preexecuted binding 进入 scheduler，指纹不匹配时仍执行 BehaviorDoc verify command，但不把 verify-only 命令未改写该 receipt 误判为 stale output。其他 preexecuted prerequisite 不得跨 resume，普通 producer 的 stale-output gate 保持不变。tier 未显式声明 `cacheInputs` 时，runner 会按 backend/frontend/shared 范围推导输入；显式输入也会自动补入 matrix、coverage registry、共享 lane、run-once 与对应 Vitest 配置，避免“声明过窄”造成误复用。`--fresh` 不读取旧进度，checkpoint 标记 `authoritative=true`，是提交、CI 和 release evidence 的唯一有效模式。

首个 tier 失败后，scheduler 会终止仍在运行的子进程组并不再启动新节点；每个 tier 前后都比较 tracked worktree 状态、mode 与 index，测试若新增 tracked diff 即失败。fresh 运行会先清理该 tier 所拥有的 `.tmp`/coverage/test-result 产物并验证内容与 mtime provenance，旧文件不能掩盖 no-op producer。测试阶段只能校验 tracked generated manifest；需要更新 tracked 生成物时必须通过显式生成命令在测试前完成，测试本身不得重写。`executionKey` 表示同一测试集合，coverage variant 只有在 coverage ID 为目标普通 tier 的超集时才能通过 `supersedes` 替代普通执行；property、model、performance、runtime、security、protocol、migration、concurrency 与 release evidence 不允许被 coverage 隐式替代。

共享准备操作由 `tools/test/run-once.mjs` 按 namespace 和输入指纹执行一次。锁 owner 同时绑定 token、PID、跨平台 creation/start identity、executable 字节 SHA-256、command digest、scheduler run、namespace 与 execution key；原始 command 不进入 owner manifest。heartbeat 和 reclaim 都比较 token 加完整 identity，时间戳必须满足 created 不晚于 heartbeat 且 heartbeat 不在未来；reclaim 先建立 owner-bound marker，再原子 rename 到独立 tombstone，旧 reclaimer 不会删除新 owner。身份暂不可读或 owner 不完整时，以绑定 owner 内容摘要和首次观察时间的 observation receipt 计算有限宽限，超期以 `owner-unverifiable` fail closed，禁止用 PID、mtime 或 marker 推断活跃。heartbeat/stale/grace policy 只进入 lock owner 与独立 lock lifecycle receipt，不改变 physical execution receipt。必需输出按内容状态验证，Wasm 使用完整 `public/wasm/`，认证 fixture 使用完整 auth 目录，release build 同时验证两个 index 输出。Playwright fixture 默认写入 `.tmp/fixtures/<namespace>/`；auth 目录固定 `0700`、cookie/storage-state 文件固定 `0600`，旧 `src/frontend/.playwright-fixtures/` 不得保留。fresh `production` / `release-final` 无论成功或失败都会在 scheduler 返回后删除默认 namespace 的 auth 目录，并写 `.tmp/release-evidence/sensitive-fixture-cleanup.json`；显式外部 `FSUSBLOG_FIXTURE_ROOT` 由调用方负责清理。

Production build root 先以完整且非空的 run/source/worktree/namespace identity 进入 `preparing`，仅在 scheduler lock exact-match 后进入 `building`。Scheduler run lock 使用唯一的 `fsusblog.scheduler-run-owner.v1` authority：owner 绑定 run、包含 target tier/source/worktree/namespace 的 candidate digest、随机 token、PID、跨平台 creation/start identity、executable/command digest 与 Unix process group 或显式 Windows Job Object authority；`starting`、`running`、`finalizing`、`complete`、`failed`、`cancelled` 转换和整个 owner 文档都由 content digest 封存，active state 不得倒退。heartbeat、terminal finalize 与 reclaim 先取得 owner token + process identity + content digest 的 CAS marker，再重验实时 process/group authority并原子改写；相同 process authority verifier 也供其他 lease schema 直接复用，避免复制 PID/start/command/group 判断。normal finalize 先归档 terminal receipt，再以原子 rename 释放 lock；stale reclaim 也必须先归档终态且 compare-before-delete。损坏、缺失或暂不可读的 owner 只产生绑定原始 owner bytes 的首次 observation 和固定宽限，始终 fail closed，禁止读取 lock mtime、进程名或 PID-only 结论。每个实际 tier 在执行命令前完成 creation-bound registration handoff；Linux production command 运行在 `systemd` transient service 的 `KillMode=control-group` 中，Windows supervisor 按可注入 native-adapter 状态机完成 ready/start handshake、suspended create、kill-on-close Job assignment、resume 与失败恢复后才允许执行。PPID snapshot、固定间隔轮询和普通 process group 只可作诊断，不能冒充 durable containment；平台无法建立该权威时在命令执行前 fail closed。sealed process-tree receipt 同时保存 scheduler lock、compiler identity 与 containment authority；active/finalize 会重查 authority 是否仍有 writer。四个 production CLI 入口从 `prepare` 成功起由同一外层 lifecycle 覆盖 scheduler、DAG 后 evidence、cleanup 与 finalize；`SIGINT` / `SIGTERM` 在 advisory 和 enforced resource mode 都会终止 active tier 并封存 `cancelled`。tier 原始失败与 seal 失败并存时保留原始 exit code，把 seal failure 作为次级诊断，并用 terminal fallback 把 manifest/owner 写为 `failed` 或 `cancelled` 后移除 `.active.json`。resume、production build owner、build GC、orphan cleanup 与 build-server cleanup 的 scheduler 活跃判定全部调用上述唯一 verifier；PID 相同但 start/executable/command identity 不同视为 inactive，owner 不完整或不可读则 `owner-unverifiable`。active marker 缺失/不完整、receipt 篡改或 identity collector 失败均阻塞 GC；GC 以 inode、manifest 与 active-owner digest 建立 compare-before-delete marker，经 exact recheck 后原子 rename 到独立 tombstone，不能删除同 run ID 的 replacement root。finalize 会拒绝活跃或不可验证 writer，并封存排除治理文件自身的 root content digest；`complete`、`failed`、`cancelled` root 的后续文件、mode 或 symlink 写入都是治理失败。

Stale build GC 是每个 fresh execution 的 `managed-production-build-gc` preflight scheduler step，不是 detached/background process。该 step 独占 `build-root-gc` 与 `disk-heavy`、声明 `io` resource class、CPU/memory minimum、5 分钟 timeout 与 byte/inode budget；所有后续 tier 都显式依赖它，故不会与 benchmark、load、soak 或其他 measurement window 重叠。receipt 逐 root 记录 exact active-owner identity、size/inode、决策、delete result 和 post-observation；只允许删除 `.tmp/build/<validated-run-id>` 直接子目录。identity unknown、symlink/root escape/current run、预算或删除失败均以 `infra.build-gc` 失败 receipt 保留 root；dry-run 永远不是 clean measurement environment 的 qualification。

Schema migration 的并发启动验收固定由 `SchemaMigrationIntegrationTests.RunAsync_AllowsConcurrentStartupMigrationAgainstSameDatabase` 覆盖：两个实例必须争用同一个 session advisory lock，同时让迁移中的 `CREATE INDEX CONCURRENTLY` 真正完成。若等待方使用阻塞 advisory lock，该用例应以锁链诊断失败，不能通过延长 command timeout 掩盖。

`SchemaMigrationIntegrationTests.RunAsync_UpgradesLegacy20260517RealDump_WhenProvided`
不属于普通 `integration` producer；普通计划用
`Fixture!=Legacy20260517RealDump` 排除并记录 `not-selected`。它唯一属于
local-only `legacy-20260517-real-dump` producer，该 producer exact-select
一个 test ID，并要求显式 enable、可读 decompressed custom dump、dump
SHA-256、source SHA 与 PostgreSQL image ID。只有真实 restore、两次
migration、legacy counts 与 postconditions 都进入同一 TRX runtime evidence
后，`planned -> executed -> passed` 才成立；任何缺失、identity drift、restore
或 migration failure 都 fail closed。

xUnit 通过 `tests/backend/xunit.runner.json` 固定 `stopOnFail=false`，单次运行会收集全部测试失败；filtered tier 先复用一次 `backend-filtered-build`，随后统一 `dotnet test --no-build`。每个 ordinary/special/filtered lane 都写入 `.tmp/test-results/backend/<lane>.trx`，retention audit 以稳定 `Class.Method` identity 汇总真实 p50、p95 与失败历史。所有使用 `PostgresSchemaMigrationFixture` 的测试类必须进入 `SchemaMigrationPostgresCollectionA/B` 之一；两个 collection 各自持有隔离 Postgres container，每个测试仍创建唯一数据库。`postgres-test-collections.json` 当前登记 87 个 fixture-backed class、606 个估算 case，checker 从源码重新发现 class 与 `Fact`/`Theory` case，拒绝漏 annotation、重复/遗漏 manifest 或 `estimatedFacts` 漂移。ordinary backend lane 与 Production union 都排除 `Fixture=LocalRedis`；四个 Redis case 只由 canonical LocalRedis producer 在隔离 Redis container 下执行，缺少 `FSUSBLOG_TEST_REDIS` 时仍 fail closed。Production fresh 只由物理 `backend-tests` bundle 生成一套 run/source-bound Release server/test artifact，随后一次 discovery 和 exact-union 统一消费；`BackendTestGovernanceTests.Issue40Requirements_HaveEvidenceAndRiskTraceability` 保留原测试 ID、原断言与 coverage，并作为普通 union 成员执行，不再分裂独立 postlude testhost 或数据库 namespace。Rights、Integrity、Cross-stack、Privacy/ZK 只消费同轮 summary/receipt/digest projection，不得触发兼容性 Debug build。`backend-production-build-authority` 根据受版本控制的 consumer inventory fail closed 拒绝回归。production union 从物理 `backend-tests` bundle 的实时 CPU 与内存配额生成互斥且穷尽的 testhost topology：默认 testhost 上限为 `min(max(2, floor(sqrt(cpuBudget))), cpuBudget, floor(memoryGiB / 1GiB), 12)`，再结合 discovered class/affinity unit、cold application/class startup penalty、Docker/PostgreSQL dependency weight 形成 machine-readable workload model；低于 2 CPU 或 2 GiB 时 fail closed。testhost 数、每 host processor 数和 rolling partition 数是三个独立维度：每个 host 至少保留 1 GiB，CPU 按商和余数（或诊断 weighted mode）分配并精确耗尽当前 admitted grant，partition 默认是 testhost 的两倍并受不可拆 planning unit 数限制。外层 grant 扩张时只在最新 CPU/内存余量内新增 slot，收缩到 active allocation 以下会 fail closed。`FSUSBLOG_BACKEND_PRODUCTION_SHARDS`、`FSUSBLOG_BACKEND_PARTITION_MULTIPLIER`、`FSUSBLOG_BACKEND_PROCESSOR_ALLOCATION_MODE` / legacy exact `FSUSBLOG_BACKEND_SHARD_PROCESSORS` 只用于诊断，summary 会记录公式、模型输入、候选 score、初始/潜在 topology 和 override 来源，不得把任何机器的 host 数写成 production 常量。高系统 load 不会把 testhost 静默降为单线程，资源冲突与内存门禁由外层 scheduler 负责。

backend xUnit 的平台成员资格由 `tools/test/backend-platform-selection.mjs` 唯一投影。测试使用稳定 `[Trait("Platform", "Unix")]` 声明 Unix-only；ordinary、CI 与 Production 从同一规则生成 filter：Windows plan 将该 test ID 记录为 `not-selected`，Linux/macOS plan 必须把它记录为 `planned` 并由 TRX 对账为 `passed` 或 `failed`。ordinary lane 分别写入 `.tmp/backend-unit/platform-membership-plan.json` 与 `platform-membership-outcome.json`，保存 VSTest test ID、FQN、display name、source assembly 与语义结果；Windows 记录不声明 assertion count。需要实际权限值的测试再声明 `[Trait("PlatformEvidence", "UnixMode")]`，并在同一 TRX result 中写入 typed runtime receipt；只有实际 fresh/effective `0700`、过宽 `0777` existing root 收敛、六个 group/other deny 与 owner create/read/delete 均成立时，`passed` outcome 才可签发。六条 upload request path 使用 `[Trait("PlatformEvidence", "UnixRequestPath")]`：plan 必须逐 case 保留 complete、abort、expired-status、expired-part-map、expired-part、expired-token 的唯一 identity，TRX receipt 必须逐条证明 expiration root 不可枚举、真实 public request 结果及 session/index postcondition；complete 还证明 manifest、owner、token digest、retry 与错误 owner/token 行为，其他 case 则证明 cleanup 完成。物理路径逃逸使用 `[Trait("PlatformEvidence", "UnixSymlinkBoundary")]`：receipt 绑定不泄露绝对路径的 root/link/target SHA-256 identity，要求真实 root 外链接被拒绝且 output 为空、同形 root 内链接正常解析、target identity 匹配并完成 link cleanup。带 platform trait 的测试不得通过 runtime `return`、skip 或 warning 伪装 Passed，runtime receipt 也不得脱离对应 evidence trait；`backend-test-governance` 使用正反 fixture 持续拒绝这些路径。Unix 文件权限设置不可用、mode 读取失败、权限未生效、目录仍可枚举、symlink identity/关系/清理不成立、六条成员缺失或 request postcondition 不成立时均由测试或 evidence reconciliation 失败。

`node tools/check-test-suite-convergence.mjs` 同时治理测试证据形态和历史 replacement。backend test 不得读取 production `.cs`、C++ header 或 performance SQL 后以字符串存在性/顺序充当行为证据；应让生产路径消费 `internal readonly` 契约，并通过 spy 调用顺序、实际执行 SQL、生成器 `--check`、TestHost 或隔离 PostgreSQL 验证可观察行为。删除映射只允许写入 `tests/test-retention-replacements.json`；baseline、post-baseline、retired tier 与 source-lock owner 路径只允许写入 `tests/matrix.yml.governance`。issue-local retention/convergence 文件不再参与当前治理，也不得重新引入。

跨语言编码规范只有一个 authority：[`development/coding-conventions.md`](development/coding-conventions.md)。它以 Microsoft .NET C# 约定为母规范，但外部 wire/ABI/database/third-party contract 与语言语法保持更高优先级。`static-governance` 执行 `node tools/docs/check-authoritative-development-docs.mjs` 和 7 类负向 fixture，一次聚合 AGENTS/CODEOWNERS/labeler/PR template 的失效路径、退休符号、命令/链接、style owner、formatter baseline、generated/vendor/fixture 分类及 external adapter 错误。

C# 执行层由根 `.editorconfig`、Roslyn build settings 与 `tools/dotnet/check-csharp-style.mjs` 共同负责。`static-governance` 运行 changed-file gate 和完整正反 fixture；full mode 对 tracked C# 文件使用透明 baseline，`strict-full` 是清空命名/XML debt 后的完成门，不是可以长期忽略的展示报告。纯机械迁移固定为三个 blame-ignore commit：`892489472e27c85d277fb98c2c35969851294b58` 负责 .NET 10 whitespace/初始 import pass，`b5c116cd54e7a0a86fd243059502a3e23f364074` 负责确定性 import 排序，`4839b4e1bc9f8c181fad14889414c729cba3108c` 负责 Roslyn 兼容的 root-namespace 分组；三者均只改 C# 格式。`IDE1006` 不自动批量 rename public/wire/ABI/database contract。文本 checker 不重复否定 Roslyn 接受的 continuation alignment、auto-property、pattern、initializer、alias import 与字符串内容；public contract type 和较窄的 protocol/codec/security public member 文档范围由 policy 分开声明。命令、阶段边界与实时 baseline 见 [C# style enforcement](development/csharp-style-enforcement.md)。

Backend configuration 只允许四个 authority：共享 `appsettings.json`、真实 `appsettings.Production.json`、最小 `appsettings.Development.example.json` 与 production operator 输入示例 `.env.production.example`。`static-governance` 执行 `node tools/configuration/check-appsettings-authority.mjs` 及 5 个聚合 fixture，拒绝重建完整 JSON example、development overlay 重复 base、production fail-closed value 非空、示例 secret 可用值或 consumer 回退到退休模板；覆盖顺序固定为 base < production overlay < `.env.production`/Compose environment < command line。

拓扑校准使用 `node tools/test/calibrate-backend-production-topology.mjs --fresh`；默认比较经机器 CPU、内存与 planning unit 裁剪后的 `2/4/6/8/12` testhost、`1.5/2/3` partition multiplier 和 uniform/weighted processor allocation。每个 candidate 至少独立执行三次完整 `./tools/test.sh production --fresh`；少于三轮、CPU 预算超过进程可见 CPU 或内存预算超过宿主总内存都会在执行前 fail closed。校准不能复用上一轮 pass、TRX、coverage、checkpoint 或 release evidence；完成后输出 `.tmp/diagnostics/backend-topology-calibration.json`，只允许把中位数/方差用于选择后续 topology，选出的配置仍须重新跑 fresh release validation。完整命令、指标定义、平台降级与销毁规则见 [`testing/backend-production-topology-calibration.md`](testing/backend-production-topology-calibration.md)。

审计、运维 readiness 与 PublicAOT artifact 测试按可观察职责拆分，不再由混合 `*ContractTests` 读取实现源码。审计证据分别由 `AuditLogStoreTests`（结构化落库、批写与 chain tail）、`AuditLogWriterWorkerTests` / `AuditFallbackWriterBehaviorTests`（失败降级与 durable fallback）、`AuditTamperEvidenceBehaviorTests`（canonical hash/MAC、固定长度校验、跨 culture chain ID）和 `AuditProjectionBehaviorTests`（PII disclosure 决策）拥有。运维证据由 `ProductionReadinessCoordinatorBehaviorTests` 验证并行启动、取消与多结果保留，`BackupRestoreScriptBehaviorTests` 通过临时 shell harness 实际调用 `pg_dump` / `pg_restore` 替身并覆盖连接串及阻断路径，`AdminOperationsBehaviorTests` 验证危险操作的 diff/MFA 策略和 typed confirmation。PublicAOT 的当前 ArticleDetail V4 文件写读、V3 只读兼容、30 秒内存 TTL、retired payload 拒绝和磁盘清理由 `ArticleDetailAedsArtifactStoreBehaviorTests` 负责；sidecar 与 cache invalidation 的可观察效果继续由 `PublicAotFileShellCacheTests`、`PublicAotDocumentServiceTests` 和 `PublicAotInvalidationTrackerTests` 负责。`Recovery_RealProcessCrashAtDurableState_RestartsIdempotently` 是 Public AOT process-crash recovery 的唯一 xUnit owner：五个 durable-state case 通过同一 test assembly 的非 discoverable `public-aot-crash-worker` command，以 `ArgumentList` 传递 sandbox/cache root、exact state、invocation 与 parent PID；父测试要求 child handshake 和 durable-state marker 精确绑定 executable/assembly/command digest、PID、非泄漏 root identity 和输出 digest，随后执行两次幂等恢复。缺参、重复/未知参数、root escape、spawn/timeout、正常完成、stale receipt 或未到指定 state 均失败；普通 discovery 不存在独立 worker test ID。实现选择、SQL 形状与吞吐预算只由静态治理或 #1042 benchmark lane 证明，不回流为 source-string 单元测试。

Article content 与 Article Rights canonical hash 测试按 [canonical hash test ownership](testing/canonical-hash-test-ownership.md) 分成完整 golden vector、产品行为 Theory、manifest compatibility 与 source governance 四层。字段 mutation 以属性名保留独立 test identity；payload 片段、runtime type shape 和 assembly reference 不再混入业务 hash 断言。支持版本、owner mapping 与 test-ID replacement 分别由 canonical vector fixture、ownership fixture 和中央 retention ledger 对账。

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

矩阵的 `executionMode` 是可执行证据契约：`execute` 只能启动 physical producer；`projection` 只能按 catalog 消费 canonical producer receipt；`summary` 只能消费结构化 receipt 并写出声明的 receipt。`summary` 必须声明 machine-readable `commandKind`、`summaryInputs`、`outputReceiptSchema`；使用 `node tools/run-test-matrix.mjs aggregate <authority>` 时，`<authority>` 必须在 `aggregateAuthorities` 中显式声明，精确解析到非排除 summary tier、dependency jobs 与 artifact/receipt inputs。`aggregate --dry-run` 和 `validate` 复用同一 planner，因此不存在、被 `manualOnly`/`localOnly`/`nightlyOnly` 过滤为空、或误把 tier ID 当 CI job 的 target 都会在静态校验时 fail closed；aggregate 本身不启动底层 producer。

### Rights V3 test matrix

Rights V3 的完整验收矩阵由 `tests/fixtures/evidence-projection/rights-v3-test-matrix.json` 列出完整 canonical assertion IDs，并由 `tools/test/lanes/rights-v3-test-matrix.sh` 生成独立 projection receipt。它属于 local Production 的 `integration-runtime` 证据，不并入 fast gate，也不再启动额外的 `dotnet test`、Vitest、frontend static checker 或兼容性 Debug build。普通 backend assertions 从同轮 backend production exact-union TRX 投影，frontend assertions 从同轮 rolling Vitest catalog/report 投影，editor workspace 与 public page manifest 规则从 run-bound frontend static receipts 投影；唯一 PostgreSQL schema migration method 由 canonical `Category=Integration` universe 执行一次并写 producer receipt。

本地复现：

```bash
./tools/test.sh production
```

该 lane 成功后写入 `.tmp/release-evidence/rights-v3-test-matrix.json`。receipt 必须绑定 source commit、worktree fingerprint、run ID、namespace、每个 producer digest 和完整 expected ID 集合；缺失、重复、非 Passed、错 source/run 或 digest mismatch 均 fail closed。PostgreSQL schema migration 仍由 canonical integration universe 使用 Docker fixture 执行；若本机缺少 Docker，应先补环境依赖再重跑，不应跳过或以旧 run 证据替代。

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

全仓 hidden retry 由 `tools/test/hidden-retry-scanner.mjs` 与 `config/testing/retry-disposition-registry.json` exact-one 对账，并已进入 `validate-matrix`；新增未登记 shell、Node、C#、Docker、framework、CI、timeout 或 failed-resume 重执行会直接失败。correctness producer inventory 固定 `allowedRetries=0`、`firstFailureBlocksQualification=true`，但在 execution-envelope、replay-plan 与 temporal-context 三项外部 owner receipt 尚未逐 producer 验证并接入统一 attempt runner 前，entry 必须保持 `migrationState=pending-external-authorities` 与 `qualificationEligible=false`，不得用本分支自算 digest 或把 inventory 声明当作完成执行证据。

Qualification consumer 统一通过 `tools/release/clean-first-attempt-verifier.mjs` 重验 aggregate 与 attempt receipt；三轮 release-candidate cohort 以 append-only slot event 保留失败轮，并要求三个独立 run/attempt root。Browser Contract、Release Reliability、Production Correctness 的成员集合由各自 canonical authority 提供，不能由 group status 或 summary 代替。immutable build、release projection 与 finalizer consumer 只接受 #2654、#2655、#2656 adapter 生成并由外部 owner verification receipt 验证的 `fsusblog.producer-semantic-outcome-candidate.v1`；consumer 不扫描 raw manifest/output/log，也不调用 producer。对应 inventory 在 execution-envelope、replay-plan 与 temporal-context authorities 尚未逐 producer 接入前保持 `qualificationEligible=false`，因此 current workflow 不会把 fixture callback、recovered evidence、final exit、latest/mtime/path 或旧 summary 升格为 release qualification。

`coverage-gate` 与 `production-correctness` 是两个 independent required checks：coverage 负责阈值和合并覆盖率，production-correctness 负责 browserless 运行时风险 DAG；`production` 只是相同拓扑的兼容命令。`release-final` 在二者之上增加唯一 Browser Contract、strict coverage、changed-code coverage、critical module coverage、ordinary required-job completeness、live exposure、artifact digest binding 和 test-quality lint。browser diagnostics receipt 保持独立，不存在 visual skip 影响 correctness 的路径。

九个历史 release domain 由
[`testing/release-domain-projection-ledger.md`](testing/release-domain-projection-ledger.md)
逐断言映射到 canonical producer。`release-final` 只消费其中同时属于 canonical
final evidence input 的七份 `fsusblog.evidence-projection-receipt.v1`，并在最终
binding 中封存每份回执的精确 ledger 路径、文件/content/build/policy digest；
它不读取 producer receipt、assertion report 或原生结果，也不执行缺失证据的
fallback。集合删除、替换、重复、新增、路径漂移或重封篡改均 fail closed。

`load` 与 WebSocket pressure 检查会写入 `.tmp/perf/load-public-api.json` 和 `.tmp/perf/notification-stream-pressure.json`，release evidence 会把 `.tmp/perf/` 作为性能证据归档。默认参数来自 `tests/performance/perf-policy.yml`：HTTP load baseline 为 `concurrency=10`、`rounds=6`、`durationMs=30000`；WebSocket pressure 为 `connections=50`、`durationMs=30000`。

性能、load、soak 与 resource qualification 的 measurement window 统一由
`tools/test/measurement-noise-envelope.mjs` admission owner 包裹。
`config/testing/measurement-noise-policy.json` 精确区分有上下限的 blocking
指标和无资格上限的 diagnostic-only 指标；Linux collector 同时读取宿主
CPU/run queue/steal、PSI、major fault、disk，以及 current-run
cgroup/process-tree throttle、memory event 与 I/O。每个已启动 window 都保留
preflight、during、post 三段宿主与 current-run evidence。collector
unsupported、缺失或 permission denied 不填零并以
`infra.measurement-collector-unavailable` fail closed；任一 blocking 指标超限
以 `infra.noisy-measurement-window` 阻止资格和产品性能结论。preflight
admission wait 在 measurement 计时开始前完成，不缩短声明的有效窗口；owner
token 使 mixed/local-production 中的嵌套 lane 只消费外层 envelope，不能双包。
直接 lane 与 Production physical bundle 的 measurement step 都先创建唯一 transient
user-systemd task cgroup，并在 workload 启动前完成该 task owner 的 preflight；bundle
runner 所在 shared cgroup 不具有 measurement authority。

每个已启动 window 把 run/window、attempt/event sequence、前序 receipt digest 和
content digest 写入独立 authority journal event；Production Fresh journal 位于当前
attempt 的受保护输出树；run-level content-addressed expected-attempt manifest 绑定
完整 attempt roster、每个 authority root 的文件清单/digest 和 receipt chain head，
并由每个 physical attempt 的 `terminal-attempts.json` 记录当时的 manifest head
digest 与外部 expected-root roster。run 目录中的独立初始化 authority 和
content-addressed terminal-authority chain 再绑定每版 terminal protection 的原始
digest；resume 必须同时存在非空 terminal authority/protection，不能从空磁盘重建
首次 attempt。terminal receipt 缺失、回滚或按当前 inventory 重算，也必须与外部
authority 和实际 attempt 目录清单比对并 fail closed。resume 不能从当前仍可见的
root 反推期望集合。
普通 evidence path 只是 chain head pointer，不是可覆盖的资格事实源。consumer
必须读取完整 manifest/journal、重算每段 policy evaluation 并验证连续
sequence/hash chain；缺少整个 prior root、receipt
改名隐藏、unknown entry、输入重排、event 缺口、pointer 覆盖或只提供 retry 都 fail
closed。三轮 qualification 还必须分别来自三个
不同 run ID 且逐轮 clean；noisy first attempt 会保留，不能由 retry 或另两轮覆盖。
该机制只观察并分类，不 kill 外部进程，也不改变产品性能阈值、并发或 measurement
duration。matrix 内直接拥有 envelope 的 tier 不与同轮 sibling task 共享执行 wave，
并保留 `benchmark-window` 排他资源；这只隔离测试调度，不改变被测 workload
的并发，也不锁定或清理宿主上的外部进程。benchmark build readiness 在 admission
之前独立复用 run-owned build-server verifier；cleanup receipt 顶层只绑定跨调用稳定的
run、namespace 与 production build root，每个 append-only event 单独绑定本次
Fresh/resume source。只有 process 的 invocation source 与当前 event source、PID start
identity 及 exact argv 全部匹配时，才终止本轮 attached 或 detached compiler server，
并持久化 cleanup 前后 inventory；qualification
owner 本身保持纯观察，sibling、IDE、未知 owner 或其他外部进程始终不被清理。

外部 process identity inventory 是诊断字段，不计入 required metric
`collectorCoverage`；identity 不可读时仍用 host cumulative 减 task-cgroup
cumulative 判断 external CPU/I/O。单项 cgroup metric 缺失会把对应值记为
unavailable、降低 metric collector coverage 并保留其余有限 observation。
collector gap 仍使 preflight fail closed，measurement workload 不得启动；
存在有限且超限的 CPU/disk/pressure blocker 时同样按 admission noise 处理。

Linux task owner 只有在 `cgroup.procs` 与 measured root process tree
精确相等时才有 current-run 归因权。shared/incomplete cgroup、任一阶段
collector failure 或缺失权限都会立即写 terminal fail-closed receipt。task
environment 保存在 run-local `0600`
JSON carrier，不能展开进 `systemd-run` argv。完整 owner/disposition 审计见
`config/testing/measurement-window-inventory.json`。`soak-long-evidence-import`
必须验证导入 summary 内的 `external-soak/72h` 三阶段 clean receipt；仅有
`mode`、`status` 或外部文件路径不具有 release-final 权威。

`tests/performance/perf-policy.yml` 是 load profile 的唯一策略源。`tools/test/lanes/load-profile.sh <profile>` 与 `runtime-evidence-probe.mjs load-profile` 必须从该文件读取 baseline / expected-peak / 2x-peak / burst 的 `concurrency`、`rounds`、`durationMs` 与预算阈值；只有显式环境变量 `FSUSBLOG_LOAD_PROFILE_CONCURRENCY`、`FSUSBLOG_LOAD_PROFILE_ROUNDS`、`FSUSBLOG_LOAD_PROFILE_DURATION_MS` 可以覆盖执行参数。每个 load profile summary 必须同时写入 `policy.file`、`profileName`、`declared`、`effective`、`thresholds`、`thresholdEvaluation`、`overrideSource` 与 `overrideSources`，release evidence 校验会拒绝没有解释的 policy/effective 不一致或没有 threshold 对照的 performance profile。`performance-evidence-summary` 只聚合 baseline、expected-peak、backend benchmark 与 capacity saturation reference，不消费 browser performance regression；browser performance 写入自己的 diagnostics summary。聚合状态保留各 ordinary producer 的真实 status，任何 failed 优先于 blocked，不能无条件写 `status:"ok"`。

load profile 与 release resource budget 的 runtime summary 是未资格化的 product
evidence。task owner 在 workload 结束时绑定其 path/size/SHA-256，并且只有 post
observation 完成、完整 authority chain 通过语义重算且 terminal receipt 为 clean
后，consumer 才能发布 `fsusblog.qualified-load-profile-summary.v1` 或
`fsusblog.qualified-release-resource-budget-summary.v1`。workload nonzero、collector
失败或 noisy receipt 不得发布 product pass；允许的持久结果只有
`fsusblog.measurement-product-conclusion.v1` 的 `infra-no-conclusion`，且不能携带
product metrics、thresholds 或 threshold evaluation，或者完全不产生 product
conclusion。

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
- `release-memory-leak-budget` 与 `release-open-handle-budget` 必须输出真实资源指标，summary 文件分别为 `.tmp/release-evidence/memory-leak-summary.json` 与 `.tmp/release-evidence/open-handle-summary.json`。每个 summary 的 `metrics[]` 不得为空；每个 metric 必须包含 `name`、`startValue`、`endValue`、`maxValue`、`delta`、`threshold`、`thresholdOperator:"<="`、`thresholdField:"delta"` 和 `status`。`status:"ok"` 只有在至少一个真实资源 metric 通过预算且没有 unavailable metric 时才允许写入；缺少指标必须写入 `unavailableMetrics[].reason` 并使 lane failed，阈值超限也必须 failed。默认阈值为 RSS delta `FSUSBLOG_RELEASE_RESOURCE_RSS_DELTA_THRESHOLD_BYTES=67108864`、FD delta `FSUSBLOG_RELEASE_RESOURCE_FD_DELTA_THRESHOLD=16`，本地无法从端口发现后端进程时用 `FSUSBLOG_RELEASE_RESOURCE_PID` 指定。qualified-local final-container 运行同时使用 topology authority 封存的 `FSUSBLOG_RELEASE_RESOURCE_CONTAINER_ID` 与 host PID，重新 inspect 二者后从该容器 `/proc/1` 读取指标；不得用端口猜测另一个进程，也不得把宿主 `/proc` 权限拒绝改写成零值。

- `release-reliability-scenario-catalog.json` v4 只声明 exact-seven 场景和结构化 lifecycle action 引用；35 个动作的 executable/args/env/cwd、timeout、receipt path/schema、pass status、state domain 与 failure-safe 属性全部由 `release-reliability-lifecycle-action-registry.json` 唯一拥有，并受对应 schema 与 closed-world `runtime-state-domain-registry.json` 校验。executor 对每个场景严格按 `preconditions → resetsBefore → measurement → postconditions → resetsAfter` 执行真实子进程，启动前清除该动作的期望回执，超时执行 SIGTERM/宽限/SIGKILL，并由独立 verifier 重读原始 bytes；exit code 0、stdout 文本或 stale `passed` 文件都不能代替本轮动作。首个非 cleanup 失败冻结为 `firstFailure` 并阻止后续 measurement/postcondition，只有 registry 标为 `safeAfterFailure` 的 reset-after 可继续；其失败单独进入 `cleanupFailures`，不能覆盖首因。result/timeline 保存每个动作的开始/结束、退出/信号/超时、原始回执路径/bytes digest，以及 reset 后、measurement 后和最终 observation。任何动作未执行、失败、回执缺失/重封或最终 observation 不 clean 都使 `qualificationEligible=false`。
- 普通 runtime lifecycle 会 exact-match backend/PostgreSQL/Redis identity、namespace、run、base URL、network membership、resource counter 与 final descendant observation。mutation reset-after 只删除 `.tmp/mutation/backend-critical` 并重新观察其缺失，不能删除或替换 immutable production build。`release-data-scale-m` 不在通用 lane 内 seed 或 cleanup：precondition 必须消费显式 `FSUSBLOG_DATA_SCALE_RUNTIME_RECEIPT_PATH` 指向的 dedicated PostgreSQL/Redis/backend/root authority，并把该 authority 的 raw path/bytes digest/content digest 绑定进 adapter receipt；measurement 只使用从该 authority 派生且 exact-match 的 URL、container IDs、namespace、run 与 roots。reset-after 只接受显式 teardown authority，必须与同一 `dataScaleRunId` 绑定并证明资源、端口、lease 与 roots 已清空。缺少 dedicated runtime/teardown owner 或 process-tree zero-descendant authority时保持 fail closed；不得退回共享 qualified-local runtime，也不得由 lifecycle adapter 伪造 owner receipt。

- Release Reliability generator 只写 `candidate-receipt.json`。独立 verifier 必须在 runtime/container 仍存活时写入内容寻址的 `verified-attestation.json`，wrapper 随后清理 owned runtime，再由 verifier finalization 写入绑定 candidate、attestation 与 exact persistent-file manifest 的 `qualified-receipt.json`。清理后的普通 `--receipt` 复验不得依赖 live container，但必须重读 manifest 的每个持久文件和 verifier source；缺 attestation、跨 run、文件集合不完整、digest 篡改或 post-attestation bytes 漂移全部 fail closed。Registry/local image 均必须封存并复验 FsusBlog OCI revision 与 `io.fsusblog.build.fsusui-source` / `io.fsusblog.build.fsusui-commit`，不得仅凭 RepoDigest 把另一 source 的 image 拼入当前 receipt。

- qualified-local final-container 启用 .NET single-file crash diagnostics，full dump 只写入容器私有的 `/app/runtime-cache` tmpfs，并随 owned container 删除，绝不复制到仓库或 release receipt。仅当该 owned backend 异常退出时，cleanup 才在私有 run-bound 目录保存 Docker state、最多 200 行且不超过 1 MiB 的日志尾部，以及各不超过 1 MiB 的 JSON crash report / createdump log；采集失败不得覆盖原始 producer 退出状态。这些诊断可能包含代码路径，完成归因后必须与该 run 的临时证据一起清理。
- qualified-local final-container 在 Docker 进入 healthy 后仍使用固定 60 秒 admission window；窗口内必须通过 `/health/live`，并逐条通过 `config/testing/runtime-http-route-contracts.json` 中 `runtime-load-soak` 的 canonical 六路请求。每条 binary route 都必须是 HTTP 200、`application/octet-stream`，且 AEDS v2 的 frame type、header、payload length 与 CRC 正确；因此 category/tag 的 404、错误 frame 或损坏 payload 会在 soak 前阻断候选，不能等待 `PublicHotRead.MaxSnapshotAge` 刷新。

在 Windows，资源 probe 通过 `Get-NetTCPConnection` 解析监听进程，并分别用 `Get-Process.WorkingSet64` 与 `Get-Process.HandleCount` 采集 RSS 和 handle 指标；这仍是对同一进程的真实计数，无法解析或读取时保持 unavailable/failed，不能以零值或目录存在代替。
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

`check:public-hydration` 中的 refresh hydration detector 会把匹配 Vue hydration 关键词的 `console.warn`、`console.error` 与 `pageerror` 统一视为 Browser Contract / diagnostics failure；不得以 `PASS (n warning(s))` 形式放行 hydration warning。该 detector 每次运行都会写入 `.tmp/release-evidence/public-hydration-detector-summary.json`，schema 为 `fsusblog.public-hydration-detector.v1`，并包含 route、stage、browser、viewport、warnings/errors 与 detector canary 结果。browserless Production 与 release evidence manifest 不读取该 Chromium artifact，而以 clock、browser-env model、payload、DOM diff、sidecar 和 matrix summary 作为正确性证据；`release-final` 的单一 Browser Contract 独立封存并校验 detector 结果。

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
node --test tests/tools/browser-migration-contract.test.mjs
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

CI release evidence 必须显式依赖当前 `plan-pr-risk` authority，并单独下载本 workflow run 的 `integration-runtime` artifact。required scale summary 的 `runIdentity` 必须 exact-match `GITHUB_SHA`、`GITHUB_RUN_ID`、`GITHUB_RUN_ATTEMPT` 和声明的 producer job；四项只要启用一项就必须全部存在。缺 artifact、缺 identity、跨 run/attempt/commit、错误 producer 或 historical artifact 都是 hard failure，不允许以宽松 artifact 下载或旧 summary 继续生成 release evidence。

---

### `load` — 轻量并发压测

> 非性能基准，仅验证基础并发稳定性。

**覆盖内容**：

- 文章列表 / 详情并发读（baseline `concurrency=10`、`rounds=6`、`durationMs=30000`，源自 `tests/performance/perf-policy.yml`）
- Binary 链并发读
- WebSocket binary notification stream 多连接稳定性（`connections=50`、`durationMs=30000`）

**backend-perf / 性能基准**：

`backend-perf` 先并行完成 Release test/benchmark producer readiness 与治理，再在 machine-quiet `benchmark-window` 中执行 native verifier P99；`backend-benchmark-regression` 负责完整 BenchmarkDotNet 回归并输出 release evidence。共享 producer 在 scheduler 下绑定 source commit + worktree fingerprint，运行时生成的 backend log/cache 不会造成同轮指纹漂移；测试 reader 一律 `--no-build --no-restore`。该 lane 默认运行 `*HotPath*`：request audit/context、binary frame encode/PipeReader binding、notification shared fanout/frame pump、read-model projection、content filter、related scoring、stats projection 与 crawler/UA normalization。`tests/performance/backend-hotpath-budgets.json` 为唯一预算源；有诚实旧实现的场景按相同参数比较 mean/allocation ratio，没有可比旧实现的 PipeReader binding 与 frame pump 使用绝对 mean/allocation budget。

Native verifier P99 的唯一成员是 `NativeGroth16ZkProofBackendTests.MclGroth16VerifierLibrary_VerifyP99StaysInsideNativeBudget`。普通 backend unit/Production shard 通过 `Category!=Performance` 将其记录为 not-selected；`backend-perf-native-p99` 在已接纳的 `benchmark-window` 内验证 current source、Release test assembly、managed/native MCL、verifying-key fixture 与 measurement owner 后精确执行一次。测试没有环境变量 early return，保留一次 warmup、32 条逐次 `Verified=true` 测量、排序后的 p99 与 `<= 50ms` 预算；TRX、样本或任一前置 identity 缺失/漂移只能生成 failed producer summary，不能声明 Passed。

`tools/perf/check-backend-benchmark-regression.mjs` 必须读取 BenchmarkDotNet JSON 的实际 `Statistics.Mean` 与 `Memory.BytesAllocatedPerOperation`，逐预算生成 before/after measurement、失败原因和 release summary。缺基准、缺相同参数、缺 allocation 或超预算都必须使 lane 失败；禁止再用 report 数量或固定 `status=ok` 代替性能证据。数据库热路径另由 PostgreSQL AOP command counter 断言：stats 子端点各自只执行其窄查询，related-reading 冷 miss 有界且 memory hit 不访问数据库；并行路径使用真实 TCS/barrier 验证同时启动、失败、取消、超时和资源释放。

冷运行会按 HotPath benchmark class 分片，class 内的 baseline/current 与全部参数组合保持不可拆；每个 class 使用独立 OS 进程、独立 artifacts 目录和 BenchmarkDotNet in-process no-emit toolchain，仍使用 `Job.ShortRun` 的完整测量强度与各 class 的 `MemoryDiagnoser`。并发数取实时 `FSUSBLOG_STEP_*` / `FSUSBLOG_BUNDLE_*` grant、OS 可用 CPU、空闲/总内存的共同下限；Linux 会把进程允许且已授予的 CPU 动态划成互斥集合分给 worker，并将每个集合的实际大小传给 .NET runtime。所有 class JSON 汇总后只调用一次相同 budget checker，默认契约必须得到 8 个 class、18 个 benchmark method、22 个参数化 measurement，不能通过删 benchmark、缩 iteration 或改预算换取时长。

production 的完整 HotPath benchmark 作为 mixed performance window 的独立 cohort 与 baseline、peak、burst、notification、QPS 同窗执行。六个 cohort 只声明相对 CPU / memory weight，`run-mixed-performance-window.mjs` 从实时 step/bundle grant 生成总和不超过父 grant 的子 grant；benchmark 使用较高相对 memory weight，但 worker 数仍由子 grant 与实时主机内存共同求得，不设置固定 GiB/worker。mixed summary 必须绑定 window `startedAt` 之后生成的 8 份 class report、22 项 measurement、统一 checker 与 release summary 的 SHA-256；checker 真实失败必须保留为 failed cohort，不能被 fresh marker 改写为成功。

测试工具契约必须验证可观察行为：coverage 脚本使用 `--dry-run` 输出 schema，coverage collector/summarizer 使用 fixture report；`backend-trx-contract-dry-run` 在临时目录写入稳定 lane 名称的真实 `.trx`；viewport runner 通过注入 Playwright/summary 结果验证退出码，progress/summary 使用临时文件系统验证 current-run pointer、resume、并发原子写与陈旧产物隔离；data-scale/performance aggregator 和 release artifact restore 均以 mixed/stripped 下载布局的实际产物为准。matrix、workflow 与 package 接线由 `tools/check-test-matrix.mjs`、`tools/check-workflow-matrix-sync.mjs` 和 backend governance checker 的结构化解析集中验证，行为测试不得再读取 shell/workflow/其他测试源码匹配实现字符串。

`backend-qps` 是静态实现证据加小样本运行时探针，不是吞吐容量基准。collector 会先执行源码结构 guard，再对本仓库启动的 Kestrel 进程做少量 HTTP probe；证据中 `performance_baseline.mode=kestrel-only`，顶层 `capacityConclusion.countedAsCapacity=false`。如果要对 nginx/CDN/reverse proxy 做部署层对比，使用单独 artifact 名称（例如 `backend-qps-deployment-proxy-optional`），并保持 `optional_deployment_layer.counted_as_project_baseline=false`。

CI 将 `backend-qps` 拆为两个阶段：`backend-qps-collectors` 使用 matrix 并发运行 `backend-qps-*` collector tier，每个 collector 在独立 runner 中 bootstrap 本地 app stack 并只上传 `.tmp/perf/backend-qps/<mode>.json`；`backend-qps` aggregate job 等待 collectors 与 `integration-runtime`，下载 collector artifacts 后运行 `tools/test/lanes/backend-qps.sh aggregate`，统一写入 `.tmp/release-evidence/backend-qps-summary.json`。summary 必须包含 `evidenceModel=static-implementation-plus-runtime-measurement`、`staticEvidenceResults`、`runtimeMeasurementResults` 和非容量结论；collector 不再各自写 summary，避免并发覆盖；本地 `./tools/test.sh backend-qps` 仍通过 matrix DAG 先完成 bootstrap 和 collectors，再执行 aggregate。

`backend-qps-runtime-sequential` 不替代上述并发 collector。它在单个已经启动并完成 warmup 的 Kestrel runtime 中顺序运行 `backend-qps` 的所有 measured scenarios，用于观察同一 runtime / namespace 下的相对变化；summary 写入 `.tmp/release-evidence/backend-qps-runtime-sequential-summary.json`，`evidenceModel=warmed-runtime-sequential-measurement`。该 lane 标记为 nightly/optional，普通 PR 不强制跑完整 sequential measurement；release evidence 不得把来自不同 CI worker 的 collector RPS 当作横向容量对比来源。

CI 的 file-only checks 与 app-stack checks 必须分阶段：`cross-stack-contract` 只直接执行 distribution、notification、upload、auth-state、SW/cache、专属 performance 与 auth-zero 等独有断言；OpenAPI、binary、frame、API、runtime、governance 与 security 共享断言通过 [canonical receipt join](testing/issue-1381-cross-stack-receipt-join.md) 消费当前 run 的物理 owner 结果，不得重新请求 checker 或 Debug build。`security-static-fuzz` 运行真实调用两套 Wasm decoder 的 `wasm-fuzz-regression` 与 perception red-team，不接受只写固定成功 JSON、未执行 target 的伪 fuzz evidence；需要本地 app stack 的 `endpoint-depth-runtime`、`integration-runtime`、`security-runtime` 保持独立 job。新增检查时若 `services: []` 且 `requiresBootstrap: none`，优先放入对应 file-only job，不能塞回 runtime job。

`wasm-fuzz-regression` 必须先用 ASAN/UBSAN 编译实际 AEDS exports 并运行 handle epoch 合约，再以 libFuzzer 覆盖 reserve/decode/clear 与 stale token；随后在当前 fresh namespace 内同时加载本轮 `frontend-build` 生成的 `aeds_decoder_basic.wasm` 与 `aeds_decoder_speed.wasm`，按 scheduler 授予的 CPU 容量生成可复现种子并真实调用两套 Wasm arena decode 导出。每个 seed 的 success/error code、frame type、payload length/hash 必须一致，并验证 sensitive arena 清零及 payload handle 在 clear 后失效；仅写入计划、读取“已执行”环境标记或复用旧 run 的 fuzz summary 都不构成通过。权威证据必须包含 `executionSource=fresh-wasm-runtime`、非零 `seedsRun`、ABI、两套解码器 SHA-256、合并 identity digest 与可重放 seed plan。

Repository-owned CMake/CTest 与 libFuzzer 资产由
`config/testing/native-test-assets.json` 统一登记语义 test ID、source owner、target、corpus、lifecycle 和
receipt。`node tools/test/run-native-tests.mjs --profile smoke` 是独立快速 smoke 入口，production fresh
exact-once 消费其 source/toolchain-bound receipt；`--profile fuzz-sanitizer --runs <count> --jobs <count>`
启用 Clang libFuzzer、ASAN 与 UBSAN，由 release-final 独立消费。runs/jobs 是资源输入，不是固定时间门禁。
两类 receipt 都绑定 commit、source input digest、compiler/CMake、target、sanitizer/fuzzer flags、corpus
identity、outcome 和 crash artifact digest。缺少 compiler、CMake、CTest 或 sanitizer/fuzzer capability
时 producer 写入结构化 `blocked` 原因并非零退出，不得伪造 pass。删除、重命名、合并或退役 native
target 前必须先在 `tests/test-retention-replacements.json` 登记映射；静态 checker 的负例无需运行长 fuzz
campaign 即可覆盖漏登记、重复 owner、丢失 corpus、未映射 target rename 和 release evidence 缺失。

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

local-profile projection 使用 `complete-success`、`complete-failure` 或 `incomplete-external-evidence`。任一 `summary-only` / `collected-blocked` entry 会强制后者并设置 `qualificationEligible=false`；它不贡献 executed test 或 coverage correctness。schema validator 机械拒绝 `summaryOnlyTierCount > 0` 与 `complete-success` 的组合，consumer 必须检查逐 entry 的 evidenceKind 与 `qualificationEligible`，不能仅凭顶层 status 通过资格门。

外部执行只能通过显式 `FSUSBLOG_EXTERNAL_EVIDENCE_RECEIPTS` 声明的 repository-relative receipt path 绑定，绝不按 mtime 或目录扫描选择。每个 `summaryOnly` tier 必须在 local-profile `externalAuthorities` catalog 中恰好声明一个 canonical authority；非空 receipt declarations 必须与待升级 tier exact-set 相等。每个 blocked tier 恰好一个 `fsusblog.external-correctness-receipt.v1`：它必须包含该 authority、当前 scheduler run、source/worktree 与 sealed artifact-digest-table build identity、非空 test/coverage/assertion IDs、`success` 状态和 canonical content digest。缺失保持 incomplete；重复、跨 run/source/build、篡改、failed/cancelled 或空 IDs 均 fail closed。成功绑定产生新的 `external-executed` entry，并保留且重新验证原 placeholder 的 schema/path/raw digest/run/source；不得改写 placeholder。`release-final` 可由 `FSUSBLOG_LOCAL_PROFILE_CHECKPOINT` 显式消费该 checkpoint，并复用 sealed checkpoint validator 逐 entry 复核资格、manifest commit、placeholder 和 external receipt binding。

`static-governance` 同时执行 `tests/tools/release-id.test.mjs`、`tests/tools/release-manifest.test.mjs`、`tests/tools/deployment-slots.test.mjs` 和 `tests/tools/dotnet-release-metadata.test.mjs`。第一组校验唯一 `YYYYMMDDHHmmss-sha12` ReleaseId 权威、真实 UTC 日期、完整 commit/createdAtUtc 交叉绑定、单次 identity snapshot、非发布 sentinel、稳定 shell CLI、跨语言 fixture 与 C#/TypeScript 生成文件漂移；第二组创建不可覆盖的 `fsusblog.release-manifest.v2`，覆盖 commit/image/frontend/Wasm/toolchain 绑定、ReleaseId/createdAtUtc/commitSha 与 OCI tag/ref 不一致拒绝、SemVer 拒绝、V1 writer 拒绝及显式 rollback-only legacy reader、无现场 build 的 deploy dry-run、pull 后 RepoDigest 与 OCI release/commit 标签不一致阻断，以及 release evidence 中 runtime slot/commit/ref/digest 的一致性；第三组以临时本地 manifest/slot/rollout fixture 证明 manifest-first 身份传递，并拒绝 expected value 或 durable source identity 篡改；第四组验证 .NET Assembly/FileVersion 固定为技术版本 `0.0.0.0`、InformationalVersion/SourceRevisionId 与同一发布身份绑定，并在 Release publish 缺失或不一致时 fail closed。本地构建只能得到显式 `local-unversioned` metadata，不能据此生成可部署 manifest。生产启动与 readiness 的对应行为由 `ReleaseIdentityTests` 和 `ProductionStartupValidatorTests` 覆盖；缺少身份不能靠本地默认值进入 Production。

同一 tier 的 `tests/tools/deployment-slots.test.mjs` 使用临时持久状态和受控 Docker/health/port doubles 执行 blue/green 编排：两个 release digest 可同时存在于独立 project/container/loopback port，重复 start/stop 保持幂等，active slot 无法被 stop/替换，候选 health 失败、端口占用、损坏 digest 与资源不足都在不改变 active runtime 的前提下失败。测试还从 fsync + rename 状态文件模拟主机重启后的 active 恢复，并检查 Compose 只共享 uploads/DataProtection、隔离 AOT/log/data 且不再出现固定 `127.0.0.1:8080` 或公网绑定。

同一 tier 的 `tests/tools/gateway-switch.test.mjs` 覆盖受控 loopback upstream 生成器、临时文件中断不影响活动 include、Blue→Green→Blue 切换/回滚、持续公网请求零拒绝/零 5xx、dry-run 全配置预检、候选 readiness/identity 拒绝、staged config 拒绝、reload 失败自动恢复源槽、发布锁竞争、`switching` 重启后 source/target 确定性恢复，以及 previous release identity 漂移时拒绝回滚。切换测试还用独立 runtime state double 证明 source 精确 Active、target 精确 Ready Candidate、target CAS activation 在 reload 前发生、durable commit 后 source drain 完成；回滚前必须把已排空旧 release 作为新 Candidate 重启。成功证据必须与最终 manifest 的 slot/release/digest 一致，并含 target activation/source drain 的 sanitized lifecycle snapshot；失败证据保留真实失败阶段与恢复动作，不能把后续未执行的检查标成通过。

`DeploymentRuntimeStateTests` 是发布生命周期行为 owner：覆盖 Candidate 全门禁、错误 mode/generation fail closed、activate/drain identity-generation CAS 与幂等、进入中的普通 HTTP 完成而新请求被拒绝、异常/取消后计数归零、notification 与 background 独立计数、准确 drain blockers/timeout、SIGTERM 与主动 drain 复用同一路径，以及公共 readiness 不泄漏 release 拓扑。涉及匿名/登录/admin/notification/binary 的既有行为套件继续运行；发布状态只包围 HTTP/notification/background admission，不改变匿名/登录/admin 授权或 AEDS frame 编解码。

`ActiveReleaseFenceContractTests`、`notificationStreamRestartPolicy.test.ts` 与 `check-background-service-classification.mjs` 共同拥有 release fence：Redis CAS/read-back、active-singleton ticket、最后提交前 guard、1012 cursor/replay-miss 语义，以及全部 BackgroundService 的 singleton/idempotency/drain/replay 分类。分类器与 analyzer 一次输出全部错误，不设置最大错误数；xUnit 继续固定 `stopOnFail=false`。

`ActiveReleaseFenceAvailabilityTests` 覆盖 production startup 强制 durable-witness probe、Redis replica degraded 但 SQL 可读时允许启动、动态 5000ms/30s 窗口的第 6 次连续失败触发 `StopApplication()`、availability 配置范围与 hosted-service 启动顺序。该集合使用 fake clock，不以 30 秒真实 sleep 伪装时序验证。

`SchemaMigrationDdlPrimitivesTests` 覆盖 typed identifier / column definition、PostgreSQL / MySQL / SQLite provider、全部 DDL step kind、dry-run preview 与 descriptor transaction wrapper。MySQL/SQLite 生成结果必须逐项匹配 `tests/migration/schema-ddl-provider-snapshots.json`；非法 identifier、任意 column SQL、错误 DDL kind、多语句注入和注释逃逸均 fail closed。

发布资格工具测试按独立临时目录和 loopback ephemeral ports 并行运行：

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

第 2 步的后端进程仍是只读 consumer。新的、完全隔离的 PostgreSQL 在
`EnsurePostgres` 完成后，必须先由 `materialize-current-schema-test` 单次
物化 canonical current schema，然后才能启动 `EnsureBackend` 或任何 runtime
application。该 producer 只接受没有 relation、routine、standalone type/domain、
operator、conversion、collation、extended-statistics 或 text-search object 的
`public` schema，从唯一
`CurrentSchemaCanonicalAuthority` 派生并封存五栏 identity；局部/旧 schema、
non-`Test`、缺 opt-in、非 admitted service envelope 的 exact `127.0.0.1`
host/port、非 exact `fsusblog` database/user、非 `public` search path、assembly
source 不符或非 canonical run-derived receipt path 都在运行时启动前 fail
closed。service envelope 必须绑定相同 run ID、通过 planned/actual exact
admission，并在 materializer 前按 admitted container ID 重新观察完整 Docker
identity；C# 在同一连接 transaction 内再 exact 比对 PostgreSQL
`system_identifier`、database/user/server version 后才可执行 DDL。

DDL 与 `CurrentSchemaStartupVerifier` 位于同一 transaction。commit 前只原子
发布 `prepared`、qualification-ineligible staging receipt；commit 后才以
no-overwrite 原子发布 `verified` terminal，所以 crash window 不会留下假的
verified evidence。commit 后 publication 失败时，producer 保持 terminal
absent，并 best-effort 补偿 schema 与清理 receipt；full run 不接受 nonzero
exit，也不会在没有 fresh catalog observation 时宣称补偿成功。独立 consumer
随后重算 self/file/assembly/catalog/envelope digest，核对 run/source/service/
database/canonical identity，并发布唯一 run-bound
`current-schema-runtime-ready` terminal；任何 missing、tampered、stale、prepared
或既存 terminal 都 fail closed。该 consumer 必须调用 candidate assembly 的
test-only read-only verification command，重新派生唯一 canonical authority 并
观察 live PostgreSQL；本地协调修改 receipt 与 self-digest 不能成为 authority。
fixture catalog 再将 runtime-ready terminal 精确封存为 runtime-topology admission，
并在 runtime process spawn 前重新消费两者。`serve` 路径仍不做 DDL。

`current-schema-bootstrap-integration` 是提交进仓库的 exclusive PostgreSQL lane，
覆盖 empty-schema positive、partial/non-relation zero-write、prepared SIGKILL、
post-commit publication compensation、stale container replacement，以及 default、
physical type/collation/identity sequence、index 与 constraint drift。它保存
partial 前后相同 query/order 的 raw catalog facts 与 SHA-256，并只接受正式
runtime-ready binding 和 self-digested terminal；临时 container、network 与
`/var/tmp` 只按本 run 的 exact identity 清理。

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

ordinary coverage 明确排除 `Integration`、`ApiIntegration`、`Concurrency`、`Performance`、`Property`、`GoldenContract` 与 `SecurityStateMachine`；其中 API integration、auth state machine、concurrency、property、golden 各自只运行一次并只输出 canonical Coverlet JSON。六个 collector 共用 `backend-coverlet-instrumentation` 互斥资源，最终按 source/module/method/line/branch identity 做精确 union，再只生成一次 Cobertura 交换文件并执行 backend coverage gate。`coverage.identity.json` 与 `backend/universe.json` 让 duplicate/missing shard、损坏 raw、错 source/module/run/source fingerprint 全部 fail closed；VSTest `_ser*` 仅在与 canonical raw byte-identical 时删除。权威输出固定为 `.tmp/coverage/backend-merged/coverage.json`、`coverage.cobertura.xml`、`Summary.json` 与 `migration-evidence.json`；threshold、changed-code 和 release-final 都读取该 `Summary.json`，不会各自重做格式转换。旧 `backend-chaos` 与 `backend-concurrency` 使用完全相同的 `Category=Concurrency` 选择，已由后者替代；fault/race coverage ID、runtime summary 和 mergeable coverage 均保留，nightly soak/performance 不受该替代影响。

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
- public-preview screenshot evidence：Browser Contract 只读重捕获完整九图矩阵并绑定当前 commit/ReleaseId、visual input digest、九个图片 hash、三类 audit 结果及本地 JSON 文件 digest；`check-release-final.mjs` 缺少或读到不同 SHA/内容的本地证据时 fail closed，不要求 CI run URL。
- release runtime lanes：admin console、auth flow、authoring flow、private preview 与 error boundary 使用 Vitest/API/static contract 绑定 release artifact；真实 RBAC browser negative path 已迁入 diagnostics。
- release AOT lanes：generation 与 static asset digest coherence 作为 browserless release evidence；真实 consumption/browser fallback 属于 diagnostics。
- Release Reliability v4 qualification：`release-final` 的 load/scale/stability correctness
  只有一个权威输入 `release-reliability-fresh`，不再直接消费 peak、burst、
  scale-m、soak-min、memory leak budget、open handle budget 或 critical mutation
  slice 的独立 tier summary。catalog 与独立 lifecycle action registry 同时固定
  exact-seven 的 35 个 action、phase/order/timeout/receipt/state-domain contract，
  以及 300 秒 soak、peak/burst 的
  concurrency/rounds/duration/threshold、scale-m 的 10,000/100,000 seed 与 12/2
  sampling、resource 的 12/2 sampling 和 64 MiB/16 delta limit，以及 mutation
  fixed subset。executor 不继承整份 caller environment；只允许 catalog 声明的
  base/inherited/fixed/internal keys，缺 required key 在 spawn 前失败。run identity
  绑定该环境合同、catalog/action registry/state-domain registry 及
  load/mutation/resource policy 实际文件 digest；独立 verifier 从原始 action receipt
  bytes 与 producer evidence 重算 action order/status、effective sampling、threshold
  和 policy binding，caller override、stale action receipt 或自重算 weakened receipt
  均不能放行。
- Release Reliability 的唯一 qualification 命令是
  `./tools/test.sh ci-tier release-reliability-fresh`。该入口顺序执行 exact-seven，
  写出 `evidenceClass=correctness`、`qualificationEligible=true` 的 scenario
  results，并生成一个由独立 verifier 验证的 qualified receipt。七个独立 scenario
  tier 只用于定点诊断；它们的 matrix `evidenceClass=diagnostic`、
  `qualificationEligible=false`、`requiredFor=none`，结果也固定为不可 qualification，
  不能作为
  `release-final` 输入或在事后合成 receipt。matrix validator 会拒绝把任何含
  `--scenario` 的入口重新标成 correctness 或 `requiredFor=release-final`。
- 只需要验证 final image 的本地 runtime admission、而不运行 exact-seven 时，
  使用同一 wrapper 的显式
  `tools/test/run-release-reliability-qualified-local.sh --runtime-admission-only`。
  该模式仍执行 fresh production build、immutable final image、qualified
  PostgreSQL/Redis/backend bridge topology、transaction fixture producer，以及固定
  60 秒窗口内由 `runtime-load-soak` 拥有的六条 canonical binary route smoke；
  每条证据记录 method/path/status/content type、`X-Fsus-*`、body bytes 和完整
  AEDS v2 header/payload/CRC 结论。创建 admission candidate 后，该模式还从
  `config/deployment/production-compose-environment.json` 读取实际
  `stop_grace_period`，对已 healthy 的 final-image container 发送真实 SIGTERM，
  并要求在 deadline 前以 exit code 0、非 OOM、无 runtime error 退出；观测写入
  同一 invocation 下的 `production-image-termination.json`。它在 scenario
  runner 前退出，并在同一目录生成 `runtime-admission-candidate.json`、
  `runtime-admission-receipt.json` 与该 termination observation；admission
  schema 固定为
  `fsusblog.release-reliability.runtime-admission.v1` 且
  `qualificationEligible=false`；不会生成或聚合 exact-seven candidate。wrapper
  必须先移除 EXIT trap、调用既有 `CleanupQualifiedRuntimeResources 0`，再由
  admission owner 证明记录的 container/network/process/file identity 全部消失，
  才能 finalize pass receipt。wrapper 的 process ownership 只复核 task-owned
  PID/identity 文件和 `/proc/<pid>/stat` 的 start-time、PGID、session，不读取
  process args 或 environment。cleanup 失败或仍有资源时没有 pass receipt；该
  receipt 也不会被 qualified locator 发现，且不能交给 release-final verifier
  充当 qualification。
- Reliability final binding：finalizer 只在 canonical
  `.tmp/release-reliability/*/qualified-receipt.json` 查找权威回执，零份报告
  `./tools/test.sh ci-tier release-reliability-fresh`，多份按排序后的全部路径报告
  ambiguity；禁止 latest、mtime 或 first-match 选择。恰好一份时，先独立调用
  `node tools/test/verify-release-reliability-receipt.mjs --receipt <path>`，随后才
  投影恰好七个顶层字段 `authorityId`、`receiptPath`、`contentDigest`、
  `sourceIdentity`、`buildIdentity`、`scenarioIds`、`verificationStatus`。投影继续
  绑定 source/worktree、production build、image、fixture、machine、topology、
  catalog/threshold/policy 与 exact-seven scenario/result/evidence digest；job
  summary 只负责 transport/completeness，memory/open-handle summary 只能通过该
  已验证回执中的原始 evidence reference 参与 correctness，不能旁路放行。
- PerceptionCharacterV3 independent release gate：同一 physical tier 生成一次 10,000 visual + 2,000 audio corpus、一次 pool-vs-retired benchmark、一次真实 Redis 双 cutover，并生成 implementation 与 independent-review 两份同 commit 回执。它由 `production-correctness` 与 `release-final` 共享 DAG 节点；scheduler 必须去重，禁止复制 corpus/benchmark 来伪造两个独立执行。
- strict evidence：manifest 必须为 `collected-ok`，live exposure/firewall/DNS evidence 必须存在，backup restore 必须是 real drill，post-deploy smoke 必须是 deployed endpoint 自动覆盖，authenticated DAST/Wasm fuzz/fault injection/short soak 必须真实执行，job summary 必须覆盖 production-correctness 与其他 required correctness jobs。独立 browser diagnostics receipt 不进入该 correctness required-job 集合。
- artifact binding：`tools/release/check-release-final.mjs` 要求 manifest commit、job summary commit 与 `sha256:` image digest 一致。
- AEDS Wasm cross-stack：普通 `aeds-frame-cost` 在 `frontend-build` 后串行绑定 server frame cost 与 basic/speed artifact/compile/decode/copy/memory budget；server summary 必须同时具有独立 structural copy reduction 与同 SHA/Release artifact 的 authoritative allocation/mean/p95 结论，缺 identity、超噪声带回退或字段驱动结论不一致时保持 blocked/failed。这些 browserless summary 缺失或不满足预算时保持 blocked。真实浏览器的 speed 选择、basic 故障回退、transferable Worker 与 load/long-task 指标属于 diagnostics，只作独立可观测 evidence，不阻断或放行 correctness manifest。
- test-quality lint：`tools/ci/check-test-quality.mjs` 首先在隔离临时仓库运行 xUnit/FluentAssertions/Vitest/Playwright/Node assert/shell 对抗 corpus 与 mutation table，然后仅消费 canonical inventory 与 adapter-resolved symbol/AST/control-flow facts。它以 closed `config/testing/test-quality-policy.json` 阻断 unresolved/unknown API、zero outcome、early return、unreachable oracle、test-to-test call、discoverable worker、constant/self/actual-as-expected 和语义不充分断言；dynamic case 必须有结构化 runtime evidence，waiver 必须精确绑定 test/rule/owner/reason/expiry/requirement/replacement evidence。唯一 producer 输出 `fsusblog.test-quality.v2` 并封存 inventory/adapter/oracle/policy/conformance digest、每 case terminal outcome、exact span、违规和 first failure；`tools/test-quality/verify.mjs` 独立重算，不允许 retry 覆写失败 artifact。

#### Critical mutation 的 Debug / Release parity

`release-mutation-critical-slice` 的 Debug Stryker authority 只属于
`source-level` evidence，不能直接满足 release artifact coverage。该 lane
继续从真实 `src/core/FsusBlog.Core.csproj` production project context
变异 `AedsEncoder.cs`，并由真实 backend test project 执行 canonical
affected tests；禁止另建只编译目标文件的瘦 project。Debug authority
绑定完整结果 inventory，同时用 `semanticMutantIdentityDigest` 绑定
source digest、operator、精确位置及 original/replacement digest，而不是
只绑定 Stryker raw ID 或 ID 字符串集合。

release-final 随后按
`config/testing/mutation/release-parity-subset.json` 的固定
operator/source-region policy，在同一真实 Core project 上运行 Release Stryker。
Release config 固定单 runner 和显式额外超时，所有 `bin`/`obj`、Stryker
physical output 与最终 assembly 都写入
`.tmp/mutation/backend-critical/release-parity/<run-id>/`。receipt 绑定 Debug
与 Release config digest、实际 MSBuild `Optimize`/`DefineConstants`/
target framework/language version、稳定 semantic mutant identity digest、
两次完整 compiler identity 与结果 inventory digest、Debug/Release
assembly-byte 分类、Release
`FsusBlog.Core.dll` digest 和实际 `dotnet test --no-build` AEDS
encode/decode smoke。smoke receipt 绑定被加载 assembly 和 selected killed
mutant IDs；普通 Release test 成功字符串不能替代 mutation producer 结果。
任一 selected mutant 在 Debug 或 Release 未 killed、两边 mutant identity
不同、Release 含 `DEBUG` 或缺 `RELEASE`、未优化、artifact 不在 run-bound
root，都会 fail closed。

Debug authority 只有在 Release parity 校验成功后才原子追加
`releaseQualification`。该字段绑定 fixed subset policy 的文件 digest /
`subsetDigest`、run-bound parity receipt 文件 digest /
`resolvedSubsetDigest`、相同 source authority inventory/config digest，以及
authority 自身的完整 planned/executed mutant ID 集合。独立 verifier 会重读
policy 与 parity receipt 并逐项比对；替换 subset、删减 executed 集合或仅改写
authority JSON/status 都不能获得资格。

该双层执行以 66 个 `AedsEncoder` planned mutants 和固定代表 subset 控制
成本；required operators 是本 authority 中可执行的七类 operator，
Stryker 4.14.2 自身标为 `Ignored` 的 block-removal 和唯一
`CompileError` 不伪装成可执行 parity。policy 不是百分比抽样，也不允许
运行时随机选择。即时回退是把
`FSUSBLOG_RELEASE_MUTATION_PARITY` 设为 `0`，这只用于本地诊断或紧急
回退，并会使 release-final 缺 required parity receipt，不能获得发布资格。

`production-correctness`（以及兼容别名 `production`）可以证明 browserless PR/CI 风险矩阵没有已知阻断；`release-closeout` 可以证明当前 manifest 已收口；只有同时包含单 Browser Contract 的 `release-final` 可以作为发布候选通过的最终凭据。

---

## Behavior-test evidence producer

#2186 建立唯一的 behavior-test evidence producer：
`tools/test-matrix/produce-behavior-test-evidence.mjs` 只消费本轮显式传入的
backend/frontend raw result observation artifacts（
`fsusblog.test-observation-artifact.v1`）、显式 current-run test plan
receipt（`--plan <path>`，`fsusblog.release-evidence.test-plan.v1`，至少
支持 `node tools/run-test-matrix.mjs evidence-plan` 产出的
`.tmp/release-evidence/test-plan.json`）、#2185 正式 source bindings 与
#1752 static admission identity，复用 #1748 的
`joinBehaviorTestEvidence` / `validateExactBehaviorCoverage` /
`--mode exact --out` authority，按 behavior 封存
`fsusblog.behavior-test-evidence-receipt.v1`。producer 不扫描历史
TRX/latest 目录、不只看 job success；receipt 逐 behavior 记录
required/observed kinds、test IDs/status/outcome/raw result refs、
plan/binding/static/catalog digests 与 contentDigest，并固定
`runtimeCandidateSpawnCountBeforeReceipt: 0`（producer 不执行、不重跑、
不补 missing evidence，只报告 exact local producer command）。

### 显式 test plan receipt 与 executed-set exact-match

`--plan <path>` 是必填输入；producer 与 verifier 均校验 plan schema
（`fsusblog.release-evidence.test-plan.v1`）、digest（`sha256:` 前缀）、
commit/run/source identity（与 observation artifacts 和
`--source-commit` 一致）。plan 缺失、schema 不匹配、digest/commit/run/
source identity 漂移均 fail closed 并输出 canonical producer command，
不允许静默跳过 exact-match。receipt 封存 `testPlanDigest`、
`testPlanCommit`、`plannedTestIds`、`unplannedBoundTestIds` 与
`extraExecutedTestIds`。

executed test set 必须与 plan 的 bound closure exact 匹配：缺 bound test
（plan 遗漏或本轮未执行）失败，**额外 executed test（计划外/超出
closure）同样失败**。shard 遗漏、duplicate testId、多跑、result
missing、failed/cancelled/timeout、binding drift 与 framework adapter
mismatch 全部 fail closed。

### evidenceStage 路由与 post-runtime receipt contract

BehaviorCatalog 的 active release behaviors 必须显式声明
`evidenceStage=pre-runtime` 或 `post-runtime`。pre-runtime producer 只消费
前一类；后一类由 `config/testing/post-runtime-producer-registry.json`
从 catalog 自动枚举并建立 exact-one producer/schema/claim mapping，禁止用
active/releaseQualification 的宽集合代理或在 consumer 中维护第二份 behavior
清单。

registry v2 对每个 observation class 固定 exact positive/negative/boundary/
failure membership、producer `toolVersion`、source/build/candidate/runtime
identity 与 canonical content digest。raw receipt 沿用
`fsusblog.post-runtime-observation-result-envelope.v1` 包装各 class schema；
只有 planned/executed clean correctness、`outcome=passed`、非 diagnostic、
非 recovered 且 terminal timeout/cancel/process-tree 状态一致的 receipt 可进入
qualification。failed、timed-out、cancelled 与 recovered receipt 可保留诊断，
但不能满足 release behavior；v1 registry/receipt 不接受兼容降级。

`fsusblog.post-runtime-accepted-claims.v1` 只承接 #2205 已接受 terminal
authority。validator 通过显式 current-run path 重读
`fsusblog.global-claim-exactness-terminal-receipt.v1`，重算 file SHA-256 与
canonical content digest，并重放 terminal validator；source/worktree、
migration-ledger digest、producer/tool version 与完整 claim set 必须 exact
一致。validator 只读现有 terminal receipt，不运行或修复上游 evidence。
唯一消费 CLI 是
`node tools/fact-extractors/post-runtime/current-run.mjs accepted-claims
--terminal <path> --out <path>`；随后必须以同一 CLI 的
`verify-accepted-claims --receipt <path>` 独立重放。输入与输出必须是 repository
内的显式 current-run regular JSON，任何 symlink 或 symlink parent 都会失败。
`fsusblog.post-runtime-candidate-plan.v1` 还绑定当前 registry content digest、
registry/schema identity、producer tool version 与 accepted-claims tool version；
任一 authority 漂移都会让旧 plan 在 raw producer 启动前失效。

Focused validation：

```bash
node tools/test-matrix/post-runtime-producer-registry.mjs
node --test tests/tools/post-runtime-producer-registry.test.mjs
```

独立 verifier `tools/test-matrix/verify-behavior-test-evidence.mjs` 重读
raw results、bindings、catalog、test plan receipt 与 receipt，重算
contentDigest、rawResultDigest、exact join 与 plan closure，拒绝 tamper、
cross-run、historical TRX/latest 目录、retry/diagnostic recovered
evidence、default success 字段与 second producer；缺 evidence 时只输出
canonical producer command。static governance 禁止从仓库元数据解析
default branch 读取 TRX、file-exists/job-status pass、manual behavior
success 或第二套 producer。

docs-only/source-only closure 不跳过 required tests；global suite success
不能掩盖 behavior missing/failed kind。producer 与 verifier 的 fixture
测试覆盖 binding exists-but-not-executed、plan 缺失/schema/commit
mismatch、plan 遗漏 bound test、多跑 extra executed、shard
omitted/duplicate、skipped/blocked/diagnostic/retry、source/binding
drift、docs-only closure、adapter mismatch、missing evidence zero
auto-rerun、second producer 与 receipt/raw refs/plan tamper。

`quality-gate.yml` 与本地 Production 只消费上述 matrix authority：PR risk
计划统一由 `pr-smart-gate-plan` 的 `tools/test/lanes/plan-pr-risk.sh`
生成 changed-files、plan 与 summary；`behavior-test-evidence` 运行并适配
唯一的 Node TAP / xUnit observation closure；随后
`backend-mutation-changed-critical` 和 `behavior-evidence-pre-runtime`
按同一 source/run identity 串联。Actions 使用对应 `ciJob`，本地
`build-static` / `backend-tests` physical bundle 执行同一 lane 命令并发布
run-bound marker；`runtime-browser` 的 `bootstrap` 必须在密封
pre-runtime receipt 校验成功后才可启动。Production profile 的五分钟预算
是 observe-only 优化目标，不得覆盖 matrix tier 的 fault ceiling 变成短超时
kill switch。


## 测试洁净性约定

详见 `tests/backend/TESTING.md`。

核心约定：

1. **无状态污染**：每个集成测试用例使用独立的数据库事务，测试后回滚
2. **密封动态端口**：acceptance/bootstrap 只消费 `production-fresh-port-lease.mjs` 按角色分配的 loopback port lease；PostgreSQL、Redis、debug backend、debug frontend 与 release preview 各自使用低于 kernel ephemeral range 的独立区间，并在 listener bind 前后执行带 token 的 handoff。不得恢复固定端口或 `FindFreePort` 的检查后使用竞态。
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

## 测试资产语义命名

活动测试、fixture、baseline 和 evidence 路径使用产品能力、协议、场景或治理职责命名，不以 issue、PR、迁移批次或执行者编号作为前缀。`tests/test-asset-semantic-renames.json` 记录历史路径到当前路径的一对一迁移，不提供 alias 或 fallback；历史 retention ledger 与归档文档仍可保留原始身份用于审计。

`node --test tests/tools/test-asset-semantic-renames.test.mjs` 验证迁移目标存在、旧路径不存在、当前可执行 test ID 与 JSON evidence identity 均为语义名称，并检查当前仓库引用已切到新路径。路径迁移引起 frontend-style identity 变化时，必须通过该 inventory 显式授权；新增违规仍会被拒绝。

## 全量测试资产审计

`npm --prefix src/frontend run test:audit` 是本地、非日常门禁的权威审计入口。它依次执行 source-bound preflight、retention discovery、test ID 唯一归属、canonical producer 分层执行和最终对账；单层失败不会阻止其它安全层生成诊断，但最终报告保持失败。只需检查环境或 inventory 时可分别使用 `-- --phase preflight` 与 `-- --phase discovery`，迁移前后比较使用 `-- --baseline <prior-report>`。

审计层覆盖 backend xUnit、frontend Vitest、Node/governance、Browser Contract、Playwright diagnostics 与 native smoke/fuzz；support、CMake graph 和 corpus 只作为 discovery asset，明确记录为不可独立执行。producer 继续由 matrix tier 权威拥有，audit 不建立第二套测试实现，也不成为 `fast`、production fresh 或 release-final 的依赖。

preflight 从 lockfile 实际 registry 推导 package auth：公共 npm 不要求私有 token；只有 lockfile 指向私有 registry 时才要求环境 credential provider，报告只保存是否需要/是否存在，不保存值。缺 .NET 10、browser、database fixture 或 native toolchain 时，相关 test IDs 全部标记 `blocked` 并非零退出，不得算作 pass。日志写入 `.tmp/test-asset-audit/logs` 前会按 secret 环境变量值脱敏。

最终 `.tmp/test-asset-audit/report.json` 包含 discovered/executed/passed/failed/skipped/blocked、每个未执行 ID 的结构化原因、replacement/retirement 状态、release-final/production producer mapping、coverage baseline，以及 `src/frontend/src` TypeScript/Vue include universe 的文件集合与 digest。baseline 比较若发现 test ID 无 live replacement 或 frontend coverage universe 静默缩小会 fail closed；不得通过放宽 include/exclude 或删除低覆盖生产文件虚增 coverage。

## Current-run evidence location governance

`config/testing/current-run-evidence-context.schema.json` 定义 evidence consumer
共同使用的本轮 identity：scheduler run、attempt、source commit、worktree
fingerprint、candidate/build identity、owned roots 和 sealed content digest。
`config/testing/evidence-locator-registry.json` 是唯一 locator registry；每个
consumer 只绑定一个 authority，locator mode 只允许 `explicit-run-path` 或
`content-addressed-reference`，cardinality 固定为 `exact-one`。`allowedRoots`
只表达路径安全边界，不授权 directory、glob、mtime、latest、fallback、priority
或 age/TTL 选择。

`node tools/test/generate-evidence-location-governance.mjs --check` 对完整 tracked
repository 的 JS/TS/C#/shell/workflow/config consumer surface 执行
`tools/test/evidence-location-scanner.mjs`，并核对唯一
`config/testing/evidence-location-migration-ledger.json`。每个 finding 必须以
stable rule ID 和 exact `file:line` 恰好出现一次，并明确分类为
`correctness-selection`、`diagnostic-only` 或 `not-evidence`；新增、缺失、重复、
orphan finding 以及 scan/content digest 漂移都 fail closed。ledger 是迁移
inventory，不会修改或替代现有 selection code；实际 locator 与 consumer 迁移
仍由后续依赖工作完成。

Registry 同时为每个 authority 声明唯一 `outputBindingKey`、producer source、
canonical caller、可执行 `producerCommand` 与 `checkpointCommand`。45 个 CLI、18 个
library caller 与 2 个 workflow producer identity 都绑定到实际 caller；Node producer
在原进程中加载 terminal hook，shell producer 由当前 shell 的 `EXIT` trap 完成同一
绑定。Hook 在 attempt 开始时要求 payload/ref 均不存在；只有本次 producer 写出的
payload 可在 terminal success 后发布 `fsusblog.current-run-evidence-reference.v1`。
缺失输出、失败、cancel，以及把旧 attempt/run identity 的 payload 包进新 ref，都
fail closed。

Publication 的每个 `prepared`、`receipt-prepared`、`finalized` 或 `aborted` state 都是
content-addressed sealed document；sealed pointer 通过 atomic rename 指向 exact state。
明确 recovery 会把未产生 receipt 的 session 封为 `aborted`，或在 staged/final bytes
与 producer 给出的 `inputDigest` 完全一致时完成 `receipt-prepared` session。Terminal
handoff 同时暴露 exact path、input/receipt-content/producer-receipt digest 和完整
run/attempt/source/worktree/candidate/build identity。Scheduler 在 run-start 创建本轮
reference block，resume 只保留同一 attempt 的 refs，并在真实 `recordSettled` success
路径消费 handoff；legacy、old-attempt、duplicate 或 digest drift 都 fail closed。
Parent 只保存 child ref descriptor，不复制 payload。所有路径都由 context/binding
明确给出，不扫描目录。Downloaded artifacts 只能通过
`fsusblog.current-run-evidence-transport-manifest.v1` 映射回原 run/source/authority/digest；
archive 打包与解压都核验 entry list、path safety 与 digest，mtime 变化不影响 authority。
quality-gate、aggregate、flaky、public-preview 与 downloaded release manifest 等非
release-final consumers 与本地使用同一 locator；缺失、重复 mapping、origin/digest mismatch
或 local+downloaded 歧义都 fail closed。Consumer receipt 必须同时引用 transport manifest
与 locator binding digest。Diagnostic browse 不得生成 correctness binding。本地与 CI 使用同一 locator 与
verifier；CI 只增加 transport 证明，不另建选择规则。age/TTL 不参与 correctness。
`node tools/test/generate-evidence-location-governance.mjs --check` 已纳入
validate-matrix / quality 入口，并与 ledger、registry、consumer call sites 双向
exact。负向矩阵与 mutation fixtures 证明 latest/mtime/first-match/fallback 无法复活。

focused 回归入口：

```bash
node --test tests/tools/evidence-location-contract.test.mjs tests/tools/evidence-location-governance.test.mjs tests/tools/current-run-evidence-publication.test.mjs tests/tools/current-run-evidence-scheduler.test.mjs tests/tools/current-run-evidence-transport.test.mjs tests/tools/current-run-evidence-locator-negative-matrix.test.mjs
```

## Node governance canonical suites

`static-governance` 不再为每个 Node contract 建立一个外层 command-manifest process。`tools/test/run-governance-suites.mjs` 先将输入 exact-once 分配到 lifecycle/retention、matrix/producer、artifact/receipt/evidence、privacy/security、release/fresh/projection 与 source/layout/naming 六个语义 owner，再以少量 canonical suite command 执行。普通 policy suite 使用单进程串行 test isolation，共享 ESM parser 与只读 fixture module cache；security/privacy、release/process-control suite 保留 per-file process isolation，避免为减少启动数破坏环境和进程组边界。

同一分类器也写入 test asset audit 的 `governancePolicyOwners`：每个 Node test/script ID 均携带 policy owner、assertion/negative invariants、coverage IDs 和 tier/release consumers。`.tmp/test-governance/suite-plan.json` 保存本轮物理 file union；重复输入、丢失 owner 或非 exact-once 分配在启动测试前失败。`check-job-summaries` 继续属于 source/layout owner，privacy/security matrix 保持独立 security owner；没有 test ID 删除，因此本次不需要伪造 replacement mapping。

## Security domain 静态门禁

`node tools/security/check-security-domain-layout.mjs` 先聚合校验安全域目录、policy metadata、
ZK contract/provenance 分类与 hash bindings、静态 evidence classification、runtime selection 和
旧 flat path；`node tools/security/check-security-matrices.mjs` 再按 declarative catalog 校验六份
矩阵。聚焦回归为 `node --test tests/tools/security-domain-layout.test.mjs`。这些检查只证明
仓库契约自洽，不替代匿名、登录、admin、notification stream 和 binary 的运行时安全测试。

## Production correctness 风险清单

`production-correctness`（以及兼容别名 `production`）必须同时满足：

- Production Fresh 的 physical producer 必须在
  `config/testing/production-disk-demand.json` 拥有 root-bound demand declaration；selected DAG
  inventory、并行 peak、terminal retention、rollback/recovery 与 uncertainty 由
  `tools/test-matrix/production-disk-demand.mjs` 统一计算。
- capacity reservation 必须先于 BehaviorDoc minimal contract build 以及 runtime/output/cache/build-root/GC mutation；`behavior-doc-static-admission` 的 cache-hit/cache-miss 均绑定同一 worst-case producer declaration。projection-only resume 在 lease 后以 checkpoint path、file identity 和 digest 只读分类，authority digest 进入 capacity plan digest，capacity DAG 只包含 BehaviorDoc 与 `logical-projection-resume`，未选中的 Docker/build/cache roots 不解析也不占 safety；reservation 后、创建新 attempt 前必须重验 authority，projection attempt 也必须经过 live guard。scheduler 在持有 run lock 时先准备并验证成功 checkpoint，再依次写入 projection output、完成 forbidden-output observation、producer receipt、terminal seal 与 estimator accounting，最后才 atomic commit 成功 checkpoint；任一完成步骤失败都保留原 projection-only failure checkpoint，reservation 以 aborted 释放，下次 resume 仍走窄 projection plan。`logical-projection-resume` declaration 显式覆盖上述全部 output 与最后一次 checkpoint commit。普通 Fresh 与 physical resume 仍使用完整 physical plan。聚焦负向门禁为
  `node --test tests/tools/production-disk-demand.test.mjs
  tests/tools/production-capacity-reservation.test.mjs
  tests/tools/production-capacity-preflight-order.test.mjs`，覆盖同 filesystem 合并、Docker unknown、
  多 run 仲裁、PID reuse/process-tree recovery、plan drift、external loss、under-declaration 与
  plan-only 零 mutation。

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
## Release-final finalizer authority

<!-- fsus-doc-claim
claimId: release-final-aggregate-contract.finalizer-authority
behaviorId: release-final-aggregate-contract
claimType: generated-section
generatedSectionId: release.finalizer-authority
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN release.finalizer-authority -->
| Key | Value |
| --- | --- |
| commandDigest | 6be786224f86a02f00489b84e3e8ba412b6dcf806495b4852e6b403562930b81 |
| commandEntrypoint | tools/test/lanes/release-final.sh |
| commandKind | finalizer |
| id | release-final |
<!-- FSUSBLOG-GENERATED:END release.finalizer-authority -->
## Current test tiers

<!-- fsus-doc-claim
claimId: browserless-production-correctness.tiers
behaviorId: browserless-production-correctness
claimType: generated-section
generatedSectionId: testing.tiers
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN testing.tiers -->
- `acceptance`
- `aeds-compression-profile`
- `aeds-frame-cost`
- `app-config-local-tuning`
- `article-private-preview`
- `backend-api-integration`
- `backend-auth-state-machine`
- `backend-benchmark-regression`
- `backend-build-governance`
- `backend-cache-invalidation-batch`
- `backend-concurrency`
- `backend-fast`
- `backend-golden`
- `backend-mutation`
- `backend-mutation-changed-critical`
- `backend-nightly`
- `backend-perf`
- `backend-property`
- `backend-qps`
- `backend-qps-article-detail-miss`
- `backend-qps-cache-hit`
- `backend-qps-cache-miss-singleflight`
- `backend-qps-cache-registry`
- `backend-qps-comment-cursor`
- `backend-qps-hotread`
- `backend-qps-index-plan`
- `backend-qps-list-pagination`
- `backend-qps-related-reading`
- `backend-qps-risk-filter`
- `backend-qps-runtime-sequential`
- `backend-qps-view-count-flush`
- `backend-qps-visitlog-invalidation`
- `backend-test-governance`
- `backend-unit`
- `behavior-doc-static-admission`
- `behavior-document-consistency-final`
- `behavior-evidence-post-runtime`
- `behavior-evidence-pre-runtime`
- `behavior-test-evidence`
- `bootstrap`
- `browser-contract`
- `browser-diagnostics`
- `browser-diagnostics-manual`
- `browser-diagnostics-nightly`
- `browser-performance-regression`
- `browser-runtime-risk-diagnostics`
- `changed-code-coverage`
- `ci`
- `coverage-backend`
- `coverage-frontend`
- `coverage-gate`
- `coverage-gate-strict`
- `coverage-merge`
- `coverage-threshold`
- `cross-browser-smoke`
- `cross-stack-contract`
- `csrf-browser-matrix`
- `data-scale-evidence-summary`
- `data-scale-m`
- `data-scale-nightly`
- `data-scale-s`
- `data-scale-xs`
- `distributed-contract-fast`
- `endpoint-depth`
- `fast`
- `fault-injection`
- `frontend-build`
- `frontend-fast-summary`
- `frontend-property-model-perf`
- `frontend-render-structure`
- `frontend-runtime-contracts`
- `frontend-static-governance`
- `frontend-unit-shard`
- `homogeneous-two-node-fixture`
- `integration`
- `integrity-proof-verification`
- `legacy-20260517-real-dump`
- `load`
- `load-2x-peak`
- `load-baseline`
- `load-burst`
- `load-peak`
- `markdown-preview-release-performance`
- `native-fuzz-sanitizer`
- `native-smoke`
- `perception-character-v3-release-gate`
- `perception-v2-redteam-nightly`
- `perception-v2-redteam-pr`
- `perception-v2-test-matrix`
- `performance-evidence-summary`
- `post-runtime-candidate-plan`
- `post-runtime-observation-producers`
- `pr-smart-gate-plan`
- `privacy-zk-comment-matrix`
- `production`
- `production-build-artifacts`
- `production-correctness`
- `production-xss-fast`
- `production-xss-release`
- `public-hydration-fast`
- `public-hydration-nightly`
- `release`
- `release-admin-console`
- `release-aot-consumption`
- `release-aot-generation`
- `release-auth-flow`
- `release-authoring-flow`
- `release-closeout`
- `release-data-scale-m`
- `release-error-boundary`
- `release-evidence`
- `release-final`
- `release-final-flaky-governance`
- `release-final-shard-completeness`
- `release-load-burst`
- `release-load-peak`
- `release-memory-leak-budget`
- `release-mutation-critical-slice`
- `release-open-handle-budget`
- `release-private-preview`
- `release-rbac-negative`
- `release-reliability-fresh`
- `release-soak-min`
- `release-static-asset-digest-coherence`
- `resilience`
- `rights-v3-test-matrix`
- `risk-control-test-matrix`
- `security`
- `security-authenticated-dast`
- `soak-long-evidence-import`
- `soak-long-scheduled`
- `soak-short-runtime`
- `static-governance`
- `test-inventory`
- `test-quality-lint`
- `ux-viewport-boundaries`
- `ux-viewport-plan-progress`
- `ux-viewport-smoke`
- `ux-viewport-visual`
- `validate-matrix`
- `visual`
- `visual-console`
- `visual-public`
- `wasm-build-artifacts`
- `wasm-fuzz-regression`
<!-- FSUSBLOG-GENERATED:END testing.tiers -->
