# Issue orchestration scope and remote snapshot

本文件是多 issue 调度中 scope selector、远端 live snapshot、分层 investigation projection、frontier 和 DAG 更新触发条件的 current authority。它只约束调度运行态，不改变 FsusBlog 产品 API、数据库、发布或前端运行时。

## Versioned selector

每轮运行使用一个 `issue-orchestration.scope-selector.v1` selector。selector 至少固定以下字段：

```text
schema
selectorVersion
type
repositories
statePolicy
dependencyClosure
implicitExpansion
parameters
remoteQueryIdentity
```

支持的 `type` 是 `explicit-issues`、`repository-open-issues`、`label-query`、`milestone-query`、`dependency-closure` 和 `parent-tracking-issue`。

- `explicit-issues` 只解析 `parameters.issueIds`。相同 label、相似标题、`related` 或 `mentioned` issue 不会隐式进入；selector 版本和 canonical parameters 不能复用到另一组 issue。
- `repository-open-issues`、`label-query` 和 `milestone-query` 是动态查询。每次远端重取都按 selector 的 repository、state policy 和 query parameters 解析匹配集合；关闭、reopen 或离开查询的节点不得静默删除。
- `dependency-closure` 只沿远端事实中明确声明的 `dependsOn` 边扩展。
- `parent-tracking-issue` 只沿 parent 的 `trackedIssueIds` 选择子 issue；是否包含 parent 由 selector parameter 明确决定。

`repositories`、集合参数和远端结果在计算 digest 前 canonicalize（对象按 key、数组按 canonical value 排序），因此同一 selector 和远端事实不受返回顺序影响。没有 selector 中明示的隐式扩张规则。

## Selector receipt and live facts

解析结果写成 `issue-orchestration.selector-receipt.v1` receipt。每个 receipt 记录：

```text
selectorVersion/type/parametersDigest/selectorDigest
resolvedIssueSet[]
exclusionReasons{}
remoteQueryIdentity
previousRemoteSnapshotDigest
remoteSnapshotDigest
remoteChangeSet{added,changed,closed,removed,reopened}
issueHistory{}
resolvedAt
receiptDigest
```

每个 resolved issue 的 remote fact 包括 issue identity、state、state reason、updatedAt、title、body、relevant comments、labels 和 milestone。`remoteSnapshotDigest` 同时绑定 selector digest、排序后的 issue set 和这些 remote fact digests；本地 test failure、rework、agent blocker、epoch、slot、lease、worktree、resource 或 cleanup 状态不属于 remote fact。动态 selector 中离开的 issue 进入 `issueHistory`，并带有 `left-selector-scope` disposition 与此前的 snapshot digest。

## Layered investigation projection

Frontier 不再把单个节点上的完整 investigation 记录当作 dispatch authority。DAG 节点必须使用三层、可独立校验的事实链：

```text
discoveryFacts
  → classificationFacts
  → dispatchInvestigation（仅在需要完整 dispatch 调查时存在）
```

对应的调查阶段是 `discovered → dependency-classified → candidate-ready → dispatch-investigated`。`discoveryFacts` 只承载 issue identity/state、显式依赖、scope membership 和候选 owner；`classificationFacts` 承载 owner evidence、active/satisfied dependencies、conflict/resource domains、risk flags、instruction roots、confidence 与 unresolved decisions；`dispatchInvestigation` 承载 exact base/worktree、AGENTS 链、允许/禁止边界、code/test/current-doc paths、实现决定、acceptance mapping、runtime probes、mutation controls 和完整 prompt inputs。浅层事实不能直接生成 implementer prompt。

各层的 schema 分别是 `issue-orchestration.discovery-facts.v1`、`issue-orchestration.classification-facts.v1` 和 `issue-orchestration.dispatch-investigation.v1`。每层都必须是 `status=complete`、带有自洽的 SHA-256 `digest`，并通过前一层 digest、selector receipt digest 和 member remote-fact digest 串联；dispatch 层还必须绑定节点的 `baseSha`。发现层与分类层由非 root 的 `dag-creator-updater` 以 `stage-model-pool.v2` 的确定性 semantic-proposal route、read-only、fresh-context、proposal-only 身份产生且共享同一 actor identity；dispatch 层由冻结合同中的 `test-owner:test-contract` route 产生，并绑定 `testOwnerId`。实际 profile 由分类和 routing compiler 决定，不能从 root 或 agent 自述推断。

