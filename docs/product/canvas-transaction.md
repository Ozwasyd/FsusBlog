# Canvas 文章链接事务

Canvas 文档与链接确认共用同一份数据及修订号。站点范围由部署的数据库决定，只有当前作者会话可以访问文档。

| 私有文档 API | AEDS 帧 |
| --- | --- |
| GET `/api/v2/authoring/canvas/documents.aeds` | CanvasGraphList (32812) |
| GET `/api/v2/authoring/canvas/documents/{id}.aeds` | CanvasGraphPage (32813) |
| POST `/api/v2/authoring/canvas/documents/write.aeds` | CanvasGraphCommand (32810) → CanvasGraphReceipt (32811) |

文档支持标题、持久视口、5 种节点和 2 种边。节点坐标使用逻辑单位的百分之一，缩放使用千分之一。每位作者最多持有 100 份活动文档和 4,000 份含删除标记的文档记录。每份文档最多保存 10,000 个节点、10,000 条边和 100,000 条分组成员关系，节点文本和边标签合计最多 8 MiB UTF-8。读取文档时按节点 UUID 和边顺序分页。后续页提交首次读到的修订号和偏移，修订变化时重新读取。

写入按顺序应用最多 64 个操作。每个操作结束时验证端点与分组成员，删除节点会同时移除关联边和成员关系。更新和删除使用期望修订号，完全相同的命令重试返回原回执。每次提交追加作者、命令、修订、请求摘要及回执头部元数据。删除文档时清除节点和边，保留精简回执和已经执行的链接计划；历史回执仍含当时的文档标题，不包含节点正文和边标签。文档写入只读文章的拥有者、存在性及固定修订坐标。

已接入三个私有 AEDS v2 API。它们使用现有会话校验和命令中间件，由部署所在数据库确定站点。Canvas、宿主文章和目标文章必须属于当前作者。确认还需使用签发计划时的同一个会话及权限代次。

| 路径 | 请求与响应 |
| --- | --- |
| POST `/api/v2/authoring/canvas/create.aeds` | CanvasCreate (32773) → CanvasCreated (32774) |
| POST `/api/v2/authoring/canvas/link/preview.aeds` | CanvasPreview (32775) → CanvasLinkPlan (32776) |
| POST `/api/v2/authoring/canvas/link/confirm.aeds` | CanvasConfirm (32777) → CanvasLinked (32778) |

创建入口为指定的两篇文章建立一个带显式引用边的私有 Canvas。目标必须有当前公开版本。预览请求绑定 Canvas、边、作者草稿、目标公开修订，以及用户显式选择的 UTF-16 源位置。当前支持文章末尾插入。服务器从公开修订生成标题和 Markdown，保留原文与原换行，验证生成内容是一条独立链接。预览写入有效期两分钟的计划，供调用方展示确切修改和确认动作。

确认只接受计划 ID。服务器锁定 Canvas、边与两篇文章，复核原会话、版本、源位置、公开目标及插入摘要。通过后调用现有文章保存事务。文章草稿、不可变修订、分类与标签承接、命令记录、outbox、Canvas 修订和回执一次提交。已有公开版本与边本身保持原样。Canvas、引用边及文章仍可访问时，原会话重试同一成功计划返回原回执。其他会话、过期计划、修订冲突或提交失败不会追加正文。链接在作者后续单独发布新修订后生效。

真实 PostgreSQL 测试覆盖会话和作者范围、私有标题不进入预览、方括号等字符的标签转义、围栏代码中的插入拒绝、目标版本变化、两个并发确认及回执持久化失败后的全量回滚。真实 Kestrel 测试覆盖已挂载路由、AEDS 请求与响应、认证、错误帧、CRC 和禁止缓存。C# 与 TypeScript 对照独立构造的预览响应字节向量。

