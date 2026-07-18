using System.Diagnostics;
using System.Reflection;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Services.VisitLog;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;
namespace FsusBlog.Server.Tests;

public sealed class VisitLogProcessorServiceTests
{
    [Fact]
    public async Task DrainBatchWithFlushWindowAsync_LowTrafficWaitsForFlushWindow()
    {
        await using ServiceProvider provider = CreateServiceProvider();
        var channel = new VisitLogChannel();
        var worker = new VisitLogProcessorService(channel, provider, NullLogger<VisitLogProcessorService>.Instance);
        var batch = new List<VisitLogMessage>();
        Assert.True(channel.TryWrite(CreateMessage()));

        var elapsed = Stopwatch.StartNew();
        await DrainBatchAsync(worker, batch, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10));
        elapsed.Stop();

        Assert.Single(batch);
        Assert.True(elapsed.Elapsed >= VisitLogProcessorService.FlushWindow * 0.75);
    }

    [Fact]
    public async Task DrainBatchWithFlushWindowAsync_FullBatchReturnsWithoutWaitingForFlushWindow()
    {
        await using ServiceProvider provider = CreateServiceProvider();
        var channel = new VisitLogChannel();
        var worker = new VisitLogProcessorService(channel, provider, NullLogger<VisitLogProcessorService>.Instance);
        var batch = new List<VisitLogMessage>();
        for (int i = 0; i < 500; i++)
        {
            Assert.True(channel.TryWrite(CreateMessage()));
        }

        var elapsed = Stopwatch.StartNew();
        await DrainBatchAsync(worker, batch, CancellationToken.None);
        elapsed.Stop();

        Assert.Equal(500, batch.Count);
        Assert.True(elapsed.Elapsed < VisitLogProcessorService.FlushWindow);
    }

    [Fact]
    public async Task DrainBatchWithFlushWindowAsync_DoesNotSwallowShutdownCancellation()
    {
        await using ServiceProvider provider = CreateServiceProvider();
        var worker = new VisitLogProcessorService(new VisitLogChannel(), provider, NullLogger<VisitLogProcessorService>.Instance);
        var batch = new List<VisitLogMessage>();
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(() => DrainBatchAsync(worker, batch, cts.Token));
        Assert.Empty(batch);
    }

    [Fact]
    public void ContributionTransport_HasOnlyCoarseAggregateDimensions()
    {
        string[] properties = typeof(VisitLogMessage)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(static property => property.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(
            new[] { "AggregateHourUtc", "ArticleId", "DwellBucket", "EventType" }.Order(StringComparer.Ordinal),
            properties);
        Assert.DoesNotContain(properties, static name =>
            name.Contains("Ip", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Route", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Viewer", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Proof", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Device", StringComparison.OrdinalIgnoreCase)
            || name.Contains("UserAgent", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ContributionChannel_AcceptsConcurrentWritersBelowItsBoundedCapacity()
    {
        const int ContributionCount = 20_000;
        var channel = new VisitLogChannel();
        int accepted = 0;

        Parallel.For(0, ContributionCount, _ =>
        {
            if (channel.TryWrite(CreateMessage()))
            {
                Interlocked.Increment(ref accepted);
            }
        });

        Assert.Equal(ContributionCount, accepted);
        Assert.Equal(ContributionCount, channel.QueuedCount);
        Assert.Equal(0, channel.SaturatedWriteCount);
    }

    [Fact]
    public async Task DrainBatchWithFlushWindowAsync_InvalidOrUnalignedContributionsAreDiscarded()
    {
        await using ServiceProvider provider = CreateServiceProvider();
        var channel = new VisitLogChannel();
        var worker = new VisitLogProcessorService(channel, provider, NullLogger<VisitLogProcessorService>.Instance);
        var batch = new List<VisitLogMessage>();
        Assert.True(channel.TryWrite(new VisitLogMessage(
            new DateTime(2026, 7, 15, 10, 12, 0, DateTimeKind.Utc),
            HumanReadEventTypes.ArticleRead,
            42,
            ReadDwellBuckets.From10To30Seconds)));

        await DrainBatchAsync(worker, batch, CancellationToken.None);

        Assert.Empty(batch);
    }

    [Theory]
    [InlineData(0, ReadDwellBuckets.Under10Seconds)]
    [InlineData(9_999, ReadDwellBuckets.Under10Seconds)]
    [InlineData(10_000, ReadDwellBuckets.From10To30Seconds)]
    [InlineData(29_999, ReadDwellBuckets.From10To30Seconds)]
    [InlineData(30_000, ReadDwellBuckets.From30To120Seconds)]
    [InlineData(119_999, ReadDwellBuckets.From30To120Seconds)]
    [InlineData(120_000, ReadDwellBuckets.Over120Seconds)]
    public void Classify_UsesOnlyFourDocumentedDwellBuckets(int dwellMs, string expected)
    {
        Assert.Equal(expected, ReadDwellBuckets.Classify(dwellMs));
    }

    [Fact]
    public async Task Persistence_WritesOnlyAggregateTables()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAdo ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        string? executedSql = null;
        ado.ExecuteCommandAsync(
                Arg.Do<string>(sql => executedSql = sql),
                Arg.Any<SugarParameter[]>())
            .Returns(Task.FromResult(1));

        await VisitLogProcessorService.PersistAggregatesAsync(
            db,
            [CreateMessage()],
            CancellationToken.None);

        Assert.NotNull(executedSql);
        Assert.Contains("article_read_hourly_aggregate", executedSql, StringComparison.Ordinal);
        Assert.Contains("read_dwell_daily_aggregate", executedSql, StringComparison.Ordinal);
        Assert.Contains("CAST(@ArticleId0 AS integer)", executedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("sys_visit_log", executedSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("viewer_key_hash", executedSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("proof_id", executedSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("route_key", executedSql, StringComparison.OrdinalIgnoreCase);
    }

    private static VisitLogMessage CreateMessage()
        => new(
            new DateTime(2026, 7, 15, 10, 0, 0, DateTimeKind.Utc),
            HumanReadEventTypes.SiteRead,
            null,
            ReadDwellBuckets.Under10Seconds);

    private static ServiceProvider CreateServiceProvider()
        => new ServiceCollection()
            .AddScoped(_ => Substitute.For<ISqlSugarClient>())
            .AddScoped(_ => Substitute.For<IDbConcurrencyGate>())
            .AddScoped(_ => Substitute.For<IArticleViewProjectionService>())
            .AddScoped(_ => Substitute.For<IHotStatsInvalidationCoalescer>())
            .BuildServiceProvider();

    private static async Task DrainBatchAsync(
        VisitLogProcessorService worker,
        List<VisitLogMessage> batch,
        CancellationToken token)
    {
        MethodInfo method = typeof(VisitLogProcessorService)
            .GetMethod("DrainBatchWithFlushWindowAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var task = (Task)method.Invoke(worker, [batch, token])!;
        await task.ConfigureAwait(false);
    }

}
