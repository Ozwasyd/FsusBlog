# Repository source ownership

FsusBlog product implementation source belongs under `src/`. Whether `.csproj`,
`package.json`, or a compiler discovers a file does not determine whether it is
source: handwritten ZK circuit definitions, shaders, protocol schemas, and SQL
migrations are all compilable domain source.

## ZK ownership boundary

| Ownership | Canonical path | Contents |
| --- | --- | --- |
| Handwritten source | `src/zk/circuits/` | v2/v5 circuit definitions and adjacent documentation |
| Generated artifacts | `artifacts/zk/` | R1CS, proving/verifying keys, ceremony outputs, and Wasm prover bundles |
| ZK contracts | `security/zk/contracts/` | circuit, tamper, and feasibility contracts |
| ZK provenance | `security/zk/provenance/` | source/artifact hashes, trusted-setup state, local review, and artifact ownership |
| Runtime configuration | `config/zk/` | active circuit/verifying-key selection and fail-closed binding |
| Test fixtures | `tests/fixtures/zk/` | witnesses, proofs, tamper vectors, and deterministic fixture manifests |
| Build/check tooling | `tools/crypto/`, `tools/security/` | compiler, artifact generator, and semantic validators |

These directories are not interchangeable: generated artifacts cannot enter `src/`, runtime configuration is not source, and test fixtures cannot qualify as ceremony evidence for production readiness.

## Security ownership boundary

Root files may not be scattered under `security/`. Matrices, policies, ZK contracts,
ZK provenance, and static evidence contracts live in `security/matrices/`,
`security/policies/`, `security/zk/contracts/`, `security/zk/provenance/`, and
`security/evidence-contracts/`; the catalog is `security/catalog/security-domain.json`.
For the complete classification, runtime paths, and fallback constraints, see
[`docs/security/security-domain-layout.md`](../security/security-domain-layout.md).

## Shared contract ownership

`src/shared/Contracts/` is the sole product-source root for cross-stack contracts. Handwritten security-protocol JSON lives in `src/shared/Contracts/Validation/Security/`, and cross-language generators live in `tools/contracts/`; generated C# and TypeScript consumers may live in Shared and frontend, but cannot become authorities. Root `contracts/security/` and `tools/frontend/` do not hold cross-stack security-protocol source or generators.

The fact-extractor runner supplies its canonical JSON digest and the admission owner's minimal-build receipt validator as explicit execution capabilities. The OpenAPI extractor requires them instead of importing parent governance modules. Its standalone producer and reader seal the runner and canonicalization source; canonical admission retains the run-relative receipt and independently verifies both cached and published observation/projection bytes. Missing capabilities or canonical cache reuse fail closed and never select the standalone receipt.

Content-lifecycle document exactness reuses the existing ownership of
`config/contracts/behavior-contracts.json`, `config/contracts/document-claim-migration-ledger.json`,
and `config/contracts/generated-fact-sections.json`. `tools/docs/content-doc-exactness.mjs`
only produces current-run mutation/terminal receipts and independently verifies them; it owns no second behavior, claim, state, transition, or Outbox registry.

## Schema migration ownership

`src/migration/` belongs to the independent `FsusBlog.Migration` project: legacy descriptors, catalogs, checksum/history, typed provider DDL, and migration-only conversion rows compile only there and in `tests/migration/`. The project also builds as an `Exe` offline-migration host, and `tools/db/run-online-migrations.sh` with `--server-dll` points to its output. `OfflineMigrationCatalogEntries.generated.cs` is derived from Migration-owned `OfflineMigrationClassificationFacts.cs` by `tools/db/generate-offline-migration-catalog.mjs`; `tools/db/check-offline-migration-catalog-parity.mjs` prevents drift. `src/shared/Contracts/Schema/` owns the single neutral current-schema description, identity/generation/projection/comparison and complete typed recipe-effect/owned-target contracts; it contains no provider SQL templates or legacy input. `src/backend/Infrastructure/SchemaMigration/` retains the current entity extractor/inspector, current-owned PostgreSQL recipes, their single fact extractor and read-only projection/artifact exporter, fail-closed startup verifier, lock, and business-backfill handlers; the Server production graph must not reference the Migration assembly. Migration's bootstrap compiler consumes independently bound neutral current facts, not Server code or a second handwritten current field mapping. Same-transaction observation, original apply/journal integration, actual owned export and native three-provider qualification remain pending; unknown capabilities fail closed and this source component does not qualify as full bootstrap. The machine-readable file/symbol inventory and content digest are at `artifacts/schema-migration/migration-assembly-receipt.json`.

