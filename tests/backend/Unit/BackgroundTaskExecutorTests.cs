using FsusBlog.Server.Infrastructure.Execution;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests;

public sealed class BackgroundTaskExecutorTests
{
    [Fact]
    public async Task RunLoopAsync_ContinuesAfterSingleIterationFailure()
    {
        using var cts = new CancellationTokenSource();
        int iterations = 0;
        int faults = 0;
        int cancellations = 0;

        await BackgroundTaskExecutor.RunLoopAsync(
            async token =>
            {
                int current = Interlocked.Increment(ref iterations);
                if (current == 1)
                {
                    throw new InvalidOperationException("boom");
                }

                cts.Cancel();
                await Task.Yield();
                return true;
            },
            NullLogger.Instance,
            "loop-test",
            cts.Token,
            retryDelay: TimeSpan.Zero,
            onCancelled: () =>
            {
                Interlocked.Increment(ref cancellations);
                return Task.CompletedTask;
            },
            onFaulted: _ =>
            {
                Interlocked.Increment(ref faults);
                return Task.CompletedTask;
            });

        Assert.Equal(2, iterations);
        Assert.Equal(1, faults);
        Assert.Equal(1, cancellations);
    }
}