当前链接转换覆盖同作者、已公开普通文章、显式引用边、文末插入及保留边。文章、标题和块引用可按作者范围解析标题和确切修订，跨工作区的精确坐标跳转仍待接入。任意文章编辑坐标、关系索引、导入导出和生产规模的 Canvas 性能验收仍待完成。视觉连线能否转换的冲突仍在台账。该版 Canvas 表结构随全新 v2 数据库离线安装。 [#2487](https://github.com/Ozwasyd/FsusBlog/issues/2487) · [#2490](https://github.com/Ozwasyd/FsusBlog/issues/2490) · [#3738](https://github.com/Ozwasyd/FsusBlog/issues/3738)

## 私有引用解析

`GET /api/v2/authoring/canvas/documents/{id}/references/{nodeId}.aeds?revision=...` 接受 Canvas ID、节点 ID 和当前文档修订。服务器在现有作者会话和文档锁下读取节点保存的目标，只查询同一作者未删除的文章。固定引用读取对应不可变修订，未固定引用读取当时的当前草稿修订。普通文章引用只取标题。标题或块引用检查该版本中的唯一 FsusUI `^anchor-id`，并返回最多 256 UTF-16 单元的纯文本上下文和 caret 偏移。标题引用要求 v1 所用的列首 ATX 标题。重复或缺失锚点没有上下文，删除、越权或不可读修订没有文章信息。

该路径最多读取一篇目标修订的 Markdown，受 200,000 UTF-16 单元和 1 MiB 字节上限约束。引用解析请求只读，其结果绑定该时刻的文档、节点与修订。切换选择或图形视图、改变已提交视口、刷新文档及撤销身份会清除预览。全量批处理、接入编辑器的精确跳转和 10,000 节点往返仍待交付。 [v1 固定契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/architecture/authoring-canvas-document-boundary.md) · [PostgreSQL 测试](../../artifacts/canvas-reference-evidence/postgres.log)

## 撤销与重做

作者会话可通过 `GET /api/v2/authoring/canvas/documents/{id}/history.aeds?revision=...` 查看当前可撤销和重做的修订。按钮提交原有文档命令，携带当前修订和重试键。服务器锁定文档后从对应栈顶恢复前后配对的节点、边、标题及视口；先核对配对事实，再提交图形和历史。一个普通编辑批次、一次撤销或一次重做各增加一个修订。重复命令返回原回执，新编辑关闭旧重做分支。恢复文章引用时再次校验当前作者及对应文章。

每份文档最多保留 100 个可重放编辑和 32 MiB 历史负载，以先达到的界限为准。载荷只保存被修改的 Canvas 记录，摘要绑定文档及原修订。每个新动作保留精简的操作结果。删除文档时清除可重放载荷。创建文档、删除文档及显式文章链接转换属于独立事务，撤销和重做只修改 Canvas，文章修订、发布和 outbox 保持原样。已安装图形布局用离线 `canvas-graph apply-empty` 增加历史表，保留原文档和修订；升级前的操作没有配对记录，不能重放。 [PostgreSQL 历史测试](../../artifacts/canvas-history-evidence/postgres.log) · [升级测试](../../artifacts/canvas-history-upgrade/run.log)

## 已知开发预览 Canvas

设置现有的 `FSUSBLOG_DB` 后，离线迁移程序的 `canvas-graph check` 对 v2 marker、整套已知列和约束进行只读核对。已知旧布局报告 Canvas 数、作者数、修订范围、边数和计划回执数量，并列出保留源坐标的列名。输出只含汇总，不包含账号或文档标识、文章内容、计划 ID 和会话摘要。

使用 `canvas-graph apply-empty` 时须先停止服务。命令取得现有数据库公开快照租约和事务排空锁，然后独占锁定三个 Canvas 表。在核对旧布局为空后，同一事务重建 Canvas 表并复查新布局；已升级数据库可安全重复执行。若存在外部 PostgreSQL 表依赖或形状不相符，事务回滚。含旧文档、边或计划的已知预览数据库只报告保留范围并拒绝修改，因为旧版没有节点几何、视口及完整操作回执。该诊断不会合成历史或删除现存数据。

独立 PostgreSQL 18.7 试验验证空表升级、重复执行、外部依赖回滚、活动服务租约拒绝、未知列拒绝及旧计划回执逐字节摘要相同。 [原生测试](../../artifacts/canvas-preview-migration-evidence/run.log)
