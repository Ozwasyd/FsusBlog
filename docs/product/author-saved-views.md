# 作者保存视图

文章管理页的「保存视图」保存作者刚运行的属性筛选。作者可命名、打开、重命名、替换为当前条件或移除个人视图。再次打开时查询 PostgreSQL 最新可读的文章。名称按 trim、NFC 和 Unicode 不变大写规则检查活跃视图唯一，限制 128 UTF‑16 字符及 512 UTF‑8 字节。重命名保留稳定 UUID、查询字节和摘要。移除保留审计记录并退出活跃列表。

服务器从当前认证会话取得作者身份，并使用当前数据库的站点 UUID。列举、保存和执行均要求该身份具有创作权限，且与 `X-Fsus-Current-Session` 一致。客户端不把视图定义写入 URL、本地浏览器存储或结果缓存。每次变更同时检查视图与集合版本。命令与幂等回执、服务端时钟记录在同一 PostgreSQL 事务。相同请求键与请求内容返回原回执，冲突保留旧数据。

版本一查询定义是 1–4 条类型化属性条件的单层交集，使用属性及选项 UUID、精确十进制和 UTC 毫秒。既有属性定义权威规范化操作数，规范字节按属性 UUID 和操作符排序并带 SHA‑256 摘要。视图打开时复核属性类型、启用状态及选项和引用目标权限，字段或选项改名继续可用。失效依赖返回明确错误，原定义仍可用新筛选替换。游标绑定会话、视图 UUID及版本、当前 schema、定义版本和完整条件，分页的文章值仍按当次数据库读取判断。视图调用同一个作者属性查询器，无发布、通知或自动任务。

| 入口 | AEDS 帧 |
| --- | --- |
| GET `/api/v2/authoring/saved-views.aeds` | SavedViewCatalog (32930) |
| POST `/api/v2/authoring/saved-views.aeds` | SavedViewCommand (32931) → SavedViewReceipt (32932) |
| POST `/api/v2/authoring/saved-views/run.aeds` | SavedViewExecute (32933) → PropertyArticlePage (32883) |

新建数据库包含保存视图表。已有 v2 数据库在服务器停止后可运行迁移工具 `saved-views` 命令安装表和校验目录；命令可重复执行。这个切片兑现属性筛选的个人视图路径。固定、默认、顺序、深链接、其他条件及共享 Rail/Search、旧库迁移和完整规模终验仍按执行依赖单独跟踪。 [#2341](https://github.com/Ozwasyd/FsusBlog/issues/2341) · [#2343](https://github.com/Ozwasyd/FsusBlog/issues/2343) · [#2346](https://github.com/Ozwasyd/FsusBlog/issues/2346) · [#2349](https://github.com/Ozwasyd/FsusBlog/issues/2349) · [#2351](https://github.com/Ozwasyd/FsusBlog/issues/2351) · [#2354](https://github.com/Ozwasyd/FsusBlog/issues/2354)
