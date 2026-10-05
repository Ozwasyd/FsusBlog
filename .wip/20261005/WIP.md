# WIP: codex/issue-3580-source-parallel-20261002-phzezt

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3580-source-parallel-20261002-phzezt`
- 原始 commit：`1209dcc359a3f7cfa23fa5c343f336701990b39c`
- 原始 tree：`909ab59f5349c0014de5fb9b88a2fd846f7db724`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3580, #3558, #3529
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
1209dcc35 test(backend): bind cgroup process evidence to actual callsites
Refs: #3580

bf8fe1bc9 test(backend): reconcile source owner metadata parent
Refs: #3580

77abb37fb test(backend): bind capture refusal to its emitted literal
Remove the forbidden marker from the fixture type name so the nested-root control relies on the actual emitted Screenshot literal, not metadata description of the fixture name.

Refs: #3558

bbfb6a255 test(backend): preserve complete export contract slice coverage
Inspect all nineteen existing types owned by the three original contract sources and every selected nested declared method root without changing the shared inspector. Preserve the one-catalog, six refusal and closed-binding checks and add compiled-shape fixture refusals for omitted records, constructors and uncalled nested members.

Refs: #3558

d0236bcf6 test(backend): bind export cgroup source lock to compiled authority
Refs: #3580

cdae3cea9 test(backend): inspect constructors in export contract evidence
Refs: #3558

19f8cd02f test(backend): replace export contract source reads
Refs: #3558

b19b3dc71 test(governance): type registry-derived receipt behavior IDs
Refs: #3529
```

## 相对原 merge base 的源码差异概况

```text
.../Unit/AccountSubjectHashProjectionTests.cs      |  31 +++
 tests/backend/Unit/DocumentExportContractTests.cs  | 160 +++++++++--
 .../DocumentExportSystemdCgroupAuthorityTests.cs   | 298 +++++++++++++++++++--
 3 files changed, 446 insertions(+), 43 deletions(-)
```

