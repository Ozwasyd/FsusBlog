# Task surface geometry

账户与后台属于 [`surface-profiles.md`](surface-profiles.md) 的 `task` 档案。它们消费当前 FsusUI 基线的 task-surface spacing、radius、overlay 与 responsive 语义，不在页面或组件内定义第三套几何值；所有权和变更路由见 [`governance.md`](governance.md)。

## Spacing

CSS 中的 `gap`、`padding` 与 `margin` 必须选择当前 FsusUI 基线公开的 spacing token 或等价 utility。选择依据是语义角色和 task density，而不是复制 token 数值；页面不得引入私有半档、局部 `px/rem` 标度或第三套 spacing alias。阅读与编辑预览不属于 task geometry，继续由 reading/editorial 契约管理。

## Radius

行内标记、control、popover、panel、expressive 与 pill 必须选择当前 FsusUI 基线对应的 public semantic token。组件不得使用通用 `rounded-*`、局部 radius 字面值或 `--fsusblog-*` 影子 token 代替上游组件几何；需要新角色时先在 FsusUI 证明其可复用性。

## Dialog

`src/frontend/src/fsusui/dialog.ts` 只选择并命名当前 FsusUI 公共契约提供的 documented variants。Wrapper 负责产品语义和 viewport containment；Dialog width、padding、header、body、footer、focus 与 motion geometry 继续由 FsusUI 所有。移动端不得覆盖调用方宽度，也不得新增页面级 Dialog breakpoint。

## Responsive tiers

Task surface 使用 `640 / 768 / 1024 / 1440px` 四个起始档位，对应的闭区间上界为 `639 / 767 / 1023 / 1439px`。窄屏横向只保留共享的 `max-height: 520px` 特例。组件不得为单页新增 `480/560/760/900/960px` 等私有档位。

## Account CSS ownership

本文件只定义 FsusBlog 如何消费跨表面的 task-surface spacing、radius、Dialog 与 breakpoint 语义。Account 的 base、identity 与 admin frame CSS 分层以 [Account style ownership](../frontend/account-style-ownership.md) 为唯一事实源；这里不复制 token 数值、selector、import 或 frame-root 清单。

## Verification boundary

`node tests/frontend/checks/static/check-account-css-ownership.mjs` 验证领域文档中的三层 CSS 边界；`node tests/frontend/checks/static/check-task-surface-geometry.mjs` 扫描账户、后台共享 CSS 与组件，校验 spacing、radius、Dialog 宽度和 breakpoint。Article Write、scheduled publish、revision 及编辑/阅读预览文件明确排除，由各自 reading/editorial 契约负责。
