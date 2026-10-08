using System.Text;

namespace FsusBlog.Contracts.Articles;

/// <summary>Closed lifecycle filters for author article entity queries.</summary>
public enum AuthorArticleQueryStatus
{
    Draft = 0,
    Scheduled = 1,
    Published = 2,
    Archived = 3
}

/// <summary>Closed source buckets; Inbox requires its separate lifecycle admission.</summary>
public enum AuthorArticleQueryBucket
{
    Recent = 0,
    Draft = 1,
    Published = 2,
    Scheduled = 3,
    Archived = 4,
    Inbox = 5
}

/// <summary>Server-derived principal and configured site, never a client authorization claim.</summary>
public sealed record AuthorArticleQueryOwner(long AdminPrincipalId, string SiteScope);

/// <summary>Bounded entity query inputs, distinct from full-text document queries and commands.</summary>
public sealed record AuthorArticleQueryRequest(
    int SchemaVersion,
    AuthorArticleQueryOwner Owner,
    Guid RequestId,
    long RequestSequence,
    string QueryText,
    IReadOnlyList<AuthorArticleQueryStatus> Statuses,
    IReadOnlyList<AuthorArticleQueryBucket> Buckets,
    string Locale,
    string Collation,
    int Limit,
    string? Cursor);

/// <summary>Metadata admitted by the server permission reader before ranking is invoked.</summary>
/// <remarks>Construction alone does not prove authorization or a verified history projection.</remarks>
public sealed record AuthorArticleQueryCandidate(
    int ArticleId,
    long ServerRevision,
    string Title,
    string Slug,
    string Category,
    IReadOnlyList<string> Tags,
    AuthorArticleQueryStatus Status,
    string PermissionToken,
    int? VerifiedRecentOrdinal);

/// <summary>Lexicographic, explainable factors in their exact descending-relevance order.</summary>
public sealed record AuthorArticleQueryRank(
    int TitleMatch,
    int TitleDistance,
    int SlugMatch,
    int SlugDistance,
    int TaxonomyMatch,
    int RecentOrdinal,
    int StatusPriority,
    int ArticleId);

/// <summary>One stable article identity and its rank; duplicate titles and slugs remain distinct.</summary>
public sealed record AuthorArticleQueryRankedCandidate(
    AuthorArticleQueryCandidate Candidate,
    AuthorArticleQueryRank Rank);

/// <summary>The single input contract for author article entity query source adapters.</summary>
public static class AuthorArticleQueryContract
{
    /// <summary>Closed input and ranking contract version.</summary>
    public const int SchemaVersion = 1;
    /// <summary>Maximum number of returned article entities in a response.</summary>
    public const int MaxLimit = 50;
    /// <summary>Maximum query length, measured in Unicode scalar values.</summary>
    public const int MaxQueryRunes = 128;
    /// <summary>The invariant normalization rule; process culture is never a sorting input.</summary>
    public const string Collation = "unicode-nfkc-invariant-v1";

    /// <summary>Rejects unknown scopes and unavailable Inbox before a source reader runs.</summary>
    public static void ValidateRequest(AuthorArticleQueryRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Owner);
        ArgumentNullException.ThrowIfNull(request.QueryText);
        ArgumentNullException.ThrowIfNull(request.Statuses);
        ArgumentNullException.ThrowIfNull(request.Buckets);
        if (request.SchemaVersion != SchemaVersion
            || request.Owner.AdminPrincipalId <= 0
            || string.IsNullOrWhiteSpace(request.Owner.SiteScope)
            || request.Owner.SiteScope.Length > 512
            || request.RequestId == Guid.Empty
            || request.RequestSequence <= 0
            || request.Limit is < 1 or > MaxLimit
            || string.IsNullOrWhiteSpace(request.Locale)
            || request.Locale.Length > 64
            || request.Collation != Collation
            || request.QueryText.EnumerateRunes().Count() > MaxQueryRunes
            || request.Cursor?.Length > 8192
            || request.Statuses.Count is < 1 or > 4
            || request.Buckets.Count is < 1 or > 6
            || request.Statuses.Any(static status => !Enum.IsDefined(status))
            || request.Buckets.Any(static bucket => !Enum.IsDefined(bucket))
            || request.Statuses.Distinct().Count() != request.Statuses.Count
            || request.Buckets.Distinct().Count() != request.Buckets.Count)
        {
            throw new ArgumentException("author_article_query_request_invalid", nameof(request));
        }
        if (request.Buckets.Contains(AuthorArticleQueryBucket.Inbox))
        {
            throw new NotSupportedException("author_article_query_inbox_unavailable");
        }
    }
}
