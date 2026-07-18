namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed record class PublicAotBackfillRequest(
    PublicPageKind Kind,
    string RouteKey,
    string Path,
    string QueryString,
    string CacheKey)
{
    public string PagePrefixKey { get; init; } = string.Empty;
    public long ScheduledInvalidationVersion
    {
        get; init;
    }
    public string? TestSessionId
    {
        get; init;
    }
}
