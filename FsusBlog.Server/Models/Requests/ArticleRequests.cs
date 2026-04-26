using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Models.Requests;

public sealed record class CreateArticleRequest
{
    public required string Title { get; init; }
    public required string Content { get; init; }
    public string? Summary { get; init; }
    public int CategoryId { get; init; }
    public List<int> TagIds { get; init; } = [];
    public PublicAotShellBundleContract? AotBundle { get; init; }
}

public sealed record class UpdateArticleRequest
{
    public required string Title { get; init; }
    public required string Content { get; init; }
    public string? Summary { get; init; }
    public int CategoryId { get; init; }
    public List<int> TagIds { get; init; } = [];
    public PublicAotShellBundleContract? AotBundle { get; init; }
}

public sealed record class SearchArticlesRequest
{
    public string Keyword { get; init; } = string.Empty;
}

public readonly record struct ArticleQueryRequest(
    int Page = 1,
    int Size = 10,
    int? CategoryId = null,
    int? TagId = null,
    bool IsDeleted = false);
