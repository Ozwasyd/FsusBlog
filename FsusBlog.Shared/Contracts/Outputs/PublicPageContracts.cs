namespace FsusBlog.Shared.Contracts.Outputs;

public enum PublicPageId
{
    Home = 1,
    ArticleDetail = 2,
    Filter = 3,
    Archive = 4,
    About = 5
}

public readonly record struct PublicPageDescriptor(
    PublicPageId Id,
    string CanonicalSlug,
    bool SeoEligible,
    bool AotShellReady,
    bool DeferSpaBoot
);

public sealed record class PublicAotShellEntryContract
{
    public PublicPageId PageId { get; init; }
    public string RouteKey { get; init; } = string.Empty;
    public string Html { get; init; } = string.Empty;
    public int? ArticleId { get; init; }
    public string? BootstrapJson { get; init; }
    public string? HydrationPropsJson { get; init; }
    public string? RendererVersion { get; init; }
    public string? IslandsJson { get; init; }
    public string? Title { get; init; }
    public string? BaseUrl { get; init; }
}

public sealed record class PublicAotShellBundleContract
{
    public List<PublicAotShellEntryContract> Entries { get; init; } = [];
    public DateTimeOffset GeneratedAtUtc { get; init; } = DateTimeOffset.UtcNow;
}

public static class PublicPageRegistry
{
    public static readonly PublicPageDescriptor Home = new(
        PublicPageId.Home,
        "home",
        SeoEligible: true,
        AotShellReady: true,
        DeferSpaBoot: true);

    public static readonly PublicPageDescriptor ArticleDetail = new(
        PublicPageId.ArticleDetail,
        "article",
        SeoEligible: true,
        AotShellReady: true,
        DeferSpaBoot: true);

    public static readonly PublicPageDescriptor Filter = new(
        PublicPageId.Filter,
        "filter",
        SeoEligible: true,
        AotShellReady: true,
        DeferSpaBoot: true);

    public static readonly PublicPageDescriptor Archive = new(
        PublicPageId.Archive,
        "archive",
        SeoEligible: true,
        AotShellReady: true,
        DeferSpaBoot: true);

    public static readonly PublicPageDescriptor About = new(
        PublicPageId.About,
        "about",
        SeoEligible: true,
        AotShellReady: true,
        DeferSpaBoot: true);

    public static readonly PublicPageDescriptor[] All =
    [
        Home,
        ArticleDetail,
        Filter,
        Archive,
        About
    ];
}
