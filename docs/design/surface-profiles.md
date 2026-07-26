# FsusBlog Surface Profiles

> **Role:** FsusBlog 规范性页面构图分类
> **Applies to:** route-level 页面和跨页面 overlay
> **Authority:** 在 [`governance.md`](governance.md) 的所有权边界内定义 Blog 产品构图；组件几何和通用 token 仍由当前 FsusUI 基线拥有

每个视觉任务必须先选择一个主档案。Route 保持一个主档案；其中的 `MarkdownRenderer` 可局部消费 `reading` 规则，empty/error region 可局部消费 `status` 规则，`overlay` 可作为跨切档案叠加在宿主页面上。这些局部语义不能改变宿主页面的内容层级，也不得为了取得某种视觉效果临时切换。

## 1. 档案映射

| 档案 | 典型范围 | 主视觉焦点 |
| --- | --- | --- |
| `public-editorial` | 首页、归档、分类、标签、搜索、About 与政策文档 | 内容主题或当前内容集合 |
| `reading` | 文章、评论、Markdown、文章预览 | 正文与当前阅读位置 |
| `task` | 身份中心、后台、表单、集合、设置、控制台、消息中心 | 当前任务、状态或下一步操作 |
| `focused-auth` | 登录、注册、恢复与身份验证步骤 | 单一身份目标 |
| `status` | 403、404、空状态与不可恢复错误 | 当前状态与恢复路径 |
| `overlay` | Dialog、Drawer、Popover、Lightbox | 临时任务或被放大的内容 |

未知 route 先按信息目标和 shell 归类；不要按现有 CSS 外观或希望使用的组件归类。

## 2. `public-editorial`

- **Shell：** 使用公共 shell；header 是唯一站点品牌面，正文不复制站点 Hero。
- **层级：** 每页只有一个内容主线。首页使用单主推荐和连续文章流；索引、筛选和文档页以标题、说明和内容集合顺序展开。
- **宽度与密度：** 使用 FsusBlog 公共容器与内容列语义；不套用 admin dashboard、KPI grid 或 task card 密度。
- **材料：** 默认 paper/document surface。普通内容区不使用 glass、glow、gradient 或 decorative shadow。
- **排版与操作：** 页面 H1 使用 [`page-title-scale.md`](page-title-scale.md)；文章标题、摘要和 metadata 使用 [`reading-typography.md`](reading-typography.md)。内容链接是主入口，避免重复 CTA。
- **动效：** 内容块默认静态；仅使用当前 FsusUI 基线允许且不延迟访问的 route settle、focus 与状态反馈。
- **响应式：** Desktop/Mobile 和 Light/Dark 保持相同内容顺序与主焦点，不用 breakpoint 隐藏关键信息。
- **必验状态：** short/long content、无封面、空集合、loading、error、分页、locale 扩展、AOT/hydration/SPA 一致性、Light/Dark、窄宽视口、zoom 和 reduced motion。

具体首页和封面构图见 [`../public-layout-rules.md`](../public-layout-rules.md)。

## 3. `reading`

- **Shell：** 文章和公开评论使用公共 shell；管理端预览可以处于 task shell，但正文内部仍按 reading profile 渲染。
- **层级：** 正文是唯一主视觉焦点。TOC、metadata、评论和 reading aids 是次级信息，不形成竞争卡片或第二个 page title。
- **宽度与密度：** 正文、宽媒体和 full-bleed 区域使用 FsusBlog reading layout 语义；长代码只在自身容器滚动。
- **材料：** 正文使用 document surface 和中性边界。普通图片、代码块、引用、评论与 TOC 不使用 glass、glow 或装饰阴影。
- **排版与操作：** 完整排版由 [`reading-typography.md`](reading-typography.md) 拥有；复制、目录跳转、评论和媒体查看保持清晰的文本或状态反馈。
- **动效：** 正文、标题、图片和代码块静态出现，不使用 scroll reveal、stagger、translate 或 scale。允许复制反馈、focus/target 定位、阅读进度状态和 media overlay settle；reduced motion 保留语义并移除非必要位移。
- **响应式：** 不改变 DOM 阅读顺序；TOC 和 reading controls 的移动端形态不得遮挡正文或造成横向溢出。
- **必验状态：** 极短与极长文章、长标题、无图片与宽图片、长代码、无评论与多评论、preview/document modes、keyboard、focus、zoom、Light/Dark、窄宽视口和 reduced motion。

## 4. `task`

