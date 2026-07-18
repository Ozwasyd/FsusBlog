# Repository source ownership

FsusBlog 的产品实现源码统一归入 `src/`。文件是否由 `.csproj`、
`package.json` 或编译器直接发现，不决定它是不是源码；手写的 ZK circuit
definition 与 shader、protocol schema、SQL migration 一样，属于可编译的领域源码。

## ZK ownership boundary

| Ownership | Canonical path | 内容 |
| --- | --- | --- |
| Handwritten source | `src/zk/circuits/` | v2/v5 circuit definitions 与同目录说明 |
| Generated artifacts | `artifacts/zk/` | R1CS、proving/verifying keys、ceremony outputs、Wasm prover bundles |
| Security manifests | `security/zk/` | source/artifact hashes、trusted-setup state、tamper 与 review contracts |
| Runtime configuration | `config/zk/` | active circuit/verifying-key selection 与 fail-closed binding |
| Test fixtures | `tests/fixtures/zk/` | witnesses、proofs、tamper vectors 与 deterministic fixture manifests |
| Build/check tooling | `tools/crypto/`, `tools/security/` | compiler、artifact generator 与 semantic validators |

这些目录不可互换：生成产物不能进入 `src/`，runtime config 不能作为 source，
test fixture 也不能被 production readiness 当作 ceremony evidence。

## Configuration ownership

通用运行时、测试和观测配置统一放在 `config/`；只有 .NET framework tool
manifest 使用 `.config/`。项目专属 `appsettings*.json` 与
`Properties/launchSettings.json` 必须和拥有它们的 project 共置，Docker Compose
launch profile 因而位于 `ops/docker/Properties/`。根级 `configs/`、无 root project
所有者的 `Properties/` 和散落的 JSON 配置均由
`tools/configuration/check-configuration-layout.mjs` 拒绝。完整 ownership 表见
[`docs/configuration-layout.md`](../configuration-layout.md)。

## Operations ownership

运维模板只有一个 top-level root：`ops/`。生产容器/Compose、开发依赖、gateway
模板和 privacy 运维示例分别由 `ops/docker/`、`ops/development/`、
`ops/gateway/`、`ops/privacy/` 拥有。零停机资源阈值是配置而不是模板，位于
`config/deployment/`；可执行部署与通用运维流程继续位于 `tools/deployment/` 和
`tools/operations/`。完整路径表、历史 local-proxy 删除决策和回退边界见
[`docs/operations-layout.md`](../operations-layout.md)。

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
明确的 `architecturalException`，否则 checker fail closed。

## Verification

```sh
node tools/check-repository-source-layout.mjs
node tools/crypto/build-zk-comment-v2-r1cs.mjs --check
node tools/crypto/check-zk-comment-v2-manifests.mjs
node tools/security/check-zk-comment-v5-manifests.mjs
node --test tests/tools/issue-1166-zk-source-layout.test.mjs
```

`tools/check-repository-source-layout.mjs` 从 Git index 读取 top-level inventory，
拒绝重新出现的 root `circuits/`、未声明的顶层目录、缺少理由的 source exception、
旧 circuit source 引用、source hash 漂移和 manifest/R1CS source binding 漂移。
