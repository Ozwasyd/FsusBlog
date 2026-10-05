# WIP: codex/issue-2143-migration-binding-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2143-migration-binding-20261003`
- 原始 commit：`4732ce5a2515aa838001bcc1a254fda2e9df6929`
- 原始 tree：`fae22b9a958c2b56ecfbde367091271e053725cc`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2143, #3529, #3530, #3525, #1604
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
4732ce5a2 fix(backend): reject migration expiry after running receipt commit
Recheck the original effective deadline after the actual final append and retain its committed cursor. Use the existing Running-to-Failed edge for postcommit cleanup and rollback, without retracting receipt evidence or altering noncommitted recovery. Preserve the primary completion error and secondary recovery failures. Add original callback cancellation and exact sequence source controls; no SDK or tests executed.

Refs: #2143

41b534c1f fix(backend): isolate state callbacks from retained migration bytes
Keep the validated canonical snapshot private. Original state operations receive independent deep-copy carriers checked before and after actual calls, so mutable backing-array access cannot change later apply or rollback payloads. Preserve the existing state authority and add real callback alias controls. Source-only verification; no SDK, tests or state services executed.

Refs: #2143

deab95a15 fix(backend): retain bounded owned migration payload snapshots
Preflight complete payload lengths before work, deep-copy caller-backed transform and default arrays, and verify the actual retained snapshot before asynchronous side effects. Bind forward work to the existing caller and plan-duration budget; preserve uncancelled rollback and receipt hashing. Add true backing-mutation, bounded-payload and deadline controls without running SDK, tests or state services.

Refs: #2143

e1f942a0e fix(backend): verify complete frozen authoring migration digests
Implement the missing canonical plan digest in the original lifecycle owner. Bind ordered transforms, exact scopes, budgets and recovery references; preserve receipt hashing and existing thresholds. Use the production digest in fixtures and add original-digest tamper refusals, legal recomputed plans and an independent protocol vector. Verification is source-only; SDK and tests remain unexecuted.

Refs: #2143

7ae21279e fix(backend): bind migration to exact owned state scopes
Reuse the existing owned-scope guard before lifecycle side effects. Preserve existing cases and add symmetric empty-scope refusals plus the optional-document positive source control. No SDK or tests were executed.

Refs: #2143

b19b3dc71 test(governance): type registry-derived receipt behavior IDs
Refs: #3529
025de17f3 test(governance): align release-final scan fixture with closed contract
Refs: #3530
de05fe6f5 fix(test): rebind current fixture selector evidence
Refs: #3525, #1604
```

## 相对原 merge base 的源码差异概况

```text
.../authoring-extension-host-boundary.md           |  41 ++
 .../AuthoringExtensionLifecycle.cs                 | 335 ++++++++-
 .../Unit/AuthoringExtensionLifecycleTests.cs       | 757 ++++++++++++++++++++-
 3 files changed, 1121 insertions(+), 12 deletions(-)
```

