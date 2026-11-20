# 管理员分类与标签目录

在管理源（HTTPS 或本机 Loopback）使用管理员 Passkey 登录后，可在 `/admin/articles` 的「分类」与「标签」标签页查看并管理分类与标签目录。普通读者会话无法读取该目录。列表显示名称、已发布与各状态汇总数量，并提供关联文章筛选、创建、编辑与无引用删除操作。

`GET /api/v2/admin/identity/taxonomy/categories.aeds` 与 `GET /api/v2/admin/identity/taxonomy/tags.aeds` 使用 AEDS `32864`，按 ID 升序返回每页最多 24 项，使用可选 `after` 继续浏览。接口按管理员会话授权，并发送 `Cache-Control: no-store`。公开数量来自带权利快照验证的现行发布投影，按公开版本的分类和标签计算。服务核对该投影与同一次 PostgreSQL 查询中的发布水位。投影暂不可用时返回 503。

草稿、排期、撤回和软删除数量按文章当前修订统计。已有公开版本且尚有有效新修订排期时，两列均可计入同一篇。保留文章数按各分类或标签在任何保留修订中的关联文章去重，涵盖历史关联。管理界面允许重新读取当前页的数据。

新库初始化独立管理员结构 v4。已有管理员 v1、v2 或 v3 的安装应在停服务后运行离线迁移工具的 `admin-identity schema`，校验旧结构后在同一事务中升级。`admin-identity grant HANDLE article.write` 和 `admin-identity revoke HANDLE article.write` 在权限实际变更时递增该管理员的会话代次，撤销旧会话及邀约。`admin.manage` 仍通过 bootstrap 发放。见 [管理员身份与操作](admin-identity.md)。

管理员可选中一项检查引用。两个目录读取路径加 `?dependency=ID` 返回 AEDS 33070，四个小端 Int32 依次为 ID、活跃引用文章数、仅保留引用文章数、已保留的标签别名数。活跃引用对未删除文章的编辑头和当前发布修订取并集，每篇最多计一次。仅保留引用包含只出现在历史修订或已删除文章上的关联。标签别名按登记行统计。无引用结果只陈述当次读取的事实，删除仍受审计回执外键及此后的写入约束。

v1 同类读取通过 `/api/binary/author/taxonomy/categories` 和 `/api/binary/author/taxonomy/tags`，独立管理员需要 `article.write`。归档数统计关联的已归档文章。v1 分类与标签删除入口物理移除数据，v2 此处只读取依赖。 [v1 授权与目录入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/AuthoringEndpoints.WorkflowRoutes.cs) · [v1 目录统计](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/AuthoringEndpoints.cs) · [v1 物理删除](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Taxonomy.cs#L287)

配置合法管理员源后，`FSUSBLOG_ADMIN_CATEGORY_METADATA` 默认自动开启（可通过 `=false` 显式关闭）。管理员可在后台目录页创建分类、改名、编辑描述或通过 `POST /api/v2/admin/identity/taxonomy/categories/{id}/delete.aeds` 删除无任何修订引用的分类，也可在文章编辑器的「分类与标签」侧边栏直接新建分类并自动选中。

分类名称按 v1 去除首尾空白并保留大小写，不创建名称别名。有效名称限制为 128 UTF‑8 字节，描述最多 500 个 Unicode 标量。创建分配新的正整数 ID，改名保留所有历史及当前修订中的分类 ID。分类与标签共用永久 `taxonomy_epoch`，有变化时在同一事务更新元数据、请求回执及公开代次。空操作或幂等重试不增加代次。

分类编辑使用 `33058` 命令和 `33059` 回执。独立管理源的 `categories/create.aeds` 通过 POST 创建，`categories/{id}/metadata.aeds` 通过 GET 读取以及 PUT 编辑。各写入的 `pow.aeds` 入口签发绑定当前管理员会话、请求帧、目标与来源的安全证明。编辑使用期望修订，创建使用零坐标和独立请求 UUID。原标签路由和帧继续有效。