三层事实由 `issue-orchestration.investigation-projection.v1` 汇总。projection 必须覆盖 selector receipt 中每个 member 恰好一次，并携带 `selectorReceiptDigest`、`remoteSnapshotDigest`、`inputDigest`、`projectionDigest`、`testOwnerCandidates` 和 `implementationReady`。其 validation 必须使用 `issue-orchestration.investigation-validation-receipt.v1`，由 `layered-investigation-validator` / `machine` / `read-only` 签发，状态为 `passed`，且 freshness 仍绑定当前 selector、remote snapshot 和每个 member 的 remote fact digest。派生列表只能由 member phase 重新计算：`candidate-ready` 只产生 `test-contract-ready`，`dispatch-investigated` 才产生 `implementation-ready`；`dependency-classified` 仍需保留 `investigation-incomplete`。

调查队列按 ready-adjacent、downstream unlock、critical path、priority、waiting age 和稳定 member identity 确定排序，数组顺序不参与权威。有 machine-ready stage 和空槽时必须先派发；后台深度调查不能压住 ready work。100 个 shallow member 中只要两个即将执行的 member 完成所需层，就可派发对应 test-owner/implementation stage，无需等待其余 98 个。长期阻塞的深度调查必须记录 `blockedSince`、blocker owner 和直接 evidence；没有 owner/evidence 的 starvation 不能成为永久停留理由。

Freshness 按 member 和 layer 隔离。issue/relevant-comment 或 selector member fact 漂移只失效受影响 member 的 discovery/classification 及其下游；base、delivery epoch、AGENTS chain、current docs、owner code 或 test-entry digest 漂移只失效该 member 的 dispatch investigation。未漂移层必须幂等复用，不能因另一 member 变化而全 scope 重做。深度 member 只能出现在 implementation 输出或 dispatch-investigation queue 之一，不能双重派发。

Acceptance group 可以复用共享 code/test/docs 索引、schema/runtime facts 和 conflict/resource evidence，但每个 member 在冻结合同前仍独立绑定 issue-specific paths、tests/probes、current docs、constraints/non-goals、owner repository、allowed/forbidden paths、acceptance map 和 investigation digest。组级 evidence 不能替代 member contract；一个 member 缺证据只阻塞该 member。Implementer 只消费完整、base/receipt-bound prompt；缺 owner、design、acceptance、counterexample、command、probe、mutation 或 stop condition 时必须返回 `test-contract-disputed`，不得自行补调查。

Projection、validation 和每层事实的 digest 或 selector/freshness 任一漂移都使 frontier 重新计算并 fail closed。旧的 `node.investigation` 属性及任何兼容 fallback 不是 current schema；出现时必须拒绝，不能把旧字段重放为 dispatch authority。

## Semantic graph 与 runtime projection 分层

语义图和运行态投影是两份独立、可分别校验和持久化的事实。`issue-orchestration.semantic-graph.v1` 只承载节点的 semantic facts（依赖、owner、conflict key、risk/UI class、acceptance group 和 contract digest），并以 `semanticGraphDigest` 封存；`issue-orchestration.runtime-projection.v1` 只承载 immutable runtime ledger 与 runtime facts 的确定性 replay 结果，并以 `runtimeProjectionDigest` 封存。两者必须分别通过 validator，写入 state root 的 `semantic-graph.json` 与 `runtime-projection.json`；不得把运行态字段写回 semantic graph，也不得把 `graphPatch`、`semanticGraph` 或其它语义 payload 嵌入 runtime projection。旧的合并对象或 compatibility fallback 一律拒绝。

三层 digest 的 ownership 不可互换：

- `scopeDigest` 覆盖 selector 及远端 snapshot 的 scope facts（issue identity、state、labels、comments、title/body、milestone 等）；
- `semanticGraphInputDigest` 只覆盖 snapshot 中用于生成 semantic graph 的 `semanticFacts`；
- `runtimeProjectionDigest` 覆盖 projector replay 的 completed、ready/blocked、critical path、conflict、lease/slot、epoch、candidate/delivery commit 和 cleanup 结果。

三者在 canonical JSON 后计算，数组返回顺序不改变 digest，且不得互相 alias。projector 版本和 digest（`issue-orchestration.runtime-projector.v1`）必须绑定 projection；projector 只能读取 semantic graph，不能解释、修改或新增 semantic edge/class。

### Remote mutation reconciliation 与 DAG mode

