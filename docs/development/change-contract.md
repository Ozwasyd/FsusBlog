# Change contract

本文件说明 FsusBlog 的 commit、pull request、格式迁移和 release note 流程。唯一可执行枚举位于 `tools/governance/change-contract-registry.mjs`；PR/push 的权威执行器是 `tools/governance/check-change-contract.mjs`。`commitlint.config.mjs` 只是给编辑器或外部 commitlint 集成使用的兼容 adapter，不是独立权威，也不能替代仓库 checker。GitHub release 配置和专项测试消费或核对同一 registry，不维护第二套 type/scope 列表。

本规范约束 Git 和 review 元数据，不改变 [跨语言编码规范](coding-conventions.md) 的源码规则。Git branch、GitHub label、test ID 和 CLI key 是外部工具接口，不把 C# `PascalCase` 机械应用到这些名称。

## Commit header

每个可合并 commit 和 squash title 使用：

```text
type(scope): imperative summary

Optional body explains why and risk instead of replaying the diff.

Refs: #1234
```

PR title只校验 header；最终 squash message 和需要进入默认分支的 commit 还必须带 `Refs` footer。英文 summary 使用小写祈使动词开头，不以句点结尾，不使用 `update stuff`、`fix bug`、`cleanup` 等无信息摘要。breaking change 同时使用 header 的 `!` 和 `BREAKING CHANGE:` footer。

允许的 type 是：`feat`、`fix`、`perf`、`refactor`、`style`、`test`、`docs`、`build`、`ci`、`chore`、`security`、`revert`。

- `style` 仅用于 `format-only` 或 `naming-only` 机械变更；不得承载运行逻辑、contract 或测试期望变化。
- `perf` 必须写 `Performance-Claim: S|M|R|C` 和仓库内 `Evidence:` 路径，等级语义继承 #1155 code-intent governance。
- `security` 必须写 `Security-Disclosure: private|not-applicable`，公开 header/body 不得包含漏洞利用细节。
- `refactor` 只声明结构等价，不声明性能、bug fix 或 behavior improvement。
- `docs` 不与运行逻辑修改混合；`test` 不修改产品 runtime。
- `revert` 写 `Reverts: <commit-sha>`，同时保留 linked issue。

允许的稳定 scope 是：`admin`、`aeds`、`api`、`auth`、`backend`、`build`、`cache`、`ci`、`cmake`、`contracts`、`core`、`cpp`、`csharp`、`database`、`deployment`、`docs`、`frontend`、`governance`、`json`、`markdown`、`operations`、`performance`、`privacy`、`public`、`release`、`security`、`shared`、`shell`、`style`、`test`、`tooling`、`wasm`、`yaml`、`zk`。scope 表达稳定 review boundary，不为每个目录、页面或临时任务新增 scope。

有效示例：

```text
feat(frontend): expose article reading progress

Keep progress local to the reader session so a failed sync cannot block reading.

Refs: #1234
```

```text
perf(cache): reduce measured hot-read latency

The cache lookup avoids a repeated allocation on the measured route.

Performance-Claim: R
Evidence: artifacts/performance/hot-read.json
Refs: #1234
```

```text
security(auth): harden session transition checks

Keep public history limited to the defensive boundary.

Security-Disclosure: not-applicable
Refs: #1234
```

## Mechanical migration sequence

Issues #1158、#1159、#1160 以及后续全仓格式迁移严格拆成以下顺序：

1. `build(style)` 或 `feat(governance)` 规则/config commit；
2. 独立 baseline/evidence commit，只记录迁移前事实，不新增允许债务数或错误上限；
3. 独立 `style(<language>)` 纯机械 commit；
4. 后续 commit 把第 3 步的完整 SHA 登记到 `.git-blame-ignore-revs`；
5. 命名或结构修复按模块和 contract boundary 分离。

纯格式 commit 还必须包含：

```text
Change-Class: format-only
Formatter: formatter-name@version :: exact formatter command
Idempotence-Evidence: artifacts/style/idempotence.json
Refs: #1234
```

