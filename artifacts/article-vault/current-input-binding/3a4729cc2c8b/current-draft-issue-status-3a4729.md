# 链 #1975 当前 source 交接：全部16 issue

本次独立后继分支 `codex/chain-1975-current-draft-integration`，精确远端/测试提交 `3a4729cc2c8bf6a01830049d7bbcb734ee16ce06`。基于原 asset/input supplier `61d686739fca17aa3f3fad3840de315c4d35eabe`，开始前 fetch master `c04f6bfcac4849638a9ee59e4a3aa34ceb5bb07f`。母分支及 supplied dependency refs 均未修改；未合并整支或猜测 sibling 提交。

实际组合 responsibility `76473e9dd3feb7e06e73fe085053373d6dbf45ae` 的原 reader/test 文件和 saved draft `53bba36b436502c3dd3e4b4d48b229a1c348d28b` 的原 reader/test 文件。责任 reader runtime 文件与 supplied SHA256 完全一致。Saved draft 增加真正原 FileService input bytes 入口，保留当前上下文/owner/server revision/source/ledger前后读取。Article/draft 共用 exact-one source-edge helper，观察数组在await前冻结。原 FileService/IFileService/native validator 未改；不存在第二 validator、暗中草稿保存、复用/引用/清理收据。

原 ArticleAssetReferenceStore 增加 ScheduleUnreferencedOwnedAssetsAsync(owner, AssetId集合, ct)，要求 caller 的真实打开事务，复用原 advisory locks、全引用缺失判断和24h单行延迟队列。所有候选的原 owner/存在性在任何调度前确认；恢复原草稿引用会取消队列。此 Task 不是 cleanup receipt，原 cleanup owner 须提交后读真实 durable queue/state。

精确提交标准 test project build/discovery exit0，89非空用例；实际 build1530 warning lines，不是零warning。8正向准入通过后，组合89/89通过、0skip、exit0：draft59、responsibility22、shared edge3、cleanup5。2次真实隔离 PostgreSQL run 分别记录 original task container create/start/kill/die/destroy；均无 owned container 残留。9 C# file canonical style0 violations，commit-range与diff-check exit0。测试数和SHA/命令/时间/源与产物哈希见 `current-draft-handoff-3a4729cc2c8b.json` 与 `current-draft-3a4729-test-runs.json`。

本轮 draft input bytes 使用受控 [1,2,3] forwarding fixture，不宣称新的native qualification。SQL为真实隔离库、原表/事务/队列；受控metadata不宣称native deletion。原61d56-case真实native与20MiB/preview证据仍只绑定61d。原 supplied22/51结果未继承，当前组合已独立执行。没有全CI、zero-warning、浏览器/live DI/AEDS端到端、显式reuse/intent/reference/cleanup receipt或终态cutover验收。

| Issue | 当前状态、下一实际门槛 |
| --- | --- |
| #1975 | PARTIAL：原 genuine backup refusal/isolated restore 修复保留；本轮组合原current输入。原 compiled operation registry + asset-precutover/current native source profile 的正式组合仍未qualified，完整destructive apply/repeat/restore待执行。禁止production动作。 |
| #1976 | WAITING：#1975尚未accepted，未开始终态封口。完整E2E/performance/governance/zero-warning门槛仍开。 |
| #1779 | TRACKING ONLY：#1975/#1976/#1761 acceptance仍未全满足；不新建implementation、不关闭。 |
| #1780 | PARTIAL：原bounded public delivery保留；Windows/full security/performance未qualified。 |
| #2074 | PARTIAL：实际AOT root authority和六项semantic proofs未完整满足，不以whitelist/delete-only替代。 |
| #2075 | WAITING：前置acceptance与完整anonymous delivery矩阵。 |
| #2076 | BLOCKED DECISION：canonical403/claims/shared consume-once与original404/DP语义须原owner定案，不在#2077自行改。 |
| #2077 | PARTIAL：原66fa upload lifecycle/native/PG修复及其旧SHA证据保留；前置qualification、gateway/platform/crossprocess/crossvolume/promotion-ledger fault门槛仍开。 |
| #2078 | WAITING：完整#2074–#2077资格。为released cleanup原module提供canonical事务入口，不等于durable cleanup receipt或整体资格。 |
| #2079 | PARTIAL：独立current owner aggregate/selector authority与acceptance未完整满足。 |
| #2080 | WAITING：terminal security/resurrection验收。 |
| #1784 | TRACKING ONLY：security child gates未全满足；只聚合、不关闭。 |
| #2258 | PARTIAL：当前article/saved draft input共用source-edge binding；原真实owner/source/native validator保留。明确reuse决策、真实verified intent/full resource rights/reference/cleanup/browser/public facts-only transport仍须原owner组合与独立验收。 |
| #2263 | PARTIAL：实际current responsibility/saved draft supplier已组合并当前89-case验证；不是release-only报告。#3735 DI/transport、原#2256/#2261/#2246 intent/reference/cleanup当前authority和product acceptance仍未闭合。 |
| #2265 | WAITING：原替换provider/business/UI全qualified前不删除legacy。 |
| #1810 | TRACKING ONLY：child +#2256/#2261/#1907与组合product gates未全满足；只聚合、不关闭。 |

唯一DI/transport owner #3735 获得精确 AddScoped hunk：`current-draft-3a4729-di-owner3735.patch`。对应归属文件未写。原 live current context不可用时拒绝；static incoming DTO closure不能当浏览器当前权威。实际 server DraftKey、server:N ACK、opaque Writer DraftId、editor sourceRevision、article revision、canonical JSON digest、raw markdown SHA保留独立含义。Suppliers是事实读取，不创造root operation/grant/receipt；当前权限/intent/reuse缺失保持recovery-required。

Source已正常push并只读ls-remote核SHA。GitHub内容API按协调方授权monitor冻结；没有新PR/comment/body/label/close操作，旧draft3813不含本增量。不push master、不merge、不deploy、不发布包、不重放held/security/receipt/integrity audits。整链未完成，所有terminal qualification=false。
