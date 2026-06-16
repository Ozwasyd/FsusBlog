using System.Collections.Frozen;

namespace FsusBlog.Shared.Contracts.Outputs;

public enum PublicPageId
{
    Home = 1,
    ArticleDetail = 2,
    Filter = 3,
    Archive = 4,
    About = 5,
    Account = 6,
    Privacy = 7,
    Guidelines = 8,
    Copyright = 9
}

public readonly record struct PublicPageDescriptor(
    PublicPageId Id,
    string CanonicalSlug,
    bool SeoEligible,
    bool AotShellReady,
    bool DeferSpaBoot,
    bool RequiresUserState,
    string FallbackBehavior
);

public static class PublicRouteIdentityRegistry
{
    public const string PublicAotShellFallback = "public-aot-shell";
    public const string PublicSearchSpaFallback = "spa-public-search-fallback";
    public const string UserStateRuntimeOnlyFallback = "user-state-runtime-only";
    public const string SearchRouteKey = "search";
    public const string SearchPath = "/" + SearchRouteKey;
    public const string AccountPath = "/user/profile";
    public const string UnknownFilterRouteKey = "filter:unknown";
    public const string ArticleBucket = "article";
    public const string ArticlePathPrefix = "/" + ArticleBucket + "/";
    public const string CategoryBucket = "category";
    public const string CategoryPathPrefix = "/" + CategoryBucket + "/";
    public const string TagBucket = "tag";
    public const string TagPathPrefix = "/" + TagBucket + "/";
    public const string TagNameBucket = "tag-name";
}

public sealed record class PublicAotShellEntryContract
{
    public PublicPageId PageId { get; init; }
    public string RouteKey { get; init; } = string.Empty;
    public string Html { get; init; } = string.Empty;
    public int? ArticleId { get; init; }
    public string? BootstrapPayload { get; init; }
    public string? HydrationPropsPayload { get; init; }
    public string? RendererVersion { get; init; }
    public string? IslandsPayload { get; init; }
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
        DeferSpaBoot: true,
        RequiresUserState: false,
        FallbackBehavior: PublicRouteIdentityRegistry.PublicAotShellFallback);

    public static readonly PublicPageDescriptor ArticleDetail = new(
        PublicPageId.ArticleDetail,
        "article",
        SeoEligible: true,
        AotShellReady: true,
        DeferSpaBoot: true,
        RequiresUserState: false,
        FallbackBehavior: PublicRouteIdentityRegistry.PublicAotShellFallback);

    public static readonly PublicPageDescriptor Filter = new(
        PublicPageId.Filter,
        "filter",
        SeoEligible: true,
        AotShellReady: true,
        DeferSpaBoot: true,
        RequiresUserState: false,
        FallbackBehavior: PublicRouteIdentityRegistry.PublicAotShellFallback);

    public static readonly PublicPageDescriptor Archive = new(
        PublicPageId.Archive,
        "archive",
        SeoEligible: true,
        AotShellReady: true,
        DeferSpaBoot: true,
        RequiresUserState: false,
        FallbackBehavior: PublicRouteIdentityRegistry.PublicAotShellFallback);

    public static readonly PublicPageDescriptor About = new(
        PublicPageId.About,
        "about",
        SeoEligible: true,
        AotShellReady: true,
        DeferSpaBoot: true,
        RequiresUserState: false,
        FallbackBehavior: PublicRouteIdentityRegistry.PublicAotShellFallback);

    public static readonly PublicPageDescriptor Account = new(
        PublicPageId.Account,
        "account",
        SeoEligible: false,
        AotShellReady: false,
        DeferSpaBoot: false,
        RequiresUserState: true,
        FallbackBehavior: PublicRouteIdentityRegistry.UserStateRuntimeOnlyFallback);

    public static readonly PublicPageDescriptor Privacy = new(
        PublicPageId.Privacy,
        "privacy",
        SeoEligible: true,
        AotShellReady: true,
        DeferSpaBoot: true,
        RequiresUserState: false,
        FallbackBehavior: PublicRouteIdentityRegistry.PublicAotShellFallback);

    public static readonly PublicPageDescriptor Guidelines = new(
        PublicPageId.Guidelines,
        "guidelines",
        SeoEligible: true,
        AotShellReady: true,
        DeferSpaBoot: true,
        RequiresUserState: false,
        FallbackBehavior: PublicRouteIdentityRegistry.PublicAotShellFallback);

    public static readonly PublicPageDescriptor Copyright = new(
        PublicPageId.Copyright,
        "copyright",
        SeoEligible: true,
        AotShellReady: true,
        DeferSpaBoot: true,
        RequiresUserState: false,
        FallbackBehavior: PublicRouteIdentityRegistry.PublicAotShellFallback);

    public static readonly PublicPageDescriptor[] All =
    [
        Home,
        ArticleDetail,
        Filter,
        Archive,
        About,
        Account,
        Privacy,
        Guidelines,
        Copyright
    ];

    private static readonly FrozenDictionary<PublicPageId, PublicPageDescriptor> ById =
        All.ToFrozenDictionary(static descriptor => descriptor.Id);

    public static PublicPageDescriptor GetRequired(PublicPageId pageId)
        => ById.TryGetValue(pageId, out PublicPageDescriptor descriptor)
            ? descriptor
            : Home;

    public static bool TryGet(PublicPageId pageId, out PublicPageDescriptor descriptor)
        => ById.TryGetValue(pageId, out descriptor);
}
