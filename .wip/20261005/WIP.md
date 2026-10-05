# WIP: codex/issue-2210-release-final-replay-stacked

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2210-release-final-replay-stacked`
- 原始 commit：`115e32eb53e34485277347e13537a3d6a3f01c7f`
- 原始 tree：`ad19ac21ec7a2886ff3886feb6f199ce21d8f8d5`
- 与当前 master 的 merge base：`25e1ed6fe349cdeeac0960f68e8dd3e226583e98`
- 相关 issue 线索：#2210, #2207, #2209, #3309, #2208, #3235, #3314, #3312
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
115e32eb5 WIP handoff: codex/issue-2210-release-final-replay-stacked
Handoff-Date: 2026-09-17
Classification: open PR work
Source-Tip: af1298eaf2847c141c2b026ba94f6cbf8bf8b695
Source-Branches: codex/issue-2210-release-final-replay-stacked
Remote-Recovery-Refs: origin/codex/issue-2210-release-final-replay-stacked
Attached-Worktrees: issue-2210-release-final-replay-stacked
Master-Anchor-At-Audit: 4915be1e3ae83e38b618f31dccd33ebf271c921e
Merge-Base: 25e1ed6fe349cdeeac0960f68e8dd3e226583e98
Divergence: master-only=380, source-only=16
Patch-Identity: unique=7, equivalent-to-master=0
Diff-Stat: 103 files changed, 19241 insertions(+), 2690 deletions(-)

Issue state:
#2207 OPEN feat(test-evidence): 封存 route、AOT、browser、cache 与 session post-runtime observations
#2209 OPEN feat(behavior-graph): join application 与 release post-runtime observations 并封存 Behavior receipt
#2210 OPEN test(release-final): 依赖 post-runtime seal 并删除 finalizer 内发现、重跑与历史 fallback

Pull requests:
#3309 OPEN https://github.com/Ozwasyd/FsusBlog/pull/3309 — fix(release): bind canonical post-runtime replay

Unique commit stack (up to 15):
a07ed92a5ed9 feat(test): curate canonical runtime observation sources
2816e70da1b6 fix(test): bind current producer entry and fixture closure
9a96b7518341 chore(test): bind exact curated naming surfaces
b30b8cb3a18b fix(test): preserve canonical source executable modes
7b0843fe3e02 fix(governance): replay canonical post-runtime joins
8413f6bab751 fix(release): bind canonical post-runtime replay
8e55dfc80c50 chore(governance): complete release replay naming metadata

Changed paths from merge-base (up to 25 of 103):
A artifacts/change-contract/issue-2205-scheduler-claims-external-naming.json
A artifacts/change-contract/issue-2207-2208-source-external-naming.json
A artifacts/change-contract/issue-2207-2208-source-provenance.json
A artifacts/change-contract/release-final-canonical-replay-external-naming.json
M config/schemas/behavior-evidence-post-runtime-receipt.schema.json
M config/testing/post-runtime-producer-registry.json
M docs/testing.md
A tests/browser-contract/contract-core.mjs
M tests/browser-contract/contract.mjs
M tests/browser-contract/fixture-lifecycle.mjs
M tests/browser-contract/fixture-lifecycle.test.mjs
M tests/browser-contract/run.mjs
M tests/browser-contract/scenarios.mjs
A tests/tools/aot-spa-hydration-raw.test.mjs
A tests/tools/application-runtime-observation.test.mjs
M tests/tools/behavior-document-consistency-final.test.mjs
M tests/tools/behavior-evidence-post-runtime.test.mjs
A tests/tools/blue-green-containment-raw.test.mjs
A tests/tools/browser-contract-observation-raw.test.mjs
A tests/tools/browser-contract-observed-facts.test.mjs
M tests/tools/content-addressed-evidence-store.test.mjs
M tests/tools/current-run-evidence-locator-negative-matrix.test.mjs
A tests/tools/post-runtime-accepted-claims.test.mjs
A tests/tools/post-runtime-observation-producers.test.mjs
M tests/tools/post-runtime-producer-registry.test.mjs
... 78 additional paths omitted; run the recovery commands below.

Historical verification evidence:
PR #3309 historical body (not rerun for this handoff):
- [x] `node --test tests/tools/release-final-post-runtime-replay.test.mjs tests/tools/release-final-current-run-locator.test.mjs tests/tools/release-final-evidence-binding.test.mjs tests/tools/release-required-evidence-catalog.test.mjs tests/tools/test-evidence-receipt-schema.test.mjs`: 40/40 pass at refreshed head af1298eaf2847c141c2b026ba94f6cbf8bf8b695.
- [x] Repository change-contract, document lifecycle (363), authoritative-development-docs and `git diff --check`: pass.
- [x] `node --test tests/tools/behavior-evidence-post-runtime.test.mjs tests/tools/behavior-document-consistency-final.test.mjs tests/tools/current-run-evidence-locator-negative-matrix.test.mjs`: 20/21 pass; FAIL on stale generated evidence-location report (current 72 consumers versus checked-in 82), not repaired in this ownership slice.
- [x] Scoped script-style invocation completed but selected zero files; it is not lint coverage for these .mjs files.

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
  git worktree add -b handoff/recovered-045 <new-path> origin/codex/issue-2210-release-final-replay-stacked
  git diff --stat 25e1ed6fe349cdeeac0960f68e8dd3e226583e98..HEAD
  git log --oneline --decorate 25e1ed6fe349cdeeac0960f68e8dd3e226583e98..HEAD
  git cherry origin/master HEAD

Next owner:
1. Determine whether the unique patches are still required or already semantically absorbed.
2. Isolate the smallest issue-scoped valid patch and remove unrelated/stale/generated drift.
3. Run focused checks, then all acceptance/runtime lanes required by the current issue.
4. Record exact commands/results and remaining blockers in the PR; use Refs-only while dependencies remain open.
5. Merge/close only with current authoritative evidence.

WIP-Handoff-Source-Tip: af1298eaf2847c141c2b026ba94f6cbf8bf8b695
WIP-Handoff-Recovery-Ref: origin/codex/issue-2210-release-final-replay-stacked
WIP-Handoff-Classification: open PR work

Handoff commit semantics:
- This commit is metadata-only and has the exact same tree as its parent.
- Parent `af1298eaf2847c141c2b026ba94f6cbf8bf8b695` is the preserved pre-handoff code tip.
- Checkout `origin/codex/issue-2210-release-final-replay-stacked` to recover both code and this handoff.

WIP-Code-Tip: af1298eaf2847c141c2b026ba94f6cbf8bf8b695
WIP-Handoff-Branch: codex/issue-2210-release-final-replay-stacked
WIP-Handoff-Remote-Ref: origin/codex/issue-2210-release-final-replay-stacked

af1298eaf chore(release): integrate updated post-runtime parent
Refs: #2210

caff4566c chore(governance): sync stacked post-runtime parent
Refs: #2209

5d9552da7 chore(test): sync current bounded source baseline
Refs: #2207, #2208, #3235

25e1ed6fe Merge pull request #3314 from Ozwasyd/codex/chain-2684-2685-comment-fixture
feat(test): enforce isolated comment fixture authority
cf1e99d0a chore(test): sync bounded audit baseline
Refs: #2207, #2208, #3235

641864d44 Merge origin/master into codex/chain-2684-2685-comment-fixture

cde6a9627 Merge pull request #3312 from Ozwasyd/codex/chain-2268-2270-revision-diff
feat(core): seal revision comparison plans
```

