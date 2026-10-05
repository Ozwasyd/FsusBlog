# WIP: codex/issue-3493-behavior-doc-generated-sections

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3493-behavior-doc-generated-sections`
- 原始 commit：`ca11d9ffc00316f82af9d9778c86084ad300daf1`
- 原始 tree：`39f8d51d68a2ebdd9bc9ec99525d4716a2f97f14`
- 与当前 master 的 merge base：`e9d28d062e8fb69ed4913ebafca635dbb1664440`
- 相关 issue 线索：#3493, #3492, #1604, #3123, #1924, #3244, #3488, #1805, #3483, #3487, #3486, #1599
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
ca11d9ffc fix(docs): restore BehaviorDoc generated fixed point
Regenerate only the catalog-owned ranges and bind the exact generated output.

Refs: #3493

e9d28d062 fix(test): reseal current fixture evidence selectors
Closes #3492

Refs: #1604
fa949c455 fix(release): exact-bind GC apply to reviewed protected manifests
Refs: #3123
96d6cb712 fix(governance): require stale dependency branches to rebase
Refs: #1924
5145e3eef fix(governance): verify javascript formatting with a trusted parser
Refs: #3244
4915be1e3 fix(ci): repair three pre-existing base gate failures (#3488)
* fix(ci): skip clean-attempt admission for plan-only invocations

ci-production --plan-only (and the validate-matrix governance chain that
seals the DAG through it) failed closed with attempt.provenance-missing:
consumesProductionCorrectness gated on the command name without checking
whether the invocation actually consumes correctness evidence. A plan-only
invocation prints the resolved DAG and executes no producer, so the
current-run clean-attempt evidence cannot attach to it.

Skip the admission only when --plan-only is present; real ci-production,
ci-tier production-correctness, and ci-release-final executions still
require FSUSBLOG_CLEAN_ATTEMPT_EVIDENCE and fail closed without it.

The release-final execution-graph test now supplies the isolated
ci-release-final run with the file-backed clean-attempt evidence input a
real correctness run would publish, produced through runProducerAttempts
and bound to the aggregate, attempt artifact, and verified external
authority receipts.

Refs: #1805

* fix(wasm): select only the pinned CMake identity for wasm builds

The wasm toolchain contract (tools/frontend/ensure-wasm.mjs
wasmToolchainContract.cmakeVersion) accepts exactly CMake 4.3.3, but
build.sh's CmakeIsSupported admitted any supported host CMake outside
the incompatible [4.2.0, 4.3.3) band. On a host with CMake 4.4.1,
SelectCmake reused it, exported FSUSBLOG_WASM_TOOLCHAIN_CMAKE=4.4.1, and
ensure-wasm then failed the whole frontend-inclusive bootstrap with a
toolchain identity mismatch instead of falling through to the pinned
bootstrap.

Require candidates to report exactly the version pinned by
tools/frontend/ensure-cmake.sh (read once, single source), so a host
CMake at the pinned version is still reused while any other version
falls through to the checksummed 4.3.3 bootstrap. The pin itself is
unchanged.

Refs: #1805

* fix(test): scope current-schema drift injections to canonical tables

The current-schema bootstrap lane's negative stages selected mutation
targets across the whole public schema, but the materialized database
also carries the runtime rollup tables (CurrentSchemaRuntimeRollupTables)
that CurrentSchemaStartupVerifier requires rather than compares. The
canonical model declares no CHECK or foreign-key constraint, so the
lane's ownedCheckConstraint query always landed on a rollup-table CHECK:
the NOT VALID drift was invisible to the verifier, which exited 0 and
aborted the lane with 'constraint-validated unexpectedly passed'.

Extend the generated verifier harness with --print-canonical-tables and
scope every drift-injection selection (default, index, precision,
collation, sequence, deferrable, check, and foreign-key targets) to
canonical-owned tables. constraint-validated now honestly reports
not-applicable on a schema with no owned CHECK/FK — the outcome the
coverage registry allows — and will exercise the rejection again if the
canonical schema gains one.

Refs: #1805

---------

Co-authored-by: Fixture <fixture@example.invalid>
87ef84b15 fix(ui): 管理端窄视口溢出与触摸目标修复 (#3483) (#3487)
* fix(ui): 管理端窄视口溢出与触摸目标修复 (#3483)

- AuditLog: 操作者/目标哈希单元格与详情面板 break-all 折行,消除
  850px+ 不可断 token 溢出;compact 元信息 span 限宽截断;分页器
  窄屏精简布局 + 横向滚动包裹;筛选网格子项限宽;日期范围单元格
  独立滚动;查看/校验动作最小触摸尺寸。
- MessageCenter: load-more 按钮补足最小触摸高度。
- AdminArticleCompactCard: 分类标签限宽截断,修复 xs-mobile
  zoom-125 下 378px 溢出。

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>

* fix(tests): viewport checker 识别 el-table 受控横向滚动 (#3483)

el-table 通过 JS 同步表头/固定列与可滚动 body,其溢出为组件支持的
受控滚动。checker 此前只识别通用 overflow 祖先与 el-tabs 箭头导航,
现对齐:当 el-table 的 scrollbar wrap 真实可滚动时视为受控溢出。
未放宽任何阈值。

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>

---------

Co-authored-by: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
343586372 fix(test): reconcile stale backend test governance baselines (#3486)
Register the missing fixture-backed PostgreSQL classes in
postgres-test-collections.json, drop the retired
AdminSessionValidationServiceTests entry, and recompute
estimatedFacts to the rediscovered fixed point; regenerate
backend-evidence-path-authority.generated.json through its
canonical producer after the matrix.yml drift; route
CanonicalArticlePublicationFixturePortTests repository-root
reads through BackendTestPaths per the path-governance rule;
refresh the checker test expectation and testing.md fact count.

Refs: #1599

Co-authored-by: Fixture <fixture@example.invalid>
Co-authored-by: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
```

## 相对原 merge base 的源码差异概况

```text
...vior-doc-generated-sections-generated-binding.json | 15 +++++++++++++++
 docs/testing.md                                       | 19 +++++++------------
 2 files changed, 22 insertions(+), 12 deletions(-)
```

