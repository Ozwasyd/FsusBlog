using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Core.Cache;

public static class CacheKeyBuilder
{
    private const string PublicAotPrefix = "public:aot:v2:";

    public static string PublicAotDocument(PublicPageId pageId, string routeKey)
        => string.Concat(PublicAotPrefix, "doc:", ((int)pageId).ToString(), ":", routeKey);
}
