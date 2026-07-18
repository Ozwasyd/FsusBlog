using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Models.Security;
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

        Assert.True(SecurityEndpoints.TryResolveRoute(HttpMethods.Put, new PathString("/perception-v2/options"), out var perceptionUpdate));
        Assert.Equal(AedsFrameType.SecurityOverview, perceptionUpdate.RequestFrame);
        Assert.Equal(AedsFrameType.SecurityOverview, perceptionUpdate.ResponseFrame);
    }

    [Fact]
    public void NormalizeSecurityAuditPayload_ConvertsPerceptionSnapshotToAotSafeObjectGraph()
    {
        var snapshot = new PerceptionSealedV2PolicySnapshot(
            "snapshot-1",
            "policy-1",
            DateTimeOffset.Parse("2026-07-06T00:00:00Z"),
            "admin:2",
            "direct switch",
            null,
            new PerceptionSealedV2PolicyOptions(
                Enabled: true,
                TextTaskEnabled: true,
                LocalizationEnabled: true,
                MicroInteractionEnabled: false,
                PoSpaceFallbackEnabled: false,
                EarlyRejectThreshold: 90,
                MaxAttempts: 3,
                MinSolveDurationMs: 750,
                MaxSolveDurationMs: 60000));

        object? normalized = SecurityEndpoints.NormalizeSecurityAuditPayload(snapshot);

        var payload = Assert.IsType<Dictionary<string, object?>>(normalized);
        Assert.Equal("snapshot-1", payload["snapshotId"]);
        var options = Assert.IsType<Dictionary<string, object?>>(payload["options"]);
        Assert.True(Assert.IsType<bool>(options["enabled"]));
        Assert.Equal(3, Assert.IsType<int>(options["maxAttempts"]));
        byte[] frame = PublicAotBinaryPayload.EncodeObjectFrame(new Dictionary<string, object?>
        {
            ["payload"] = normalized
        });
        Assert.NotEmpty(frame);
    }
}
