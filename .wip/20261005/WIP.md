# WIP: codex/issue-2268-returned-identity-20261002

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2268-returned-identity-20261002`
- 原始 commit：`7e41214019026b7aa87d844d09106937ea1d760d`
- 原始 tree：`0b6e4d7efee107018b57fe071a034dc656310fb6`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2268, #3529, #3530, #3525, #1604, #2174, #3178
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
7e4121401 fix(test): correct legacy revision comparison fixture digests
Restore the original v1 admission schema prefix in the fixed fixture vectors; retain the v2 rejection assertions and production contract.

Refs #2268

f8f02f2f5 fix(contracts): version nullable revision comparison inputs
Separate typed null from exact string payloads while retaining the logical metadata budget. Reject legacy comparison envelopes and recreate evidence from exact authorized sources.

Refs: #2268

d454e49ea fix(contracts): reject substituted revision compare identities
Bind returned article, draft, and canonical revision coordinates before sealing authorized comparison inputs.

Refs: #2268

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
docs/api/article-publication-revisions.md          |   6 +
 .../AuthoringRevisionComparePackageReader.cs       |  17 +-
 .../Services/Articles/RevisionCompareCanonical.cs  |   3 +-
 .../Services/Articles/RevisionCompareContract.cs   |   6 +-
 .../Articles/RevisionCompareMetadataRegistry.cs    |  66 +++++-
 .../Articles/RevisionComparePackageSeal.cs         |   8 +
 .../Services/Articles/RevisionComparePackages.cs   |   7 +
 .../Services/Articles/RevisionComparePlanner.cs    |   5 +
 .../AuthoringRevisionComparePackageReaderTests.cs  | 192 ++++++++++++++++
 .../Unit/RevisionComparePlannerPackageTests.cs     | 136 ++++++++++++
 tests/backend/Unit/RevisionComparePlannerTests.cs  | 247 +++++++++++++++++++++
 .../Unit/RevisionSourceDiffInvariantTests.cs       |  19 ++
 12 files changed, 700 insertions(+), 12 deletions(-)
```

