namespace FsusBlog.Server.Models.ReadModels;

using FsusBlog.Server.Entities;

public sealed record class ArticleListItemReadModel
{
    public int Id { get; init; }
    public string Title { get; init; } = string.Empty;
    public string? Summary { get; init; }
    public string? CoverImageUrl { get; init; }
    public string? Snippet { get; init; }
    public int Views { get; init; }
    public DateTime CreateTime { get; init; }
    public int CategoryId { get; init; }
    public string CategoryName { get; init; } = string.Empty;
    public IReadOnlyList<TagReadModel> Tags { get; init; } = ArticleReadModelCollections.EmptyTags;
    public bool? IsDeleted { get; init; }
    public ArticleStatus Status { get; init; } = ArticleStatus.Published;
    public DateTime? ScheduledPublishAt { get; init; }
    public DateTime? PublishedAt { get; init; }
}

public sealed record class ArticleDetailReadModel
{
    public int Id { get; init; }
    public string Title { get; init; } = string.Empty;
    public string Content { get; init; } = string.Empty;
    public string? Summary { get; init; }
    public string? CoverImageUrl { get; init; }
    public int Views { get; init; }
    public int WordCount { get; init; }
    public int EstimatedReadingMinutes { get; init; }
    public bool ShowReadingNotice { get; init; }
    public DateTime CreateTime { get; init; }
    public int CategoryId { get; init; }
    public string CategoryName { get; init; } = string.Empty;
    public IReadOnlyList<TagReadModel> Tags { get; init; } = ArticleReadModelCollections.EmptyTags;
    public bool IsDeleted { get; init; }
    public ArticleStatus Status { get; init; } = ArticleStatus.Published;
    public DateTime? ScheduledPublishAt { get; init; }
    public DateTime? PublishedAt { get; init; }
}

public sealed record class TagReadModel
{
    public int Id { get; init; }
    public string Name { get; init; } = string.Empty;
}

public sealed record class ArticleListPageReadModel
{
    public List<ArticleListItemReadModel> Items { get; init; } = [];
    public int Total { get; init; }
    public string? NextCursor { get; init; }
    public bool HasMore { get; init; }
}

public static class ArticleReadModelCollections
{
    public static readonly IReadOnlyList<TagReadModel> EmptyTags = Array.Empty<TagReadModel>();
}
