# WIP: codex/issue-3527-durable-resource-boundary

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3527-durable-resource-boundary`
- 原始 commit：`9c836344dfb0f48654cd11111ad0505e3b14ab37`
- 原始 tree：`951aee4a15fd47fcdceaa232179682f24d77039f`
- 与当前 master 的 merge base：`d653afbde02b75814d8384777886b10419fb38a1`
- 相关 issue 线索：#3527, #2174, #3178, #3511, #3060, #3510
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
9c836344d fix(governance): scope resource naming evidence exactly
Limit the exception manifest to paths matched by the trusted base registry's glob semantics.

Refs: #3527

ae872a8e7 fix(test): align resource boundary imports
Keep canonical test imports lint-clean and reseal the generated release-final closure without changing enforcement behavior.

Refs: #3527

2994c305f chore(governance): bind resource boundary PR evidence
Record exact generated authority bytes and the registered external naming surfaces for the resource-bound candidate.

Refs: #3527

7124fb5f8 fix(test): bind durable execution to resource boundary
Keep durable and nested systemd workers beneath the same live resource ancestor, with pre-exec read-back, dynamic grants and exact recovery records. Canonical production-lane qualification and independent review remain open.

Refs: #3527

d653afbde feat(test): materialize canonical article lifecycle fixtures
Refs: #2174
98e490f6d feat(contracts): bind typed AEDS endpoint observation
Refs: #3178
d3658ecdd fix(governance)!: close terminal zero-legacy scanner (#3511)
Refs: #3060
BREAKING CHANGE: Final consistency reports now require the closed zero-legacy scan shape and an independently recomputed repository scan.
1c59bdb65 Merge pull request #3510 from Ozwasyd/codex/issue-3118-projection-reseal
fix(test): bind content projection to semantic fragments
```

## 相对原 merge base 的源码差异概况

```text
...sue-3527-resource-boundary-external-naming.json |   46 +
 ...e-3527-resource-boundary-generated-binding.json |   12 +
 .../testing/physical-execution-process-policy.json |    2 +
 docs/testing.md                                    |    8 +
 docs/testing/content-addressed-evidence-storage.md |   30 +-
 .../issue-1069-run-bound-production-builds.md      |   10 +-
 .../issue-1072-production-resource-enforcement.md  |  374 ++-
 .../release-final-execution-target-authority.json  |  686 +++-
 .../content-addressed-evidence-store.test.mjs      |   75 +-
 .../tools/physical-execution-process-tree.test.mjs |  606 +++-
 .../physical-execution-systemd-sender.test.mjs     |  104 +
 .../production-capacity-preflight-order.test.mjs   |   82 +-
 .../tools/production-capacity-reservation.test.mjs |  262 ++
 .../tools/production-resource-enforcement.test.mjs | 3466 +++++++++++++++++++-
 tests/tools/scheduler-owner-identity.test.mjs      |  312 +-
 .../support/esm-fixture-materializer-runner.mjs    |   60 +
 tests/tools/support/esm-fixture-materializer.mjs   |   84 +-
 .../scheduler-checkpoint-recovery-probe.mjs        |   12 +
 tests/tools/test-matrix-resource-boundary.test.mjs |  694 ++++
 tools/run-test-matrix.mjs                          |  159 +-
 .../content-addressed-evidence-store.mjs           |   48 +-
 tools/test-matrix/production-build-layout.mjs      | 1223 ++++++-
 tools/test-matrix/production-build-lifecycle.mjs   |   32 +-
 .../production-capacity-reservation.mjs            |  269 +-
 .../production-resource-enforcement.mjs            |  418 ++-
 .../production-systemd-resource-boundary.mjs       | 1191 +++++++
 tools/test-matrix/scheduler.mjs                    | 1068 +++++-
 tools/test/lanes/static-governance.sh              |    6 +
 .../physical-execution-linux-systemd-adapter.mjs   |  619 +++-
 tools/test/physical-execution-nested-channel.mjs   |  584 ++++
 tools/test/physical-execution-nested-socket.py     |  140 +
 tools/test/physical-execution-process-tree.mjs     |  862 ++++-
 tools/test/physical-execution-systemd-sender.mjs   |  274 ++
 33 files changed, 13325 insertions(+), 493 deletions(-)
```

