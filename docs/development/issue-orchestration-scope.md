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

## DAG update authority

初始 DAG 只能由使用 `gpt-5.6-sol` / `low` 的 root scheduler 显式启动一次 `gpt-5.6-sol` / `max`、read-only、fresh-context、非 resident 的 one-shot `dag-creator`。后续只有 root scheduler 发现 `remoteSnapshotDigest` 相对上一轮变化，才显式启动同样隔离属性的 one-shot `dag-updater`。没有 digest 变化时 semantic action 为 `none`，即使 execution ledger 有失败或返工事件也不得更新 DAG。

启动请求必须声明 `explicit=true`，requester role 为 `root-scheduler`；任何非 root requester、错误 model/effort、可写 sandbox、继承 context、resident agent 或错误 agent role 都以稳定 denial 返回。更新 agent 生成的 proposal 必须由 root scheduler 原样接受，且 proposal、selector receipt、remote snapshot 和 resolved issue set 的 digest/内容逐项相等；root 不得在接受时改写 issue set 或 selector。

Subagent 的本地发现只作为 `possible-remote-contract-impact` execution-ledger event 返回并附直接 evidence。要纳入 scope，root 必须先让事实成为远端 issue 或现有 issue 的正文/评论变化；下一轮真实 remote snapshot 变化后才可更新 DAG。无关优化建议不创建 issue，也不扩大 scope。

## Grouped delivery window

Acceptance-group delivery 在窗口开始前记录 `preWindowRemoteSnapshotDigest`。一次 push 和窗口内逐 issue side effect 完成后，只做一次 live remote refresh，形成 `postWindowReceipt`；refresh 必须标记为 `post-window`、`live-remote` 且确实发生在 side effect 之后。禁止按 member 刷新、用本地推算替代真实刷新，或因已知 side effect 跳过窗口末刷新。

窗口中断时，恢复记录已完成的远端 side effect，并在恢复后重新取得 live snapshot；不得继续使用 pre-window scope。窗口最多产生一次 DAG updater launch，且仅当窗口末 digest 与 pre-window digest 不同。

## Stable denial codes and checks

调用方应保留以下错误码，便于故障定位：`invalid-selector-schema`、`selector-version-parameters-mismatch`、`dag-launch-required`、`dag-launch-denied`、`proposal-mismatch` 和 `delivery-window-invalid`。这些拒绝表示合同不满足，不应通过重试未变化的 selector、snapshot 或 launch request 绕过。

行为合同和负向测试位于 `tests/tools/issue-orchestration-scope-selector.test.mjs`，fixture 位于 `tests/fixtures/issue-orchestration/scope-selector-cases.json`，实现入口为 `.agents/skills/issue-orchestration/scripts/scope-selector.mjs`。修改 selector 或 snapshot 合同时运行：

```bash
node --test tests/tools/issue-orchestration-scope-selector.test.mjs
node tools/docs/generate-document-lifecycle.mjs --check
node tools/docs/check-authoritative-development-docs.mjs
```

本合同不实现 DAG dependency/frontier/batch，不自动创建远端 issue，也不改变产品代码。
