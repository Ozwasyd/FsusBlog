using FsusBlog.Server.Services.VistitLog;
using FsusBlog.Server.Entities;
using IP2Location;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.ObjectPool;

namespace FsusBlog.Server.Tests;

public sealed class VisitLogProcessorServiceTests
{
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
