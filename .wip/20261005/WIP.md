# WIP: codex/issue-3120-quality-gate-artifact-transport

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3120-quality-gate-artifact-transport`
- 原始 commit：`4ad3978dbc013592d5c93bbf9a4dd5fe08a09318`
- 原始 tree：`94566e37dd0870a5c3beda06c481609153c94a8d`
- 与当前 master 的 merge base：`73f9e47d0097ecb616d504c6f60f46b3a1dc4c01`
- 相关 issue 线索：#3120, #3121, #3184, #3182, #3179
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
4ad3978db WIP handoff: codex/issue-3120-quality-gate-artifact-transport
Handoff-Date: 2026-09-17
Classification: open PR work
Source-Tip: 9486f3d3a0f73a4a6dfea38245c231230c07b6ce
Source-Branches: codex/issue-3120-quality-gate-artifact-transport
Remote-Recovery-Refs: origin/codex/issue-3120-quality-gate-artifact-transport
Attached-Worktrees: issue-3120-quality-gate-artifact-transport
Master-Anchor-At-Audit: 4915be1e3ae83e38b618f31dccd33ebf271c921e
Merge-Base: 73f9e47d0097ecb616d504c6f60f46b3a1dc4c01
Divergence: master-only=798, source-only=7
Patch-Identity: unique=5, equivalent-to-master=0
Diff-Stat: 20 files changed, 2591 insertions(+), 174 deletions(-)

Issue state:
#3120 OPEN ci(test): bind production summary to sealed evidence transport artifacts

Pull requests:
#3121 OPEN https://github.com/Ozwasyd/FsusBlog/pull/3121 — fix(ci): seal quality-gate evidence transport

Unique commit stack (up to 15):
9f734ec04c0c fix(ci): seal quality-gate evidence transport
fabbff59a038 fix(ci): bind quality-gate transport authority
a7f40b734574 fix(ci): validate transported quality-gate collections
114d21cc6ee5 chore(governance): bind final quality-gate naming surfaces
9486f3d3a0f7 fix(ci): sync quality-gate transport authority

Changed paths from merge-base (up to 25 of 20):
M .github/workflows/quality-gate.yml
A artifacts/change-contract/issue-3120-quality-gate-transport-external-naming.json
A artifacts/change-contract/issue-3120-quality-gate-transport-generated-binding.json
M config/testing/correctness-attempt-producers.json
M config/testing/current-run-evidence-location-acceptance.json
M config/testing/evidence-location-migration-ledger.json
M config/testing/evidence-locator-registry.json
M docs/testing.generated.md
M tests/matrix.yml
M tests/tools/current-run-evidence-transport.test.mjs
M tests/tools/evidence-location-governance.test.mjs
M tests/tools/flaky-test-governance.test.mjs
A tests/tools/quality-gate-evidence-transport.test.mjs
M tools/ci/check-flaky-evidence.mjs
M tools/ci/check-job-summaries.mjs
A tools/ci/prepare-quality-gate-evidence-transport.mjs
M tools/ci/summarize-quality-gate.mjs
A tools/ci/verify-quality-gate-evidence-transport.mjs
M tools/test/current-run-evidence-transport.mjs
M tools/test/run-current-run-evidence-transport.mjs


Historical verification evidence:
PR #3121 historical body (not rerun for this handoff):
- [ ] `./tools/test.sh fast`
- [ ] Targeted backend tests:
- [ ] Targeted frontend checks:

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
  git worktree add -b handoff/recovered-084 <new-path> origin/codex/issue-3120-quality-gate-artifact-transport
  git diff --stat 73f9e47d0097ecb616d504c6f60f46b3a1dc4c01..HEAD
  git log --oneline --decorate 73f9e47d0097ecb616d504c6f60f46b3a1dc4c01..HEAD
  git cherry origin/master HEAD

Next owner:
1. Determine whether the unique patches are still required or already semantically absorbed.
2. Isolate the smallest issue-scoped valid patch and remove unrelated/stale/generated drift.
3. Run focused checks, then all acceptance/runtime lanes required by the current issue.
4. Record exact commands/results and remaining blockers in the PR; use Refs-only while dependencies remain open.
5. Merge/close only with current authoritative evidence.

WIP-Handoff-Source-Tip: 9486f3d3a0f73a4a6dfea38245c231230c07b6ce
WIP-Handoff-Recovery-Ref: origin/codex/issue-3120-quality-gate-artifact-transport
WIP-Handoff-Classification: open PR work

Handoff commit semantics:
- This commit is metadata-only and has the exact same tree as its parent.
- Parent `9486f3d3a0f73a4a6dfea38245c231230c07b6ce` is the preserved pre-handoff code tip.
- Checkout `origin/codex/issue-3120-quality-gate-artifact-transport` to recover both code and this handoff.

WIP-Code-Tip: 9486f3d3a0f73a4a6dfea38245c231230c07b6ce
WIP-Handoff-Branch: codex/issue-3120-quality-gate-artifact-transport
WIP-Handoff-Remote-Ref: origin/codex/issue-3120-quality-gate-artifact-transport

9486f3d3a fix(ci): sync quality-gate transport authority
Refs: #3120

82468e004 chore(governance): merge current master
Refs: #3120

73f9e47d0 Merge pull request #3184 from Ozwasyd/codex/issue-3182-large-blob-revision-reader
fix(governance): bound exact revision blob reads
c02829102 fix(governance): ignore Git object replacement refs
Pin exact revision reads to original commit and blob objects so local replacement refs cannot rewrite trusted candidate bytes.

Refs: #3182

2c173ad11 chore(governance): bind revision reader naming surfaces
Declare the existing external spelling owners touched by the issue-scoped checker and documentation correction.

Refs: #3182

f5f2c1374 fix(governance): bound exact revision blob reads
Resolve candidate content through an exact commit tree entry and reject non-files, oversized blobs, and truncated object output before trusting bytes.

Refs: #3182

7f4c5c71a Merge pull request #3179 from Ozwasyd/codex/issue-3176-taxonomy-generated-baselines
docs(governance): refresh taxonomy generated fact sections
```

## 相对原 merge base 的源码差异概况

```text
.github/workflows/quality-gate.yml                 |  93 +++
 ...120-quality-gate-transport-external-naming.json |  54 ++
 ...0-quality-gate-transport-generated-binding.json |  36 +
 config/testing/correctness-attempt-producers.json  |   4 +-
 .../current-run-evidence-location-acceptance.json  |  27 +-
 .../evidence-location-migration-ledger.json        | 316 +++++++--
 config/testing/evidence-locator-registry.json      |  35 +-
 docs/testing.generated.md                          |   4 +-
 tests/matrix.yml                                   |   6 +
 .../tools/current-run-evidence-transport.test.mjs  | 181 ++++-
 tests/tools/evidence-location-governance.test.mjs  |   2 +-
 tests/tools/flaky-test-governance.test.mjs         |   6 +-
 .../tools/quality-gate-evidence-transport.test.mjs | 739 +++++++++++++++++++++
 tools/ci/check-flaky-evidence.mjs                  |  58 +-
 tools/ci/check-job-summaries.mjs                   |  86 ++-
 .../ci/prepare-quality-gate-evidence-transport.mjs | 648 ++++++++++++++++++
 tools/ci/summarize-quality-gate.mjs                |  57 +-
 .../ci/verify-quality-gate-evidence-transport.mjs  | 177 +++++
 tools/test/current-run-evidence-transport.mjs      | 225 +++++--
 tools/test/run-current-run-evidence-transport.mjs  |  11 +-
 20 files changed, 2591 insertions(+), 174 deletions(-)
```