每轮 remote refresh 先按 `issue-orchestration.expected-remote-mutations.v1` 封存 expected registry 和 `expectedRemoteMutationDigest`，再将观测到的 completion comment、state/reason transition、delivery label change 等逐项 reconcile。expected delivery window（包括 acceptance-group window）若匹配，semantic graph digest 保持稳定，决策为 `projection-only`，`dagUpdaterDispatchCount` 必须为 0。slot、lease、epoch、ready/frontier、candidate、delivery、cleanup、telemetry，以及本地 failure/rework/verifier/agent event 同样只能更新 runtime projection，不得请求 semantic DAG work。

只有 `semanticGraphInputDigest` 发生未预期变化（dependency、owner、conflict、contract 或 acceptance-group 等 semantic fact）时，决策才是 `semantic-patch`，并且必须授权恰好一次 fresh、read-only DAG updater。普通 semantic update 只能返回 `issue-orchestration.semantic-graph-patch.v1`：patch 绑定 base `semanticGraphDigest`、允许的最小 operation、直接 evidence digests、可重算的 result digest，且不得嵌入 full graph；root 只能原样接受已封存 patch，不能自行 author/edit，应用必须经过 root-acceptance gate。`full-create` 仅用于 initial create；`full-recovery` 仅用于带 machine evidence 的 `graph-corruption-recovery` 或显式 `scope-replacement`。其它 full proposal、base drift、非法 operation、结果 digest 不匹配或 root-authored patch 必须 fail closed。

每个判断必须签发 `issue-orchestration.dag-update-decision-receipt.v1`，同时绑定 scope、semantic input、semantic graph、runtime projection 的 before/after digests、expected-mutation reconciliation、patch/full identity、updater dispatch identity 和 projector identity，并按 mode 强制 nullability。`#1826` telemetry 只能由已验证 receipt 派生；`falsePositiveDagDispatchCount` 必须恒为 `0`，不能由手写计数器或本地 stage event 推断。

## Ready frontier 与 stage eligibility

Frontier 的计算粒度是 `member issue + stage`，不是根代理手写的 `status=ready`。编译器接收同一份 DAG、selector receipt 和 frontier runtime，输出 `issue-orchestration.frontier-projection.v1`：

```text
eligibilityInputDigest
frontierDigest
readyFrontier[]
notReadyReasons{}
executionProjection[]
computedAt
```

`readyFrontier` 是当前 scope 内所有没有 compiler reason 的 member-stage 对的最大集合。DAG 的节点顺序、issue 返回顺序、文件遍历顺序、root narration 和手写 status 都不参与 eligibility；节点必须与 selector receipt 的 `resolvedIssueSet` 精确相等。因而遗漏一个 eligible member、把 blocked member 加入 ready，或只改写 digest，都会使独立重算失败。

每个 issue 只有一个确定的下一 stage。frontier 的语义 stage 映射到事件账本中的严格链：非 UI 节点按 `test-contracting → test-contract-frozen → implementing-self-testing → candidate-green → independent-verifying → behavior-green → documenting → documentation-green → delivery-ready → delivering → cleaning` 推进，UI/UX 节点在 `behavior-green` 后必须先经过 `ux-acceptance → ux-accepted`，再进入 `documenting`。对应 stage receipt 未通过时，后续 stage 不得进入 frontier；所有 receipt 通过后，该 issue 不再产生 ready 或 not-ready projection。`review`、通用 `verifying`、`deliverable` 和 `delivered` 不是当前 stage 或兼容入口。

编译器至少检查 active dependency/tombstone、上述 layered investigation projection 的完整度与 freshness、owner repository、base SHA、selector/remote fact identity、同 stage active attempt、未变化 terminal、候选能力与权限、delivery freeze、exclusive lease 和 remote facts freshness。候选的 role、model、effort、mode、允许路径、UI 所需 design Skill/authority digest 也属于 eligibility input；local stage progress 只重新计算 execution frontier，不触发 semantic DAG update。

所有非 ready active member 必须由编译器产生稳定、排序固定的 reason。reason 只能使用以下枚举，并绑定直接 evidence identity 或 digest：

| 顺序 | `notReadyReason` |
| ---: | --- |
| 1 | `dependency-unsatisfied` |
| 2 | `investigation-incomplete` |
| 3 | `owner-unresolved` |
| 4 | `base-drift` |
| 5 | `scope-drift` |
| 6 | `active-attempt` |
| 7 | `terminal-unchanged` |
| 8 | `runtime-capability-missing` |
| 9 | `delivery-frozen` |
| 10 | `exclusive-lease-held` |
| 11 | `remote-facts-stale` |

自由文本 reason、没有 evidence 的 reason、数组重排导致的 digest 漂移以及 stale selector/comment、base、scope、terminal 或 candidate permission 下继续复用旧 projection 均 fail closed。`notReadyReasons` 为空只有在所有 active member 已完成 stage chain 时合法；空 frontier 但仍有无 blocker 的 member 不合法。

