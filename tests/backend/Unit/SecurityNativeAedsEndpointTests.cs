using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Modules.Endpoints;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityNativeAedsEndpointTests
{
    [Fact]
    public void TryResolveRoute_KnowsRiskListAndPowRoutes()
    {
        Assert.True(SecurityEndpoints.TryResolveRoute(HttpMethods.Post, new PathString("/risk/ip/reset"), out var resetRoute));
        Assert.Equal(AedsFrameType.SecurityRiskResetRequest, resetRoute.RequestFrame);
        Assert.Equal(AedsFrameType.SecurityRiskResetResponse, resetRoute.ResponseFrame);

        Assert.True(SecurityEndpoints.TryResolveRoute(HttpMethods.Delete, new PathString("/anti-crawler/allowlist/entry-1"), out var listRoute));
        Assert.Null(listRoute.RequestFrame);
        Assert.Equal(AedsFrameType.AntiCrawlerListEntryDeleteResponse, listRoute.ResponseFrame);

        Assert.True(SecurityEndpoints.TryResolveRoute(HttpMethods.Put, new PathString("/pow/options"), out var powRoute));
        Assert.Equal(AedsFrameType.PowOptionsUpdateRequest, powRoute.RequestFrame);
        Assert.Equal(AedsFrameType.PowPolicySnapshot, powRoute.ResponseFrame);
    }

    [Fact]
    public void TryResolveRoute_KnowsRiskControlConsoleRoutes()
    {
        foreach (string path in new[]
        {
            "/risk-control/overview",
            "/risk-control/options",
            "/challenges/overview",
            "/policies/overview",
            "/perception-v2/overview",
            "/perception-v2/options"
        })
        {
            Assert.True(SecurityEndpoints.TryResolveRoute(HttpMethods.Get, new PathString(path), out var route));
            Assert.Null(route.RequestFrame);
            Assert.Equal(AedsFrameType.SecurityOverview, route.ResponseFrame);
        }

        Assert.True(SecurityEndpoints.TryResolveRoute(HttpMethods.Put, new PathString("/risk-control/options"), out var update));
        Assert.Equal(AedsFrameType.SecurityOverview, update.RequestFrame);
        Assert.Equal(AedsFrameType.SecurityOverview, update.ResponseFrame);
    }
}