`src/shared/Algorithms/Schema/` owns the single current-only PostgreSQL native catalog,
expression/effect reader and comparer. Its connection boundary is the BCL
`DbConnection`/`DbTransaction`; it has no provider package, Server/Migration dependency,
legacy mapping or journal payload/history validation. Server and Migration consume
the same measurement/comparison implementation. Migration retains its original
owned-artifact and full journal-chain validation wrapper. The sole neutral
`CurrentSchemaControlShape` describes the current apply journal's seven columns,
four constraints and native backing indexes. The current-only
`PgCurrentSchemaControlShape` renders that shape for original offline Core and
test-only materialization and delegates native shape validation to the same
catalog/effect comparer; production Server never creates it.
Server derives the composite target
from its sole entity extractor, original recipe fact extractor and these control
facts, then reads all
native schema effects on one read-only snapshot. Unknown control tables are not
admitted by name. A same-name malformed journal refuses, and Server never parses
its history or payload. The persistent journal is part of the versioned current
physical closure, not a terminal cleanup exception; complete chain/resume remain
offline-only. Native qualification is still separate pending work.

`src/shared/Algorithms/IO/NativeRegularFileGuard.cs` owns the single Linux
x64/arm64 original regular-file and held-FD identity primitive. Server receipt
admission and Migration's original artifact-reader facade consume it through their
existing Shared references; the Server graph has no Migration dependency. Each
consumer retains its own byte/hash limits. The shared owner contains no receipt
codec, migration history, database qualification or readiness publication. Held
database descriptors remain non-owning and the guard never reopens/closes their
leaf, preserving SQLite's process-wide record locks. Original file controls and
native provider acceptance remain distinct from this source ownership move.

Within Migration, `PgLegacyNonArticlePreparation` reuses the original account-subject
hasher and the bootstrap compiler's entity-default interpretation. Their callers do
not own another hash algorithm or SQL-default policy. Article preservation binds
its target predicate and the actual retained current-schema target separately in
its operation identity, following the existing native bootstrap owner. Compiling
these original sources does not qualify native preservation, recovery or bootstrap
acceptance.

## Memory allocation discovery boundary

`config/development/memory-allocation-boundaries.json` belongs to the existing
`development-governance` directory owner in the configuration ownership registry.
It is inventory-only governance input and records explicit source-path families and initial
source traces for PublicHotRead snapshots, PublicAOT file materialization, ordinary L1,
owned AEDS frames, notification fanout, and database materialization. The established
snapshot store, AOT commit journal, revocation boundary, queue delivery catalog,
configuration contract, and test matrix retain their respective responsibilities.
The catalog grants no data migration, publication, delivery, or runtime configuration
authority. Every recorded migration permission remains denied pending its class contract.

The producer is `tools/governance/memory-allocation-inventory.mjs`. It binds the current
Git commit, complete index digest, tracked-change digest, source bytes, dependency
manifests, ownership inputs, and producer bytes to a worktree fingerprint. Its reader
reopens the candidate and independently compares lexical discovery with ripgrep.
Generated and vendor path candidates stay in the denominator; filenames do not certify
source ownership, and unclassified surfaces remain owner-resolution-required.
Output contains source locations
and digests, rather than payloads or credentials. A changed source, replacement SHA,
altered trace, omitted match, or forged resolved count is refused.

```bash
# Restore this package-free tool only against the installed offline SDK/cache.
dotnet restore tools/governance/memory-syntax-observer/FsusBlog.MemorySyntaxObserver.csproj --locked-mode --source "$NUGET_PACKAGES" --ignore-failed-sources
dotnet publish tools/governance/memory-syntax-observer/FsusBlog.MemorySyntaxObserver.csproj --no-restore -c Release --output .tmp/memory-inventory/syntax-observer
export FSUS_MEMORY_SYNTAX_OBSERVER="$PWD/.tmp/memory-inventory/syntax-observer/FsusBlog.MemorySyntaxObserver.dll"
node tools/governance/memory-allocation-inventory.mjs produce .tmp/memory-inventory/run.json <run-id>
node tools/governance/memory-allocation-inventory.mjs verify .tmp/memory-inventory/run.json
node tools/governance/memory-allocation-inventory.mjs verify .tmp/memory-inventory/run.json --require-complete
node --test tests/tools/memory-allocation-inventory.test.mjs
```

Production creates a new file exclusively; repeat runs use new run identities and paths,
preserving previous receipts. The ordinary reader verifies intake identity and discovery
and recorded family/syntax projection only. Every matched source path must map to exactly
one explicit family; extra, omitted, or duplicate source assignments are refused. A new
source match requires an explicit catalog update. The observer uses Roslyn from the installed
.NET SDK without additional packages and records containing types/members, operation arguments,
capacity-model limits, comments, literals, declarations, and parse-error diagnostics. Its
assembly closure and SDK version are bound to the receipt and replayed by the reader.
This is syntax observation, not semantic compilation or a reference-lifetime proof. Mixed
families retain unresolved class-specific eligibility and deny all migration. The strict
command still refuses acceptance: complete consumer/release graphs, actual capacity and
asynchronous release evidence remain unresolved. Six detailed source traces and the remaining
family exclusions are observations, not runtime qualification.
The registered regression owner is the existing static-governance test topology.

All future configurable memory capabilities must default to Auto: bounded discovery and
qualification, automatic activation and deterministic eligible selection after admission.
Disabled must stop new probes and use before draining old owners. Required must preserve
permissions, safety, qualification, and budgets. Discovery, qualification, online state,
selection, and per-operation admission remain distinct. This inventory changes no serving
behavior and claims no performance improvement.

