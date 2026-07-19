# Issue #1311 account header action handoff

`AccountLayout` 的共享顶栏现在使用一条明确的 FsusUI 控件高度链，而不再混用 36px、40px 与分段主题控件。

| 动作 | 之前 | 现在 |
| --- | --- | --- |
| desktop 主站 | 36px、无常驻边界 | `--fsus-control-height-compact`（40px） |
| mobile 主站 | 40px | `--fsus-control-height`（44px） |
| 主题 | 持久三段选择器 | FsusUI `menu-button`，40px/44px 随壳层密度切换 |
| 账号菜单 | 40px | desktop 40px、mobile 44px |
| mobile 导航 | 40px | 44px，并公开 `aria-controls` / `aria-expanded` |

四类动作都使用 control radius、paper surface、1px 边界、Scholarly Blue hover/open 状态与 2px inset focus ring。边界在所有状态下占位，因此菜单开合不会改变 header 行宽；forced-colors 下改用系统 `ButtonText` 和 `Highlight`。

## 验证证据

- `check:visual-density-governance` 锁定 40px/44px token、`menu-button`、drawer ownership 和 expanded state。
- `AccountHeaderMenu.test.ts` 覆盖账号/管理端切换、policy/logout、登出 loading/disabled 和 mobile icon-only density 标记。
- frontend typecheck 验证 `ThemeModeToggle` 变体与 Vue 属性绑定。

视觉变更严格限于 header action hit area、边界、主题 affordance 与直接需要的对齐；品牌、header 高度、菜单内容、导航信息架构、页面内容和权限保持不变。
