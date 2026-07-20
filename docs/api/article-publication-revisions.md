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

普通创建/更新的状态矩阵如下；`✓` 表示允许，`—` 表示拒绝。`Deleted → Published`
仅代表专用 restore 操作，普通 update 不得使用该边。

| 源状态 ↓ / 目标状态 → | `Draft` | `Scheduled` | `Published` | `Archived` | `Deleted` |
|---|---:|---:|---:|---:|---:|
| `Draft` | ✓ | ✓ | ✓ | ✓ | — |
| `Scheduled` | ✓ | ✓ | ✓ | ✓ | — |
| `Published` | ✓ | ✓ | ✓ | ✓ | — |
| `Archived` | ✓ | ✓ | ✓ | ✓ | — |
| `Deleted` | — | — | restore only | — | — |

`Scheduled` 必须携带严格晚于服务端当前 UTC 时间的 `scheduledPublishAt`；其它目标状态
不得携带该字段。未定义枚举、缺失/过期计划时间、非法转换和直接写 `Deleted` 都返回
`ErrorCode.Validation`，并分别在 error `details` 中返回稳定代码
`article_status_undefined`、`article_scheduled_at_required`、
`article_scheduled_at_must_be_future`、`article_status_transition_invalid`、
`article_deleted_requires_delete_flow`（非定时状态附带时间使用
`article_scheduled_at_not_allowed`）。

| 操作 | 后台状态 | 公开坐标 |
|---|---|---|
| 立即发布 | `Published` | 新建发布记录并原子切换 |
| 首次定时发布 | `Scheduled` | 暂无发布记录，到点后新建 |
| 已发布文章定时更新 | `Published` + `pending_publication_at` | 到点前保留旧发布记录，到点后切换 |
| 归档 | `Archived` | 保留历史发布记录，不再公开 |
| 恢复 | `Published` | 新建恢复发布记录 |
| 修订回滚到草稿 | `Draft` | 基于完整历史包新建修订和非公开发布记录，转换类型为 `rollback` |
| 修订回滚并发布 | `Published` | 基于完整历史包新建修订和公开发布记录，转换类型为 `rollback` |
| 修订回滚并归档 | `Archived` | 基于完整历史包新建修订和非公开发布记录，转换类型为 `rollback` |

操作约束在同一策略内叠加：rollback 只允许显式选择 `Draft`、`Published` 或
`Archived`，不得隐式默认或进入 `Scheduled`；restore 只允许
`Deleted → Published`；worker 只允许到期的 `Scheduled → Published` 或带 pending
publication 的 `Published → Published`。writer 在持有文章行锁后复核源状态，不能由
请求端或 worker 自报状态绕过。

## 历史版本包与回滚

单条修订详情是可读的完整历史版本包，包含正文修订、不可变 Rights V3 快照、可选
responsibility 快照，以及该修订关联的 release 坐标。缺失必要 rights 快照时详情以
`packageComplete=false` 明示不完整；服务端不得从当前策略或默认策略补写一个看似完整的
历史包。

回滚请求使用 AEDS JSON `ArticleRevisionRollbackRequest(213)`，必须提交
`baseRevisionId`、目标状态与 8..500 字符的审计原因。服务端在同一事务内检查
`baseRevisionId`，复制源 revision 的正文、分类、标签、rights 和 responsibility，随后
创建全新的 revision、rights/responsibility 绑定与 release。新 revision 记录源
revision、执行 admin principal 和原因；旧 revision/publication 永不重新启用或修改。
冲突返回 `article_revision_conflict` 且不产生任何 revision、release 或 outbox。

无论目标状态是否公开，rollback 都分配新的 release 坐标，outbox 也只携带新
revision/release。`Draft` 与 `Archived` 的新 release 不会进入公开读取；`Published` 才会
切换公开投影。这样公开 AOT、search、feed、binary cache 和 notification stream 不会把
旧 publication 当成新变更重放。

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

主要风险是旧数据缺少修订、权利或责任快照，迁移期间投影坐标不完整，以及旧缓存
格式仍驻留。部署采用 expand-first：先增加可空的 rollback provenance 列与索引，再启用
新代码。历史包不完整时回滚 fail closed，不从当前策略或默认值猜测。服务端缓存读取器
兼容旧版本，写入器使用新版本。

需要降级时，先停止定时发布 worker 和 outbox 消费（保留待处理事件），再将应用流量
切回兼容旧列的代码并暂时隐藏回滚入口；数据库新增列和索引保持不删除。恢复新代码后重新启动 worker，
按事件内精确坐标继续投影，不需要重启 PostgreSQL 或 Redis。
