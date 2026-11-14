# 文章文本属性

编辑页的属性区使用本地 FsusUI 表单，登录作者可为自己的站点工作区创建文本字段。稳定字段 ID 和机器键用于查找，展示标签可以改名。已保存文章可写入或删除属性值，空字符串与未设置有独立语义。正文、分类、公开文章和公开搜索使用各自的修订及可见性规则。

服务端通过 PostgreSQL 保存属性定义及版本、文章属性值版本和事务回执。所有操作从当前授权会话提取作者，以部署数据库确定站点。属性写入同时校验文章、属性 schema、属性定义和属性值的版本。请求键与精确内容绑定，重试同一请求返回原回执，不能触发再次写入。属性定义及值都归当前作者。未授权访问统一拒绝，不读取任何未授权文章的属性。

定义 API 支持创建、改名、弃用和删除文本字段。弃用保留原值，并允许作者明确删除原值。留有值时，删除定义会拒绝并返回待处理数量。属性分页绑定文章、schema 和属性值版本，任一变化后要求从第一页重载。定义快照进入领域层前核对闭合结构及内容摘要，并施加读取预算。

| 路径 | AEDS 请求和响应 |
| --- | --- |
| POST `/api/v2/authoring/properties/workspace.aeds` | PropertyWorkspaceRequest (32780) → PropertyWorkspace (32783) |
| POST `/api/v2/authoring/properties/definition.aeds` | PropertyDefinitionCommand (32779) → PropertyCommandReceipt (32782) |
| POST `/api/v2/authoring/properties/text.aeds` | PropertyTextCommand (32781) → PropertyCommandReceipt (32782) |

真实 Kestrel 和 PostgreSQL 测试覆盖作者范围、相同命令并发重试、不同负载重放冲突、过期属性值版本拒绝、改名保持 ID 及数据、弃用和删除保护、显式删除以及原文章修订保持不变。

原生 Chrome 端到端测试通过 FsusUI 编辑器创建文本字段、保存值并刷新读取，同时验证发布后公开首页和文章页面均不含该值。测试保留分类及标签场景，并使用隔离 PostgreSQL 数据库。证据见本机 `artifacts/native-e2e-fsusv2-e2e.jbfu7Q/browser-result.json`。

当前编辑区提供创建和修改文本值。定义管理界面、其他七种类型的持久化和值输入、查询及搜索投影、旧库导入和完整 Inspector 交互仍待交付。领域层继续拒绝扩展成任意脚本或数据类型。 [#2322](https://github.com/Ozwasyd/FsusBlog/issues/2322)
