# 管理员分类与标签目录

在独立 HTTPS 管理源的 `/admin/identity` 中使用 Passkey 登录后，可查看分类和标签目录。目录需要单独授予的 `article.write`。站点作者会话和 `admin.manage`、`audit.read` 或 `comment.moderate` 各自的权限无法读取该目录。列表显示分类和标签名与汇总数量，没有文章标题、正文、作者、删除资格或写操作。

`GET /api/v2/admin/identity/taxonomy/categories.aeds` 与 `GET /api/v2/admin/identity/taxonomy/tags.aeds` 使用 AEDS `32864`，按 ID 升序返回每页最多 24 项，使用可选 `after` 继续浏览。接口按管理员会话授权，并发送 `Cache-Control: no-store`。公开数量来自带权利快照验证的现行发布投影，按公开版本的分类和标签计算。服务核对该投影与同一次 PostgreSQL 查询中的发布水位。投影暂不可用时返回 503。

草稿、排期、撤回和软删除数量按文章当前修订统计。已有公开版本且尚有有效新修订排期时，两列均可计入同一篇。保留文章数按各分类或标签在任何保留修订中的关联文章去重，涵盖历史关联。管理界面允许重新读取当前页的数据。

新库初始化独立管理员结构 v4。已有管理员 v1、v2 或 v3 的安装应在停服务后运行离线迁移工具的 `admin-identity schema`，校验旧结构后在同一事务中升级。`admin-identity grant HANDLE article.write` 和 `admin-identity revoke HANDLE article.write` 在权限实际变更时递增该管理员的会话代次，撤销旧会话及邀约。`admin.manage` 仍通过 bootstrap 发放。见 [管理员身份与操作](admin-identity.md)。

v1 同类读取通过 `/api/binary/author/taxonomy/categories` 和 `/api/binary/author/taxonomy/tags`，独立管理员需要 `article.write`。v1 目录含归档状态和删除资格；这些字段依赖其状态机与写操作。v2 在独立管理页面提供原生二进制目录，管理员分类和标签写入仍待实现。见 [v1 授权与目录入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/AuthoringEndpoints.WorkflowRoutes.cs)及 [v1 目录统计](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/AuthoringEndpoints.cs)。
