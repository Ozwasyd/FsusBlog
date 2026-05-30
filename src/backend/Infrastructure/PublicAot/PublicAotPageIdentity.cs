using System.Collections.Frozen;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotPageIdentity
{
    private static readonly FrozenDictionary<PublicPageKind, PublicPageId> PageIds = BuildPageIds();
    private static readonly FrozenSet<PublicPageKind> SeoEligibleKinds = BuildSeoEligibleKinds();

    internal static PublicPageId ToPageId(PublicPageKind kind)
        => PageIds.TryGetValue(kind, out PublicPageId pageId)
            ? pageId
            : throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unsupported public page kind.");

    internal static string ToHydrationKind(PublicPageKind kind)
        => ToPageId(kind).ToString();

    internal static string GetCanonicalSlug(PublicPageKind kind)
        => PublicPageRegistry.GetRequired(ToPageId(kind)).CanonicalSlug;

    internal static string? GetDefaultFixedPath(PublicPageKind kind)
        => kind switch
        {
            PublicPageKind.Home => "/",
            PublicPageKind.ArticleDetail => null,
            PublicPageKind.Filter => null,
            PublicPageKind.Account => null,
            _ => string.Concat("/", GetCanonicalSlug(kind))
        };

    internal static IReadOnlyCollection<PublicPageKind> GetSeoEligibleKinds()
        => SeoEligibleKinds;

    private static FrozenDictionary<PublicPageKind, PublicPageId> BuildPageIds()
    {
        Dictionary<PublicPageKind, PublicPageId> map = [];
        foreach (PublicPageKind kind in Enum.GetValues<PublicPageKind>())
        {
            if (kind == PublicPageKind.Unknown)
            {
                continue;
            }

            if (!Enum.TryParse(kind.ToString(), ignoreCase: false, out PublicPageId pageId) ||
                !PublicPageRegistry.TryGet(pageId, out _))
            {
                throw new InvalidOperationException($"Public page kind '{kind}' is not aligned with shared PublicPageRegistry.");
            }

            map[kind] = pageId;
        }

        return map.ToFrozenDictionary();
    }

    private static FrozenSet<PublicPageKind> BuildSeoEligibleKinds()
    {
        HashSet<PublicPageKind> kinds = [];

        foreach (PublicPageDescriptor descriptor in PublicPageRegistry.All)
        {
            if (!descriptor.SeoEligible)
            {
                continue;
            }

            if (!Enum.TryParse(descriptor.Id.ToString(), ignoreCase: false, out PublicPageKind kind) ||
                kind == PublicPageKind.Unknown)
            {
                throw new InvalidOperationException($"Shared SEO page '{descriptor.Id}' is not aligned with PublicPageKind.");
            }

            kinds.Add(kind);
        }

        return kinds.ToFrozenSet();
    }
}