The common resource vector distinguishes `Inodes`, `OperationSlots`, and `Bytes`.
An inode capacity domain needs its own identity and cap; available operation slots
cannot stand in for free inodes. The coordinator rejects a complete vector when any
domain is exhausted and retains live charges across policy reductions.
`FrozenDiskPhysicalAllocationPolicy` retains an owner-supplied immutable physical
upper bound, including volume/root identity, maximum logical and charged bytes,
policy revision, and finite expiry. Missing, expired, mismatched, or out-of-range
bounds reject use. Sampled file blocks do not establish a conservative metadata or
extent bound. This adapter supplies neither filesystem qualification nor automatic
activation; the disk owner must consume the independent inode domain, and the
existing policy owner must establish a qualified bound before enabling physical
admission. The current source-compatible disk path without a physical policy remains
unqualified for Auto. No new setting or per-host enable authority is introduced.

`MemoryCapabilityPolicyPlan` validates a complete bounded registration roster and
policy revision before it can be consumed by the existing configuration owner.
Omitted modes normalize to Auto; unknown keys, dependency cycles, transitive
Required/Disabled conflicts and competing Required backends reject the revision.
The dependency order is deterministic and copied inputs cannot mutate the plan.
Backend selection requires current-revision online, release and runtime facts for
the candidate and its dependencies, plus that candidate's qualified workload and
operation admission. A budget rejection leaves online facts intact. A required
unavailable backend cannot silently select another member of its exclusive group.
This contract has no probe, driver, publication or readiness side effects and does
not qualify a controller's supplied facts; production activation and safe draining
remain with the common capability controller and the existing resource owners.

The coordinator's optional `existingPhysicalDomains` roster declares internal
persistent byte/inode accounting roles, not a user enable switch. The storage
owner must verify and retain an already-existing object before calling
`MemoryReservation.CommitObservedExisting`; this API does not create backing or
qualify its content. It records that occupancy even above a reduced current cap
and reports OverTarget. Only newly retained host/index resources can consume the
existing scratch reservation, and overlapping persistent/new capacity, stale
policy revision, descriptor mismatch, duplicate identity and arithmetic overflow
are rejected without partially adopting the object. New disk growth still uses
ordinary hard admission. Failed deletion leaves the physical owner charged; final
disposal is legal only after the existing storage owner actually relinquishes the
backing. Object replacement checks and namespace coordination stay with that owner.

