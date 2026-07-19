# Article Core use-case ownership

## Runtime path

文章运行时只有一条应用路径：

```text
Binary/AOT/authoring adapter
  -> IArticleCoreService
  -> Article query/command contract
  -> IArticleCoreGateway
  -> ArticleService (Server infrastructure adapter)
  -> database/cache/projection/notification/file ports
```

`IArticleService`、`ArticleServiceCoreAdapter`、`ArticleCoreGateway` 与
`ArticleCoreQueryCache` 已从生产代码删除。Server request DTO 不再出现在 Core port，
Core handler 负责校验、用例结果和错误语义；infrastructure adapter 负责事务与外部
资源适配，不再调用另一个 Server 业务 service。

## Cache and side-effect ownership

| Use case | Read/cache owner | Invalidation and side-effect owner |
| --- | --- | --- |
| Public article list binary | `ArticleEndpointService` owns `ArticleListFrame`; its cold source query sets `UseSourceCache=false` | `ArticleListVersion` and existing output-cache invalidation |
| Private/admin list | `ArticleService` infrastructure port owns `ArticleList` | article mutation invalidation dispatcher |
| Public detail | AEDS artifact/projection stores | artifact projector and invalidation dispatcher |
| Private detail | `ArticleService` infrastructure port owns `ArticleDetail` | article mutation invalidation dispatcher |
| Search | `ArticleService` owns the versioned `ArticleSearch` cache | mutation side-effect coordinator/search projector |
| Hot binary | `ArticleEndpointService` owns `ArticleHotFrame`; source ranking remains `TopArticles` | hot version provider and hot invalidation coalescer |
| Create/update/delete/restore/trash | no read cache in Core handler | database transaction first, then `IArticleMutationSideEffectCoordinator`; aborted public fences schedule recovery |

`ArticleHot` remains a reserved policy id but has no writer after removing the Core DTO cache.

## Rollback without process restart

The change does not alter routes, AEDS frame types, response fields, authorization, or database
schema. A bad frontend delivery can switch the static asset alias back to the previous immutable
artifact without restarting the backend. For a source-cache incident, existing cache invalidation
operations can evict article policies while the process stays online; the next Core query rebuilds
from the database. Public mutation fence recovery and the outbox continue to replay incomplete
projection/search/notification edges without a process restart.

## Verification boundaries

- Anonymous: public list/detail/hot binary contracts remain on `IArticleEndpointService`.
- Logged-in and admin: private/status/deleted queries retain the existing permission checks in the endpoint adapter.
- Notification stream: article mutations still publish through `IArticleMutationSideEffectCoordinator`; stream handshake code is unchanged.
- Binary: frame types, POD codecs, routes, and response DTOs are unchanged.
- Transaction rollback: existing create/update/delete/restore/trash transaction and aborted-fence tests remain authoritative.
