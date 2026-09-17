using System.Collections.Frozen;

using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotPageCatalog
{
    private enum LocalRouteTopology
    {
        StaticSeoPage,
        DynamicArticle,
        DynamicFilter,
        AccountFixedPath
    }

    private sealed record LocalPageMetadata(
        string DefaultTitle,
        string StoredPageName,
        LocalRouteTopology RouteTopology);

    private static readonly FrozenDictionary<PublicPageKind, LocalPageMetadata> s_localMetadataByKind =
        new Dictionary<PublicPageKind, LocalPageMetadata>
        {
            [PublicPageKind.Home] = new(string.Empty, "首页", LocalRouteTopology.StaticSeoPage),
            [PublicPageKind.ArticleDetail] = new("文章详情", "文章详情", LocalRouteTopology.DynamicArticle),
            [PublicPageKind.Filter] = new("筛选", "筛选列表", LocalRouteTopology.DynamicFilter),
            [PublicPageKind.About] = new("关于", "关于", LocalRouteTopology.StaticSeoPage),
            [PublicPageKind.Archive] = new("归档", "归档", LocalRouteTopology.StaticSeoPage),
            [PublicPageKind.Privacy] = new("隐私政策", "隐私政策", LocalRouteTopology.StaticSeoPage),
            [PublicPageKind.Guidelines] = new("用户守则", "用户守则", LocalRouteTopology.StaticSeoPage),
            [PublicPageKind.Copyright] = new("版权声明", "版权声明", LocalRouteTopology.StaticSeoPage),
            [PublicPageKind.Account] = new("账户中心", "账户中心", LocalRouteTopology.AccountFixedPath)
        }.ToFrozenDictionary();

    internal static readonly IReadOnlyList<PublicAotPageDescriptor> s_all = BuildDescriptors();

    private static readonly FrozenDictionary<PublicPageKind, PublicAotPageDescriptor> s_byKind =
        s_all.ToFrozenDictionary(static descriptor => descriptor.Kind);

    private static readonly FrozenDictionary<PublicPageId, PublicAotPageDescriptor> s_byPageId =
        s_all.ToFrozenDictionary(static descriptor => descriptor.PageId);

    private static readonly FrozenDictionary<string, PublicAotPageDescriptor> s_byStaticPath =
        s_all.Where(static descriptor => !string.IsNullOrWhiteSpace(descriptor.StaticPath))
            .ToFrozenDictionary(static descriptor => descriptor.StaticPath!, StringComparer.OrdinalIgnoreCase);

    private static readonly FrozenDictionary<string, PublicAotPageDescriptor>.AlternateLookup<ReadOnlySpan<char>> s_byStaticPathSpanLookup =
        s_byStaticPath.GetAlternateLookup<ReadOnlySpan<char>>();

    internal static PublicAotPageDescriptor Home => GetRequired(PublicPageKind.Home);

    internal static PublicAotPageDescriptor ArticleDetail => GetRequired(PublicPageKind.ArticleDetail);

    internal static PublicAotPageDescriptor Filter => GetRequired(PublicPageKind.Filter);

    internal static PublicAotPageDescriptor About => GetRequired(PublicPageKind.About);

    internal static PublicAotPageDescriptor Archive => GetRequired(PublicPageKind.Archive);

    internal static PublicAotPageDescriptor Privacy => GetRequired(PublicPageKind.Privacy);

    internal static PublicAotPageDescriptor Guidelines => GetRequired(PublicPageKind.Guidelines);

    internal static PublicAotPageDescriptor Copyright => GetRequired(PublicPageKind.Copyright);

    internal static PublicAotPageDescriptor Account => GetRequired(PublicPageKind.Account);

    internal static PublicAotPageDescriptor GetRequired(PublicPageKind kind)
        => s_byKind.TryGetValue(kind, out PublicAotPageDescriptor? descriptor)
            ? descriptor
            : Home;

    internal static PublicAotPageDescriptor GetRequired(PublicPageId pageId)
        => s_byPageId.TryGetValue(pageId, out PublicAotPageDescriptor? descriptor)
            ? descriptor
            : Home;

    internal static bool TryGet(PublicPageKind kind, out PublicAotPageDescriptor descriptor)
        => s_byKind.TryGetValue(kind, out descriptor!);

    internal static bool TryGet(PublicPageId pageId, out PublicAotPageDescriptor descriptor)
        => s_byPageId.TryGetValue(pageId, out descriptor!);

    internal static bool TryGetByStaticPath(string path, out PublicAotPageDescriptor descriptor)
        => s_byStaticPath.TryGetValue(path, out descriptor!);

    internal static bool TryGetByStaticPath(ReadOnlySpan<char> path, out PublicAotPageDescriptor descriptor)
        => s_byStaticPathSpanLookup.TryGetValue(path, out descriptor!);

    private static IReadOnlyList<PublicAotPageDescriptor> BuildDescriptors()
    {
        List<PublicAotPageDescriptor> descriptors = [];

        foreach (PublicPageKind kind in Enum.GetValues<PublicPageKind>())
        {
            if (kind == PublicPageKind.Unknown)
            {
                continue;
            }

            if (!s_localMetadataByKind.TryGetValue(kind, out LocalPageMetadata? metadata))
            {
                throw new InvalidOperationException($"PublicAotPageCatalog is missing local metadata for kind '{kind}'.");
            }

            descriptors.Add(CreateDescriptor(kind, metadata));
        }

        return descriptors;
    }

    private static PublicAotPageDescriptor CreateDescriptor(PublicPageKind kind, LocalPageMetadata metadata)
    {
        string canonicalSlug = PublicAotPageIdentity.GetCanonicalSlug(kind);
        string? defaultFixedPath = PublicAotPageIdentity.GetDefaultFixedPath(kind);

        return metadata.RouteTopology switch
        {
            LocalRouteTopology.StaticSeoPage => new PublicAotPageDescriptor(
                kind,
                StaticPath: defaultFixedPath,
                FixedRouteKey: canonicalSlug,
                metadata.DefaultTitle,
                metadata.StoredPageName,
                CanonicalFixedPath: defaultFixedPath),
            LocalRouteTopology.AccountFixedPath => new PublicAotPageDescriptor(
                kind,
                StaticPath: null,
                FixedRouteKey: canonicalSlug,
                metadata.DefaultTitle,
                metadata.StoredPageName,
                CanonicalFixedPath: PublicRouteIdentityRegistry.AccountPath),
            _ => new PublicAotPageDescriptor(
                kind,
                StaticPath: null,
                FixedRouteKey: null,
                metadata.DefaultTitle,
                metadata.StoredPageName,
                CanonicalFixedPath: null)
        };
    }
}
