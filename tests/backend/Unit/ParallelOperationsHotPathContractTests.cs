using FsusBlog.Server.Infrastructure.Execution;

using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ParallelOperationsHotPathContractTests
{
    [Fact]
    public async Task Gate_StartsIndependentOperationsTogetherUpToConfiguredCapacity()
    {
        var gate = new DbConcurrencyGate(
            new DbConcurrencyGateOptions(4, TimeSpan.FromSeconds(1)),
            NullLogger<DbConcurrencyGate>.Instance);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var allStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int started = 0;

        Task<int>[] operations = Enumerable.Range(0, 4)
            .Select(index => gate.ExecuteAsync(
                $"parallel-{index}",
                async _ =>
                {
                    if (Interlocked.Increment(ref started) == 4)
                        allStarted.TrySetResult();
                    await release.Task;
                    return index;
                },
                _ => Task.FromResult(-1)))
            .ToArray();

        await allStarted.Task;
        Assert.Equal(new DbConcurrencyGateSnapshot(4, 4, 0), gate.GetSnapshot());
        release.TrySetResult();
        int[] results = await Task.WhenAll(operations);
        Assert.Equal([0, 1, 2, 3], results);
        Assert.Equal(new DbConcurrencyGateSnapshot(4, 0, 0), gate.GetSnapshot());
    }

    [Fact]
    public async Task Gate_TimeoutUsesFallbackAndReleasesCapacityAfterFailure()
    {
        var gate = new DbConcurrencyGate(
            new DbConcurrencyGateOptions(1, TimeSpan.FromMilliseconds(25)),
            NullLogger<DbConcurrencyGate>.Instance);
        var occupied = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<int> owner = gate.ExecuteAsync(
            "owner",
            async _ =>
            {
                occupied.TrySetResult();
                await release.Task;
                return 1;
            },
            _ => Task.FromResult(-1));
        await occupied.Task;

        int timedOut = await gate.ExecuteAsync(
            "waiter",
            _ => Task.FromResult(2),
            _ => Task.FromResult(-1));
        Assert.Equal(-1, timedOut);
        release.TrySetResult();
        Assert.Equal(1, await owner);

        await Assert.ThrowsAsync<InvalidOperationException>(() => gate.ExecuteAsync<int>(
            "failure",
            _ => throw new InvalidOperationException("measured failure"),
            _ => Task.FromResult(-1)));
        Assert.Equal(3, await gate.ExecuteAsync("after-failure", _ => Task.FromResult(3), _ => Task.FromResult(-1)));
        Assert.Equal(0, gate.GetSnapshot().InUse);
    }

    [Fact]
    public async Task Gate_CancellationDoesNotLeakWaitingOrInUseResources()
    {
        var gate = new DbConcurrencyGate(
            new DbConcurrencyGateOptions(1, TimeSpan.FromSeconds(2)),
            NullLogger<DbConcurrencyGate>.Instance);
        var occupied = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task owner = gate.ExecuteAsync(
            "owner",
            async _ =>
            {
                occupied.TrySetResult();
                await release.Task;
                return true;
            },
            _ => Task.FromResult(false));
        await occupied.Task;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => gate.ExecuteAsync(
            "cancelled",
            _ => Task.FromResult(true),
            _ => Task.FromResult(false),
            cancellation.Token));
        release.TrySetResult();
        await owner;
        Assert.Equal(new DbConcurrencyGateSnapshot(1, 0, 0), gate.GetSnapshot());
    }
}
