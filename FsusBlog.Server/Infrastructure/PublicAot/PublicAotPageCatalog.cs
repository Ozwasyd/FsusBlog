using System.Collections.Frozen;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotPageCatalog
{
    internal static readonly PublicAotPageDescriptor Home = new(
        PublicPageKind.Home,
        PublicPageId.Home,
        HydrationKind: "Home",
        StaticPath: "/",
        FixedRouteKey: "home",
        DefaultTitle: string.Empty,
        StoredPageName: "首页",
        CanonicalFixedPath: "/");

    internal static readonly PublicAotPageDescriptor ArticleDetail = new(
        PublicPageKind.ArticleDetail,
        PublicPageId.ArticleDetail,
        HydrationKind: "ArticleDetail",
        StaticPath: null,
        FixedRouteKey: null,
        DefaultTitle: "文章详情",
        StoredPageName: "文章详情",
        CanonicalFixedPath: null);

    internal static readonly PublicAotPageDescriptor Filter = new(
        PublicPageKind.Filter,
        PublicPageId.Filter,
        HydrationKind: "Filter",
        StaticPath: null,
        FixedRouteKey: null,
        DefaultTitle: "筛选",
        StoredPageName: "筛选列表",
        CanonicalFixedPath: null);

    internal static readonly PublicAotPageDescriptor About = new(
        PublicPageKind.About,
        PublicPageId.About,
        HydrationKind: "About",
        StaticPath: "/about",
        FixedRouteKey: "about",
        DefaultTitle: "关于",
        StoredPageName: "关于",
        CanonicalFixedPath: "/about");

    internal static readonly PublicAotPageDescriptor Archive = new(
        PublicPageKind.Archive,
        PublicPageId.Archive,
        HydrationKind: "Archive",
        StaticPath: "/archive",
        FixedRouteKey: "archive",
        DefaultTitle: "归档",
        StoredPageName: "归档",
        CanonicalFixedPath: "/archive");

    internal static readonly IReadOnlyList<PublicAotPageDescriptor> All =
    [
        Home,
        ArticleDetail,
        Filter,
        About,
        Archive
    ];

    private static readonly FrozenDictionary<PublicPageKind, PublicAotPageDescriptor> ByKind =
        All.ToFrozenDictionary(static descriptor => descriptor.Kind);

    private static readonly FrozenDictionary<PublicPageId, PublicAotPageDescriptor> ByPageId =
        All.ToFrozenDictionary(static descriptor => descriptor.PageId);

    private static readonly FrozenDictionary<string, PublicAotPageDescriptor> ByStaticPath =
        All.Where(static descriptor => !string.IsNullOrWhiteSpace(descriptor.StaticPath))
            .ToFrozenDictionary(static descriptor => descriptor.StaticPath!, StringComparer.OrdinalIgnoreCase);

    private static readonly FrozenDictionary<string, PublicAotPageDescriptor>.AlternateLookup<ReadOnlySpan<char>> ByStaticPathSpanLookup =
        ByStaticPath.GetAlternateLookup<ReadOnlySpan<char>>();

    internal static PublicAotPageDescriptor GetRequired(PublicPageKind kind)
        => ByKind.TryGetValue(kind, out PublicAotPageDescriptor? descriptor)
            ? descriptor
            : Home;

    internal static PublicAotPageDescriptor GetRequired(PublicPageId pageId)
        => ByPageId.TryGetValue(pageId, out PublicAotPageDescriptor? descriptor)
            ? descriptor
            : Home;

    internal static bool TryGet(PublicPageKind kind, out PublicAotPageDescriptor descriptor)
        => ByKind.TryGetValue(kind, out descriptor!);

    internal static bool TryGet(PublicPageId pageId, out PublicAotPageDescriptor descriptor)
        => ByPageId.TryGetValue(pageId, out descriptor!);

    internal static bool TryGetByStaticPath(string path, out PublicAotPageDescriptor descriptor)
        => ByStaticPath.TryGetValue(path, out descriptor!);

    internal static bool TryGetByStaticPath(ReadOnlySpan<char> path, out PublicAotPageDescriptor descriptor)
        => ByStaticPathSpanLookup.TryGetValue(path, out descriptor!);
}
