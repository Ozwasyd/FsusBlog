# 文章修订与发布坐标

## 目标

文章的可编辑状态与公开状态使用两个独立坐标：

- `current_revision_id` 指向后台当前编辑修订；
- `current_publication_id` 指向公开侧当前发布记录。

发布记录是不可变快照，固定关联 `article_revision_id`、`revision_no`、
`rights_snapshot_id`、可选的 `responsibility_snapshot_id`、发布时间和转换类型。
公开 AOT、AEDS、搜索与缓存投影必须从该发布坐标读取，不能在消费事件时猜测
“最新修订”。

## 状态转换

所有写入经 `ArticlePublicationTransitionWriter` 收口：

| 操作 | 后台状态 | 公开坐标 |
|---|---|---|
| 立即发布 | `Published` | 新建发布记录并原子切换 |
| 首次定时发布 | `Scheduled` | 暂无发布记录，到点后新建 |
| 已发布文章定时更新 | `Published` + `pending_publication_at` | 到点前保留旧发布记录，到点后切换 |
| 归档 | `Archived` | 保留历史发布记录，不再公开 |
| 恢复 | `Published` | 新建恢复发布记录 |
| 修订回滚 | `Published` | 基于回滚内容新建修订和发布记录，转换类型为 `rollback` |

定时任务在同一数据库事务中锁定候选文章、创建发布记录、更新文章指针并写入
outbox。失败时整个批次回滚，旧发布版本继续可读。

## 投影契约

文章列表和详情投影携带以下坐标：

- `currentRevisionId` / `revisionNo`
- `currentPublicationId` / `publicationNo`

公开请求的标题、摘要、封面、分类、正文、标签、权利快照与责任快照均来自
`current_publication_id` 固定的版本。后台私有请求继续显示当前编辑修订。
outbox 事件同时在列和 payload 中保存精确坐标；消费者只处理事件给出的版本。

## 风险与无重启回退

主要风险是旧数据缺少修订或权利快照、迁移期间投影坐标不完整，以及旧缓存格式
仍驻留。部署采用 expand-first：先增加可空列、发布表、回填和一致性视图，再启用
新代码。服务端缓存读取器兼容旧版本，写入器使用新版本。

需要降级时，先停止定时发布 worker 和 outbox 消费（保留待处理事件），再将应用流量
切回兼容旧列的代码；数据库新增列和表保持不删除。恢复新代码后重新启动 worker，
按事件内精确坐标继续投影，不需要重启 PostgreSQL 或 Redis。

