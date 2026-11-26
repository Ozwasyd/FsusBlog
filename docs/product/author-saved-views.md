# 作者保存视图

文章管理页的「保存视图」保存作者刚运行的属性筛选。作者可命名、打开、重命名、替换为当前条件或移除个人视图。再次打开时查询 PostgreSQL 最新可读的文章。名称按 trim、NFC 和 Unicode 不变大写规则检查活跃视图唯一，限制 128 UTF‑16 字符及 512 UTF‑8 字节。重命名保留稳定 UUID、查询字节和摘要。移除保留审计记录并退出活跃列表。

服务器从当前认证会话取得作者身份，并使用当前数据库的站点 UUID。列举、保存和执行均要求该身份具有创作权限，且与 `X-Fsus-Current-Session` 一致。客户端不把视图定义写入 URL、本地浏览器存储或结果缓存。每次变更同时检查视图与集合版本。命令与幂等回执、服务端时钟记录在同一 PostgreSQL 事务。相同请求键与请求内容返回原回执，冲突保留旧数据。

查询定义最多包含 4 条类型化属性条件，可以同时保留已应用的标题或摘要关键字。顶层条件取交集，同字段的多个条件可显式选择任一匹配。属性操作数使用属性及选项 UUID、精确十进制和 UTC 毫秒。既有属性定义权威规范化操作数，规范字节按属性 UUID、操作符及备选操作数排序并带 SHA‑256 摘要。使用同字段条件组的定义使用内部七版，包含非空关键字的普通定义使用六版。沿用已有编码的定义中，文章引用「任一匹配」使用五版，单选使用四版，多选使用三版，「值存在」使用二版，剩余条件使用一版。旧运行时打开超出所支持版本的视图会返回依赖不可用。视图打开时复核属性类型、启用状态及选项和引用目标权限，字段或选项改名继续可用。失效依赖返回明确错误，原定义仍可用新筛选替换。游标绑定会话、视图 UUID 及版本、当前 schema、定义版本和完整条件，包括关键字及其匹配范围。分页的文章值仍按当次数据库读取判断。视图调用同一个作者属性查询器，无发布、通知或自动任务。 [固定查询合同](https://github.com/Ozwasyd/FsusBlog/issues/2341)

| 入口 | AEDS 帧 |
| --- | --- |
| GET `/api/v2/authoring/saved-views.aeds` | SavedViewCatalog (32930) |
| POST `/api/v2/authoring/saved-views.aeds` | SavedViewCommand (32931) → SavedViewReceipt (32932) |
| POST `/api/v2/authoring/saved-views/run.aeds` | SavedViewExecute (32933) → PropertyArticlePage (32883) |
| GET `/api/v2/authoring/saved-views/placement.aeds` | SavedViewPlacement (32935)，包含默认项与按服务端顺序分页的固定项 |
| POST `/api/v2/authoring/saved-views/placement.aeds` | SavedViewPlacementCommand (32934) → SavedViewReceipt (32932) |

固定项按服务器顺序显示在个人保存视图面板，支持取消固定和键盘触发的上移、下移。新固定项追加到末尾。重排在同一事务校验集合及移动对象版本，并批量写入变动的顺序。每个作者和站点至多一个默认项；进入未指定视图的面板时执行其读取。移除默认项前须明确清除或选择替代项。保存视图的固定、排序与默认命令变更集合版本，保留定义版本，并写入幂等审计回执。

文章管理接受 `/admin/articles?view=<UUID>&viewSchema=1` 深链接。一版链接坐标适用于七个定义版本。服务端按当前会话解析并执行指定视图，重命名保留链接可用。失效、已移除、访问受限及不受支持的链接显示不可用状态，默认项只在没有显式视图的正常面板入口启用。

早期的独立作者搜索页 `/user/manage/article/search` 曾用同一视图 ID、版本和当前权限执行保存视图。搜索与列表之间切换只携带稳定视图链接。搜索页当时提供只读执行，变更在文章列表进行。真实 Chrome 核对了两页的 AEDS 执行请求和结果顺序，以及已移除视图和匿名访问的拒绝。

文章编辑器的「Article library」在当前作者已有固定视图时提供「Pinned views」。标题和顺序取自服务端，每页最多 25 项。打开某项通过同一稳定链接进入文章管理并执行已保存的查询。离开编辑器仍受未保存更改保护。窄屏使用现有 FsusUI Drawer。关掉并重新打开文章库会重新读取固定项。原生 Chrome 验证了两个固定项的服务端顺序、取消离开和保留本机稿件、继续离开后执行确定的查询、移除后重新读取，以及最后一项移除后隐藏入口。

所需保存视图及偏好表结构随 `FsusBlog.V2.Cli` 统一的 `plan` / `apply` 初始化。验证入口：`tests/Integration/PropertyQueryPostgresTests.cs` 及 `FSUSBLOG_TEST_FLOW=article-library bash tests/EndToEnd/run-native.sh`。
