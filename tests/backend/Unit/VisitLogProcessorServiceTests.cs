using System.Diagnostics;
using System.Reflection;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Services.VisitLog;
using FsusBlog.Server.Entities;
using IP2Location;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.ObjectPool;
using NSubstitute;
using SqlSugar;
using VisitLogEntity = FsusBlog.Server.Entities.VisitLog;

namespace FsusBlog.Server.Tests;

public sealed class VisitLogProcessorServiceTests
{
    [Fact]
    public async Task DrainBatchWithFlushWindowAsync_LowTrafficWaitsForFlushWindow()
    {
        await using ServiceProvider provider = CreateServiceProvider();
        var channel = new VisitLogChannel();
        var worker = new VisitLogProcessorService(
            channel,
            provider,
            NullLogger<VisitLogProcessorService>.Instance);
        var batch = new List<VisitLogEntity>();
        Assert.True(channel.TryWrite(CreateMessage("127.0.0.1")));

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
        var worker = new VisitLogProcessorService(
            channel,
            provider,
            NullLogger<VisitLogProcessorService>.Instance);
        var batch = new List<VisitLogEntity>();
        for (int i = 0; i < 500; i++)
        {
            Assert.True(channel.TryWrite(CreateMessage("127.0.0.1")));
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
        var channel = new VisitLogChannel();
        var worker = new VisitLogProcessorService(
            channel,
            provider,
            NullLogger<VisitLogProcessorService>.Instance);
        var batch = new List<VisitLogEntity>();
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(() => DrainBatchAsync(worker, batch, cts.Token));
        Assert.Empty(batch);
    }

    [Fact]
    public async Task DrainBatchWithFlushWindowAsync_AnonymizesIpBeforePersistence()
    {
        await using ServiceProvider provider = CreateServiceProvider();
        var channel = new VisitLogChannel();
        var worker = new VisitLogProcessorService(
            channel,
            provider,
            NullLogger<VisitLogProcessorService>.Instance);
        var batch = new List<VisitLogEntity>();

        Assert.True(channel.TryWrite(CreateMessage("127.0.0.1")));

        await DrainBatchAsync(worker, batch, CancellationToken.None);

        var item = Assert.Single(batch);
        Assert.Null(typeof(VisitLogEntity).GetProperty("IP"));
        PropertyInfo? ipHashProperty = typeof(VisitLogEntity).GetProperty("IpHash");
        Assert.NotNull(ipHashProperty);
        string? ipHash = Assert.IsType<string>(ipHashProperty!.GetValue(item));
        Assert.Equal(64, ipHash.Length);
        Assert.NotEqual("127.0.0.1", ipHash);
    }

    [Fact]
    public async Task Source_DrainBatchUsesDeadlineWaitWithoutLinkedCancellationTokenSource()
    {
        await using ServiceProvider provider = CreateServiceProvider();
        var channel = new VisitLogChannel();
        var worker = new VisitLogProcessorService(
            channel,
            provider,
            NullLogger<VisitLogProcessorService>.Instance);
        var batch = new List<VisitLogEntity>();
        Assert.True(channel.TryWrite(CreateMessage("127.0.0.1")));

        var elapsed = Stopwatch.StartNew();
        Task drain = DrainBatchAsync(worker, batch, CancellationToken.None);
        await Task.Delay(VisitLogProcessorService.FlushWindow / 2);
        Assert.True(channel.TryWrite(CreateMessage("127.0.0.2")));
        await drain.WaitAsync(TimeSpan.FromSeconds(10));
        elapsed.Stop();

        Assert.Equal(2, batch.Count);
        Assert.InRange(
            elapsed.Elapsed,
            VisitLogProcessorService.FlushWindow * 0.75,
            VisitLogProcessorService.FlushWindow * 1.75);
    }

    [Fact]
    public async Task Source_FlushPathCachesScopedServicesAndUsesAccumulatedStats()
    {
        await using ServiceProvider provider = CreateServiceProvider();
        using IServiceScope scope = provider.CreateScope();
        var channel = new VisitLogChannel();
        var worker = new VisitLogProcessorService(
            channel,
            provider,
            NullLogger<VisitLogProcessorService>.Instance);
        MethodInfo resolve = typeof(VisitLogProcessorService).GetMethod(
            "ResolveFlushServices",
            BindingFlags.Instance | BindingFlags.NonPublic)!;

        _ = resolve.Invoke(worker, [scope.ServiceProvider]);
        object? firstProjection = typeof(VisitLogProcessorService)
            .GetField("_articleViewProjectionService", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(worker);
        object? firstCoalescer = typeof(VisitLogProcessorService)
            .GetField("_hotStatsInvalidationCoalescer", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(worker);
        _ = resolve.Invoke(worker, [scope.ServiceProvider]);

        Assert.Same(firstProjection, typeof(VisitLogProcessorService)
            .GetField("_articleViewProjectionService", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(worker));
        Assert.Same(firstCoalescer, typeof(VisitLogProcessorService)
            .GetField("_hotStatsInvalidationCoalescer", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(worker));

        var batch = new List<VisitLogEntity>();
        var articleRead = new VisitLogMessage(
            "127.0.0.1",
            DateTime.UtcNow,
            HumanReadEventTypes.ArticleRead,
            "article:42",
            42,
            "viewer",
            "proof",
            8000);
        typeof(VisitLogProcessorService).GetMethod(
            "ProcessSingleMessageCore",
            BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(worker, [articleRead, batch]);
        object stats = typeof(VisitLogProcessorService)
            .GetField("_flushStats", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(worker)!;
        var coalescer = Assert.IsAssignableFrom<IHotStatsInvalidationCoalescer>(firstCoalescer);
        MethodInfo markStats = typeof(VisitLogProcessorService).GetMethod(
            "MarkStatsAfterFlushAsync",
            BindingFlags.Instance | BindingFlags.NonPublic)!;
        await ((Task)markStats.Invoke(worker, [coalescer, stats, CancellationToken.None])!).ConfigureAwait(false);

        Assert.Single(batch);
        await coalescer.Received(1).MarkStatsDirtyAsync("visit-log-flush", Arg.Any<CancellationToken>());
        await coalescer.Received(1).MarkHotArticlesDirtyAsync("article-read-projection", Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ExecuteAsync_ContinuesProcessingAfterSingleMessageFailure()
    {
        await using ServiceProvider provider = CreateServiceProvider();
        var channel = new VisitLogChannel();
        var pool = new SequencedFaultPool();
        var worker = new VisitLogProcessorService(
            channel,
            provider,
            NullLogger<VisitLogProcessorService>.Instance,
            pool);

        await worker.StartAsync(CancellationToken.None);

        try
        {
            Assert.True(channel.TryWrite(CreateMessage("8.8.8.8")));
            Assert.True(channel.TryWrite(CreateMessage("8.8.4.4")));

            await pool.SecondAttemptObserved.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(Volatile.Read(ref pool.GetCalls) >= 2);
        }
        finally
        {
            await worker.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StopAsync_DoesNotThrowWhenPendingMessagesAreFaulty()
    {
        await using ServiceProvider provider = CreateServiceProvider();
        var channel = new VisitLogChannel();
        var worker = new VisitLogProcessorService(
            channel,
            provider,
            NullLogger<VisitLogProcessorService>.Instance,
            new AlwaysFaultingPool());

        await worker.StartAsync(CancellationToken.None);
        Assert.True(channel.TryWrite(CreateMessage("8.8.8.8")));

        var exception = await Record.ExceptionAsync(() => worker.StopAsync(CancellationToken.None));

        Assert.Null(exception);
    }

    private static VisitLogMessage CreateMessage(string ip) =>
        new(ip, DateTime.UtcNow, HumanReadEventTypes.SiteRead, "home", null, "viewer", "proof", 8000);

    private static ServiceProvider CreateServiceProvider()
        => new ServiceCollection()
            .AddSingleton<IConfiguration>(new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["VisitLog:IpHashPepper"] = "unit-test-visit-log-ip-hash-pepper-with-enough-entropy"
                })
                .Build())
            .AddScoped(_ => Substitute.For<ISqlSugarClient>())
            .AddScoped(_ => Substitute.For<IDbConcurrencyGate>())
            .AddScoped(_ => Substitute.For<IArticleViewProjectionService>())
            .AddScoped(_ => Substitute.For<IHotStatsInvalidationCoalescer>())
            .BuildServiceProvider();

    private static async Task DrainBatchAsync(VisitLogProcessorService worker, List<VisitLogEntity> batch, CancellationToken token)
    {
        MethodInfo method = typeof(VisitLogProcessorService)
            .GetMethod("DrainBatchWithFlushWindowAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var task = (Task)method.Invoke(worker, [batch, token])!;
        await task.ConfigureAwait(false);
    }

    [Theory]
    [InlineData("127.0.0.1", "本地网络")]
    [InlineData("::1", "本地网络")]
    [InlineData("10.0.0.9", "内网")]
    [InlineData("172.16.1.8", "内网")]
    [InlineData("192.168.1.8", "内网")]
    [InlineData("fc00::1", "内网")]
    public void TryClassifyLocalNetwork_LocalOrPrivateIp_ReturnsStableRegion(string ip, string expectedRegion)
    {
        bool matched = VisitLogProcessorService.TryClassifyLocalNetwork(ip, out string region);

        Assert.True(matched);
        Assert.Equal(expectedRegion, region);
    }

    [Fact]
    public void TryClassifyLocalNetwork_PublicIp_DoesNotMatch()
    {
        bool matched = VisitLogProcessorService.TryClassifyLocalNetwork("8.8.8.8", out string region);

        Assert.False(matched);
        Assert.Equal(string.Empty, region);
    }
    private sealed class SequencedFaultPool : ObjectPool<Component>
    {
        public int GetCalls;
        public TaskCompletionSource<bool> SecondAttemptObserved { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override Component Get()
        {
            int call = Interlocked.Increment(ref GetCalls);
            if (call >= 2)
            {
                SecondAttemptObserved.TrySetResult(true);
            }

            throw new InvalidOperationException("simulated ip lookup failure");
        }

        public override void Return(Component obj)
        {
        }
    }

    private sealed class AlwaysFaultingPool : ObjectPool<Component>
    {
        public override Component Get() => throw new InvalidOperationException("simulated ip lookup failure");

        public override void Return(Component obj)
        {
        }
    }
}
