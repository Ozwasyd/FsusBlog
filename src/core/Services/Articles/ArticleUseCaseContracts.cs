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
    bool UseSourceCache = true,
    ArticleListCursorPosition? Cursor = null,
    ArticleListSortMode Sort = ArticleListSortMode.Latest);

public readonly record struct ArticleListCursorPosition(DateTime CreateTimeUtc, int Id, long SortValue = 0);

public enum ArticleListSortMode : byte
{
    Latest = 0,
    Relevance = 1,
    Hot = 2
}

public readonly record struct ArticleDetailQuery(int Id, bool IncludePrivate = false);

public readonly record struct CreateArticleCommand(ArticleWriteRequestCoreModel Article);

public readonly record struct UpdateArticleCommand(
    int Id,
    ArticleWriteRequestCoreModel Article,
    ArticleUpdateIntent Intent = ArticleUpdateIntent.Standard,
    bool Force = false,
    ArticleRollbackMetadata? Rollback = null);

public readonly record struct ArticleRollbackMetadata(
    long SourceRevisionId,
    long ActorAdminPrincipalId,
    string Reason);

public sealed class ArticleRevisionConflictException(
    long currentRevisionId,
    int revisionNo,
    int status,
    DateTime updatedAtUtc) : Exception("article_revision_conflict")
{
    public long CurrentRevisionId { get; } = currentRevisionId;
    public int RevisionNo { get; } = revisionNo;
    public int Status { get; } = status;
    public DateTime UpdatedAtUtc { get; } = updatedAtUtc;

    public string ToApiDetails()
        => FormattableString.Invariant(
            $"{{\"currentRevisionId\":\"{CurrentRevisionId}\",\"revisionNo\":{RevisionNo},\"status\":{Status},\"updatedAt\":\"{UpdatedAtUtc:O}\"}}");
}

public enum ArticleUpdateIntent
{
    Standard = 0,
    Rollback = 1
}

public readonly record struct ArticleIdCommand(int Id);

public readonly record struct ArticleSearchQuery(string Keyword);

public readonly record struct ArticleCountQuery(int Count);

public readonly record struct ArticleViewCountCommand(int ArticleId, int Count = 1);

public readonly record struct ArticleViewCountBatchCommand(IReadOnlyDictionary<int, int> ArticleCounts);