## 相对原 merge base 的源码差异概况

```text
...ssue-2205-scheduler-claims-external-naming.json |  15 +
 .../issue-2207-2208-source-external-naming.json    |  75 ++
 .../issue-2207-2208-source-provenance.json         | 574 ++++++++++++
 ...ase-final-canonical-replay-external-naming.json |  22 +
 ...avior-evidence-post-runtime-receipt.schema.json | 505 +++++++++--
 config/testing/post-runtime-producer-registry.json |  80 +-
 docs/testing.md                                    |  14 +
 tests/browser-contract/contract-core.mjs           |  66 ++
 tests/browser-contract/contract.mjs                |  68 +-
 tests/browser-contract/fixture-lifecycle.mjs       |  24 +-
 tests/browser-contract/fixture-lifecycle.test.mjs  |  18 +
 tests/browser-contract/run.mjs                     |  21 +-
 tests/browser-contract/scenarios.mjs               |  41 +
 tests/tools/aot-spa-hydration-raw.test.mjs         | 257 ++++++
 .../tools/application-runtime-observation.test.mjs | 481 ++++++++++
 .../behavior-document-consistency-final.test.mjs   |  86 +-
 .../tools/behavior-evidence-post-runtime.test.mjs  | 468 +++++++++-
 tests/tools/blue-green-containment-raw.test.mjs    | 371 ++++++++
 .../browser-contract-observation-raw.test.mjs      | 192 ++++
 .../tools/browser-contract-observed-facts.test.mjs |  61 ++
 .../content-addressed-evidence-store.test.mjs      |   3 +-
 ...t-run-evidence-locator-negative-matrix.test.mjs |   1 +
 tests/tools/post-runtime-accepted-claims.test.mjs  | 520 +++++++++++
 .../post-runtime-observation-producers.test.mjs    |  84 ++
 .../tools/post-runtime-producer-registry.test.mjs  | 473 +++++++++-
 .../tools/release-authority-pure-contract.test.mjs |  71 ++
 .../tools/release-deployment-observation.test.mjs  |  11 +
 .../release-final-current-run-locator.test.mjs     |   3 +-
 .../tools/release-final-evidence-binding.test.mjs  |  11 +
 .../release-final-post-runtime-replay.test.mjs     | 113 +++
 tests/tools/release-manifest.test.mjs              | 109 +++
 tests/tools/release-readiness-raw.test.mjs         | 689 +++++++++++++++
 .../release-required-evidence-catalog.test.mjs     |  56 ++
 tests/tools/release-rollout-evidence.test.mjs      | 548 +-----------
 .../tools/runtime-observation-probe-facts.test.mjs | 156 ++++
 tests/tools/runtime-observation-probes.test.mjs    | 452 ++++++++++
 .../runtime-role-minimal-v3-contract.test.mjs      | 126 +++
 tests/tools/scheduler-owner-identity.test.mjs      | 311 ++++++-
 .../browser-contract-observation-fixture.mjs       | 200 +++++
 .../canonical-post-runtime-source-fixture.mjs      | 169 ++++
 .../support/post-runtime-candidate-fixture.mjs     | 169 ++++
 tests/tools/support/post-runtime-join-fixture.mjs  | 443 ++++++++++
 .../support/release-rollout-evidence-fixture.mjs   | 531 +++++++++++
 .../support/runtime-role-minimal-v3-fixture.mjs    | 142 +++
 tests/tools/test-evidence-receipt-schema.test.mjs  | 265 +++++-
 tests/tools/test-matrix-scheduler.test.mjs         |   2 +
 .../release-rollout-evidence-receipt-contract.mjs  | 575 ++++++++++++
 tools/deployment/release-rollout-evidence.mjs      | 546 +-----------
 tools/deployment/release-rollout-lib.mjs           |  25 +-
 ...ehavior-doc-minimal-contract-build-contract.mjs | 149 ++++
 ...vior-doc-minimal-contract-build-v3-contract.mjs | 239 +++++
 .../behavior-doc-static-admission-contract.mjs     | 219 +++++
 tools/docs/post-runtime-accepted-claims.mjs        | 416 +++++++++
 tools/docs/public-preview-quality-contract.mjs     |  87 +-
 tools/docs/public-preview-quality-publication.mjs  |  26 +-
 tools/docs/public-preview-registry.mjs             |  37 +-
 tools/fact-extractors/post-runtime/adapter.mjs     | 968 +++++++++++++++++++++
 .../post-runtime/application-runtime.mjs           |  33 +
 tools/fact-extractors/post-runtime/current-run.mjs | 137 +++
 .../post-runtime/receipt-seal-contract.mjs         |   8 +
 .../post-runtime/release-deployment.mjs            |  33 +
 .../post-runtime/semantic-contracts.mjs            | 145 +++
 .../release/browser-contract-receipt-contract.mjs  | 436 ++++++++++
 tools/release/check-release-final.mjs              |   2 +
 .../public-preview-quality-receipt-contract.mjs    | 153 ++++
 tools/release/release-final-domain-evidence.mjs    | 154 +++-
 tools/release/release-id-value-contract.mjs        | 247 ++++++
 tools/release/release-id.mjs                       | 240 +----
 tools/release/release-manifest-value-contract.mjs  | 247 ++++++
 tools/release/release-manifest.mjs                 | 243 +-----
 ...ema-compatibility-coordinate-value-contract.mjs |  88 ++
 tools/release/schema-compatibility-coordinate.mjs  |  84 +-
 tools/release/test-evidence-receipts.mjs           | 545 +++---------
 .../aot-spa-hydration-observed-facts.mjs           | 210 +++++
 tools/test-evidence/aot-spa-hydration-raw.mjs      | 312 +++++++
 .../aot-spa-hydration-source-contract.mjs          |  27 +
 tools/test-evidence/blue-green-containment-raw.mjs | 911 +++++++++++++++++++
 .../browser-contract-observation-raw.mjs           | 342 ++++++++
 .../browser-contract-observed-facts.mjs            | 129 +++
 ...anonical-release-authorities-value-contract.mjs | 117 +++
 .../canonical-release-authorities.mjs              |  76 ++
 .../release-authority-bundle-contract.mjs          |  31 +
 .../release-authority-facts-contract.mjs           |  84 ++
 tools/test-evidence/release-readiness-raw.mjs      | 718 +++++++++++++++
 .../runtime-observation-probe-facts.mjs            | 233 +++++
 .../runtime-observation-probe-receipt-contract.mjs |  52 ++
 tools/test-evidence/runtime-observation-probes.mjs | 814 +++++++++++++++++
 tools/test-evidence/runtime-observation-raw.mjs    | 235 +++++
 .../prepared-public-projection-contract.mjs        |  86 ++
 tools/test-fixtures/receipt/projection.mjs         |  84 +-
 .../test-matrix/behavior-evidence-post-runtime.mjs | 603 ++++++++++---
 .../content-addressed-evidence-store.mjs           |  16 +-
 .../test-matrix/post-runtime-producer-registry.mjs | 345 +++++++-
 tools/test-matrix/required-evidence-catalog.mjs    |  55 ++
 tools/test-matrix/scheduler-run-owner.mjs          | 439 ++++++++++
 tools/test-matrix/scheduler.mjs                    | 513 ++++++++++-
 .../test/bundles/behavior-evidence-post-runtime.sh |  39 +-
 .../bundles/post-runtime-observation-producers.sh  | 114 +++
 tools/test/current-run-evidence-publication.mjs    |   1 +
 tools/test/lanes/post-runtime-candidate-plan.sh    |  58 ++
 .../lanes/post-runtime-observation-producers.sh    |   5 +
 tools/test/lanes/production-correctness-receipt.sh |   1 +
 tools/test/lanes/runtime-observation-probes.sh     | 102 +++
 103 files changed, 19241 insertions(+), 2690 deletions(-)
```

