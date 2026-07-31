# Issue orchestration scope and remote snapshot

本文件是多 issue 调度中 scope selector、远端 live snapshot 和 DAG 更新触发条件的 current authority。它只约束调度运行态，不改变 FsusBlog 产品 API、数据库、发布或前端运行时。

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

每个 issue 只有一个确定的下一 stage。非 UI 节点按 `test-contract-ready → implementation-ready → behavior-verification-ready → documentation-ready → delivery-ready → cleanup-ready` 推进；UI/UX 节点在 behavior green 后必须先经过 `ux-acceptance-ready`，再进入 documentation。对应 stage receipt 未通过时，后续 stage 不得进入 frontier；所有 receipt 通过后，该 issue 不再产生 ready 或 not-ready projection。

编译器至少检查 active dependency/tombstone、investigation 完整度、owner repository、base SHA、selector/remote fact identity、同 stage active attempt、未变化 terminal、候选能力与权限、delivery freeze、exclusive lease 和 remote facts freshness。候选的 role、model、effort、mode、允许路径、UI 所需 design Skill/authority digest 也属于 eligibility input；local stage progress 只重新计算 execution frontier，不触发 semantic DAG update。

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

Root scheduler 只消费 compiler projection 和 selector/batch 输出，不得编辑 ready、reason 或当前 stage。没有 root-only delivery action 时，`selectDispatchCandidates` 按 canonical `readyFrontier` 顺序截取 `availableSlots`，输出必须是非空且最大化的 dispatch candidate set：有 15 个可用独立 eligible member 就必须有 15 个候选，只有 N 个 eligible member 就精确为 N 个。ready work 被空 batch 隐藏、派发非当前 stage、为 group overlay 折叠 member、或用 group green 掩盖单个 member blocker，均由 dispatch validator 拒绝。

唯一允许 ready frontier 非空而暂不派发的情形，是已登记且有直接 evidence 的 root-only delivery action；输出必须保留机器 `noDispatchReason`。依赖未满足、scope/remote facts 漂移、base 不一致、候选能力缺失、未变化 terminal、freeze 或 exclusive lease 只能减少 frontier，不能通过手写 ready 绕过。completed prerequisite 只在合法 `CLOSED/completed` tombstone、可达 delivered commit 和 evidence digest 都一致时满足依赖；reopen 或 tombstone 漂移会在下一次编译中移除 dependent。

DAG gate 必须使用当前 runtime 和 selector receipt 独立重算 projection，并比较 `eligibilityInputDigest`、`frontierDigest`、ready frontier、reason 和 execution projection；任何缺失、篡改或 scope 不完整都保持 `dispatchEnabled=false`，直到生成新的绑定 projection。该 frontier 合同不改变产品 API、数据库、发布或前端运行时。

## DAG update authority

初始 DAG 只能由使用 `gpt-5.6-sol` / `low` 的 root scheduler 显式启动一次 `gpt-5.6-sol` / `max`、read-only、fresh-context、非 resident 的 one-shot `dag-creator`。后续只有 root scheduler 发现 `remoteSnapshotDigest` 相对上一轮变化，才显式启动同样隔离属性的 one-shot `dag-updater`。没有 digest 变化时 semantic action 为 `none`，即使 execution ledger 有失败或返工事件也不得更新 DAG。

启动请求必须声明 `explicit=true`，requester role 为 `root-scheduler`；任何非 root requester、错误 model/effort、可写 sandbox、继承 context、resident agent 或错误 agent role 都以稳定 denial 返回。更新 agent 生成的 proposal 必须由 root scheduler 原样接受，且 proposal、selector receipt、remote snapshot 和 resolved issue set 的 digest/内容逐项相等；root 不得在接受时改写 issue set 或 selector。

Subagent 的本地发现只作为 `possible-remote-contract-impact` execution-ledger event 返回并附直接 evidence。要纳入 scope，root 必须先让事实成为远端 issue 或现有 issue 的正文/评论变化；下一轮真实 remote snapshot 变化后才可更新 DAG。无关优化建议不创建 issue，也不扩大 scope。

## Grouped delivery window

Acceptance-group delivery 在窗口开始前记录 `preWindowRemoteSnapshotDigest`。一次 push 和窗口内逐 issue side effect 完成后，只做一次 live remote refresh，形成 `postWindowReceipt`；refresh 必须标记为 `post-window`、`live-remote` 且确实发生在 side effect 之后。禁止按 member 刷新、用本地推算替代真实刷新，或因已知 side effect 跳过窗口末刷新。

窗口中断时，恢复记录已完成的远端 side effect，并在恢复后重新取得 live snapshot；不得继续使用 pre-window scope。窗口最多产生一次 DAG updater launch，且仅当窗口末 digest 与 pre-window digest 不同。

## Stable denial codes and checks

调用方应保留以下错误码，便于故障定位：`invalid-selector-schema`、`selector-version-parameters-mismatch`、`dag-launch-required`、`dag-launch-denied`、`proposal-mismatch` 和 `delivery-window-invalid`。这些拒绝表示合同不满足，不应通过重试未变化的 selector、snapshot 或 launch request 绕过。

Selector 行为合同位于 `tests/tools/issue-orchestration-scope-selector.test.mjs`，fixture 位于 `tests/fixtures/issue-orchestration/scope-selector-cases.json`，实现入口为 `.agents/skills/issue-orchestration/scripts/scope-selector.mjs`；frontier 行为合同位于 `tests/tools/issue-orchestration-ready-frontier.test.mjs`，实现入口为 `.agents/skills/issue-orchestration/scripts/frontier-compiler.mjs`。修改 selector、snapshot 或 frontier 合同时运行：

```bash
node --test tests/tools/issue-orchestration-scope-selector.test.mjs
node --test tests/tools/issue-orchestration-ready-frontier.test.mjs
node tools/docs/generate-document-lifecycle.mjs --check
node tools/docs/check-authoritative-development-docs.mjs
```

本合同不自动创建远端 issue，也不改变产品代码、API、数据库、发布或前端运行时。
