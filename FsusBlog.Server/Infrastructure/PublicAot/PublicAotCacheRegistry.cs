using System.Linq;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotCacheRegistry
{
    internal const string GlobalRegistryKey = "public:aot:v2:registry";
    private const string CacheKeyPrefix = "public:aot:v2:doc:";
    private const string PageRegistryKeyPrefix = "public:aot:v2:registry:page:";
    private const string RouteRegistryKeyPrefix = "public:aot:v2:registry:route:";

    internal static IEnumerable<string> GetRegistryKeys(PublicPageId pageId, string routeKey)
    {
        yield return GlobalRegistryKey;
        yield return BuildPageRegistryKey(pageId);

        string? routeBucket = ResolveRouteBucket(pageId, routeKey);
        if (!string.IsNullOrEmpty(routeBucket))
        {
            yield return BuildRouteRegistryKey(pageId, routeBucket);
        }
    }

    internal static string BuildPageRegistryKey(PublicPageId pageId)
        => string.Concat(PageRegistryKeyPrefix, ((int)pageId).ToString());

    internal static string BuildRouteRegistryKey(PublicPageId pageId, string routeBucket)
        => string.Concat(RouteRegistryKeyPrefix, ((int)pageId).ToString(), ":", routeBucket);

    internal static IReadOnlyList<string> GetAllKnownRegistryKeys()
    {
        return
        [
            GlobalRegistryKey,
            .. PublicPageRegistry.All.Select(static page => BuildPageRegistryKey(page.Id)),
            BuildRouteRegistryKey(PublicPageId.ArticleDetail, "article"),
            BuildRouteRegistryKey(PublicPageId.Filter, "category"),
            BuildRouteRegistryKey(PublicPageId.Filter, "tag")
        ];
    }

    internal static bool TryResolveRegistryScope(string prefix, out string registryKey, out bool requiresPrefixFilter)
    {
        registryKey = GlobalRegistryKey;
        requiresPrefixFilter = true;

        if (!TryParseCacheKey(prefix, out PublicPageId pageId, out string routeKeyPrefix))
        {
            return false;
        }

        string? routeBucket = ResolveRouteBucket(pageId, routeKeyPrefix);
        if (!string.IsNullOrEmpty(routeBucket))
        {
            registryKey = BuildRouteRegistryKey(pageId, routeBucket);
            requiresPrefixFilter = true;
            return true;
        }

        registryKey = BuildPageRegistryKey(pageId);
        requiresPrefixFilter = !string.IsNullOrEmpty(routeKeyPrefix);
        return true;
    }

    internal static bool TryParseCacheKey(string cacheKey, out PublicPageId pageId, out string routeKey)
    {
        pageId = default;
        routeKey = string.Empty;

        if (!cacheKey.StartsWith(CacheKeyPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> remainder = cacheKey.AsSpan(CacheKeyPrefix.Length);
        int separatorIndex = remainder.IndexOf(':');
        if (separatorIndex < 0)
        {
            return false;
        }

        if (!int.TryParse(remainder[..separatorIndex], out int pageValue)
            || !Enum.IsDefined(typeof(PublicPageId), pageValue))
        {
            return false;
        }

        pageId = (PublicPageId)pageValue;
        routeKey = remainder[(separatorIndex + 1)..].ToString();
        return true;
    }

    internal static string? ResolveRouteBucket(PublicPageId pageId, string routeKey)
    {
        if (string.IsNullOrEmpty(routeKey))
        {
            return null;
        }

        int separatorIndex = routeKey.IndexOf(':');
        if (separatorIndex <= 0)
        {
            return null;
        }

        string bucket = routeKey[..separatorIndex];
        return pageId switch
        {
            PublicPageId.ArticleDetail when string.Equals(bucket, "article", StringComparison.Ordinal) => bucket,
            PublicPageId.Filter when string.Equals(bucket, "category", StringComparison.Ordinal) => bucket,
            PublicPageId.Filter when string.Equals(bucket, "tag", StringComparison.Ordinal) => bucket,
            _ => null
        };
    }
}
