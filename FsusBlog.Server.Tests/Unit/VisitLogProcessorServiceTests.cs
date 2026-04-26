using FsusBlog.Server.Services.VistitLog;
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
            Assert.True(channel.TryWrite(new VisitLogMessage("127.0.0.1", 1, DateTime.UtcNow)));
            Assert.True(channel.TryWrite(new VisitLogMessage("127.0.0.2", 2, DateTime.UtcNow)));

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
        Assert.True(channel.TryWrite(new VisitLogMessage("127.0.0.1", 1, DateTime.UtcNow)));

        var exception = await Record.ExceptionAsync(() => worker.StopAsync(CancellationToken.None));

        Assert.Null(exception);
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
