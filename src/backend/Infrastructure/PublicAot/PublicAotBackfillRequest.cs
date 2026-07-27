namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed record class PublicAotBackfillRequest(
    PublicPageKind Kind,
    string RouteKey,
    string Path,
    string QueryString,
    string CacheKey)
{
    // The immutable artifact key includes the scheduled generation. Invalidation
    // is coordinated on the stable route identity instead.
    public string InvalidationKey { get; init; } = string.Empty;
    public string PagePrefixKey { get; init; } = string.Empty;
    public long ScheduledInvalidationVersion
    {
        get; init;
    }
    public string? TestSessionId
    {
        get; init;
    }
    public string FrontendAssetVersion
    {
        get; init;
    } = string.Empty;
}