`Format-only` gate 对每个声明的纯格式 commit 单独复核语言 token、结构语义或规范 formatter 输出；不能通过删除全部空白来近似语义，因为 C/C++ token boundary、Shell/YAML 缩进和 Markdown 空白都可能改变行为。任何数据库 migration、API schema、generated contract 或测试期望语义变化都会失败，必须移到 behavior、naming 或 generated commit。纯格式 commit 不重生成无关 artifact，也不修改外部 contract。

formatter 必须二次运行证明幂等。PR 中的 `Formatter idempotence evidence` 是本 PR 已修改的一个 JSON 文件，schema 为 `fsusblog.format-idempotence-evidence.v1`，至少包含 formatter identity、version、完整 command、被检查的 repository-relative paths、第一次和第二次运行的同一算法 tree digest，以及 `idempotent: true`。checker 重新计算或核对路径和 digest；一段自由文本、未变更路径或只有“已运行”的声明都不是证据。

机械命名 commit 使用：

```text
Change-Class: naming-only
External-Contracts: preserved
Refs: #1234
```

数据库 identity、wire/API schema 和 generated contract 不接受 `Naming-only` 逃逸；需要改变时按 public contract change 审查。一个 commit 无法登记自身 SHA，因此 `.git-blame-ignore-revs` 必须在纯格式 commit 后单独更新。PR gate 从 merge base 到 head 找出本次纯格式 commit，逐个检查其 parent diff，再要求后续 governance commit 登记完全相同的 SHA 集合；包含 blame metadata 的 PR aggregate diff 不会被误当成一份纯格式 diff。

