using System.Reflection;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Tests;

public sealed class RumTelemetryServiceTests
{
    [Fact]
    public async Task RumTelemetry_IngestionUsesBoundedChannelAndPersistenceIsWorkerOwned()
    {
        var channel = new RumTelemetryChannel(capacity: 2);
        var service = new RumTelemetryService(channel);

        RumMetricIngestResponse response = await service.IngestBatchAsync(CreateBatch("article"));

        Assert.True(response.Accepted);
        Assert.Equal(1, response.AcceptedCount);
        Assert.True(channel.TryRead(out RumMetricBatchRequest? queued));
        Assert.Equal("article", queued!.PageType);

        ConstructorInfo serviceConstructor = Assert.Single(typeof(RumTelemetryService).GetConstructors());
        Assert.Equal(
            [typeof(RumTelemetryChannel)],
            serviceConstructor.GetParameters().Select(static parameter => parameter.ParameterType).ToArray());
        ConstructorInfo workerConstructor = Assert.Single(typeof(RumTelemetryFlushWorker).GetConstructors());
        Assert.Contains(workerConstructor.GetParameters(), static parameter =>
            parameter.ParameterType == typeof(IServiceScopeFactory));

        var services = new ServiceCollection();
        services.AddFsusRuntimeServices(new ConfigurationBuilder().AddInMemoryCollection().Build());
        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(RumTelemetryChannel)
            && descriptor.Lifetime == ServiceLifetime.Singleton);
        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(RumTelemetryService)
            && descriptor.Lifetime == ServiceLifetime.Scoped);
        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(IRumTelemetryService)
            && descriptor.Lifetime == ServiceLifetime.Scoped);
        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(IHostedService)
            && descriptor.ImplementationType == typeof(RumTelemetryFlushWorker));
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

}
