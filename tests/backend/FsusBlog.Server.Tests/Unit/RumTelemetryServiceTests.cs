using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Telemetry;

namespace FsusBlog.Server.Tests;

public sealed class RumTelemetryServiceTests
{
    [Fact]
    public void Normalize_AcceptsOnlyBoundedAnonymousMetricFields()
    {
        RumMetricAuditContext? context = RumTelemetryService.Normalize(new RumMetricRequest(
            "web_vital_lcp",
            "article",
            "server-aot",
            1234.5678,
            new Dictionary<string, double>
            {
                ["durationMs"] = 1234.5678,
                ["domInteractive"] = 456,
                ["userId"] = 42
            },
            DateTime.UtcNow));

        Assert.NotNull(context);
        Assert.Equal("article", context!.PageType);
        Assert.Equal("server-aot", context.AotSource);
        Assert.Equal(1234.5678, context.Value);
        Assert.True(context.Metrics.ContainsKey("durationMs"));
        Assert.True(context.Metrics.ContainsKey("domInteractive"));
        Assert.False(context.Metrics.ContainsKey("userId"));
    }

    [Fact]
    public void Normalize_RejectsUnknownMetricNamesAndBodylessPayloads()
    {
        Assert.Null(RumTelemetryService.Normalize(new RumMetricRequest(
            "keystroke_capture",
            "article",
            "server-aot",
            1,
            null,
            DateTime.UtcNow)));

        Assert.Null(RumTelemetryService.Normalize(new RumMetricRequest(
            "web_vital_cls",
            "article",
            "server-aot",
            null,
            new Dictionary<string, double> { ["unknown"] = 1 },
            DateTime.UtcNow)));
    }
}
