# WIP: codex/issue-3118-content-field-projection

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3118-content-field-projection`
- 原始 commit：`3c2700ec8f58f760d84a8d2d799e264ca8be9453`
- 原始 tree：`7b1bb5548122c599192a27c949400c928a4cbf73`
- 与当前 master 的 merge base：`89dce31d1ca5a6fe84d6d866fef9956814080f54`
- 相关 issue 线索：#3118, #3119, #3101
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
3c2700ec8 WIP handoff: codex/issue-3118-content-field-projection
Handoff-Date: 2026-09-17
Classification: open PR work
Source-Tip: 14ef7a06478b9e5cdbbe44527a28397bda26badd
Source-Branches: codex/issue-3118-content-field-projection
Remote-Recovery-Refs: origin/codex/issue-3118-content-field-projection
Attached-Worktrees: issue-3118-content-field-projection
Master-Anchor-At-Audit: 4915be1e3ae83e38b618f31dccd33ebf271c921e
Merge-Base: 89dce31d1ca5a6fe84d6d866fef9956814080f54
Divergence: master-only=896, source-only=6
Patch-Identity: unique=6, equivalent-to-master=0
Diff-Stat: 10 files changed, 1619 insertions(+), 63 deletions(-)

Issue state:
#3118 OPEN fix(test-fixtures): 收窄 content field projection source binding

Pull requests:
#3119 OPEN https://github.com/Ozwasyd/FsusBlog/pull/3119 — fix(test): bind fixture projection to field semantics

Unique commit stack (up to 15):
571b94391cd1 fix(test): bind fixture projection to field semantics
7c344a24c701 chore(governance): bind projection naming surfaces
89914a0a2079 fix(test): extract production field contracts
0addd083a65a fix(test): bind projection to Roslyn symbols
9d6bfaa93066 chore(governance): scope extractor naming evidence
14ef7a06478b fix(test): checkpoint in-flight local work

Changed paths from merge-base (up to 25 of 10):
A artifacts/change-contract/issue-3118-content-field-contract-generated-binding.json
A artifacts/change-contract/issue-3118-content-field-projection-external-naming.json
M config/testing/content-field-contracts.generated.json
M docs/testing.md
M tests/tools/content-shape-catalog.test.mjs
A tools/testing/FsusBlog.ContentFieldContractExtractor/FsusBlog.ContentFieldContractExtractor.csproj
A tools/testing/FsusBlog.ContentFieldContractExtractor/Inject.targets
A tools/testing/FsusBlog.ContentFieldContractExtractor/Program.cs
A tools/testing/FsusBlog.ContentFieldContractExtractor/packages.lock.json
M tools/testing/content-shape-catalog.mjs


Historical verification evidence:
PR #3119 historical body (not rerun for this handoff):
- [ ] `./tools/test.sh fast`
- [ ] Targeted backend tests:
- [ ] Targeted frontend checks:
- [x] Other:
- `dotnet build tools/testing/FsusBlog.ContentFieldContractExtractor/FsusBlog.ContentFieldContractExtractor.csproj --configuration Release --no-restore` — passed with 0 warnings.
- `node --test tests/tools/content-shape-catalog.test.mjs tests/tools/content-shape-generator.test.mjs tests/tools/fixture-catalog.test.mjs` — 46 passed / 0 failed.
- `node tools/testing/content-shape-catalog.mjs --check` — catalog, production projection, locale coverage, and governance valid.
- `node tools/testing/generate-fixture-catalog-artifacts.mjs --check` — no generated artifact drift.

Current verification status:
- No build, test matrix, PostgreSQL/Docker/browser lane, or acceptance suite was rerun while creating this metadata commit.
- Historical PR text and old receipts are navigation evidence only; they do not qualify this source tip against current master.
- The source worktree was clean at the preceding checkpoint audit, but branch semantics and dependencies may now be stale.

Known handoff risks:
- Never merge this catalog commit or the source checkpoint directly.
- Recheck current issue text, Depends-on state, open PR ownership, generated-output ownership, and current AGENTS.md.
- Closed/merged or safety-classified work must first be compared with master using patch-id/range-diff; do not reopen or redeliver automatically.
- Generic checkpoint commits may mix work layers and must be split, squashed, or reworded before delivery.

Recovery and continuation:
  git fetch origin
  git worktree add -b handoff/recovered-083 <new-path> origin/codex/issue-3118-content-field-projection
  git diff --stat 89dce31d1ca5a6fe84d6d866fef9956814080f54..HEAD
  git log --oneline --decorate 89dce31d1ca5a6fe84d6d866fef9956814080f54..HEAD
  git cherry origin/master HEAD

Next owner:
1. Determine whether the unique patches are still required or already semantically absorbed.
2. Isolate the smallest issue-scoped valid patch and remove unrelated/stale/generated drift.
3. Run focused checks, then all acceptance/runtime lanes required by the current issue.
4. Record exact commands/results and remaining blockers in the PR; use Refs-only while dependencies remain open.
5. Merge/close only with current authoritative evidence.

WIP-Handoff-Source-Tip: 14ef7a06478b9e5cdbbe44527a28397bda26badd
WIP-Handoff-Recovery-Ref: origin/codex/issue-3118-content-field-projection
WIP-Handoff-Classification: open PR work

Handoff commit semantics:
- This commit is metadata-only and has the exact same tree as its parent.
- Parent `14ef7a06478b9e5cdbbe44527a28397bda26badd` is the preserved pre-handoff code tip.
- Checkout `origin/codex/issue-3118-content-field-projection` to recover both code and this handoff.

WIP-Code-Tip: 14ef7a06478b9e5cdbbe44527a28397bda26badd
WIP-Handoff-Branch: codex/issue-3118-content-field-projection
WIP-Handoff-Remote-Ref: origin/codex/issue-3118-content-field-projection

14ef7a064 fix(test): checkpoint in-flight local work
Refs: #3118

9d6bfaa93 chore(governance): scope extractor naming evidence
Refs: #3118

0addd083a fix(test): bind projection to Roslyn symbols
Refs: #3118

89914a0a2 fix(test): extract production field contracts
Refs: #3118

7c344a24c chore(governance): bind projection naming surfaces
Record the exact generated JSON and Node tooling paths governed by the existing external naming registries.

Refs: #3118

571b94391 fix(test): bind fixture projection to field semantics
Keep generated identity sensitive to projected field contracts while ignoring unrelated implementation changes in the same production owner files.

Refs: #3118

89dce31d1 Merge pull request #3101 from Ozwasyd/codex/issue-3099-testing-coverage-entry-count
docs(test): refresh coverage entry fact
```

## 相对原 merge base 的源码差异概况

```text
...8-content-field-contract-generated-binding.json |  16 +
 ...8-content-field-projection-external-naming.json |  19 +
 .../testing/content-field-contracts.generated.json |  12 +-
 docs/testing.md                                    |  15 +-
 tests/tools/content-shape-catalog.test.mjs         | 413 ++++++++++
 .../FsusBlog.ContentFieldContractExtractor.csproj  |  19 +
 .../Inject.targets                                 |  17 +
 .../Program.cs                                     | 828 +++++++++++++++++++++
 .../packages.lock.json                             |  31 +
 tools/testing/content-shape-catalog.mjs            | 312 ++++++--
 10 files changed, 1619 insertions(+), 63 deletions(-)
```

