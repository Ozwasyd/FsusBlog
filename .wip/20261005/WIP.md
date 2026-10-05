# WIP: codex/issue-3551-backend17-integration-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3551-backend17-integration-20261003`
- 原始 commit：`a573fd2c66f0cf3e77e0b655a2061d1dab8f9348`
- 原始 tree：`0107f0e8435c92a5c65bfad544b1144cdeee0ff9`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3551, #3554, #3558, #3560, #3562, #3564, #3566, #3568, #3570, #3572, #3574, #3576, #3578, #3580, #3582, #3586, #3588, #3590, #1914, #2427, #3597, #3559, #3529, #3530
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
a573fd2c6 chore(backend): bind integrated owner external naming metadata
Declare each changed registered naming path once under the original trusted schema; preserve all frozen backend and prerequisite source bytes.

Refs: #3551, #3554, #3558, #3560, #3562, #3564, #3566, #3568, #3570, #3572, #3574, #3576, #3578, #3580, #3582, #3586, #3588, #3590, #1914, #2427, #3597

461a29300 fix(backend): integrate frozen backend evidence owners on current master
Carry exact frozen scoped owners and their original minimal runtime prerequisites without restoring historical trees or changing scanner policy. Compilation, runtime evidence and issue acceptance remain unverified.

Refs: #3551, #3559, #3554, #3558, #3560, #3562, #3564, #3566, #3568, #3570, #3572, #3574, #3576, #3578, #3580, #3582, #3586, #3588, #3590, #1914, #2427, #3597

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
.../issue-1914-current-external-naming.json        |  12 +
 ...3551-backend17-integration-external-naming.json |  20 +
 docs/architecture/overview.md                      |   2 +-
 .../AuthoringExtensions/AuthoringExtensionRpc.cs   |  11 +
 .../DocumentExport/DocumentExportHtmlSanitizer.cs  |   5 +
 .../Unit/AccountSubjectHashProjectionTests.cs      |  31 ++
 tests/backend/Unit/ArticleVaultExecutionTests.cs   | 217 +++++++--
 .../Unit/AuthoringCommandContributionTests.cs      | 208 ++++++++-
 .../AuthoringExtensionExecutionResolverTests.cs    | 403 ++++++++++++++++-
 .../AuthoringExtensionPackagePersistenceTests.cs   | 380 +++++++++++++++-
 tests/backend/Unit/AuthoringExtensionRpcTests.cs   | 498 ++++++++++++++++++++-
 .../Unit/AuthoringExtensionServiceBrokerTests.cs   | 218 ++++++++-
 .../Unit/AuthoringExtensionWorkerSandboxTests.cs   | 203 ++++++++-
 .../CanonicalArticlePublicationFixturePortTests.cs | 158 ++++++-
 tests/backend/Unit/DocumentExportContractTests.cs  | 160 ++++++-
 .../Unit/DocumentExportHtmlProviderTests.cs        | 445 +++++++++++++++++-
 tests/backend/Unit/DocumentExportSandboxTests.cs   | 390 +++++++++++++++-
 .../DocumentExportSystemdCgroupAuthorityTests.cs   | 298 +++++++++++-
 tests/backend/Unit/PrivateAssetDeliveryTests.cs    | 118 +++--
 tests/backend/Unit/PrivateAssetStoreTests.cs       | 265 +++++++++--
 .../backend/Unit/PublicArtifactRevocationTests.cs  | 198 ++++++--
 .../backend/Unit/PublicHotReadDbAdmissionTests.cs  | 264 ++++++++++-
 tests/backend/Unit/SpaAssetManifestServiceTests.cs |  47 +-
 tests/tools/execution-envelope-network.test.mjs    | 304 ++++++++++++-
 tools/test/native/execution-envelope-landlock.c    | 110 +++--
 25 files changed, 4554 insertions(+), 411 deletions(-)
```

