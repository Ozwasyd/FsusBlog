# DAG 与调度

本文件是仓库外状态根、DAG 启动门禁、issue 图、槽位、难度选型、terminal 与全局完成条件的唯一详细来源。

## 唯一状态根

所有 DAG、执行 ledger、槽位、锁、issue 状态、恢复指纹和临时 evidence 只能位于同一个本机状态根。其规范化真实路径必须与以下保护根完全分离，既不能位于其中，也不能成为其父目录：

- FsusBlog 仓库；
- FsusUI 仓库；
- 两仓共同工作区及本次启动工作区；
- `git worktree list --porcelain` 从两仓发现的每个 worktree。

优先从操作系统用户状态目录或系统临时目录选择本轮独立子目录。禁止使用任一仓库或共同工作区内的 `.tmp`、cache、ignored 子目录；不得新增 ignored fallback、读取旧仓库内状态作为权威，或把本地状态路径写成产品事实。

在创建候选目录或写入任何状态前，运行：

```bash
node .agents/skills/issue-orchestration/scripts/validate-state-root.mjs \
  --candidate <state-root> \
  --repository <FsusBlog-root> \
  --repository <FsusUI-root> \
  --workspace <common-or-launch-workspace>
```

守卫会按输入遍历顺序解析相对路径和 `..`，拒绝 symlink 组件，以最近存在祖先推导不存在尾部的规范路径，并同时核验 Linux mount coordinate、device/inode identity 和实际 Git worktree。对无法证明 backing path 的 FUSE/overlay alias mount 直接拒绝。它不以字符串前缀作为充分证据；无法读取 mount 或 worktree 身份时 fail closed。第一次校验通过后，只能使用输出的 `candidate.canonical` 以 `0700` 权限创建状态根；创建后必须用同一参数复验，复验通过前不得写 DAG。

根代理是完整状态的唯一写入者。implementer 和 reviewer 只接收当前闭环任务、局部 diff 与所需 evidence 投影，不得读取或修改完整 DAG、ledger、锁、槽位或状态根。

## 启动 DAG 门禁

读取适用指令链并确认两仓路径、远端、默认分支、HEAD 和 dirty state 后，按以下状态机启动：

```text
instructions_loaded
  -> repository_facts_verified
  -> state_root_validated
  -> dag_loaded | dag_missing
  -> remote_reconciled
  -> consistency_passed
  -> dispatch_enabled
```

`dispatch_enabled` 之前禁止修改产品代码、创建 worktree 或派发 subagent。顺序如下：

1. 在状态根查找当前仓库组合和 issue 范围对应的 DAG；不存在、不可读或损坏时标记需要重建，不得继续派发。
2. 重新读取本次范围全部远端 open issues 和会改变范围或验收的评论，生成当前启动时间之后的 issue snapshot。
3. 读取相邻代码、直接测试、适用 current 文档和依赖事实，核对责任仓、依赖、执行顺序、验收组和 terminal 恢复条件。
4. 校验 DAG schema、状态根、仓库路径和远端、默认分支、base/HEAD、dirty fingerprint、issue 精确集合及更新时间、评论 fingerprint、节点依赖和验收组。
5. 缺失、损坏、过期、范围不完整、出现新 issue、仓库身份或 base SHA 不同、评论变化、owner/依赖/验收组失真时，在状态根重建或完成一致性恢复；恢复失败保持 `dispatchEnabled=false`。
6. 有效 DAG 仍须刷新远端 snapshot。事实和 fingerprint 未变时只更新 freshness/consistency evidence，复用节点、terminal 指纹、执行 ledger 和有效 evidence，不无理由重建或重复探针。

DAG 和 issue snapshot 均必须在已验证状态根内。所有 `runtimeFiles` 路径必须相对状态根，且不得包含父目录跳转或穿过 symlink。至少使用以下 schema 字段：

- DAG：`issue-orchestration.dag.v1`、run id、规范状态根、刷新时间、仓库 facts/fingerprint、issue fingerprint、节点、验收组、运行态相对路径和 consistency evidence；
- issue snapshot：`issue-orchestration.issue-snapshot.v1`、刷新时间，以及每个 open issue 的仓库、编号、状态、更新时间和评论 fingerprint；
- 节点：精确 issue identity、owner、依赖、验收组、状态、难度、调查过的代码/测试/current 文档/约束；terminal 节点另含类别、直接证据和恢复 fingerprint。

