# Repository source ownership

FsusBlog 的产品实现源码统一归入 `src/`。文件是否由 `.csproj`、
`package.json` 或编译器直接发现，不决定它是不是源码；手写的 ZK circuit
definition 与 shader、protocol schema、SQL migration 一样，属于可编译的领域源码。

## ZK ownership boundary

| Ownership | Canonical path | 内容 |
| --- | --- | --- |
| Handwritten source | `src/zk/circuits/` | v2/v5 circuit definitions 与同目录说明 |
| Generated artifacts | `artifacts/zk/` | R1CS、proving/verifying keys、ceremony outputs、Wasm prover bundles |
| ZK contracts | `security/zk/contracts/` | circuit、tamper 与 feasibility contracts |
| ZK provenance | `security/zk/provenance/` | source/artifact hashes、trusted-setup state、local review 与 artifact ownership |
| Runtime configuration | `config/zk/` | active circuit/verifying-key selection 与 fail-closed binding |
| Test fixtures | `tests/fixtures/zk/` | witnesses、proofs、tamper vectors 与 deterministic fixture manifests |
| Build/check tooling | `tools/crypto/`, `tools/security/` | compiler、artifact generator 与 semantic validators |

这些目录不可互换：生成产物不能进入 `src/`，runtime config 不能作为 source，
test fixture 也不能被 production readiness 当作 ceremony evidence。

## Security ownership boundary

`security/` 下禁止散落 root files。矩阵、策略、ZK contract、ZK provenance 与静态
evidence contract 分别位于 `security/matrices/`、`security/policies/`、
`security/zk/contracts/`、`security/zk/provenance/` 和
`security/evidence-contracts/`；总目录位于 `security/catalog/security-domain.json`。
完整分类、运行时路径和回退约束见
[`docs/security/security-domain-layout.md`](../security/security-domain-layout.md)。

## Shared contract ownership

`src/shared/Contracts/` 是跨栈契约的唯一 product-source root。手写的安全协议 JSON 位于
`src/shared/Contracts/Validation/Security/`，跨语言生成器位于 `tools/contracts/`；生成的
C# 与 TypeScript consumer 可以分别位于 Shared 和 frontend，但不得反向成为事实源。
根目录 `contracts/security/` 与 `tools/frontend/` 不承载跨栈安全协议 source/generator。

内容 lifecycle 文档 exactness 复用 `config/contracts/behavior-contracts.json`、
`config/contracts/document-claim-migration-ledger.json` 与
`config/contracts/generated-fact-sections.json` 的既有 ownership；
`tools/docs/content-doc-exactness.mjs` 只是 current-run mutation/terminal receipt producer 与
independent verifier，不拥有第二份 behavior、claim、state、transition 或 outbox registry。

## Configuration ownership

通用运行时、测试和观测配置统一放在 `config/`；只有 .NET framework tool
manifest 使用 `.config/`。项目专属 `appsettings*.json` 与
`Properties/launchSettings.json` 必须和拥有它们的 project 共置，Docker Compose
launch profile 因而位于 `ops/docker/Properties/`。根级 `configs/`、无 root project
所有者的 `Properties/` 和散落的 JSON 配置均由
`tools/configuration/check-configuration-layout.mjs` 拒绝。完整 ownership 表见
[`docs/configuration-layout.md`](../configuration-layout.md)。

Release Reliability 的场景与动作事实源分离：`config/testing/release-reliability-scenario-catalog.json`
拥有 exact-seven 场景、命令语义、环境合同和结构化 lifecycle action 引用；
`config/testing/release-reliability-lifecycle-action-registry.json` 唯一拥有 35 个动作的
进程调用、timeout、回执、状态域与 failure-safe cleanup 合同，对应 JSON Schema 位于
`config/schemas/release-reliability-lifecycle-action-registry.schema.json`。
`config/testing/runtime-state-domain-registry.json` 是 action state domain 的 closed-world
词表。`config/testing/physical-execution-process-policy.json` 单独拥有 tree termination、
bounded pipe close 与连续 zero-member observation，不拥有 registry action timeout。
`tools/test/release-reliability-lifecycle-actions.mjs` 加载合同，并作为唯一 outer executor
通过 `tools/test/physical-execution-process-tree.mjs` 运行每个 action、封存 process-tree
receipt；`tools/test/release-reliability-lifecycle.mjs` 只执行动作/观察真实状态，
`tools/test/verify-release-reliability-lifecycle-action.mjs` 独立重读 raw receipt；
具体 soak/load/data-scale/mutation/resource lane 不拥有 lifecycle receipt，也不得自封
precondition、reset 或 postcondition。Data-scale lane 只测量 dedicated runtime owner
准备的 fixture/runtime，seed 与 teardown 分别仍由其专属 owner authority 承担。

