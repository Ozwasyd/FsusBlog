# 文章属性

登录作者可在编辑页通过本地 FsusUI 表单创建属性，并为已保存文章设置或移除属性值。支持八种类型：文本、数值、布尔、日期、单选、多选、文章引用和 URL。属性定义及值归当前作者，服务端根据部署数据库确定站点。文章正文、分类、公开页面和公开搜索有各自的修订及可见性规则。

字段 ID 和机器键保持稳定。单选和多选用选项 ID 保存值。数值按精确十进制传输，日期使用毫秒精度的 UTC 时间。允许空字符串的字段保留空字符串，显式空值和未设置也各有独立语义。引用指向当前作者的已公开文章，使用稳定数值 ID。服务端拒绝自引用和循环。目标撤回公开后，已存引用保留，编辑页显示不可用状态，省略目标 ID。URL 属性按 HTTPS 规则校验。

属性写入同时校验文章、属性定义集合、当前定义和属性值的版本。属性分页绑定文章、定义集合和属性值版本，任一变化后从第一页重载。请求键与内容绑定，重试同一请求返回原回执。定义快照进入领域层前核对结构和内容摘要。定义 API 支持创建、改名、弃用和删除字段。弃用保留原值，作者可明确移除原值。尚有值时，删除定义会拒绝并返回待处理数量。

属性表单有未提交改动时，需先保存或取消，再离开编辑页或更新文章和分类。服务端响应未确认时，重试会继续使用原请求和原请求键。切换文章、文章修订或登录身份会取消旧请求并清空旧表单。日期输入只接受 UTC 时间，单独输入日期时使用 UTC 午夜。编辑页区分空文本、显式空值、未设置和不可用引用。

| 路径 | AEDS 请求和响应 |
| --- | --- |
| POST `/api/v2/authoring/properties/editor.aeds` | PropertyWorkspaceRequest (32780) → PropertyEditor (32786) |
| POST `/api/v2/authoring/properties/schema.aeds` | PropertySchemaCommand (32784) → PropertyCommandReceipt (32782) |
| POST `/api/v2/authoring/properties/values.aeds` | PropertyValueCommand (32785) → PropertyCommandReceipt (32782) |
| POST `/api/v2/authoring/properties/workspace.aeds` | PropertyWorkspaceRequest (32780) → PropertyWorkspace (32783)，文本字段投影 |
| POST `/api/v2/authoring/properties/definition.aeds` | PropertyDefinitionCommand (32779) → PropertyCommandReceipt (32782)，文本定义 |
| POST `/api/v2/authoring/properties/text.aeds` | PropertyTextCommand (32781) → PropertyCommandReceipt (32782)，文本值 |

每页最多 25 个字段。数值、布尔值和时间的载荷形态固定。每条选择定义或选择集合最多 32 个选项标识。三套独立字节向量对照 C# 和 TypeScript，覆盖八种属性值、空值与未设置、稳定身份、UTF-8、十进制和 64 位版本坐标。

真实 Kestrel 和 PostgreSQL 测试已覆盖八种类型的保存及读取、精确小数、假布尔值、无效选项、同键并发重试、请求内容冲突、过期版本、改名及弃用保护。未发布引用、自引用、环和不允许的 URL 会被拒绝。参考文章撤回后返回不可用状态。原生 Chrome 经 FsusUI 编辑页创建并刷新读取了文本、超出 JavaScript 安全整数精度的小数和 False。公开首页及文章页未显示私有值。证据见本机 `artifacts/native-e2e-fsusv2-e2e.ZDTHdh/browser-result.json`。

定义管理界面、查询和搜索投影、旧库导入以及完整 Inspector 交互仍待交付。属性类型及其约束由领域层控制。 [#2322](https://github.com/Ozwasyd/FsusBlog/issues/2322)