远端 snapshot 写入状态根后，先用下列命令加 `--facts-only`，取得规范仓库 facts、issue fingerprint 和 repository fingerprint；该阶段固定输出 `dispatchEnabled=false`，只用于新建或核对 DAG。写入或恢复 DAG 后，去掉 `--facts-only` 运行完整门禁：

```bash
node .agents/skills/issue-orchestration/scripts/check-dag-gate.mjs \
  --state-root <state-root> \
  --dag <state-root>/dag.json \
  --issues-snapshot <state-root>/issue-snapshot.json \
  --repository FsusBlog=<FsusBlog-root> \
  --repository FsusUI=<FsusUI-root> \
  --default-branch FsusBlog=master \
  --default-branch FsusUI=main \
  --workspace <common-or-launch-workspace> \
  --startup-time <ISO-8601>
```

只有输出 `valid=true` 且 `dispatchEnabled=true` 才能让节点进入 `ready`。该机器检查不替代第 3 步的语义调查；仅从 issue 标题、数量或时间猜测依赖不构成一致性。

## 运行态图

DAG 至少记录：

- run id、刷新时间、固定请求的 15 个 subagent 槽位、实际可用槽位及能力证据；
- 两仓绝对路径、默认分支、HEAD、dirty state 与远端身份；
- 每个节点的 issue URL/编号、当前标题、依赖、责任仓、验收组、状态、难度、实现者、reviewer、开始时间；
- 状态根内运行态相对路径、已执行命令的 evidence key、产物 fingerprint、合法重跑原因；
- terminal 类别、直接证据、恢复条件及恢复指纹。

不得提交运行态，也不得把 issue 状态、槽位、锁或临时 evidence 复制到 `AGENTS.md`、current 产品文档或 Skill 入口。

## 刷新与重算

每轮调度先重新读取所选范围的 open issues 及相关评论，再吸收：

1. 远端新出现且属于本次范围的 issue；
2. 执行中由直接证据确认的真实实现缺陷；
3. reviewer blocker 或验收失败形成的返工节点。

随后重算每个受影响节点的依赖、责任仓、执行顺序和重合验收组。不得把执行期缺陷放在图外处理。责任仓必须来自当前代码、测试、文档和本地 alias 事实，不从 issue 标签或标题猜测。

只有满足全部条件的节点才是 `ready`：

- 当前启动的状态根与 DAG 门禁已经输出 `dispatchEnabled=true`；
- 所有前置依赖已交付，或已有直接证据证明与本节点独立；
- 责任仓、base SHA、修改边界、验收组和难度已确定；
- 不处于未变化的 terminal 状态；
- 没有同一修改正在被另一名实现者处理。

## 工作守恒

存在 `ready` 节点且有空闲槽位时，下一次调度动作必须派发；不得以等待、轮询或汇总代替派发。只在没有可执行节点、没有空闲槽位或需要完成一次不可并行的根代理交付动作时等待。

预计超过 5 分钟的 build、Fresh、consumer、visual 或性能任务启动后，立即返回调度循环，为其他独立 `ready` 节点分配空闲槽位。长任务只占自己的槽位；不得让根线程只轮询它。

Skill 的调度预算固定为 15 个 subagent 槽位，根调度线程不占用该预算。DAG 必须记录 `subagentSlotsConfigured=15`、实际运行时可提供的 subagent capacity 证据，以及 `subagentSlotsEffective`。

`subagentSlotsEffective` 取 15、运行时实际 subagent capacity 和环境资源上限三者的最小值；调用者可为单次运行显式降低，但不得提高到 15 以上。每个 implementer、reviewer 或仍运行的长任务各占一个 subagent 槽位。槽位满时才等待最早能改变 DAG 的事件。

## 根调度模型

