# FsusBlog Design Governance

> **Role:** FsusBlog 规范性设计治理入口
> **Applies to:** 所有页面、布局、组件组合、主题、token、排版、图标、动效、响应式与渲染输出变更
> **Authority:** 解释 FsusBlog 如何消费当前 FsusUI 设计契约；不修改或复制 FsusUI 的通用设计系统

FsusBlog 的产品方向是“内容优先的编辑式阅读 + 安静、紧凑的任务界面”。公共面让内容承担视觉焦点，账户与后台让当前任务承担视觉焦点；两者共享 FsusUI 的组件、token、状态和交互语言，不各自建立通用 UI 体系。

## 1. 设计基线

每个设计任务先解析实际生效的 FsusUI 基线。`src/frontend/scripts/fsusui-local.ts` 是本地 alias 解析事实源：

- `FSUSBLOG_USE_LOCAL_FSUSUI` 未显式设为 `0` 或 `false`，且 `FSUSBLOG_LOCAL_FSUSUI_ROOT` 或默认同级 `FsusUI` 包含有效源码时，以该源码为当前设计基线；
- 记录源码绝对路径、Git HEAD 和工作区是否 dirty，再读取其中的 `docs/index.md`、`docs/design.md`、设计治理、相关领域契约和 `.agents/skills/fsusui-design-conformance/SKILL.md`；
- 本地 alias 不生效时，才使用 lockfile 中的精确包版本或 CI 明确 pin 的源码基线；若该基线不携带权威设计文档，只能完成兼容性审查，不能声称已按当前 FsusUI 设计契约验收。

包版本不能覆盖一个实际生效的本地源码 alias，历史截图也不能覆盖当前基线的规范。

## 2. 规则优先级

冲突按以下顺序解决：

1. 安全和无障碍要求；
2. 当前生效 FsusUI 基线的规范、设计文档与公共领域契约；
3. 本文档；
4. [`surface-profiles.md`](surface-profiles.md) 与最近的 FsusBlog 领域设计文档；
5. 已批准的实现和视觉基线；
6. workflow、示例、框架默认值、流行样式或实现者偏好。

低优先级来源不得改变高优先级语义。通用视觉规则归 FsusUI；FsusBlog 不另建通用 UX 或 accessibility 规范。产品特有的无障碍应用要求写入最近的 surface profile 或业务契约。

## 3. 所有权

FsusUI 拥有：

- 公共组件 API、内部几何和 documented variants；
- 通用颜色、排版、间距、圆角、材料和动效 token；
- 控件状态、键盘行为、focus、overlay 与共享无障碍语义；
- 可复用的 task、navigation、form、data-region 和 feedback primitives。

FsusBlog 拥有：

- route、信息架构、业务流程、产品文案和内容顺序；
- 页面构图、内容优先级、阅读列与编辑式布局；
- 从 documented variants 中进行选择；
- 具有产品语义的 `--fsusblog-*` token；
- 真实内容 fixtures、端到端状态和视觉证据。

通用 primitive 在有效消费者中都不正确时，在 FsusUI 修复；route 构图、内容层级或 variant 选择错误时，在 FsusBlog 修复。不得用 consumer compatibility wrapper 同时掩盖两侧问题。

## 4. 组件与 token 边界

FsusBlog 必须通过 FsusUI 的公共组件、props、slots、tokens 和稳定 data hooks 组合页面。

FsusBlog 不得：

- 定义、伪造或覆盖 `--fsus-*` token；
- 抄录 FsusUI token 的数值作为本仓权威值；
- 使用 `:deep()`、`.el-*` 内部结构、生成路径或 private import 修理组件几何；
- 为单页 fork 通用 FsusUI 组件或隐藏其缺陷；
- 为获得圆角、glass、阴影或动效而错误标注 surface；
- 把页面构图反向写成 FsusUI 的全局默认值。

`--fsusblog-*` 必须表达 Blog 产品语义，并可映射到当前 FsusUI 的公共 token。产品 wrapper 只有在增加业务语义或稳定构图时才允许存在，不能替换 primitive。

## 5. 变更分类

开始修改前必须声明：

- 当前 FsusUI 基线；
- owner 是 FsusUI 还是 FsusBlog；
- [`surface-profiles.md`](surface-profiles.md) 中的设计档案；
- 受影响的信息层级、组件、状态、主题、locale、视口和 reduced-motion 行为；
- 本次是恢复既有契约，还是提出设计契约变更；
- 明确的改动范围与不改范围。

若无法判定 owner，先用最小 fixture 在 FsusUI 公共 primitive 与 FsusBlog 页面组合之间定位问题，不得先写 override。

## 6. 保持默认

除非任务明确授权，保持信息架构、内容顺序、操作数量与优先级、主视觉焦点、组件语义和现有无障碍行为。

不要为了“更完整”顺手增加卡片、badge、icon、helper copy、CTA、illustration、gradient、glass、shadow、glow 或 decorative motion。公共面保持内容优先，task surface 保持低噪声和可操作密度；缺少证据时选择恢复契约所需的最小完整变更。

## 7. 例外

只有上游或最近领域契约提供明确例外机制时才允许例外。例外必须记录语义原因、精确范围、owner、影响状态和平台、验证证据、移除或复审条件。审美偏好、框架默认值、模仿其他产品、避免上游修复或让单张截图通过均不是有效理由。

## 8. 证据与文档所有权

静态 checker、编译或零 diff 截图不能单独证明设计验收。视觉变更必须检查受影响的真实状态、Light/Dark、窄宽视口、locale 扩展、键盘焦点、zoom、overflow 和 reduced motion，并记录实际查看的 rendered evidence。

设计文档按单一关注点分工：

- 本文档拥有设计基线、所有权、优先级和变更治理；
- [`surface-profiles.md`](surface-profiles.md) 拥有 route/surface 构图分类；
- [`reading-typography.md`](reading-typography.md) 拥有阅读排版；
- [`task-surface-geometry.md`](task-surface-geometry.md) 拥有 FsusBlog 对 task-surface 几何语义的消费方式；
- [`page-title-scale.md`](page-title-scale.md) 拥有产品级标题层级；
- [`../public-layout-rules.md`](../public-layout-rules.md) 拥有公共与编辑式页面构图；
- [`../frontend/layout-visual-governance.md`](../frontend/layout-visual-governance.md) 拥有代表页面、截图和 baseline movement 证据。

workflow 与 Skill 只引用这些事实源，不复制设计值。