## Operations ownership

运维模板只有一个 top-level root：`ops/`。生产容器/Compose、开发依赖、gateway
模板和 privacy 运维示例分别由 `ops/docker/`、`ops/development/`、
`ops/gateway/`、`ops/privacy/` 拥有。零停机资源阈值是配置而不是模板，位于
`config/deployment/`；可执行部署与通用运维流程继续位于 `tools/deployment/` 和
`tools/operations/`。完整路径表、历史 local-proxy 删除决策和回退边界见
[`docs/operations-layout.md`](../operations-layout.md)。

## Language entrypoint ownership

`src/frontend/` 由 `FsusBlog.Client.esproj`、Vite 和 JavaScript/TypeScript 工具链拥有，
不得出现 C# application entrypoint。所有 C# source 必须位于某个 `.csproj` 的目录边界内，
或作为带 owner、依赖声明、调用命令、测试和输出契约的 file-based app 显式登记。
`tests/governance/repository-source-layout.json` 将这条语言 ownership 边界绑定到
`tests/governance/csharp-entrypoint-ownership.json` 和
`tools/check-csharp-entrypoint-ownership.mjs`；生成 protocol fixture 的工具还必须拥有稳定的
`generate`/`check` 命令，且不得写死 `/tmp` 或 `/var/tmp` 输出路径。完整决策见
[`docs/testing/issue-1174-csharp-entrypoint-ownership.md`](../testing/issue-1174-csharp-entrypoint-ownership.md)。

Issue #1166 将原 top-level `circuits/` 纯路径迁移到
`src/zk/circuits/`。v2 与 v5 source bytes 的 SHA-256 保持不变；v2 R1CS
IR 和 Groth16 binary 因内嵌 `source_path` 合法变化，因此对应 artifact、circuit、
trusted-setup 与 local-review hashes 必须同步更新。迁移不改变 circuit id、public
input/witness layout、constraint count、proof system、curve、ceremony state 或
`production_usable=false` 的 fail-closed 状态。

## Root exceptions

`src/` 是唯一 canonical product-source root。`benchmarks/`、`tests/`、`tools/`
和 `ops/` 中包含可执行源码，但分别受 benchmark isolation、test isolation、
repository tooling 与 operator tooling 的架构例外约束，不进入产品源码或 shipping
assemblies。`.config/` 是 .NET tool manifest 所需的 framework root；其他
top-level 目录必须在
`tests/governance/repository-source-layout.json` 中声明为 artifact、configuration、
documentation、security 或 automation ownership；新增 source-like root 必须同时提供
明确的 `architecturalException`，否则 checker fail closed。顶层 `release-evidence/`
已经退役并被列入禁止目录：历史报告属于 `docs/reports/`，静态契约属于
`security/evidence-contracts/`，fixture 属于 `tests/fixtures/evidence/`，fresh bundle
只能写入未跟踪的 `.tmp/release-evidence/`。可选 `release-index/` 是唯一例外，且
只能保存 `check-release-evidence-layout.mjs` 校验过的最小 identity/integrity JSON，
不能保存 bundle 或替代其不可变存储引用。

## Verification

```sh
node tools/check-repository-source-layout.mjs
node tools/check-csharp-entrypoint-ownership.mjs
node tools/security/check-security-domain-layout.mjs
node tools/security/comment-privacy-build-contract.mjs
node tools/crypto/check-zk-artifact-ownership.mjs
node tools/security/check-zk-comment-v5-manifests.mjs
node --test tests/tools/zk-source-layout.test.mjs
```

`tools/check-repository-source-layout.mjs` 从 Git index 读取 top-level inventory，
拒绝重新出现的 root `circuits/`、`deploy/`、`release-evidence/`，以及未声明的顶层目录、缺少理由的 source exception、
旧 circuit source 引用、source hash 漂移和 manifest/R1CS source binding 漂移。
它同时确认 C# entrypoint ownership 的 policy/checker 没有脱离 canonical source-layout contract；
具体 C# project/file-app/global-output/protocol-fixture 违规由后者一次聚合报告。
