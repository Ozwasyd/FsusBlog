namespace FsusBlog.Server.Models.Requests;

public sealed record class UpdateSeoConfigRequest
{
    public string Title { get; init; } = "Fsus's Blog";
    public string Description { get; init; } = "FORWARD";
    public string Keywords { get; init; } = "记录";
    public string Author { get; init; } = "Fsu";
    public string OgImage { get; init; } = string.Empty;
    public string BaseUrl { get; init; } = "https://blog.fsus.blog";
}

public sealed record class UpdatePageContentRequest
{
    public string? Slug { get; init; }
    public string? Content { get; init; }
}