## Dispatch candidate 与 fail-closed 边界

Root scheduler 只消费 compiler projection 和 selector/batch 输出，不得编辑 ready、reason、rank 或当前 stage。DAG gate 把 `frontierProjection`、`frontierRuntime`、`selectorReceipt`、`dispatchFrontier`、`dispatchRankingPolicy` 和 `dispatchBatch` 作为一个不可拆分单元；缺少一个或全部缺失都 fail closed。dispatch frontier 必须与已验证 ready frontier 的 issue/stage 集合精确相等，并把每个 DAG node 的 priority、critical-path、downstream unlock、starvation、acceptance group、conflict/resource evidence、role/worktree/write scope、receipt/Skill、candidate 和 epoch facts 原样绑定。

版本化 `critical-unlock-conflict.v1` policy 先严格按 `P0 → P1 → P2`，同一 priority 内再按 starvation threshold、downstream blocked count、critical-path length、acceptance-group completion value、starvation age 和稳定 `taskId` 排序。高 acceptance completion 不能越过更高 priority；长期等待只能在同 priority 内前移，不能越过 semantic dependency 或 stage receipt prerequisite。input 顺序和 issue number 不具有调度权威。

selector 按该确定顺序逐项加入不超过 `availableSlots` 的安全任务，得到 deterministic maximal safe batch。20 个互不冲突任务与 15 个槽必须选择 15 个；只有 N 个安全任务时精确选择 N 个。共享显式 write conflict key、同一 issue worktree 的两个 writer、共享 exclusive resource key 或命中 active lease 的任务不能共选；长任务只占自己的 slot 和显式 resource keys，不冻结无关 ready work。conflict key 必须来自 investigated owner/write-surface evidence，不能只按路径前缀猜测，也不能伪造成 semantic dependency。root-only delivery 同样只阻塞其 repository 或显式 keys。

输出 `issue-orchestration.dispatch-batch.v1` 必须完整列出 `selected`、`deferred`、机器 `selectionReasons`、结构化 `deferReasons`、全部 rank components 和 `batchDigest`。ready work 被空 batch 隐藏、遗漏仍可安全填槽的任务、超出 slot、派发非法 stage、绕过 conflict/resource lease、root 重排或改写 reason/digest，均由独立重算拒绝。acceptance group 只有在 shared surface、same epoch、atomic independent commits、有限且有界的 cold-start/lost-parallelism evidence 和 canonical member order 全部成立时可用；group session 没有 active member 时不占 slot，也不能降低 work conservation 或替代 member receipt。

依赖未满足、scope/remote facts 漂移、base 不一致、候选能力缺失、未变化 terminal、freeze 或 exclusive lease 只能减少可选安全集合，不能通过手写 ready 绕过。completed prerequisite 只在合法 `CLOSED/completed` tombstone、可达 delivered commit 和 evidence digest 都一致时满足依赖；reopen 或 tombstone 漂移会在下一次编译中移除 dependent。

DAG gate 必须使用当前 runtime 和 selector receipt 独立重算 frontier 与 dispatch batch，并比较 `eligibilityInputDigest`、`frontierDigest`、ready frontier、execution projection、ranking explanations 和 `batchDigest`；任何缺失、篡改或 scope 不完整都保持 `dispatchEnabled=false`，直到生成新的绑定 projection/batch。该合同不改变产品 API、数据库、发布或前端运行时。

## Dispatch receipt 与 runtime identity

每次阶段派发都必须先生成不可变的 `issue-orchestration.dispatch-request.v1`。request 至少绑定 `runId`、`nodeId`、`attemptId`、`stageRole`、prompt/DAG/frontier/issue snapshot digest、repository/base/candidate identity、`testContractDigest`、`epochId`、allowed/forbidden path digest、requested model/effort/sandbox/fork/cwd、required Skill 与 design-authority digest、group/member/lease identity（非分组路径也必须显式写 `groupId=null`）以及 `requestDigest`。request、完整 prompt、token、credential 和 secret environment 不进入 receipt；request/receipt 只写仓库外状态根。

`issue-orchestration.runtime-observation.v1` 必须从真实 child rollout 和机器 observation 读取，而不是复制 request 字段。它至少记录 `threadId`、`rolloutId`、`startedAt`、effective model/effort/role/sandbox/fork/cwd、runtime metadata digest、dispatch/git/Skill/lease observation 及其来源。`skill-loader`、git identity 和 lease observation 必须来自受信机器来源并自洽哈希；agent 自述不是 authority。缺少这些字段时只能返回 `capability-unverified`，任何 mismatch、漂移、重放、secret material、错误 worktree 或不符合角色的 sandbox 都返回 `rejected`，不得进入 active attempt。

