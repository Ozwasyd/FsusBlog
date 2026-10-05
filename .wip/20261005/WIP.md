# WIP: codex/issue-2395-terminal-journal-binding-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2395-terminal-journal-binding-20261003`
- 原始 commit：`aa7e5cd53a0b260999128dc5e402b853e8c3ef8c`
- 原始 tree：`3b88e610c46cc4e51ba2298471c6046b82de69d6`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2395, #2394, #3529, #3530, #3525, #1604, #2174, #3178
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
aa7e5cd53 fix(backend): bind bulk aggregates to journal terminal evidence
Refs: #2395

ed421876c fix(backend): recheck bulk plan expiry before admission journal
Refuse a new admission when awaited authority preflight crosses the original plan expiry boundary. Preserve existing idempotency results, frozen selection and upstream authority validation.

Refs: #2395

3ab774ce5 fix(contracts): seal article bulk preflight fact boundaries
Hide inaccessible state facts even in proposed-change digests and require complete permission and state facts for eligible plans, including independently resealed fixtures.

Refs: #2394

b19b3dc71 test(governance): type registry-derived receipt behavior IDs
Refs: #3529
025de17f3 test(governance): align release-final scan fixture with closed contract
Refs: #3530
de05fe6f5 fix(test): rebind current fixture selector evidence
Refs: #3525, #1604
d653afbde feat(test): materialize canonical article lifecycle fixtures
Refs: #2174
98e490f6d feat(contracts): bind typed AEDS endpoint observation
Refs: #3178
```

## 相对原 merge base 的源码差异概况

```text
.../Articles/Bulk/ArticleBulkExecutionFramework.cs |  47 ++++-
 .../Articles/Bulk/ArticleBulkPlanAuthority.cs      |   9 +-
 .../backend/Unit/ArticleBulkPlanAuthorityTests.cs  | 187 +++++++++++++++++++
 .../Unit/ArticleBulkRuntimeContractTests.cs        | 198 +++++++++++++++++++++
 4 files changed, 438 insertions(+), 3 deletions(-)
```

