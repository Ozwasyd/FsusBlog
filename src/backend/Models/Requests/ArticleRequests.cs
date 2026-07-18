
using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Models.Requests;

public sealed record class CreateArticleRequest
{
    public required string Title
    {
        get; init;
    }
    public required string Content
    {
        get; init;
    }
    public string? Summary
    {
        get; init;
    }
    public string? CoverImageUrl
    {
        get; init;
    }
    public int CategoryId
    {
        get; init;
    }
    public List<int>? TagIds
    {
        get; init;
    }
    public ArticleStatus Status { get; init; } = ArticleStatus.Published;
    public DateTime? ScheduledPublishAt
    {
        get; init;
    }
    public ArticleRightsRequest? Rights
    {
        get; init;
    }
}

public sealed record class UpdateArticleRequest
{
    public required string Title
    {
        get; init;
    }
    public required string Content
    {
        get; init;
    }
    public string? Summary
    {
        get; init;
    }
    public string? CoverImageUrl
    {
        get; init;
    }
    public int CategoryId
    {
        get; init;
    }
    public List<int>? TagIds
    {
        get; init;
    }
    public ArticleStatus Status { get; init; } = ArticleStatus.Published;
    public DateTime? ScheduledPublishAt
    {
        get; init;
    }
    public ArticleRightsRequest? Rights
    {
        get; init;
    }
}

public sealed record class ArticleRightsRequest
{
    public string? Mode
    {
        get; init;
    }
    public bool Enabled { get; init; } = true;
    public string? LicenseType
    {
        get; init;
    }
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
    public string? CopyPolicy
    {
        get; init;
    }
    public int MaxExcerptChars { get; init; } = 300;
    public bool AllowCodeCopy { get; init; } = true;
    public bool ShowPublicBadge { get; init; } = true;
    public bool ProofBindingEnabled { get; init; } = true;
}