唯一 routing authority 是 versioned `issue-orchestration.stage-model-pool-policy.v2`（`stage-model-pool.v2`）manifest；dispatch receipt、batch selector 和 continuity validation 必须消费同一份机器重算的 classification、route 和 capability digest。Root scheduler 固定为 `luna-low`，不参与模型判断；DAG semantic proposal 使用 `terra-max`，只有 authority/topology conflict 使用 `sol-xhigh`，合法 frontier exception 才能使用 `sol-max`；两阶段 `test-owner` 按 focused/cross-module → runtime/lifecycle risk → protocol/security/authority conflict 选择 `sol-high`、`terra-max` 或 `sol-xhigh`。Code implementer 按 bounded/complex/high-risk/frontier 选择 `luna-max`、`sol-high`、`terra-max` 或 `sol-xhigh`；UI implementer 仅允许 `sol-low`/`sol-medium`，UX path 分别使用 `sol-medium`、`sol-high`、`sol-xhigh`；documentation writer 仅允许 `luna-high`/`luna-max`。每次 assignment 必须绑定 policy version、stage role/phase、allowed/default/selected profile、routing input、capability digest、member receipt、sandbox/write scope 和 required Skill digests。

Documentation 仅在 behavior-green，且 UI work 已 ux-accepted 后启动；普通同步使用 `luna-high`，跨文档 authority 迁移可使用 `luna-max`，不得按余额、失败次数、reworkCount、telemetry 或人工偏好切换。FsusBlog UI/UX stage 必须从机器 load evidence 取得 `fsusblog-design-conformance` 与 `fsusui-design-conformance` 的 exact digest。`uiDecisionClass=system-design-dispute` 时必须先由 fresh read-only `ui-system-adjudicator` 使用 `sol-high`/`sol-xhigh` 输出 machine-readable owner、边界、design authority 和允许的 low/medium implementation class；裁决者没有实现权。behavior verification、UX acceptance 和 adjudication 都必须 fresh、read-only 且不继承 implementer 对话。group continuity 必须重新按 member 分类和 routing，不能继承上一 member 的 profile、权限或 verifier context。

旧 `issue-implementer`、`issue-reviewer`、`cleanup-verifier` role/agent alias，以及 node-local `model`/`effort`、`implementationProfile`、`reviewProfile` 均无 authority 或 fallback。Code/UI implementer 不能签 behavior/UX receipt；behavior verification 仍由冻结合同的独立 `test-owner` 执行。Cleanup 不进入 LLM model pool：确定性 resource registry、inventory 和 machine resource verifier 才能签发 `resources-clean`，异常诊断可读但不能替代机器绿色 authority。

dispatch receipt `issue-orchestration.dispatch-receipt.v1` 只有在 request digest、runtime metadata digest、thread/rollout identity、prompt/DAG/frontier/base/candidate/epoch、effective model/effort/role/sandbox/fork/cwd、Skills 和 group/member/lease 全部一致时才是 `verified`。`implementation.started` 和 ledger transition 必须引用 verified dispatch receipt；普通冻结合同也不能依赖某个 issue-specific test path 才启用此门禁。

## Append-only event ledger 与 projection

Issue execution history 的唯一事实源是仓库外状态根中的追加式事件账本；`dag.json` 只保存由账本重放得到的 projection，不再是可独立编辑的状态事实。账本不进入 FsusBlog、FsusUI、共同工作区或任一 worktree。

### Versioned schemas 与 hash chain

账本首行使用 `issue-orchestration.ledger.v1`，至少绑定 `runId`、规范化 `stateRootCanonical`、`baseSha`、`issueSnapshotFingerprint`、`repositoryFingerprint` 和 `createdAt`；其后每行是 `issue-orchestration.event.v1`。事件必须带有以下机器字段：

```text
eventId / sequence / runId / nodeId / eventType / fromState / toState
attemptId / actorRole / sourceDagDigest / issueSnapshotFingerprint
repositoryFingerprint / baseSha / payloadDigest / evidenceRefs[]
createdAt / previousEventDigest / eventDigest
```

