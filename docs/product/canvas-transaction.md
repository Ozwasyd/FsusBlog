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

当前链接转换覆盖同作者、已公开普通文章、显式引用边、文末插入及保留边。标题和块引用能保存同作者文章 ID、锚点及可选固定修订，解析和跳转仍待接入。Canvas 界面、撤销／重做、任意编辑坐标、关系索引和生产规模的 Canvas 性能验收仍待完成。视觉连线能否转换的冲突仍在台账。该版 Canvas 表结构随全新 v2 数据库离线安装，开发预览版的旧 Canvas 表形状仍缺现场升级工具。 [#2487](https://github.com/Ozwasyd/FsusBlog/issues/2487) · [#2490](https://github.com/Ozwasyd/FsusBlog/issues/2490) · [#3738](https://github.com/Ozwasyd/FsusBlog/issues/3738)
