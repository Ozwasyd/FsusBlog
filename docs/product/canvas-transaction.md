# Canvas 文章链接事务

已接入三个私有 AEDS v2 API。它们使用现有会话校验和命令中间件，由部署所在数据库确定站点。Canvas、宿主文章和目标文章必须属于当前作者。确认还需使用签发计划时的同一个会话及权限代次。

| 路径 | 请求与响应 |
| --- | --- |
| POST `/api/v2/authoring/canvas/create.aeds` | CanvasCreate (32773) → CanvasCreated (32774) |
| POST `/api/v2/authoring/canvas/link/preview.aeds` | CanvasPreview (32775) → CanvasLinkPlan (32776) |
| POST `/api/v2/authoring/canvas/link/confirm.aeds` | CanvasConfirm (32777) → CanvasLinked (32778) |

创建入口为指定的两篇文章建立一个带显式引用边的私有 Canvas。目标必须有当前公开版本。预览请求绑定 Canvas、边、作者草稿、目标公开修订，以及用户显式选择的 UTF-16 源位置。当前支持文章末尾插入。服务器从公开修订生成标题和 Markdown，保留原文与原换行，验证生成内容是一条独立链接。预览写入有效期两分钟的计划，供调用方展示确切修改和确认动作。

确认只接受计划 ID。服务器锁定 Canvas、边与两篇文章，复核原会话、版本、源位置、公开目标及插入摘要。通过后调用现有文章保存事务。文章草稿、不可变修订、分类与标签承接、命令记录、outbox、Canvas 修订和回执一次提交。已有公开版本与边本身保持原样。原会话重试同一成功计划返回同一回执，其他会话、过期计划、修订冲突或提交失败不会追加正文。链接在作者后续单独发布新修订后生效。

真实 PostgreSQL 测试覆盖会话和作者范围、私有标题不进入预览、方括号等字符的标签转义、围栏代码中的插入拒绝、目标版本变化、两个并发确认及回执持久化失败后的全量回滚。真实 Kestrel 测试覆盖已挂载路由、AEDS 请求与响应、认证、错误帧、CRC 和禁止缓存。C# 与 TypeScript 对照独立构造的预览响应字节向量。

当前只覆盖同作者、已公开普通文章、显式引用边、文末插入及保留边的路径。还需接入真正的 Canvas/FsusUI 编辑器界面、预览与撤销历史、任意支持的编辑坐标、标题/块引用、关系索引与完整 Canvas 生命周期。视觉连线能否转换的冲突仍在台账。 [#2487](https://github.com/Ozwasyd/FsusBlog/issues/2487) · [#2490](https://github.com/Ozwasyd/FsusBlog/issues/2490) · [#3738](https://github.com/Ozwasyd/FsusBlog/issues/3738)
