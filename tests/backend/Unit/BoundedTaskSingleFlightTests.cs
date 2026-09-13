using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BoundedTaskSingleFlightTests
{
    [Fact]
    public async Task SameKeyOneHundredConcurrentCallersShareOneBuildAndRetireEntry()
    {
        var flight = new BoundedTaskSingleFlight<int>();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int builds = 0;

        Task<int>[] callers = Enumerable.Range(0, 100)
            .Select(_ => flight.RunAsync(
                CachePolicyId.RelatedReading,
                "article:42",
                async _ =>
                {
                    Interlocked.Increment(ref builds);
                    await release.Task;
                    return 42;
                }))
            .ToArray();

        await WaitUntilAsync(() => flight.ActiveKeyCount == 1);
        release.SetResult();

        Assert.All(await Task.WhenAll(callers), static result => Assert.Equal(42, result));
        Assert.Equal(1, Volatile.Read(ref builds));
        await WaitUntilAsync(() => flight.ActiveKeyCount == 0);
    }

    [Fact]
    public async Task DistinctKeyCapacityRejectsWithoutRejectingFollowersOfAdmittedKey()
    {
        var flight = new BoundedTaskSingleFlight<int>(maxActiveKeys: 1);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<int> leader = flight.RunAsync(
            CachePolicyId.ArticleHotFrame,
            "hot:1",
            async _ =>
            {
                await release.Task;
                return 7;
            });
        await WaitUntilAsync(() => flight.ActiveKeyCount == 1);

        Task<int> follower = flight.RunAsync(
            CachePolicyId.ArticleHotFrame,
            "hot:1",
            _ => Task.FromResult(8));
        CacheCoordinationException rejected = await Assert.ThrowsAsync<CacheCoordinationException>(() =>
            flight.RunAsync(
                CachePolicyId.ArticleHotFrame,
                "hot:2",
                _ => Task.FromResult(9)));

        Assert.Equal("build-flight-cap", rejected.Reason);
        release.SetResult();
        Assert.Equal(7, await leader);
        Assert.Equal(7, await follower);
    }

    [Fact]
    public async Task CancelledWaiterDoesNotCancelSharedBuildOrOtherWaiters()
    {
        var flight = new BoundedTaskSingleFlight<int>();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<int> leader = flight.RunAsync(
            CachePolicyId.TopArticlesFrame,
            "featured:1",
            async _ =>
            {
                await release.Task;
                return 11;
            });
        await WaitUntilAsync(() => flight.ActiveKeyCount == 1);

        using var cancelled = new CancellationTokenSource();
        Task<int> cancelledWaiter = flight.RunAsync(
            CachePolicyId.TopArticlesFrame,
            "featured:1",
            _ => Task.FromResult(12),
            cancelled.Token);
        Task<int> survivingWaiter = flight.RunAsync(
            CachePolicyId.TopArticlesFrame,
            "featured:1",
            _ => Task.FromResult(13));
        await cancelled.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelledWaiter);
        release.SetResult();
        Assert.Equal(11, await leader);
        Assert.Equal(11, await survivingWaiter);
    }

    private static async Task WaitUntilAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        while (!predicate())
        {
            await Task.Delay(10, timeout.Token);
        }
    }
}
