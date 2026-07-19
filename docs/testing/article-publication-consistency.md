# 文章发布坐标迁移与一致性验证

## 迁移范围

`20260719-pre-article-publication-coordinates` 执行 expand/backfill；
`20260719-post-article-publication-consistency` 在 CodeFirst 完成后安装检查视图：

1. 为 `article` 增加当前修订、当前发布和待发布时间；
2. 创建不可变 `article_publication` 表和唯一版本号约束；
3. 为 outbox 增加修订与发布坐标；
4. 为历史文章补齐修订、权利快照和公开发布记录；
5. 为尚未处理的历史 outbox 事件绑定迁移事务时的稳定坐标；
6. 创建 `article_publication_consistency_v1` 只读一致性视图。

迁移不会改写已处理事件。历史 pending/retry 事件无法恢复其原始时刻不存在的发布
坐标，因此明确绑定到迁移事务中的当前稳定版本；迁移后的所有新事件必须在写入时
携带精确坐标。

## 一致性查询

部署前后运行：

```sql
SELECT issue, COUNT(*)
FROM article_publication_consistency_v1
GROUP BY issue
ORDER BY issue;
```

预期结果为空。检查器覆盖：公开文章缺少发布指针、发布记录缺少修订、发布记录中的
修订号不匹配、权利快照不匹配，以及 pending/retry outbox 缺少精确修订坐标。

## 本地验收矩阵

验收只使用本地 PostgreSQL、固定 UTC 时间、单进程 worker 和仓库内数据：

- 匿名请求：公开列表与详情保持同一 `publicationNo`，定时点前仍读旧版本；
- 登录请求：私有详情可见当前编辑 `revisionNo`，公开坐标仍保持旧版本；
- admin 请求：立即发布、定时发布、归档、恢复、修订回滚均经过统一转换入口；
- notification stream：事件预览与 outbox 固定到相同修订/发布坐标；
- binary：新坐标随列表/详情投影传递，旧缓存版本仍可读取；
- AOT、搜索、缓存：同一文章的公开内容与发布记录所指修订一致；
- 失败注入：发布记录、指针或 outbox 任一步失败时事务回滚，旧公开版本保持可读。

不使用完整生产环境、PR、release 或外部验证平台作为本议题验收条件。