`sequence` 从 1 连续递增，第一事件的 `previousEventDigest` 是 64 个零组成的 genesis digest；之后必须严格等于上一事件的 `eventDigest`。对象在计算 SHA-256 前按 key 递归 canonicalize，`payloadDigest` 覆盖 payload，`eventDigest` 覆盖去掉自身 digest 后的完整事件。缺字段、重复 `eventId`、run/node/base 身份漂移、序列缺口、重排、删除、payload 或 hash-chain 篡改均 fail closed。

历史事件不可编辑或覆盖。纠错必须追加 `ledger.correction-recorded`，并引用既有 `targetEventId` 与其原始 `targetEventDigest`；目标缺失或 digest 不匹配时拒绝。自然语言说明不能替代状态、身份、sequence 或 evidence 字段。

### Deterministic projection 与 recovery

`issue-orchestration.projection.v1` 从空 projection 和有序 ledger replay 确定性生成，至少包含每个 node 的 `status`、`activeAttemptId`、`reworkCount`、`terminal`、`evidenceRefs`、`timestamps`，以及 `lastSequence`、`lastEventDigest` 和 `projectionDigest`。相同 ledger 必须得到相同 projection digest；DAG gate 比较 `runId`、`projectionDigest` 及上述 node 字段，手工修改 `dag.json` 而不追加合法事件一律拒绝。

恢复只信任已提交的 ledger：

| 现场 | 恢复动作 | 派发边界 |
| --- | --- | --- |
| event 已提交、projection 缺失或落后 | 从 ledger forward replay 并原子写回 projection | replay 成功前不得派发 |
| projection 超前 ledger | 丢弃 projection，按 ledger 重建 | 不执行 projection 中未提交动作 |
| projection digest 已相同 | 保持 `projection-already-current` | 不重复 attempt、delivery、commit 或 cleanup side effect |
| JSONL tail 截断或损坏 | 报告最后有效 sequence，返回 `ledger-tail-corrupt` | `dispatchEnabled=false`，不得跳过坏事件 |

event append 与 projection 写回使用外部状态根内的受控写入和 fsync/atomic rename；delivery、commit、cleanup 的 side-effect key 重复时拒绝，而不是再次执行。

### Stage events、same-attempt loop 与 receipts

唯一正常事件链为：

```text
discovered
  → test-contracting → test-contract-frozen
  → implementing-self-testing → candidate-green
  → independent-verifying → behavior-green
  → documenting → documentation-green
  → delivery-ready → delivering → cleaning → closed
```

UI/UX issue 在 `behavior-green` 与 `documenting` 之间必须追加：

```text
behavior-green → ux-acceptance → ux-accepted
```

事件类型由唯一 machine transition table 约束。当前 authority 使用 `test-contract.*`、`implementation.*`、`independent-verification.*`、`ux-acceptance.*`、`documentation.*`、`delivery.*`、`cleanup.*`、`issue.closed/reopened` 及 terminal/attempt/correction 事件；旧 `review.*`、通用 `verification.*`、direct `node.status-updated` 不得作为兼容权威。

`implementation.started` 建立一个 active attempt 和实现 owner，但必须同时绑定 `issue-orchestration.dispatch-receipt.v1` 且 `verificationStatus=verified`。实现者可以在 `implementing-self-testing` 内反复修改实现、运行冻结合同允许的可见矩阵并记录 attempt-local red/green cycles；这些内部循环不创建新的全局 attempt、不递增 `reworkCount`，也不触发 semantic DAG update。

`implementation.candidate-green` 必须绑定同一 active attempt、request/base/candidate/epoch/test-contract identity 和 `issue-orchestration.implementer-self-test-receipt.v1`。self-test receipt 必须由 deterministic verifier 根据完整 visible test matrix、每个命令的 exit/result digest、lint/typecheck/build policy、非空 failure history/fix cycles、`firstFailureRefs`、implementation diff digest、working-tree digest 和 before/after 相同的 frozen test-tree digest 生成；所有命令通过、`remainingFailures` 为空、冻结 tests/fixtures/snapshots/thresholds 未改动时才可为 `verified`。旧 `issue-orchestration.verified-candidate-receipt.v1`、focused subset、skipped 命令、snapshot/断言放宽或 root/implementer 自述均不能满足 candidate-green。

`candidate-green` 不能直接成为 `behavior-green`。必须先由独立 `test-owner` 启动 `independent-verification`，重新运行关键检查并签发 fresh receipt，且 receipt 与事件都绑定同一 candidate SHA；实现者本人、root narration 或旧 verifier 不能宣告 pass。独立 verifier 拒绝时，`independent-verification.rejected` 必须绑定原 active attempt 或明确的 continuation attempt，只递增一次全局 `reworkCount`，并保留最早 `firstFailure` evidence；后续自测、文档或 cleanup 成功不得覆盖它。

