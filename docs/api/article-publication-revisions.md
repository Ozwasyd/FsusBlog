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

Allowed/forbidden transition tables 由 [`contracts.md`](contracts.md) 的 generated
sections 拥有；scheduled、rollback、restore 与 delete 的坐标关系由本文件和相邻
current authority 中的 generated sections/受控 prose claims 拥有。

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

## 修订正文比较契约

修订正文比较只消费通过 `RevisionComparePlanVerifier` 复核的 sealed compare plan。plan
固定 base/compare package digest、raw Markdown SHA-256、article/revision 或 draft
coordinates、reader scope、到期时间、取消 identity 与资源预算；执行前重新读取 exact package
reference，不能把 `latest` 或 current pointer 重新解释成另一修订。正文与 metadata/snapshots
仍由 package 持有，diff result 只返回 byte ranges、line terminator 类型、heading identity 和
content-addressed receipts，不成为第二份内容 authority。

`revision-source-diff-v1` 先按原始 bytes 切分 LF、CRLF、lone CR 与无结尾换行的 physical
lines，BOM、trailing spaces 和所有 Unicode bytes 均留在原 source range。line matching
使用 deterministic unique-line anchors 与 increasing subsequence；无稳定 anchor 的封闭区间
明确输出 insert/delete/replace，不猜测 move。replace hunk 再以
`unicode-text-elements-v1` 做 Unicode grapheme/word refinement，invalid UTF-8 只跳过 word
refinement，不改变 byte-level line result。heading navigation 由 fence-aware、只读 Markdown
heading scanner 产生 ATX/setext ranges；不读取 rendered HTML、current DOM、local cache，也不
使用 regex 改写 Markdown semantics。

source bytes/line/token/memory/time/output/chunk 上限全部来自 sealed plan。超限、取消、过期、
package drift 或 receipt/range tamper 都 fail closed；engine 在 worker task 上计算，100k-line
输入仍使用有界内存与 `O(n log n)` anchor 排序/LIS 路径，禁止在 UI/main thread 运行。

## 风险与无重启回退

主要风险是旧数据缺少修订、权利或责任快照，迁移期间投影坐标不完整，以及旧缓存
格式仍驻留。部署采用 expand-first：先增加可空的 rollback provenance 列与索引，再启用
新代码。历史包不完整时回滚 fail closed，不从当前策略或默认值猜测。服务端缓存读取器
兼容旧版本，写入器使用新版本。

需要降级时，先停止定时发布 worker 和 outbox 消费（保留待处理事件），再将应用流量
切回兼容旧列的代码并暂时隐藏回滚入口；数据库新增列和索引保持不删除。恢复新代码后重新启动 worker，
按事件内精确坐标继续投影，不需要重启 PostgreSQL 或 Redis。
## Current publication coordinates

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.publication-coordinates
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.publication-coordinates
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.article.publication-coordinates -->
- `publicationId`
- `publicationNo`
- `responsibilitySnapshotId`
- `responsibilityVersion`
- `revisionId`
- `revisionNo`
- `rightsSnapshotId`
<!-- FSUSBLOG-GENERATED:END content.article.publication-coordinates -->

## 受控 publication 因果事实

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.scheduled-boundary
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.scheduled-boundary
render: key-value-table
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.article.scheduled-boundary -->
| Key | Value |
| --- | --- |
| nonScheduledScheduledAt | forbidden |
| scheduledPublishAt | {"boundary":"exclusive","relationToUtcNow":"strictly-after","required":true,"unit":"utc-instant"} |
| status | Scheduled |
<!-- FSUSBLOG-GENERATED:END content.article.scheduled-boundary -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.restore-semantics
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.restore-semantics
render: key-value-table
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.article.restore-semantics -->
| Key | Value |
| --- | --- |
| createsPublication | true |
| operation | Restore |
| revivesOldPublicationPointer | false |
| source | Deleted |
| target | Published |
<!-- FSUSBLOG-GENERATED:END content.article.restore-semantics -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.responsibility
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.responsibility
render: key-value-table
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.article.responsibility -->
| Key | Value |
| --- | --- |
| publicProjection | article_responsibility_snapshot without admin-actor fields |
| requiredCoordinateWhenPresent | responsibilitySnapshotId |
| snapshotOptionalOnNonPublish | true |
| versionField | responsibilityVersion |
<!-- FSUSBLOG-GENERATED:END content.article.responsibility -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.scheduled-pre-due
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.scheduled.preDueCurrent
render: relation-subject-predicate-object
-->
scheduled transition before due preserves old current publication coordinate when an article already has a current publication and pendingPublicationAt is still in the future。

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.scheduled-due
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.scheduled.dueTransition
render: relation-subject-predicate-object
-->
scheduled due transition creates new publication coordinate and switches current pointer without creating another revision when scheduledPublishAt or pendingPublicationAt is at or before the worker current time。

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.scheduled-stale
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.scheduled.replaceCancelStale
render: relation-subject-predicate-object
-->
replacement cancellation or stale schedule does-not-switch current publication pointer before a due row is successfully claimed when the due predicate no longer matches or the row loses the FOR UPDATE SKIP LOCKED claim。

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.restore-causal
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.restore.causal
render: relation-subject-predicate-object
-->
restore creates new publication coordinate without reviving the old publication or creating a new revision when a soft-deleted article is restored from its existing current revision。
