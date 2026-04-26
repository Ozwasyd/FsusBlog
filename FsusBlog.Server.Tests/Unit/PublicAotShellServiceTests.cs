using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotShellServiceTests
{
    [Fact]
    public void IsRenderableCacheEntry_RejectsMismatchedFrontendAssetVersion()
    {
        var entry = new PublicAotCacheEntry
        {
            CacheKey = "public:aot:v2:doc:1:home",
            RouteKey = "home",
            RendererVersion = PublicAotShellService.PublicRendererVersion,
            FrontendAssetVersion = "frontend-v1",
            Value = "<html>cached</html>"
        };

        bool renderable = PublicAotShellService.IsRenderableCacheEntry(entry, "frontend-v2");

        Assert.False(renderable);
    }

    [Fact]
    public void IsRenderableCacheEntry_AcceptsMatchingRendererAndFrontendAssetVersion()
    {
        var entry = new PublicAotCacheEntry
        {
            CacheKey = "public:aot:v2:doc:1:home",
            RouteKey = "home",
            RendererVersion = PublicAotShellService.PublicRendererVersion,
            FrontendAssetVersion = "frontend-v1",
            Value = "<html>cached</html>"
        };

        bool renderable = PublicAotShellService.IsRenderableCacheEntry(entry, "frontend-v1");

        Assert.True(renderable);
    }
}
