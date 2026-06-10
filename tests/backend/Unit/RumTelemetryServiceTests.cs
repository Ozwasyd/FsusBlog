using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;

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

    [Fact]
    public void BatchShape_AllowsOnlyLowCardinalityDimensions()
    {
        Assert.True(RumTelemetryService.IsBatchItemShapeAllowed(new RumMetricBatchItem(
            "web_vital_lcp",
            1234,
            DateTime.UtcNow,
            new Dictionary<string, double> { ["value"] = 1234 },
            new Dictionary<string, string>
            {
                ["routeKind"] = "article",
                ["renderMode"] = "server-aot"
            })));

        Assert.False(RumTelemetryService.IsBatchItemShapeAllowed(new RumMetricBatchItem(
            "web_vital_lcp",
            1234,
            DateTime.UtcNow,
            new Dictionary<string, double> { ["value"] = 1234 },
            new Dictionary<string, string> { ["route"] = "/article/42" })));
    }

    [Fact]
    public void BatchShape_RejectsOversizedMetricNamesAndTooManyValues()
    {
        Assert.False(RumTelemetryService.IsBatchItemShapeAllowed(new RumMetricBatchItem(
            new string('a', RumTelemetryContractLimits.MaxMetricNameLength + 1),
            1,
            DateTime.UtcNow,
            null,
            null)));

        Assert.False(RumTelemetryService.IsBatchItemShapeAllowed(new RumMetricBatchItem(
            "web_vital_lcp",
            1,
            DateTime.UtcNow,
            new Dictionary<string, double>
            {
                ["value"] = 1,
                ["durationMs"] = 1,
                ["domInteractive"] = 1,
                ["responseStart"] = 1,
                ["extra"] = 1
            },
            null)));
    }
}
