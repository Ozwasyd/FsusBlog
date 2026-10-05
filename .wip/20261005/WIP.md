# WIP: codex/issue-2025-schema-source-io-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2025-schema-source-io-20261003`
- 原始 commit：`4057b1f03256da6b43da52ca944bf40adb04930a`
- 原始 tree：`a275b94a5406ed84d7559c0e373dfb1ae138a199`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2025, #2020, #3529, #3530
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
4057b1f03 fix(governance): bound fixed semantic schema source reads
Reject nonregular and oversized source files before hydration, retain descriptor/path identity through a bounded read, and preserve the first error across close failures.

Refs: #2020 #2025

c2e70f9ce feat(governance)!: register closed semantic outcome schema dispositions
Keep candidate v1 and registry/algorithm v2 while versioning the contained canonicalization policy. Delegate complete fixed-schema coverage to the single bounded DATA_ONLY query and preserve legacy metadata-only validation obligations.

BREAKING CHANGE: contained outcome canonicalization policy v2 requires closed producer and aggregate schema declarations; policy v1 is refused without a fallback.
Refs: #2020 #2025

9a0fd5dbe fix(governance): preserve finalizer output failure classification
Require the original exact missing-evidence reason for each absent required output without rejecting legitimate partial failures or changing the adapter.

Refs: #2025

be9f78547 fix(governance)!: guard outcome inputs before validation
Reject unsafe or unbounded JSON before any legacy read or digest. Preserve the original per-member missing-evidence classification instead of accepting unrelated global failures.

BREAKING CHANGE: producer outcome analysis requires explicit caller-owned finite hostExpectedLimits; payload budget defaults are not accepted.
Refs: #2025

7a7cc47ba test(governance): register producer analysis source controls
Keep analysis tests as unexecuted SOURCE controls and bind the ordinary external naming metadata without changing the checker.

Refs: #2020 #2025

39747c2ab feat(governance)!: add registry-driven producer outcome analysis
Keep candidate v1 and original adapter contracts while migrating the single disposition registry to v2. Analysis remains data-only; unavailable independent authorities cannot seal outcomes.

BREAKING CHANGE: outcome disposition consumers require registry v2 and registry-canonical-json-sha256-v2; candidate v1 remains unchanged.
Refs: #2020 #2025

b19b3dc71 test(governance): type registry-derived receipt behavior IDs
Refs: #3529
025de17f3 test(governance): align release-final scan fixture with closed contract
Refs: #3530
```

## 相对原 merge base 的源码差异概况

```text
.../producer-outcome-analysis-external-naming.json |   28 +
 config/schemas/aggregate-run-outcome.schema.json   |  180 ++
 .../schemas/producer-semantic-outcome.schema.json  |  610 ++++++
 config/testing/outcome-field-dispositions.json     | 2162 +++++++++++++++++++-
 docs/testing.md                                    |    8 +
 tests/tools/producer-outcome-analysis.test.mjs     |  647 ++++++
 tests/tools/semantic-outcome-contract.test.mjs     |  607 ++++++
 tools/test-matrix/outcomes/outcome-contract.mjs    |  201 +-
 .../outcomes/producer-outcome-analysis.mjs         |  476 +++++
 .../outcomes/semantic-outcome-contract.mjs         |  649 ++++++
 10 files changed, 5550 insertions(+), 18 deletions(-)
```

