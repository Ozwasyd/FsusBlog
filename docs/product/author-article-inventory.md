# 作者文章列表与回收站

`/user/manage/article/list` 和 `/user/manage/article/trash` 复用现有作者工作区。服务器用有效站点会话与作者权限准入，再按会话作者筛选文章。每页最多 20 项，按稳定文章 ID 倒序。管理列表搜索标题或摘要，按大小写不敏感的字面子串匹配。v2 没有独立的私有摘要字段，管理列表取当前保存正文的前 200 个 Unicode 字符作为摘要。分类、标签和状态可以与关键字叠加。分页边界是上一页最后一条的 ID，每次读取重新检查权限。并发新增文章在刷新首页后可见。

活动管理列表已经应用的关键字也参与「按文章属性筛选」。属性查询在同一条 SQL 中以标题或摘要的字面匹配和全部属性条件取交集，结果区标出已应用的关键字，续页及保存视图保留该条件。

活动列表能进入实际编辑工作区。曾经发布而尚未重新发布的稿件显示已撤回。待定时发布只取同一作者、会话代次和当前稿件修订对应的任务。若已有公开版本且提交了新一次排期，取待定时发布状态。回收站展示本作者已软删除文章的当前修订摘要，包括标题、日期和分类标签。

作者可在活动列表确认移入回收站，并在回收站确认恢复为未公开稿件。软删除撤销现有公开版本并取消排期。投影发生故障时暂停公开服务，直到从已提交的状态重建。恢复创建新修订，保留移入回收站时的标题、正文、分类标签、私有属性及历史沿革。恢复后重新公开仍需单独发布。

两个页面从 `GET /api/v2/authoring/articles.aeds` 获取列表，使用 `match=title-summary`。省略 `match` 或传入 `match=title` 时仅查标题，供工作区文章栏等现有调用方使用。AEDS 帧 `32840` 输出 ID、修订、标题、状态、时间和分类标签。HTML 入口只返回应用壳并发送 noindex，API 响应使用 `Cache-Control: no-store`。移入和恢复分别通过 `POST /api/v2/authoring/delete.aeds` 与 `POST /api/v2/authoring/restore.aeds` 提交已有 `ArticleCommand` 帧，校验当前作者和预期修订。对同一命令的精确重试只执行一次。恢复返回新私有稿件的 `Draft` 帧。

独立 HTTPS 管理页的 **Article inventory** 提供跨作者活动列表和回收站。每次 GET `/api/v2/admin/identity/articles.aeds` 都复核当前管理员会话和 `article.write`，响应禁止缓存。列表共用 AEDS 32840、原有关键字分类标签状态过滤和 ID 续页。排期只取文章所有者当前有效许可代次，归档仍由独立档案列表按私有发布坐标核对。管理页支持标题或摘要搜索以及键盘翻页。

停服执行 `admin-article-trash-restore schema` 后，持有 `article.write` 的独立管理员可在回收站使用 **Restore to draft**。Passkey 证明绑定文章 ID、预期修订和命令 UUID。事务重新核验当前授权，锁定软删除文章并恢复给原作者。新私有修订继承正文、摘要、分类标签、权利、附件引用及作者属性。审核记录和恢复事件同一事务写入。AEDS 33063 仅含文章 ID 和新修订。断连后可重试同一请求核对原回执。

v1 用 `/api/binary/admin/article` 的 ArticleList 帧提供独立管理员目录。v1 操作恢复后直接重新公开，V2 的 **Restore to draft** 明确恢复为私有稿件。管理员恢复并重新公开、旧列表帧兼容、批量管理及永久删除仍待实现。 [v1 管理接口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs) · [v1 发布行为](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/ArticleService.LifecycleAndReadModels.cs#L113-L178)