根调度进程固定使用 `gpt-5.6-sol` / `max`。进入调度循环前先从本轮
运行时元数据核验实际 model 与 reasoning effort；不匹配时分类为调用
问题，停止本次父调用并以正确参数接管 checkpoint。错误父调用产生的
子任务或 evidence 只有在角色、任务边界、内容 fingerprint 和候选验证
仍然有效时才可复用；不得借修正父模型重复实现或重建有效产物。

这项要求只约束根调度进程，不参与下面的任务难度分档，也不得传播成
custom agent 的固定模型。

## Subagent 难度、模型与返工提升

所有实现和 review 任务使用 `gpt-5.6-sol`，只按当前闭环任务的实际难度选择 reasoning effort；不按比例凑数，也不参照根调度进程的 effort：

| 难度带 | 判断 | effort |
| --- | --- | --- |
| 简单至中下 | 边界明确、单一 owner、局部机械实现与 focused checks | `low` |
| 中下至中等 | 局部设计判断、少量跨文件修改或一般运行时验证 | `medium` |
| 中等至中上 | 跨模块协作、重要权衡或多阶段验证，但边界已闭合 | `high` |
| 中上至难 | 复杂并发、跨 owner 行为或高风险运行时/契约推演 | `xhigh` |
| 难至极难 | 跨仓、跨协议、安全/公开契约/架构级高风险推演 | `max` |

DAG 为每个节点记录 `difficultyBand`、`model`、`effort` 和 `reworkCount`。`reworkCount` 只在已确认的实现缺陷或 reviewer blocker 回到原实现者时增加；测试/基线、环境和调用问题不计数。

`reworkCount < 2` 时 effort 必须精确等于难度带对应档位，不得无依据升档或降档。

当 `reworkCount >= 2` 时，下一次修复派发必须在该节点基础难度档之上至少提升一档 effort：`low → medium → high → xhigh → max`，并记录提升前后档位及直接触发证据。基础档已为 `max` 时保持 `max` 并记录封顶，不得通过更换 owner、重置计数或把实现缺陷改分类来规避提升。

每次派发显式传递该节点的 model 与 reasoning effort，并使用非 full-history fork；当前 Codex 的角色派发要求 `fork_turns="none"` 或正整数，full-history fork 不接受角色/模型覆盖。派发后从实际 child rollout 或等价运行时元数据核验 model、effort 和 role。若当前 surface 不暴露这些参数或无法核验，不得默默继承父线程并声称选型成功；停止该派发并记录能力缺口。

## Terminal

合法 terminal 只有：

- `impossible`：当前仓库和允许环境内不可实现；
- `externally_blocked`：需要无法由本地工作消除的外部状态或权限；
- `not_applicable`：直接证据证明该 issue 不适用于当前事实。

进入 terminal 前，先执行 [`group-delivery.md`](group-delivery.md) 的“Terminal 前本地交付”，完成全部本地可行工作。terminal issue 保持 open。评论必须列出：

1. 已完成并已推送的本地可行工作；
2. 精确阻碍或不适用事实；
3. 命令、输出、远端状态或其他直接证据；
4. 可观察的恢复条件。

把恢复条件规范化为指纹。后续刷新时条件与指纹未变化，不得重派；发生可观察变化后才移出 terminal，重新调查并重算图。静态推测、subagent 自述或“暂时看起来不能”不是 terminal 证据。

“未取得 CI evidence”不是 terminal 类别。CI 未执行、实际失败和不可替代的 CI 专属门禁按 [`group-delivery.md`](group-delivery.md) 的唯一关闭规则处理；计费或额度导致 job 未启动本身不得自动产生 `externally_blocked`。

## 60 分钟恢复

若连续 60 分钟没有以下任一实际产出：

- 新 commit；
- 经远端核验的 issue closure；
- 有直接证据的 terminal blocker；

则立即重裁 DAG，取消或释放无效工作，缩小过大的节点，重新计算依赖与验收组，并按资源调整并行度。不得增加评审层、重复原验收或保留没有进展路径的槽位占用。

## 全局完成

只有 Skill 入口定义的三项停止条件同时成立才完成。存在未阻塞节点、未交付验收组、未核验 closure，或没有直接证据的 open issue 时，均不得结束。
