# 作者文章列表与回收站

`/user/manage/article/list` 和 `/user/manage/article/trash` 复用现有作者工作区。服务器用有效站点会话与作者权限准入，再按会话作者筛选文章。每页最多 20 项，按稳定文章 ID 倒序。标题搜索为大小写不敏感的字面子串，支持分类、标签和当前状态筛选。分页边界是上一页最后一条的 ID，每次读取重新检查权限。并发新增文章在刷新首页后可见。

活动列表能进入实际编辑工作区。曾经发布而尚未重新发布的稿件显示已撤回。待定时发布只取同一作者、会话代次和当前稿件修订对应的任务。若已有公开版本且提交了新一次排期，取待定时发布状态。回收站展示本作者已软删除文章的当前修订摘要，包括标题、日期和分类标签；回收站没有编辑、恢复或永久删除动作。恢复需要独立核验历史发布、权利、责任与资源引用。

两个页面只从 `GET /api/v2/authoring/articles.aeds` 获取数据。AEDS 帧 `32840` 为 v2 作者读取。接口输出 ID、修订、标题、状态、时间和分类标签，不含正文，也不接受目标 owner 参数。HTML 入口只返回应用壳并发送 noindex，API 响应使用 `Cache-Control: no-store`。

v1 保留相同页面路由。它用 `/api/binary/admin/article` 的 ArticleList 帧为具备 `article.write` 的独立管理员列出私有文章，回收站含归档和软删除。现切片使用 v2 站点作者会话和 owner 范围。撤回留在活动列表；历史归档恢复、后台跨作者目录、批量管理及永久删除仍待实现。参考 [v1 管理列表接口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs) 和 [v1 回收站](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/views/admin/article/Trash.vue)。
