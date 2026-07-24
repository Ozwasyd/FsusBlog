# Frontend Source Index 与 rule host

`tools/frontend/run-source-rule-host.mjs` 是 source-bound frontend governance
的 canonical producer。每次运行都重新枚举完整 `src/frontend/src` 输入树，
并把 commit、worktree fingerprint、run ID、parser/toolchain version、每文件
SHA-256 和输入树 digest 绑定到同一份 index。它不是跨 commit 缓存；任一
Vue、TypeScript、JavaScript、CSS 或 SCSS 输入变化都会产生新的 tree digest
并重新完成 inventory、read 和 primary parse。

## 解析与诊断契约

一次主解析提供 Vue SFC block/span、TypeScript AST/import graph、template
class/ARIA/text/route/component metadata，以及 CSS declaration/token/span。
rule 只能读取内存 index，不得再次遍历源码。每条 rule 仍拥有独立 rule ID、
coverage ID、finding、source span、receipt digest 和 pass/fail。index 缺失、
parser version 漂移、host 崩溃、receipt 缺失、digest 漂移或 source span
不能回指输入文件时，host 必须失败。

机器证据写入 `.tmp/frontend/source-rule-host/`：

- `source-index.json`：完整 inventory 和 inventory/read/parse 计数；
- `owner-registry.json`：所有 `src/frontend/package.json` 中 `check:*`
  命令的唯一 owner；
- `receipts/*.json`：每条迁移 rule 的独立 receipt；
- `rule-host.json`：常驻 host 汇总；
- `migration-before-after.json`：迁移前后 Node 进程、重复源码读取/解析以及
  conclusion/finding identity 等价结论。

writer、临时 fixture、真实 runner/CLI 检查和未迁移规则继续保留独立进程。
owner registry 会显式说明其 owner 与原因；不得为了减少进程数把这些边界
并入 read-only host。

## 本地运行与回退

```bash
node tools/frontend/run-source-rule-host.mjs
```

如需无重启降级，只需把 `tests/matrix.yml` 中
`frontend-source-rule-host` 恢复为原有独立 checker entries；原
`check:font-size-contract` 和 `check:font-weight-contract` 命令仍保留，
可直接执行并与 migration evidence 对照。回退不得复用旧 index 或 receipt。