- **Shell：** 身份中心与后台使用 account/admin shell、稳定 chrome 和唯一页面 header；inbox takeover 仍保留当前模块上下文。
- **层级：** 当前任务、状态和下一步操作优先。说明、统计与辅助操作不得压过 primary action。
- **宽度与密度：** 使用 FsusUI task primitives 和 [`task-surface-geometry.md`](task-surface-geometry.md) 的消费边界；dashboard 保持可操作摘要，不演化为装饰 KPI 墙。
- **材料：** quiet surface、清晰分组和必要边界优先；普通 form、collection、settings 与 console 不使用 public editorial hero 或 expressive glass。
- **排版与操作：** 页面标题由 [`page-title-scale.md`](page-title-scale.md) 拥有。危险、批量、pending、partial、success 和 error 状态使用 FsusUI 语义 primitive。
- **动效：** 只解释 route settle、pending/settled、row update、focus 和 overlay 状态。批量操作反馈 summary，不逐行 stagger。
- **响应式：** 桌面侧栏与移动 Drawer 表达同一导航；不新增第二套导航、页面私有 breakpoint 或改变权限过滤结果。
- **必验状态：** anonymous/unauthorized/authorized、权限裁剪、empty/loading/error/success/partial/disabled、长表单、长表格、mobile Drawer、keyboard、focus return、zoom、Light/Dark 和 reduced motion。

## 5. `focused-auth`

- **Shell：** 使用专注身份流程的单列构图；站点 chrome 只提供必要返回路径，不引入 marketing 版式。
- **层级：** 一个语义 H1、一个当前身份目标和一个 primary action。恢复、Passkey、MFA 或帮助入口按当前步骤降级排列。
- **宽度与密度：** 表单宽度由内容和 FsusUI control 契约决定；不使用多卡片网格、侧栏卖点或装饰 Hero。
- **材料：** 中性页面与单一 task region；不使用 glass、gradient、glow 或大面积装饰图。
- **排版与操作：** 标题使用 [`page-title-scale.md`](page-title-scale.md)；控件、校验、loading 与 disabled geometry 完全消费 FsusUI 公共契约。
- **动效：** 仅允许步骤、校验、pending 和 focus 的功能反馈；不得让字段或说明依次入场。
- **响应式：** 保持标签、说明、错误和操作的 DOM 顺序；键盘与密码管理器路径不因 viewport 改变。
- **必验状态：** empty、invalid、pending、server error、disabled、Passkey/MFA capability 差异、长 locale、keyboard、focus、zoom、Light/Dark 和 reduced motion。

## 6. `status`

- **Shell：** 根据状态来源保留公共或账户上下文；不可恢复状态不得伪装为正常 task page。
- **层级：** 一个状态 H1、必要说明和清晰恢复路径。错误码是辅助信息，不替代标题。
- **宽度与密度：** 内容紧凑并靠近恢复操作；短内容不使用 `min-height`、空卡片或插画填充 viewport。
- **材料：** 使用中性 status/empty primitive；除非业务契约明确要求，不添加 illustration、glass、gradient 或 warning glow。
- **排版与操作：** 标题使用 [`page-title-scale.md`](page-title-scale.md)。primary recovery action 最多一个，其他路径保持次级。
- **动效：** 状态静态出现；只允许 focus、action pending 和 route navigation 反馈。
- **响应式：** 所有视口保持状态、说明和恢复操作顺序，不以图形替代文本。
- **必验状态：** 403、404、业务空态、可重试与不可重试错误、无返回历史、长错误说明、keyboard、focus、zoom、Light/Dark 和 reduced motion。

## 7. `overlay`

- **宿主关系：** overlay 继承宿主档案的内容优先级，只暂时承载一个任务或被放大的内容。
- **所有权：** FsusUI 拥有 Dialog、Drawer、Popover 的 geometry、focus trap、keyboard、scrim 和公共 motion；FsusBlog 只选择 documented variant，并拥有标题、内容顺序和 action priority。
- **材料：** 普通 overlay 使用 FsusUI 默认材料。Article image lightbox 是当前唯一允许的 glass consumer surface；新增例外必须回到 [`governance.md`](governance.md) 登记。
- **动效：** 仅使用 FsusUI overlay settle；reduced motion 下移除非必要 translate、scale 和 blur。Reading 内容本身不随 overlay 入场重复 reveal。
- **响应式：** 内容必须被 viewport containment，长内容在 overlay 内部滚动，不由页面 selector 改写组件内部 geometry。
- **必验状态：** open/close、Escape、外部关闭策略、初始 focus、focus trap/return、长标题与长内容、destructive/pending/error、mobile、zoom、Light/Dark 和 reduced motion。

## 8. 跨档案不变量

- 每页只有一个语义 H1；主题和 viewport 不改变信息顺序。
- FsusUI public component、token、focus 和状态语义跨档案一致。
- `--fsusblog-*` 只表达产品语义，不成为 FsusUI token 的影子副本。
- loading、empty、error、success、disabled 与 permission 状态必须使用真实内容验证，不能只检查理想 happy path。
- 设计验收必须记录实际查看的 rendered evidence；未检查的状态不能由零 diff 或静态 gate 代替。
