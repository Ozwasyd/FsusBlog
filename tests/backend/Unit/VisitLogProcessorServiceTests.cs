using System.Diagnostics;
using System.Reflection;
using FsusBlog.Server.Services.VisitLog;
using FsusBlog.Server.Entities;
using IP2Location;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.ObjectPool;
using VisitLogEntity = FsusBlog.Server.Entities.VisitLog;

namespace FsusBlog.Server.Tests;

public sealed class VisitLogProcessorServiceTests
{
    [Fact]
    public async Task DrainBatchWithFlushWindowAsync_LowTrafficWaitsForFlushWindow()
    {
        await using ServiceProvider provider = new ServiceCollection().BuildServiceProvider();
        var channel = new VisitLogChannel();
        var worker = new VisitLogProcessorService(
            channel,
            provider,
            NullLogger<VisitLogProcessorService>.Instance);
        var batch = new List<VisitLogEntity>();
        Assert.True(channel.TryWrite(CreateMessage("127.0.0.1", 1)));

        var elapsed = Stopwatch.StartNew();
        await DrainBatchAsync(worker, batch, CancellationToken.None);
        elapsed.Stop();

        Assert.Single(batch);
        Assert.True(elapsed.Elapsed >= VisitLogProcessorService.FlushWindow * 0.75);
        Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task DrainBatchWithFlushWindowAsync_FullBatchReturnsWithoutWaitingForFlushWindow()
    {
        await using ServiceProvider provider = new ServiceCollection().BuildServiceProvider();
        var channel = new VisitLogChannel();
        var worker = new VisitLogProcessorService(
            channel,
            provider,
            NullLogger<VisitLogProcessorService>.Instance);
        var batch = new List<VisitLogEntity>();
        for (int i = 0; i < 500; i++)
        {
            Assert.True(channel.TryWrite(CreateMessage("127.0.0.1", i)));
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
        await using ServiceProvider provider = new ServiceCollection().BuildServiceProvider();
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
    public void Source_DrainBatchUsesDeadlineWaitWithoutLinkedCancellationTokenSource()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src/backend/Services/VisitLog/VisitLogProcessorService.cs"));

        Assert.Contains("ResolveFlushWindowRemaining", source, StringComparison.Ordinal);
        Assert.Contains("Task.WhenAny(readTask, delayTask)", source, StringComparison.Ordinal);
        Assert.DoesNotContain("CancellationTokenSource.CreateLinkedTokenSource", source, StringComparison.Ordinal);
        Assert.DoesNotContain("CancelAfter(FlushWindow)", source, StringComparison.Ordinal);
        Assert.DoesNotContain("catch (OperationCanceledException) when (!token.IsCancellationRequested)", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ExecuteAsync_ContinuesProcessingAfterSingleMessageFailure()
    {
        await using ServiceProvider provider = new ServiceCollection().BuildServiceProvider();
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
            Assert.True(channel.TryWrite(CreateMessage("8.8.8.8", 1)));
            Assert.True(channel.TryWrite(CreateMessage("8.8.4.4", 2)));

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
        await using ServiceProvider provider = new ServiceCollection().BuildServiceProvider();
        var channel = new VisitLogChannel();
        var worker = new VisitLogProcessorService(
            channel,
            provider,
            NullLogger<VisitLogProcessorService>.Instance,
            new AlwaysFaultingPool());

        await worker.StartAsync(CancellationToken.None);
        Assert.True(channel.TryWrite(CreateMessage("8.8.8.8", 1)));

        var exception = await Record.ExceptionAsync(() => worker.StopAsync(CancellationToken.None));

        Assert.Null(exception);
    }

    private static VisitLogMessage CreateMessage(string ip, int? userId) =>
        new(ip, userId, DateTime.UtcNow, HumanReadEventTypes.SiteRead, "home", null, "viewer", "proof", 8000);

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

    private static string FindRepoRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "FsusBlog.slnx")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException("repo root not found");
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
