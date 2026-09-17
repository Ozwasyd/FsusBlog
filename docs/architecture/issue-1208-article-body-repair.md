# Issue 1208：ArticleBody 本机修复与公开产物门禁

## 数据流

发布文章读取以 `article_body` 是否存在且非空为正文健康门禁。详情数据库读取、Public AOT、ArticleDetail AEDS、public-hot 和搜索索引发现缺失后，只提交文章 ID 与低基数来源到单进程有界队列；同一文章在待处理期间去重。

修复 worker 从文章的 `current_publication_id` 精确读取已发布 revision 正文，避免把尚未发布的 current draft 泄漏到公开正文；仅在以下条件同时成立时写回：

- 文章未删除且为 Published；
- current publication 与其 revision 都属于该文章；
- `current_revision_id` 与已发布 revision 一致，不存在待发布草稿歧义；
- revision 正文非空；
- `article_body` 不存在或当前正文为空白。

修复成功后依次撤销旧公开投影、失效文章缓存与 Public AOT、重建搜索索引、ArticleDetail AEDS，并要求 public-hot 进入更新队列。单个后处理失败会触发最多三次本机重试；修复 SQL 幂等，不覆盖已有非空正文。

## 可观测性

观测维度固定为 `article_body` 下的读取位置、`repair_queue` 和 `repair` 结果，不把文章 ID 写入指标标签。文章 ID 只进入结构化日志。关键结果包括：

- `queued` / `full`：是否进入有界修复队列；
- `missing`：具体公开读取路径被正文门禁阻止；
- `completed` / `unresolved` / `retry` / `failed`：修复结果。

管理端一致性扫描覆盖空/缺失正文、current revision 指针、current publication 指针、正文与 current revision 漂移。扫描只报告问题，不批量猜测或覆盖正文。

## 风险与无重启恢复

- revision 本身缺失或为空时，worker 保持数据不变并记录 `unresolved`；公开读取继续显式失败，不产生错误正文产物。
- 队列满时，当前请求仍被正文门禁保护；后续请求或完整性扫描会再次暴露问题。
- 如需停止自动修复，可暂停后台运行槽的 worker 消费并保留读取门禁；直接修复 PostgreSQL 的 current revision/body 关系后，调用既有缓存失效、Public AOT 失效与公开产物重建入口即可恢复，无需重启 Web 进程。
- 回退不得恢复 summary-to-content。紧急降级只能让受影响文章保持暂不可用，或在校验 revision 后补齐 `article_body`。

## 本地验证边界

验证只使用本地 PostgreSQL、缓存替身和测试夹具；不连接生产数据库，不读取生产缓存，不执行发布或线上全量扫描。