只登记已 review、可达、非 merge、确属 `format-only` 且通过真实 diff 复核的完整 SHA。#1163 生效前已合入、尚无 `Change-Class` footer 的 #1158/#1160 迁移，只能通过 executable registry 中逐个完整 SHA 的 legacy review metadata grandfather；subject 以 `style` 开头不是充分条件，不能用 scope、前缀或通配符扩张 legacy 例外：

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
node tools/governance/check-change-contract.mjs --repository
```

回滚格式迁移时 revert 对应机械 commit；规则/config 和 evidence 独立存在，reviewer 可判断是临时回退还是规范回退。删除 gate 不需要应用重启，但必须以独立 `ci(governance)` 变更说明风险；不要删除历史上仍有效的 blame-ignore SHA。

## Pull request contract

`.github/PULL_REQUEST_TEMPLATE.md` 是结构入口，`Change Contract` status check 是 squash title 和 PR metadata 的权威机器门禁。PR 必须明确 linked child issue、substantive scope summary、至少一个已勾选的 tests entry、classification、coding convention、docs/intent、compatibility/risk、performance、release note、generated binding、rollout 和 rollback；删除这些 section 不能通过 parser。

parser 按 Markdown section 读取字段：heading 必须唯一且位于真实文档结构中，fenced example 不能伪造 section，字段不得跨 section 或重复。required contract checkbox 必须实际勾选；不适用时先在 `Notes For Reviewers` 写明原因，再确认该项已完成审查。`Behavior change`、`Format-only` 与 `Naming-only` 仍按互斥值校验，不能靠保留未勾选模板绕过。

- `Behavior change`、`Format-only`、`Naming-only` 互斥；后两者必须使用 `style` title。
- `Generated output`、`Public contract change`、`External naming exception` 是补充分类。
- `External naming exception` 必须填写一个本 PR 已修改的 repository-relative JSON manifest，schema 为 `fsusblog.external-naming-exceptions.v1`。每个 entry 独立填写 #1157 registry 中的 exact exception ID、受影响 paths 和不可采用内部命名的具体原因；checker 逐项绑定 ID/path scope，并要求所有 entry 的 path union 精确等于 changed files 中全部已登记命名 surface。重复 ID、跨 entry 重复 path、未变更 path、越界 path 和未覆盖 surface 均 fail closed；不得用一个宽泛 ID 覆盖无关路径。
- generated diff 通常与 generator source 同 PR，并列出 source、outputs 和 changed JSON binding manifest。唯一例外是下述严格 post-merge repair。
- generated binding manifest 使用 `fsusblog.generated-output-binding.v1`，至少包含 generator source paths、每个 output 的 repository-relative path 与由 head blob 重新计算的 SHA-256；manifest 自身必须是本 PR changed path，但作为关系证据不递归绑定自身，任意 64 位占位值或未解析 evidence 文件不能通过。
- 已合并 source commit 遗漏 generated output 时，generated-only PR 使用 `fsusblog.post-merge-generated-output-repair.v1`，并且只可选择 trusted registry 中的 canonical producer。manifest 精确绑定 source commit、merged PR、merge commit、当前 source/generator blob、canonical command，以及每个 output 在当前 PR base 的 checked-in digest、source revision 重放的 expected digest 和 candidate head 的 current digest。checker 证明两个 commit 都是当前 PR base 的祖先、source commit 只属于该 merged PR、该 PR 与 source commit 都遗漏 output，然后在 source parent、source revision 和 candidate head 的独立 worktree 中执行 producer。source/generator 改动、未知 command/output、额外 producer output、任意字段或 `latest`/mtime discovery、stale digest、未变化 output 和非 canonical candidate bytes 都 fail closed。
- bot PR 仍须勾选 generated、填写与 PR author login 完全一致的 automation identity，并满足 title、issue、release note 和 evidence 规则；label/edit/synchronize 事件的 sender 不是 bot identity authority。
- unrelated API、UI、database、security 和 style 变更拆分；generated output 与 source 同 PR 但单独标记 review。
- 不设置统一行数上限；复杂度和职责 evidence 由 #1162 约束。
- tracking issue 可以和 child issue 同时关联，但 `Closes` 只写本次实际完成的 child。

PR description 不能用“顺便”扩张 scope。模板复选框是机器输入，不替代测试结果与 reviewer 判断。

External naming manifest 例如：

```json
{
    "schema": "fsusblog.external-naming-exceptions.v1",
    "exceptions": [
        {
            "id": "c-abi-wasm-export",
            "paths": [
                "src/frontend/wasm/aeds/src/exports.cpp"
            ],
            "reason": "preserve the caller-visible C ABI spelling"
        },
        {
            "id": "shell-environment-variable",
            "paths": [
                "tools/example.sh"
            ],
            "reason": "preserve the caller-visible process environment key"
        }
    ]
}
```

S/M/R/C 只允许 `perf` PR title，并且一个 PR 必须只有一个绑定的 perf commit。`Evidence path` 是本 PR changed path 中的 `fsusblog.performance-claim-evidence.v1` JSON manifest，至少包含：

```json
{
    "schema": "fsusblog.performance-claim-evidence.v1",
    "changeRevision": "0123456789abcdef0123456789abcdef01234567",
    "claimLevel": "R",
    "status": "measured",
    "evidence": [
        {
            "path": "artifacts/performance/hot-read-result.json",
            "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }
    ]
}
```

Level S 的 `status` 必须是 `structural-only`；M/R/C 必须是 `measured`。checker 将 `changeRevision` 绑定到本 PR 唯一 perf commit，并从 candidate head 重算每个 changed evidence file 的 SHA-256。这个 binding manifest 只证明 identity/path/blob 绑定；具体测量是否达到 #1155 的机器、runtime、artifact、统计与 route/capacity authority，仍由相应 evidence checker 判断，不能用一个自报 `measured` 字段替代。

### GitHub execution topology

`pull_request` job 把 candidate head 与 `pull_request.base.sha` 分别 checkout。它从 trusted base checkout 加载 checker，通过 `--root` 审计 candidate repository，避免 PR 先把自己的 gate 改成 no-op；candidate diff 使用 merge base 到 head，而不是把 base 后续提交反向算入 PR。删除、rename 和 file-type change 都属于 changed-path 集合。

trusted base/before checkout 必须使用完整 reachable Git history（`fetch-depth: 0`）。blame-ignore、format-history 和 merge-base 审计需要读取被登记 revision 及其 parent；shallow trusted checkout 造成 object 不可达时属于 CI invocation defect，不能降级为跳过历史校验或把 candidate checker 当作 fallback。checkout 仍固定到 PR base 或 push `before` SHA，并保持 `persist-credentials: false`。

trusted registry 还列出 gate、workflow、template、release config 和 commitlint adapter 的 policy file set。candidate PR 若修改其中任一文件，base checker 会按 Git object 比较并拒绝该 PR，不能把必需 token 留在注释里后替换未来 gate。默认分支当前由 repository ruleset 要求所有变更先经过 pull request；ruleset 的 enforcement、target 和 bypass actors 必须在执行时从 GitHub 回读，不能用历史文档或本地权限推断。policy bootstrap 仍须使用 owner 明确授权且满足当前 ruleset 的升级路径，不存在普通 contributor 例外。

PR 合并到 `master` 后，`push` job 优先从 `github.event.before` checkout 前一版本 checker 审计 candidate 的 `before..after` commit range；首次安装没有前序 checker 时才由 candidate bootstrap。`workflow_dispatch` 使用 candidate checker 执行 repository audit。push job 发生在 GitHub 接收对象之后，因此仍是事后审计；预防控制来自 ruleset 和配置为 required 的 pull-request status checks。GitHub Actions 可用时，本地通过不能替代这些远端 checks；若 Actions 明确被关闭或不可用且没有可执行的远端 check，maintainer 只有在本地等价 CI 全绿并把命令、结果和 Actions 状态记录到 PR 后才可合并。远端 check 缺失或未运行不得表述为通过。

## Release note authority

`.github/release.yml` 根据已合并 PR 的唯一 `release-note:*` label 生成 release notes；仓库不再维护与它并列的根 `CHANGELOG.md`。分类是 `Added`、`Changed`、`Fixed`、`Security`、`Deprecated`、`Removed`、`Internal/Tooling`，另用 `none` 排除无需记录的变更。启用门禁前必须在 GitHub 创建 registry 中全部 `release-note:*` labels；配置文件本身不会创建 label。

PR body 的 Audience、Category、Summary 必须和 label/type 一致。GitHub 生成器实际把 merged PR title 渲染为条目文本，因此除 `Category: none` 外，`Summary` 必须逐字等于 PR title 中 `type(scope):` 后的 summary；`none` 必须写 `Summary: none`。body Summary 不是第二份可独立漂移的 changelog 文案：

- user-facing：`Added`、`Changed`、`Fixed`、`Security`、`Deprecated`、`Removed`；
- internal：`Internal/Tooling`；
- none：`none` / `release-note:none`。

纯格式、内部 rename 和 CI 重排禁止进入 user-facing 分类。安全条目只描述防御结果，不公开漏洞细节。generated 或 bot PR 也不自动豁免 release 分类。

## Machine identifier exceptions

以下外部工具 identity 明确保留，不映射为源码标识符：

| Kind | Convention |
| --- | --- |
| `git-branch` | lowercase/kebab-case |
| `github-label` | lowercase/kebab-case，namespace 使用冒号 |
| `test-id` | lowercase/kebab-case |
| `cli-key` | lowercase/kebab-case |

这些例外只保护 Git/CLI surface；同一概念进入 C#/TS/C++ 内部 symbol 后仍服从 [跨语言命名映射](coding-conventions.md#naming-map)。

## Local checks

本地 WIP commit 不要求每次都满足 release message，但进入 review 前应检查 staged message 或候选 squash title：

```bash
node tools/governance/check-change-contract.mjs --message-file .git/COMMIT_EDITMSG
node tools/governance/check-change-contract.mjs --title "fix(backend): reject stale session state"
node tools/governance/check-change-contract.mjs --range origin/master..HEAD
node tools/governance/check-change-contract.mjs --repository
node --test tests/tools/change-contract.test.mjs
```

GitHub `Change Contract` job 使用 merge-base/head diff、PR title/body、labels、PR author、evidence manifests 和 blame-ignore history 复核；本地通过不能替代可用且已配置的 protected branch status check。只有 Actions 明确被关闭或不可用时，才使用上文定义的本地等价 CI 例外，并保留 PR 证据；合并后的 push job 仍报告为 post-merge audit。
