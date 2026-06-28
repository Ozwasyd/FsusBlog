using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests;

public sealed class RumTelemetryServiceTests
{
    [Fact]
    public void RumTelemetry_SourceUsesBoundedChannelAndMovesDbInsertToWorker()
    {
        string source = ReadSource("src/backend/Services/Telemetry/RumTelemetryService.cs");
        string service = Slice(source, "public sealed class RumTelemetryService", "public sealed class RumTelemetryFlushWorker");
        string worker = Slice(source, "public sealed class RumTelemetryFlushWorker", "internal sealed record RumMetricAuditContext");
        string registrations = ReadSource("src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs")
            + ReadSource("src/backend/Infrastructure/Bootstrap/RuntimeInfrastructureServiceCollectionExtensions.cs");

        Assert.Contains("public sealed class RumTelemetryChannel", source, StringComparison.Ordinal);
        Assert.Contains("BoundedChannelFullMode.DropOldest", source, StringComparison.Ordinal);
        Assert.Contains("TryEnqueue", service, StringComparison.Ordinal);
        Assert.DoesNotContain("Insertable", service, StringComparison.Ordinal);
        Assert.Contains("Insertable", worker, StringComparison.Ordinal);
        Assert.Contains("AddSingleton<RumTelemetryChannel>()", registrations, StringComparison.Ordinal);
        Assert.Contains("AddHostedService<RumTelemetryFlushWorker>()", registrations, StringComparison.Ordinal);
    }

    [Fact]
    public void RumTelemetryChannel_WhenFull_DropsOldestAndKeepsNewest()
    {
        var channel = new RumTelemetryChannel(capacity: 1);
        var oldest = CreateBatch("home");
        var newest = CreateBatch("article");

        RumTelemetryEnqueueResult first = channel.TryEnqueue(oldest);
        RumTelemetryEnqueueResult second = channel.TryEnqueue(newest);

        Assert.True(first.Accepted);
        Assert.True(second.Accepted);
        Assert.Equal(1, second.DroppedCount);
        Assert.True(channel.TryRead(out RumMetricBatchRequest? queued));
        Assert.Equal("article", queued!.PageType);
        RumTelemetryChannelSnapshot snapshot = channel.CreateSnapshot();
        Assert.Equal(2, snapshot.AcceptedBatches);
        Assert.Equal(1, snapshot.DroppedBatches);
    }

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

    private static RumMetricBatchRequest CreateBatch(string pageType)
        => new(
            pageType,
            "route",
            "server-aot",
            [
                new RumMetricBatchItem(
                    "web_vital_lcp",
                    1234,
                    DateTime.UtcNow,
                    new Dictionary<string, double> { ["value"] = 1234 },
                    null)
            ]);

    private static string ReadSource(string relativePath)
        => File.ReadAllText(Path.Combine(TestInfrastructure.BackendTestPaths.RepositoryRoot, relativePath));

    private static string Slice(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker: {startMarker}");
        int end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing end marker: {endMarker}");
        return source[start..end];
    }
}
