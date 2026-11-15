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
| GET `/api/v2/authoring/properties/filter/catalog.aeds` | PropertyFilterCatalog (32880)，按机器键分页 |
| POST `/api/v2/authoring/properties/filter/definition.aeds` | PropertyFilterabilityCommand (32881) → PropertyCommandReceipt (32782) |
| POST `/api/v2/authoring/properties/filter/articles.aeds` | PropertyArticleQueryGroup (32912) 或单条件 PropertyArticleQuery (32882) → PropertyArticlePage (32883) |

每页最多 25 个字段。数值、布尔值和时间的载荷形态固定。每条选择定义或选择集合最多 32 个选项标识。三套独立字节向量对照 C# 和 TypeScript，覆盖八种属性值、空值与未设置、稳定身份、UTF-8、十进制和 64 位版本坐标。

真实 Kestrel 和 PostgreSQL 测试已覆盖八种类型的保存及读取、精确小数、假布尔值、无效选项、同键并发重试、请求内容冲突、过期版本、改名及弃用保护。未发布引用、自引用、环和不允许的 URL 会被拒绝。参考文章撤回后返回不可用状态。原生 Chrome 经 FsusUI 编辑页创建并刷新读取了文本、超出 JavaScript 安全整数精度的小数和 False。公开首页及文章页未显示私有值。证据见本机 `artifacts/native-e2e-fsusv2-e2e.ZDTHdh/browser-result.json`。

作者从文章管理的「按文章属性筛选」入口选择字段，显式启用精确筛选，再用属性值、未设置或显式空值检索自己的非删除文章。启用和停用校验 schema 和定义版本，保留现有属性值。停用、弃用、越权、引用不可用和过期条件会返回错误，不扩大查询范围。存储值直接参与相等运算，精确十进制、UTC 日期、空字符串、空多选集合、False 和 0 独立。引用只匹配当前作者可访问的、仍公开的目标。结果按文章 ID 倒序分页，续页游标绑定同一会话、版本和规范化条件。每页反映该次数据库读取，可见性和属性值变化时重新核对。

「值存在」适用于八种已启用筛选的属性，只匹配当前字段类型的实际存储值。空文本、空多选集合、False 和 0 属于实际值。未设置、显式空值以及目标已不可读的文章引用都不匹配。此条件无需填写操作数，可以和其他条件同时执行或保存到个人视图。PropertyArticleQueryGroup（32912）以比较编号 `5` 和零载荷类型标记 `-2` 表示 `value.is-present`。相等、未设置和显式空值的现有编码继续有效。

同一查询入口支持最多四条条件，文章须同时满足每条条件。数值使用精确十进制，日期使用毫秒精度 UTC。两者都支持小于、小于或等于、大于和大于或等于。可给同一字段分别设置上下限，各端点独立选择是否包含。缺失和空值不会落入有序范围，同一字段上的重复操作符会拒绝。续页游标绑定当前会话和规范化后的完整条件组，交换条件次序不影响续页。PostgreSQL 通过作者、字段及文章顺序缩小候选，再执行类型化数值和时间比较；新建数据库扩展该键索引，已有数据库保留字节协议和查询行为。

冻结 v1 定义权威含八种类型和操作符描述，批处理属性查询权威为不可用。两端独立比较的行为已定义，`*.between` 的边界决策仍由 C10 跟踪。全文、分面、按属性排序、同字段 OR、专用值索引、独立 1,000 字段 / 10,000 文章规模验收及旧库导入仍待交付。[个人保存视图](author-saved-views.md) 已复用现有属性查询。 [#2324](https://github.com/Ozwasyd/FsusBlog/issues/2324#issuecomment-6111553848) · [#2327](https://github.com/Ozwasyd/FsusBlog/issues/2327) · [#1861 依赖链](https://github.com/Ozwasyd/FsusBlog/issues/1861#issuecomment-5174474530)