文档 writer 只能在非 UI issue 的 `behavior-green` 或 UI issue 的 `ux-accepted` 后启动；delivery 只能在 `documentation-green` 后启动，关闭还要求 delivery 与 machine cleanup 都已完成。`issue.reopened` 会清除 delivery authority/completion，并标记 semantic DAG/frontier 重新计算。

### Authority 与 fail-closed 边界

- root scheduler（`root-scheduler`）是唯一可调用 ledger append 的 writer；所有 implementer、test owner、UX verifier、UI system adjudicator、documentation writer、machine resource verifier、independent verifier、subagent 都只能返回 receipt/evidence，尝试写 ledger 必须返回 `ledger-writer-role`。
- DAG creator/updater 只产生 proposal；只有 root 在 remote live snapshot digest 确实变化、proposal 身份匹配且 actor 为 `dag-updater` 时，才能追加 `dag.proposal-accepted`。本地 stage/rework event 不触发 semantic DAG update。
- `stateRoot` 必须与两个产品仓库、共同工作区和所有 worktree 完全分离；保护根重叠、路径逃逸、祖先 symlink 或 ledger/projection 位于受保护目录时拒绝。ledger path 不能通过 symlink 绕过该边界。
- terminal 进入必须有合法 category（`externally_blocked`、`resource_failed` 或 `contract_disputed`）和 direct evidence；recovery fingerprint 未变化时不得恢复或重派。cleanup failure 不能释放 lease/slot，也不能覆盖 first failure。
- group session 与每个 member 独立 replay；group green 不能替代 member 的 contract、independent verification、commit 或 delivery。非法成员顺序、重复 active member、一个 lease 绑定多个 member 均 fail closed。

这些拒绝是合同失败，不应通过重试未变化的 ledger、projection、candidate SHA、remote snapshot 或权限请求绕过。

## Resource registry、retention 与 cleanup

每个运行使用 `issue-orchestration.resource-registry.v1` 登记唯一 resource identity、owner class、run/attempt/member、worktree、slot、writer/read lease、service descendants、ports 和 state。Implementer 内部 red/green cycle 保留同一 attempt、issue worktree、slot 和 writer；普通测试失败只追加 self-test cycle 与不可覆盖的 first-failure evidence，不创建全局 attempt、重建 worktree 或启动 cleanup。

`candidate-green` 原子撤销 implementer writer，并只为同一 candidate 授予 independent verifier read-only lease。verification rejection 撤销 reader，并在同一 worktree/attempt 上恢复唯一 writer；双 writer、新 worktree 或丢失 retained service descendant/port owner 都 fail closed。

Cleanup 只在合法 disposition 后启动。`issue-orchestration.resource-cleanup-receipt.v1` 必须由 machine resource verifier 签发，状态为 `resources-clean`，包含空的 machine-observed `postInventory` 和自洽 digest；agent 自述、缺 inventory 或仍有 owned resource 都不能释放 slot/lease 或授权 delivery。Cleanup 执行与 quiescence 不使用 LLM profile；Luna/low 或 Terra/max 只能解释异常，不能签发绿色 receipt。dirty worktree 进入 `quarantined-dirty`，保持 slot、阻止 delivery 且不得 force remove。

Member cleanup 只删除 member-owned resources；group-owned worktree/service 必须保持 `retained`，直到所有 member cleanup 后的 group cleanup。Crash recovery 对比 baseline/observed registry：unknown/orphan owner 使恢复失败，externally-owned resource 必须保留且不得删除；外部资源缺失同样是 cleanup failure。

## DAG update authority

初始 DAG 只能由使用 `luna-low` 的 root scheduler 显式启动一次 `stage-model-pool.v2` semantic-proposal route 的 `dag-creator`。后续 root scheduler 先对 live remote snapshot 重算本节的三层 digest 和 expected-mutation registry；只有 `semanticGraphInputDigest` 出现未预期变化时，才显式启动同样 fresh-context、read-only、非 resident 的 `dag-updater`，且其唯一允许的普通 proposal 是一次最小 `semantic-patch`。scope、runtime projection、expected delivery mutation 或本地 execution ledger 变化都保持 `projection-only`，不得启动 updater；三层 digest 均未变化时 semantic action 为 `none`。route 默认使用 `terra-max`，仅在冻结分类证据允许时使用 `sol-xhigh`，Sol/max 只保留给合法 frontier exception。即使 execution ledger 有失败或返工事件也不得更新 semantic DAG。

