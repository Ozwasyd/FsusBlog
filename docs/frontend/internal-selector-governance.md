# Internal selector governance

`tests/evidence/frontend/internal-selector-registry.json` 是生产前端 `:deep()` 与直接
`.el-*` override 的机器可读事实源。`check:internal-selector-governance` 在本地读取
源码与 registry，不依赖 GitHub API、CI 或网络。

## Ownership classification

每个仍保留的 selector 必须登记 `path`、`kind`、`selector`、`occurrences`、
`owner`、`reason`、`expiresOn` 与 `replacementIssue`：

- `FsusUI`：Blog 依赖组件内部 DOM/BEM；replacement 必须迁移到公开 prop、slot、
  token、variant 或稳定 data hook。
- `FsusBlog`：规则跨越 consumer 自己的组件或运行时生成内容；replacement 必须把
  样式移到 markup owner，或改用稳定的业务 class/data hook。
- `third-party`：只有无法控制的第三方 markup 才可使用；reason 必须说明边界与替代
  计划，不能把 FsusUI 或 Blog 自己的缺口归到第三方。

同一路径可通过 `selectors` 数组继承 ownership metadata，但每个 selector 的 kind、
文本与 occurrence 数仍独立登记。过期、重复、消失但未删的条目都会 fail closed。

## Monotonic budget

`maximumDeepOccurrences` 与 `maximumDirectElOccurrences` 只能随迁移下降。新增 selector
即使没有超过总预算，只要未登记也会失败；删除 selector 后不降低预算或不删除 stale
entry 同样失败。PublicShell 和 ThemeModeToggle 内部 selector 永远不能登记豁免。

不得用以下方式“降债”：

- 把 `:deep()` 改写为全局 `.el-*`；
- 复制 FsusUI SCSS；
- 使用 `!important`、负 margin 或绝对定位补偿；
- 删除样式并接受 focus ring 裁切、任意控件高度或不可解释的像素回退。

## Migration evidence

每个迁移单元先用失败测试固定 selector 数与业务状态，再提交实现。涉及可见几何时，
至少覆盖 light/dark、desktop/mobile，并记录关键 bounding box；非重设计迁移差异不
超过 1px，focus-visible ring 的位置/尺寸差异不超过 2px。控件高度只允许
40/44/48px，spacing 只允许 4/8/12/16/20/24/32px，radius 只允许
4/6/10/12/24px opt-in。

本轮基线、逐 surface 降幅及真实浏览器证据状态记录在
`tests/evidence/frontend/internal-selector-migration-evidence.json`。字段为 `null` 或明确写
`pending` 的场景尚未通过，不得在 issue 或 release evidence 中解释为绿色。
`check:fsusui-boundary` 同时拒绝脚本中的 FsusUI internal DOM 查询；表单错误聚焦等
行为必须使用 `aria-invalid` 或 consumer 自有的稳定 data hook。

无需重启的回退以静态资源槽为单位：切回上一份已验证的 frontend asset 即可。回退
版本可以暂时恢复仍在有效期内的 registry 条目，但不得恢复 PublicShell 内部 selector，
也不得放宽预算或关闭 fail-closed gate。
