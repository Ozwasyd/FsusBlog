using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Services.Articles;

public readonly record struct ArticlePageQuery(
    int Page,
    int Size,
    int? CategoryId,
    int? TagId,
    bool IsDeleted,
    int? Status = null,
    bool IncludePrivate = false,
    string? Keyword = null,
    long? ListCacheVersion = null,
    bool UseSourceCache = true);

public readonly record struct ArticleDetailQuery(int Id, bool IncludePrivate = false);

public readonly record struct CreateArticleCommand(ArticleWriteRequestCoreModel Article);

public readonly record struct UpdateArticleCommand(int Id, ArticleWriteRequestCoreModel Article);

public readonly record struct ArticleIdCommand(int Id);

public readonly record struct ArticleSearchQuery(string Keyword);

public readonly record struct ArticleCountQuery(int Count);

public readonly record struct ArticleViewCountCommand(int ArticleId, int Count = 1);

public readonly record struct ArticleViewCountBatchCommand(IReadOnlyDictionary<int, int> ArticleCounts);