启动请求必须声明 `explicit=true`，requester role 为 `root-scheduler`；任何非 root requester、错误 model/effort、可写 sandbox、继承 context、resident agent 或错误 agent role 都以稳定 denial 返回。更新 agent 生成的 proposal 必须由 root scheduler 原样接受，且 proposal、selector receipt、remote snapshot 和 resolved issue set 的 digest/内容逐项相等；root 不得在接受时改写 issue set 或 selector。

Subagent 的本地发现只作为 `possible-remote-contract-impact` execution-ledger event 返回并附直接 evidence。要纳入 scope，root 必须先让事实成为远端 issue 或现有 issue 的正文/评论变化；下一轮真实 remote snapshot 变化后才可更新 DAG。无关优化建议不创建 issue，也不扩大 scope。

## Grouped delivery window

Acceptance-group delivery 在窗口开始前记录 `preWindowRemoteSnapshotDigest`。一次 push 和窗口内逐 issue side effect 完成后，只做一次 live remote refresh，形成 `postWindowReceipt`；refresh 必须标记为 `post-window`、`live-remote` 且确实发生在 side effect 之后。禁止按 member 刷新、用本地推算替代真实刷新，或因已知 side effect 跳过窗口末刷新。

窗口中断时，恢复记录已完成的远端 side effect，并在恢复后重新取得 live snapshot；不得继续使用 pre-window scope。窗口最多产生一次 DAG updater launch，且仅当窗口末 digest 与 pre-window digest 不同。

## Stable denial codes and checks

调用方应保留以下错误码，便于故障定位：`invalid-selector-schema`、`selector-version-parameters-mismatch`、`dag-launch-required`、`dag-launch-denied`、`proposal-mismatch` 和 `delivery-window-invalid`。这些拒绝表示合同不满足，不应通过重试未变化的 selector、snapshot 或 launch request 绕过。

Selector 行为合同位于 `tests/tools/issue-orchestration-scope-selector.test.mjs`，fixture 位于 `tests/fixtures/issue-orchestration/scope-selector-cases.json`，实现入口为 `.agents/skills/issue-orchestration/scripts/scope-selector.mjs`；frontier 行为合同位于 `tests/tools/issue-orchestration-ready-frontier.test.mjs`，实现入口为 `.agents/skills/issue-orchestration/scripts/frontier-compiler.mjs`；stage model pool 行为合同位于 `tests/tools/issue-orchestration-stage-profiles.test.mjs`，其 v2 acceptance/mutation/runtime fixtures 位于 `tests/fixtures/issue-orchestration/stage-profile-*.json`，实现入口为 `.agents/skills/issue-orchestration/scripts/stage-profile-policy.mjs`；event ledger 行为合同位于 `tests/tools/issue-orchestration-event-ledger.test.mjs`，其 acceptance/mutation/runtime fixtures 位于 `tests/fixtures/issue-orchestration/event-ledger-*.json`，实现入口为 `.agents/skills/issue-orchestration/scripts/event-ledger.mjs`；dispatch/runtime/self-test 行为合同位于 `tests/tools/issue-orchestration-dispatch-receipt.test.mjs`，fixture 位于 `tests/fixtures/issue-orchestration/dispatch-receipt-*.json`，实现入口为 `.agents/skills/issue-orchestration/scripts/dispatch-receipt.mjs`；semantic graph/runtime projection 行为合同位于 `tests/tools/issue-orchestration-semantic-runtime-projection.test.mjs`，fixture 位于 `tests/fixtures/issue-orchestration/semantic-runtime-projection-*.json`，实现入口为 `.agents/skills/issue-orchestration/scripts/semantic-runtime-projection.mjs`。修改 selector、snapshot、frontier、stage model pool、ledger、dispatch receipt 或 semantic/runtime projection 合同时运行：

```bash
node --test tests/tools/issue-orchestration-scope-selector.test.mjs
node --test tests/tools/issue-orchestration-ready-frontier.test.mjs
node --test tests/tools/issue-orchestration-stage-profiles.test.mjs
node --test tests/tools/issue-orchestration-dispatch-receipt.test.mjs
node --test tests/tools/issue-orchestration-event-ledger.test.mjs
node --check .agents/skills/issue-orchestration/scripts/dispatch-receipt.mjs
node --test tests/tools/issue-orchestration-semantic-runtime-projection.test.mjs
node tools/docs/generate-document-lifecycle.mjs --check
node tools/docs/check-authoritative-development-docs.mjs
```

本合同不自动创建远端 issue，也不改变产品代码、API、数据库、发布或前端运行时。
