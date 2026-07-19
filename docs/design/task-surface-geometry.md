# Task surface geometry

账户与后台属于 task surface。它们直接消费 FsusUI 的 4px spacing 与语义圆角，不再在页面或组件内定义第三套几何值。

## Spacing

CSS 中的 `gap`、`padding` 与 `margin` 使用下列现有 token：

| Token | 值 | 用途 |
| --- | ---: | --- |
| `--fsus-space-1` | 4px | 图标与文字、最小行内间距 |
| `--fsus-space-2` | 8px | 控件内部、紧凑操作组 |
| `--fsus-space-3` | 12px | 紧凑列表与表单 |
| `--fsus-space-4` | 16px | 默认组间距 |
| `--fsus-space-5` | 20px | 中等面板间距 |
| `--fsus-space-6` | 24px | Dialog、Card、Drawer 主 padding |
| `--fsus-space-8` | 32px | 页面区块与 viewport 安全间距 |

Tailwind utility 仍可用于整数 4px 档位；task surface 禁止 `.5` 档位和局部 `px/rem` spacing。阅读与编辑预览不是 task surface，继续由各自的 reading/editorial 契约管理。

## Radius

行内标记、控件、popover、panel、expressive 与 pill 分别使用 `--fsus-radius-control-small`、`--fsus-radius-control`、`--fsus-radius-popover`、`--fsus-radius-panel`、`--fsus-radius-panel-large` 与 `--fsus-radius-pill`。组件不得使用通用 `rounded-*` 或局部 radius 字面值代替语义 token。

## Dialog

`FsusDialog` 的宽度类型由 `src/frontend/src/fsusui/dialog.ts` 统一定义，仅包含：

- default：`50%`
- compact：`min(92vw, 28rem)`
- extra compact：`min(92vw, 24rem)`
- long-form：`min(92vw, 48rem)`

Wrapper 只负责 viewport containment，并把 FsusUI 的 Dialog padding 固定到 `--fsus-space-6`；header、body、footer 的边界和布局继续由 FsusUI 所有。移动端不再覆盖调用方宽度，也不新增页面级 Dialog breakpoint。

## Responsive tiers

Task surface 使用 `640 / 768 / 1024 / 1440px` 四个起始档位，对应的闭区间上界为 `639 / 767 / 1023 / 1439px`。窄屏横向只保留共享的 `max-height: 520px` 特例。组件不得为单页新增 `480/560/760/900/960px` 等私有档位。

## Verification boundary

`node tests/frontend/checks/static/check-task-surface-geometry.mjs` 扫描账户、后台共享 CSS 与组件，校验 spacing、radius、Dialog 宽度和 breakpoint。Article Write、scheduled publish、revision 及编辑/阅读预览文件明确排除，由其各自 issue 与 reading/editorial 契约负责。