`LinuxProcMemoryPressureSource` provides background-only host availability/swap
capacity and process RSS/swap occupancy observations from bounded `/proc` reads.
It reserves the reusable buffer's full capacity before allocation; Disabled avoids
both sampling and buffer admission, and disable drains the capture lock before
clearing the buffer and releasing its charge. Missing fields retain Unknown;
duplicate fields, unknown units, overflow and oversized files retain Malformed;
expired captures retain Stale. Each observation carries its source, scope, domain
revision and clock. Ledger inode observations keep their independent inode unit.
The [kernel proc documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
defines the host and process fields; host availability is not a scoped cgroup
capacity and process swap occupancy does not prove swap activity or thrashing.
This source registers no controller or diagnostics authority. Scoped cgroup
membership/ancestor sampling, Windows/macOS adapters, automatic qualification and
P01 sampling performance remain outstanding; no raw proc observation qualifies
admission headroom or a platform support row.

`MemoryGovernor` is a pure input-bound transition function. Its immutable policy
requires explicit candidate/evidence identity and finite targets, headroom margins,
growth rates, source ages and recovery windows from the existing frozen baseline
owner. Missing/unqualified policy or pressure facts return UnmetPrerequisite and
stop expansion while retaining the latest hard bounds. Scoped usage and capacity
must match the resource domain/revision; overlapping host, GC, process, native and
UMA counters are not summed. The ownership ledger still bounds allocated but
untouched memory; matching scoped headroom additionally accounts for competition.
Sample freshness uses both UTC and monotonic age; clock-range overflow freezes
growth and retains the latest bound. Recovery uses the monotonic clock and bounded
integral growth. Requested reclaim,
allocator relinquishment, OS retention, pending and blocked feedback remain
separate; target changes never dispose owners or spend projected reclaim credit.

`MemoryReservationCoordinator.TryReserveUnderBounds` atomically checks the complete
vector against configured and supplied bounds at the observed accounting revision.
`ApplyGovernedBounds` additionally retains a revisioned derived bound in the same
canonical ledger so existing raw managed/native factories cannot escape an accepted
scope through another reservation call. It never increases the configured hard cap,
drops a live charge or erases an existing scoped key. Fault/disable paths keep the
last bound; recovery requires a newer compatible input-bound decision. The existing
configuration revision remains independent of this decision sequence. These APIs
expose both configured and actually enforced caps through the immutable accounting
snapshot. A missing prior decision cannot conceal a retained bound; invalid inputs
cannot raise it. Fresh qualified recovery still grows independent slot budgets
only after the declared stable window and within its growth limit. These APIs
have no qualification or scheduler authority. The pure governor and explicit ledger
adapter are not registered for production startup; authoritative P01 inputs, actual
scoped sources and operating/performance acceptance remain required.

`MemoryCapabilityController` consumes the single immutable policy-plan roster and
explicit frozen baseline, current governor decision, runtime identity and release
qualification inputs. `TickAsync` is an explicit control-plane operation, not a new
scheduler. Missing prerequisites return UnmetBaseline/UnmetGovernor without invoking
a backend; Disabled starts no probe or reservation. An admitted callback owns its
actual completion: caller cancellation or deadline expiry cannot release scratch
while an uncooperative probe continues. Policy/identity generations reject late
results. Retry windows, cooldown and circuit bounds come from the supplied policy;
qualified recovery requires no second enable flag. Budget rejection is per operation
and does not discard a healthy backend's online facts.

Operation admission linearizes with runtime disable and uses the same canonical
scoped ledger gate. Controller operation leases delay retirement until their actual
completion; `MemoryCapabilityOwner.FromManaged`/`FromNative`/`FromGpu` then use
those existing owners' retirement and actual Drained tasks. No logical target or IDisposable return is
used as proof that readers, pins or native operations have relinquished storage.
`FromDisk` accepts a caller-owned root and its complete borrower roster under a
finite, existing ownership-policy limit. The caller transfers exclusive root
ownership and stops new borrower creation. Each store stops new work and drains
its real leases, I/O, temporaries and physical charges; the root closes only after
every borrower succeeds. A failed borrower faults the composite without closing
the root, while other actual drains remain observed. Store never closes a borrowed
root. Faulted GPU/quarantine drain likewise preserves custody and reports DrainFault
instead of Off or a permitted restart. These adapters do not qualify any platform.
`MemoryCapabilityGpuAllocationPolicy` retains explicitly declared device/staging
physical upper bounds, scoped to capability, device identity/epoch, policy and
accounting revisions, and finite UTC/monotonic validity. Missing bounds reject use;
request bytes and observed allocation size never invent a conservative upper bound.
Resolution checks the enforced common byte/slot caps including shared UMA parents.
The actual GPU module then reserves those bounds before allocation and commits the
observed physical capacity, rechecking admission if pressure changed after resolution.
This policy contract supplies no calibrated production values or hardware qualification.
Read-only selection performs no probing or
pressure-file I/O. These classes are not registered at startup or wired to public
readiness/diagnostics routes; existing authorities retain those responsibilities.
The new tests belong to the original backend Unit discovery and the existing
`backend-unit` matrix/cache input closure. Their synthetic qualification and numeric
inputs prove state transitions, actual managed ownership and real task-owned Linux
file/descriptor drain. Controlled GPU driver callbacks do not establish hardware
qualification. These tests do not establish calibration,
platform qualification, production Auto activation or full A01-A20 acceptance.

The current backend, Core, Shared, and Migration projects target `net10.0`. A .NET target
or an available local toolchain does not establish product platform support. The catalog distinguishes the Dockerfile's `linux-musl-x64` shipping default from
additional candidate targets and binds each row's source and required offline closure.
The memory program's qualified release support contract and installed offline closure remain
owner-resolution-required. Linux, Windows, and macOS on x64 and ARM64 are retained as
NotVerified candidate rows, not asserted supported deployments; missing environments
cannot be removed from subsequent qualification. A current Linux x64 SDK observation
does not qualify a native, disk, GPU, or other platform backend. Docker validation remains
with its authorized owner.

Withdraw or revise the catalog and its producer through these existing governance owners
to roll back inventory work. No product resources or serving state are changed.

## Configuration ownership

Shared runtime, test, and observability configuration belongs in `config/`; only the .NET framework tool manifest uses `.config/`. Project-specific `appsettings*.json` and `Properties/launchSettings.json` stay with their owning project, so Docker Compose launch profiles live in `ops/docker/Properties/`. Root `configs/`, ownerless `Properties/`, and scattered JSON configuration are rejected by `tools/configuration/check-configuration-layout.mjs`. See [`docs/configuration-layout.md`](../configuration-layout.md) for the complete ownership table.

The Change Contract post-merge generated-repair schema is `config/schemas/post-merge-generated-output-repair.schema.json`, explicitly registered by `config/configuration-ownership.json`; the producer allowlist exists only in the trusted `tools/governance/change-contract-registry.mjs` and cannot be inferred from historical directories, mtime, or the newest file. Multi-step repairs with dependencies use `config/schemas/post-merge-generated-output-repair-dag.schema.json`; its trusted registry seals the sole canonical repair and external-naming manifest paths, ordered steps, generator closure, dependency consumption, and complete output ownership, so a v1 single-producer manifest, arbitrary evidence path, or unregistered command cannot substitute. If a merged PR omitted declared external-naming evidence, `config/schemas/post-merge-external-naming-evidence-repair.schema.json` binds the original PR's exact base/head/merge, unchanged source blob/revision, registered surface, and missing artifact digest; an ordinary external-naming manifest must still change with its affected source, and repair may not rewrite source.

Release Reliability separates scenario and action authorities: `config/testing/release-reliability-scenario-catalog.json` owns the exact-seven scenarios, command semantics, environment contract, and structured lifecycle-action references; `config/testing/release-reliability-lifecycle-action-registry.json` alone owns the 35 actions' process calls, timeouts, receipts, state domains, and failure-safe cleanup contract, whose JSON Schema is `config/schemas/release-reliability-lifecycle-action-registry.schema.json`. `config/testing/runtime-state-domain-registry.json` is the closed-world action-state vocabulary. `config/testing/physical-execution-process-policy.json` alone owns tree termination, bounded pipe close, and consecutive zero-member observation, not registry action timeouts. `tools/test/release-reliability-lifecycle-actions.mjs` loads the contract and is the sole outer executor via `tools/test/physical-execution-process-tree.mjs`; it runs each action and seals a process-tree receipt. `tools/test/release-reliability-lifecycle.mjs` only executes actions/observes real state, while `tools/test/verify-release-reliability-lifecycle-action.mjs` independently rereads the raw receipt. Soak/load/data-scale/mutation/resource lanes do not own lifecycle receipts and cannot self-certify precondition, reset, or postcondition. A data-scale lane measures only the fixture/runtime prepared by its dedicated runtime owner; its seed and teardown remain with their respective owner authorities.

The backend inventory's sealed-history repair schema is `config/schemas/post-merge-generated-output-history-repair.schema.json`.
The trusted change-contract registry owns its exact history, six-file producer closure, canonical manifest/output and policy roster;
`tools/governance/generated-output-history-repair-v3.mjs` validates that contract through the existing isolated Git/replay adapter.
Its metadata preparation command does not approve historical provenance or qualify producer execution. See the
[change contract](../development/change-contract.md#pull-request-contract) for independent bootstrap and repair boundaries.

## Operations ownership

Operations templates have one top-level root, `ops/`. Production containers/Compose, development dependencies, gateway templates, and privacy-operation examples belong to `ops/docker/`, `ops/development/`, `ops/gateway/`, and `ops/privacy/`. Zero-downtime resource thresholds are configuration in `config/deployment/`, not templates; executable deployment and general operations remain in `tools/deployment/` and `tools/operations/`. Backend environment templates are owned by `config/examples/`; the root `.env.example` and `.env.production.example` paths are retired. See [`docs/operations-layout.md`](../operations-layout.md) for the path table, historical local-proxy removal decision, and fallback boundary.

Backend Docker SDK stage 的唯一输入 inventory 是
`config/build/backend-docker-inputs.json`。`tools/docker/backend-input-closure.mjs`
用 production publish properties 读取真实 `ProjectReference`、repo-local MSBuild
imports 与编译/发布 items，双向核对 inventory 后才生成隔离的 named build context；
`ops/docker/FsusBlog.Server.Dockerfile` 只消费其中的 `restore`、`compile` 与
`publish` domain。frontend/WASM、release evidence、docs/tests 和无关 tooling
不能回退进入 backend SDK stage，新增 project/import 或越界 item 会 fail closed。
`config/build/backend-restore.xml` 是该 context 的显式 NuGet configuration：host
evaluation 与 Docker restore/publish 指向同一文件，不复制用户级 configuration 或凭证。
settings lookup 必须返回该文件的 exact singleton；空结果不能解释为没有 host configuration。
所有 closure evaluation 通过 `tools/docker/backend-input-environment.mjs` 使用 Linux
`bubblewrap` 与 canonical physical runner：repository 只读挂载到 `/src`，网络和 `/tmp`
隔离；passwd/group/NSS 为 task-owned synthetic identity，不挂载 host home 或配置。
缺少隔离能力时失败，不回退 host evaluation。SDK stage 和 evaluation 同时要求 `/src`
以外的根目录 MSBuild/NuGet/editor 配置不存在；真实 environment/process/log receipt
保存在 `.tmp/backend-input-evaluations/`，不进入 backend compile cache key。
materializer 分别观察实际 restore/publish properties 的输入并取闭包并集；Configuration、
RuntimeIdentifier 与完整 publish request 写入无时间的 profile markers，参与 restore domain
digest，且每个 Docker consumer 在调用前验证。Debug probe 明确传递 Debug request，不借用
Release observation；实际 publish 调用次数与各 target 的发布语义保持不变。
候选分支使用 `backend-input-closure.mjs probe-buildkit` 在 tracked-clean Git snapshot
上执行 cold、无关输入、backend source 与 MSBuild import 四组真实 BuildKit build；
materializer domain digest 是稳定 cache key，raw progress 另行证明无关输入的
restore/compile/publish vertex 命中真实 BuildKit cache，backend/MSBuild 输入变化则 miss；
实际 SDK image 与 root-context witness 还会双向证明 `.env` 等无关文件存在于 build
context 但没有进入 `/src`。

`backend-docker-inputs.v2` 在同一 inventory 中另列独立 Migration entry root；仅显式
`--tool migration` 才求值和物化 `migration/restore`、`migration/compile`、
`migration/publish`。该根复用同一个真实 MSBuild evaluator、隔离环境与 item/import
核对，Server 的 project graph、三个输入 domain 和默认 final target 不含 Migration。
`current-native-task` 是 local-only、禁止 registry push 的 task image target：从 final
继承原 Server entrypoint，只把独立、非 single-file 的 Migration publish 放到
`/app/tools/migration`。原 build producer 观察实际 image ID 与该目录全部 regular file
字节，生成 `fsusblog.current-native-task-tool-image.v1` 绑定 assembly、deps、runtimeconfig
及其余 publish artifacts；缺文件、symlink、错误 source/profile 或不完整测量均拒绝。
这不是生产 release manifest、current receipt 或 native capability。Publish DLL 本身
不安装 sealed Host 的四个 owned factory，默认 Host 缺能力仍拒绝；实际编译、image
measurement、配置组合与三 provider qualification 各自仍须原执行验收。
Migration 根的四个 retained-reader EmbeddedResource 另以 exact path/LogicalName
登记在该根，不扩展 Server external items 或整个 tools subtree。原 item evaluator
必须在 Migration 项目两次真实 profile observation 中看到完整、无重复的四个
EmbeddedResource；名字漂移、不同 item/project owner、额外复制语义、缺文件及
symlink source 均拒绝。四份源字节进入同一 selected-input 前后观察与 compile
domain；唯一原 retained-input producer 源按原 owner 移交，未执行或改写其产物。
这些嵌入资源只提供原读取算法，不替代 current-target producer，也不授予 Host
的 source、backup、tool、operation capabilities 或配置组合。

闭包测试的唯一 physical owner 是 lifecycle registry 中的
`backend-docker-input-closure` real-subprocess entry，由 matrix 的 `static-governance`
执行，并绑定同名 coverage entry；production-image workflow 不再重复 raw 执行测试。
该 workflow 的 PR filters 覆盖 inventory 声明的 project、restore、external item 与
publish roots，也覆盖各 project ancestor 的隐式 MSBuild/editor/SDK 配置。
production-build-artifacts 同时绑定 restore XML，并在 matrix 中声明 inventory、restore、
checker 和 Dockerfile 的触发输入。Local closure/materialization fixtures 不能替代实际
BuildKit cache、SDK image 文件排除或 cold final-image runtime 验收。

## Language entrypoint ownership

`src/frontend/` is owned by `FsusBlog.Client.esproj`, Vite, and the JavaScript/TypeScript toolchain; it may not contain a C# application entry point. Every C# source file must be within a `.csproj` directory boundary or explicitly registered as a file-based app with owner, dependency declaration, invocation command, tests, and output contract. `tests/governance/repository-source-layout.json` binds this language boundary to `tests/governance/csharp-entrypoint-ownership.json` and `tools/check-csharp-entrypoint-ownership.mjs`; protocol-fixture generators also need stable `generate`/`check` commands and may not hard-code `/tmp` or `/var/tmp`. See [`docs/testing/issue-1174-csharp-entrypoint-ownership.md`](../testing/issue-1174-csharp-entrypoint-ownership.md) for the full decision.

Issue #1166 moved the original top-level `circuits/` path to `src/zk/circuits/`. The v2 and v5 source bytes' SHA-256 remain unchanged; v2 R1CS IR and Groth16 binary may legitimately change because they embed `source_path`, so corresponding artifact, circuit, trusted-setup, and local-review hashes must be updated. The migration changes neither circuit ID, public input/witness layout, constraint count, proof system, curve, ceremony state, nor the fail-closed `production_usable=false` state.

## Root exceptions

`src/` is the sole canonical product-source root. `benchmarks/`, `tests/`, `tools/`, and `ops/` contain executable source under benchmark-isolation, test-isolation, repository-tooling, and operator-tooling exceptions; they do not enter product source or shipping assemblies. Stryker tool source is a tooling dependency pinned by `config/testing/mutation/stryker-tool.v1.json` to the official source archive and versioned `tools/mutation/patches/` overlays. `tools/mutation/stryker-tool.mjs` builds it only inside an admitted run-owned mutation custody directory, binds its actual package/executable/dependency closure, and leaves resource enforcement and cleanup to the existing scheduler/process-tree owners. It is never linked into product runtime or shipping assemblies. `.config/` is the framework root required by the .NET tool manifest. Every other top-level directory must be declared in `tests/governance/repository-source-layout.json` as artifact, configuration, documentation, security, or automation ownership; a new source-like root also needs an explicit `architecturalException`, or the checker fails closed. Top-level `release-evidence/` is retired and forbidden: historical reports belong in `docs/reports/`, static contracts in `security/evidence-contracts/`, fixtures in `tests/fixtures/evidence/`, and a fresh bundle only in untracked `.tmp/release-evidence/`. Optional `release-index/` is the sole exception and may contain only the minimal identity/integrity JSON checked by `check-release-evidence-layout.mjs`; it cannot store a bundle or replace its immutable storage reference.

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

`tools/check-repository-source-layout.mjs` reads the top-level inventory from the Git index and rejects a reintroduced root `circuits/`, `deploy/`, or `release-evidence/`, undeclared top-level directories, unjustified source exceptions, old circuit-source references, source-hash drift, and manifest/R1CS source-binding drift. It also confirms that C# entry-point ownership policy/checkers remain attached to the canonical source-layout contract; the C# project/file-app/global-output/protocol-fixture checker aggregates those specific violations.

`LinuxCgroupScopeResolver` parses bounded captured membership/mount metadata,
resolves v1 memory or unified v2 paths and their observable ancestor roster, and
retains namespace/mount/membership identity. Missing, denied, stale, malformed,
ambiguous and namespace-escaping captures remain distinct unavailable results.
The resolver performs no I/O and cannot qualify a source or grant growth. A live
sampler must still verify actual directory inode/open identities, stable captures
and matching per-ancestor usage/limits before existing qualification/admission.
Its byte/record/ancestor bounds are explicit caller policy inputs, not defaults.
Format references are the [kernel cgroup documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html)
and [kernel proc mountinfo documentation](https://www.kernel.org/doc/Documentation/filesystems/proc.txt).

`LinuxCgroupDirectoryReader` owns an actual read-only kernel directory descriptor
on Linux x64/arm64. It checks the controller filesystem, statx mount/device/inode
identity and namespace identity before opening a resolved ancestor. Scalar reads
use fixed controller filenames, reject symlinks and another file domain, check
directory identity before/after, and clear caller-owned bounded scratch on return.
Disposal waits for the synchronous read and closes the descriptor; repeated
disposal is safe. v1 combined memsw is not reported as swap occupancy. Missing,
denied, malformed and unlimited values remain distinct from a real numeric zero.
The raw observed-directory API requires the complete prior native identity; it
does not certify process membership. Raw identity and scalar captures retain
`NotVerified`. Stable process membership/mount recapture, complete ancestor
sampling, qualification, measured metadata/descriptor costs and canonical
governor composition remain required. The supplied read bound is caller policy;
the test's 64-byte buffer is not a production default.

`LinuxCgroupContextReader` reads this process's membership/mount metadata into
separate caller-owned admitted buffers under explicit byte/record/ancestor/time
bounds. It checks actual cgroup and mount namespace links before/after the read,
retains their observed identities even when path resolution fails, and reports
UTC/monotonic capture provenance. It clears both used scratch spans on success,
unavailable capture or clock exception. Overlapping/undersized spans reject before
capture. Context comparison invalidates changed membership, mounts, namespaces,
ancestors, source or clock, including expiry and checked timestamp overflow.
Matching contexts remain `NotVerified`; complete ancestor sampling, actual inode
continuity, measured metadata bounds and canonical qualification are still required.
The existing background/capability owner controls discovery, disabled behavior and
admitted buffer/metadata lifetime. This raw capture surface installs no timer,
request hook, capability registry or growth policy.

The directory reader's v2 counter surface uses the same descriptor owner,
fixed-filename read, directory/file inode checks, overflow byte and scratch clearing
as scalar capture. `LinuxCgroupCounterParser` reads selected native `memory.stat`
keys, explicitly local `memory.events.local` events and `memory.pressure` totals.
Bytes, event counts and cumulative PSI microseconds have separate units. High
events are distinct from max/OOM events; major faults are not attributed to swap.
Key order is not assumed; duplicates, missing keys, overflow and unknown target
formats cannot produce zero. PSI averages are checked for the supported native
format, while returned totals retain microseconds. The v2 counter surface keeps
v1 counters unavailable instead of interpreting combined RSS/swap-cache or
substituting a v2 format. The separate `CaptureV1Stat` surface uses the same native
directory owner, fixed memory.stat read, overflow byte and used-scratch clearing.
`LinuxCgroupV1StatParser` preserves native keys, local/total/hierarchical-limit
scopes and units. A v2 directory returns Unknown without a v1 read. Actual v1
runtime evidence, context binding and qualification remain required.

`LinuxCgroupTimedCounterReader` borrows that directory owner for one counter read
and records the UTC and monotonic endpoints around the actual read, with an
explicit caller-supplied duration bound. Clock reversal, frequency changes,
timestamp overflow or an excessive read window remove the usable value while
retaining the observed endpoints. Disabled mode captures neither a counter nor
time. The caller-supplied scratch span is cleared on every exit, including clock
and ownership exceptions; those exceptions remain visible and the borrowed owner
is not disposed. Source identity includes a process-instance identity. A read
window does not supply an exact point timestamp, a rate, a qualified process
binding or a production default for sampling costs. Existing context/ancestor
binding, admitted metadata lifetime and frozen P01/P02 limits remain required.
`LinuxCgroupCounterNormalizer` consumes agreeing raw directory/context identities
to distinguish byte-gauge changes from cumulative counter resets. Its contexts
do not timestamp counters, so every result leaves `PerSecond` absent; source
comparison alone does not establish sample freshness or directory-to-roster binding.
The timed reader's comparison checks its actual read windows and capture freshness
before calling that normalizer. Fresh contexts cannot rescue missing, stale or
discontinuous counter windows; these composed results still provide no rate.

`LinuxVmStatActivityReader` calls `LinuxVmStatActivityParser` on an actual bounded
read of `/proc/vmstat`, with operation-owned file disposal and caller-owned admitted
scratch cleared on all exits. It retains independent swap page and major-fault
fields, actual read endpoints and `Environment.SystemPageSize` for checked swap
byte conversion. An overflow byte refuses truncated input; unavailable fields and
invalid clocks retain nonnumeric states. These are unqualified host counters,
separate from the existing meminfo/status occupancy source. The reader adds no
timer, process attribution, swap-thrashing classification, public diagnostics or
production defaults. Complete host/domain binding, admitted metadata costs and
frozen sampling/performance limits remain required.

`LinuxZramMemoryStatParser` accepts captured text, an explicit supported layout
identity and capture validity. Its current layout retains five byte fields and
four page counts separately. Parsing neither discovers a device nor supplies a
device identity, reset epoch, sample window or physical headroom. A genuine
version-bound device read owner and runtime evidence remain required.

These raw counters do not classify thrashing, grant headroom or qualify a process
domain. Native meanings follow the [cgroup v2 interfaces](https://docs.kernel.org/admin-guide/cgroup-v2.html),
[PSI interface](https://docs.kernel.org/accounting/psi.html) and
[v1 memory statistics](https://docs.kernel.org/admin-guide/cgroup-v1/memory.html).

The established `PublicHotReadBinaryArtifactFactory.ConsumeReservedPayloadAsync`
composes `ReservedAedsFrameWriter` with the existing
`TransientBufferLease.ConsumeAsync` operation hold. It accepts caller-admitted
storage and a stable, caller-owned payload, checks the canonical artifact ceiling
and logical destination length, rejects overlapping source/destination, and awaits
the frame consumer before releasing that hold. Cancellation of an outer wait
does not return storage still used by the consumer. The borrowed frame cannot
outlive the callback; captured memory rejects access after operation completion.
The finite managed fixture budgets are not production defaults or native
qualification. This operation surface adds no allocator or publication authority.
Long-lived PublicHot snapshots still require a body ownership-transfer contract
on `PublicBinaryArtifact`, integration with the original snapshot/read retirement
owner, and simultaneous source/destination/workspace admission. The existing
byte-array `FromFrame` and unbounded compression path do not supply those
contracts. Unknown-length producers and compression workspace remain separate
unverified work; they cannot publish the callback's borrowed memory.

`WindowsNativeMemoryPressureReader` is a raw 64-bit Windows PSAPI2 observation
surface using system32 `GlobalMemoryStatusEx`, `K32GetPerformanceInfo` and
`K32GetProcessMemoryInfo`. It fills fixed caller-owned admitted value storage,
retains native API/scope and per-call UTC/monotonic provenance, and checks page
conversion and capture clock validity. Omitted mode is Auto; Disabled clears old
output and makes no native or clock capture. Unsupported targets are separate
from disabled mode and report unavailable values. Current-process pseudo-handles
remain borrowed. Physical availability, system commit, process private commit and
page-fault counts are distinct observations; commit limits are not promoted to
hard physical/job capacity, private commit is not swap occupancy, and page faults
are not classified as swap activity. The API/ABI guard (PSAPI2 Windows 6.1+,
x64/arm64) is not a product support or qualification declaration. All results
remain `NotVerified`; job/compression/pressure APIs, actual Windows rows, measured
probe/metadata costs and canonical Auto/readiness integration remain required.
Native ABI/meanings follow [PERFORMANCE_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-performance_information)
and [PROCESS_MEMORY_COUNTERS_EX](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex).

`PortableMemoryPressureSource.CapturePlatformObservations` is the existing
observation owner's raw platform caller. It uses its clock and caller-admitted
output spans to invoke `MacOsSysctlMemoryReader` and
`WindowsCurrentJobMemoryReader`, with an explicit finite Job query duration.
Invalid shape or policy clears both owned prefixes before any probe; exceptions
clear partial rows and preserve caller-owned tails. Disabled makes no native or
clock capture. The returned metadata and output rows retain each reader's states,
native meanings and `NotVerified`; they are not inserted into portable comparable
history. macOS `hw.memsize` is host physical total, while `vm.swapusage` is host
swap occupancy. Immediate Windows Job limits retain class 9 flags, separate peaks
and class 13 notification-time occupancy. Query time is not notification time;
missing Job identity/epoch prohibits cross-frame comparison. No host metric,
process attribution, headroom or qualification is inferred. Genuine Windows/macOS
runtime rows, admitted metadata/probe costs, frozen policy, original background
caller and canonical Auto activation/readiness remain required.
