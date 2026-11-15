# 作者文章列表与回收站

`/user/manage/article/list` 和 `/user/manage/article/trash` 复用现有作者工作区。服务器用有效站点会话与作者权限准入，再按会话作者筛选文章。每页最多 20 项，按稳定文章 ID 倒序。管理列表搜索标题或摘要，按大小写不敏感的字面子串匹配。v2 没有独立的私有摘要字段，管理列表取当前保存正文的前 200 个 Unicode 字符作为摘要。分类、标签和状态可以与关键字叠加。分页边界是上一页最后一条的 ID，每次读取重新检查权限。并发新增文章在刷新首页后可见。

活动管理列表已经应用的关键字也参与「按文章属性筛选」。属性查询在同一条 SQL 中以标题或摘要的字面匹配和全部属性条件取交集，结果区标出已应用的关键字，续页及保存视图保留该条件。

活动列表能进入实际编辑工作区。曾经发布而尚未重新发布的稿件显示已撤回。待定时发布只取同一作者、会话代次和当前稿件修订对应的任务。若已有公开版本且提交了新一次排期，取待定时发布状态。回收站展示本作者已软删除文章的当前修订摘要，包括标题、日期和分类标签。

作者可在活动列表确认移入回收站，并在回收站确认恢复为未公开稿件。软删除撤销现有公开版本并取消排期。投影发生故障时暂停公开服务，直到从已提交的状态重建。恢复创建新修订，保留移入回收站时的标题、正文、分类标签、私有属性及历史沿革。恢复后重新公开仍需单独发布。

两个页面从 `GET /api/v2/authoring/articles.aeds` 获取列表，使用 `match=title-summary`。省略 `match` 或传入 `match=title` 时仅查标题，供工作区文章栏等现有调用方使用。AEDS 帧 `32840` 输出 ID、修订、标题、状态、时间和分类标签。HTML 入口只返回应用壳并发送 noindex，API 响应使用 `Cache-Control: no-store`。移入和恢复分别通过 `POST /api/v2/authoring/delete.aeds` 与 `POST /api/v2/authoring/restore.aeds` 提交已有 `ArticleCommand` 帧，校验当前作者和预期修订。对同一命令的精确重试只执行一次。恢复返回新私有稿件的 `Draft` 帧。

v1 保留相同页面路由。它用 `/api/binary/admin/article` 的 ArticleList 帧为具备 `article.write` 的独立管理员列出私有文章，状态 3 的归档文章位于独立管理员档案列表。回收站只查询软删除文章，管理员的回收站恢复通过敏感操作复核。v2 作者恢复只开放未公开稿件。通过管理员回滚归档的文章只在独立管理员档案列表中显示，由管理员使用通行密钥将准确的归档修订重新发布。跨作者的一般目录、批量管理及永久删除仍待实现。参考 [v1 管理接口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs)、[v1 恢复写入](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Articles/ArticleLifecycleTransitionWriter.cs) 和 [v1 回收站](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/views/admin/article/Trash.vue)。
