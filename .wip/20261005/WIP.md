# WIP: codex/issue-1762-media-preservation-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-1762-media-preservation-20261003`
- 原始 commit：`1dec20d30268fa8a109bf3d5fafcb712a8bcf6c4`
- 原始 tree：`8565f3742281284bfefc5aa3411cce128103e17c`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#1762, #3529, #3530, #3525, #1604, #2174, #3178, #3511, #3060
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
1dec20d30 fix(database): bound offline media directory metadata before staging
Account for every unique directory prefix against the explicit metadata budget before any target writes and independently during generation verification. Preserve the original file and total byte limits and publication authority boundary.

Refs: #1762

a1a33cbdb feat(database): preserve offline article media through anchored staging
Inventory original cover, Markdown and source HTML media through real AST parsers. Bind case-exact aliases and streamed file hashes; stage through anchored Linux handles and recover publication only through the original durable journal port. Media publication is not database commit authority.

Refs: #1762

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
d3658ecdd fix(governance)!: close terminal zero-legacy scanner (#3511)
Refs: #3060
BREAKING CHANGE: Final consistency reports now require the closed zero-legacy scan shape and an independently recomputed repository scan.
```

## 相对原 merge base 的源码差异概况

```text
Directory.Packages.props                           |   2 +
 src/migration/ArticleMediaPreservation.cs          | 400 ++++++++++++++++++++
 .../ArticleMediaPreservationFileSystem.cs          | 409 +++++++++++++++++++++
 src/migration/FsusBlog.Migration.csproj            |   2 +
 tests/migration/ArticleMediaPreservationTests.cs   | 346 +++++++++++++++++
 5 files changed, 1159 insertions(+)
```

