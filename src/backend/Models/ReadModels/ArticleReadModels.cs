
using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Models.ReadModels;

public sealed record class ArticleListItemReadModel
{
    public int Id
    {
        get; init;
    }
    public string Title { get; init; } = string.Empty;
    public string? Summary
    {
        get; init;
    }
    public string? CoverImageUrl
    {
        get; init;
    }
    public string? Snippet
    {
        get; init;
    }
    public int Views
    {
        get; init;
    }
    public DateTime CreateTime
    {
        get; init;
    }
    public int CategoryId
    {
        get; init;
    }
    public string CategoryName { get; init; } = string.Empty;
    public IReadOnlyList<TagReadModel> Tags { get; init; } = ArticleReadModelCollections.EmptyTags;
    public bool? IsDeleted
    {
        get; init;
    }
    public ArticleStatus Status { get; init; } = ArticleStatus.Published;
    public DateTime? ScheduledPublishAt
    {
        get; init;
    }
    public DateTime? PublishedAt
    {
        get; init;
    }
}

public sealed record class ArticleDetailReadModel
{
    public int Id
    {
        get; init;
    }
    public string Title { get; init; } = string.Empty;
    public string Content { get; init; } = string.Empty;
    public string? Summary
    {
        get; init;
    }
    public string? CoverImageUrl
    {
        get; init;
    }
    public int Views
    {
        get; init;
    }
    public int WordCount
    {
        get; init;
    }
    public int EstimatedReadingMinutes
    {
        get; init;
    }
    public bool ShowReadingNotice
    {
        get; init;
    }
    public DateTime CreateTime
    {
        get; init;
    }
    public int CategoryId
    {
        get; init;
    }
    public string CategoryName { get; init; } = string.Empty;
    public IReadOnlyList<TagReadModel> Tags { get; init; } = ArticleReadModelCollections.EmptyTags;
    public bool IsDeleted
    {
        get; init;
    }
    public ArticleStatus Status { get; init; } = ArticleStatus.Published;
    public DateTime? ScheduledPublishAt
    {
        get; init;
    }
    public DateTime? PublishedAt
    {
        get; init;
    }
    public DateTime? UpdatedAt
    {
        get; init;
    }
    public ArticleRightsReadModel Rights { get; init; } = new();
}

public sealed record class ArticleRightsReadModel
{
    public long SnapshotId
    {
        get; init;
    }
    public long ArticleRevisionId
    {
        get; init;
    }
    public int RevisionNo
    {
        get; init;
    }
    public bool Enabled { get; init; } = true;
    public string LicenseType { get; init; } = "all-rights-reserved";
    public string? CopyrightHolder
    {
        get; init;
    }
    public int? CopyrightYear
    {
        get; init;
    }
    public string? RightsStatement
    {
        get; init;
    }
    public string? AttributionTemplate
    {
        get; init;
    }
    public string CopyPolicy { get; init; } = "append-attribution";
    public int MaxExcerptChars { get; init; } = 300;
    public bool AllowCodeCopy { get; init; } = true;
    public bool ShowPublicBadge { get; init; } = true;
    public bool ProofBindingEnabled { get; init; } = true;
    public string? CanonicalUrl
    {
        get; init;
    }
    public string PolicyHash { get; init; } = string.Empty;
    public string ContentCanonicalHash { get; init; } = string.Empty;
    public string? ProofUrl
    {
        get; init;
    }
    public string? ProofStatus
    {
        get; init;
    }
}

public sealed record class TagReadModel
{
    public int Id
    {
        get; init;
    }
    public string Name { get; init; } = string.Empty;
}

public sealed record class ArticleListPageReadModel
{
    public List<ArticleListItemReadModel> Items { get; init; } = [];
    public int Total
    {
        get; init;
    }
    public string? NextCursor
    {
        get; init;
    }
    public bool HasMore
    {
        get; init;
    }
}

public static class ArticleReadModelCollections
{
    public static readonly IReadOnlyList<TagReadModel> EmptyTags = Array.Empty<TagReadModel>();
}
