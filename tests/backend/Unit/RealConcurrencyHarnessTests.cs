namespace FsusBlog.Server.Tests.Unit;

public sealed class RealConcurrencyHarnessTests
{
    [Fact]
    public void RunAsync_RejectsTooFewOrMissingWorkersBeforeStartingAny()
    {
        int started = 0;
        Func<Task> worker = () =>
        {
            Interlocked.Increment(ref started);
            return Task.CompletedTask;
        };
        Assert.Throws<ArgumentException>(() =>
        {
            _ = RealConcurrencyHarness.RunAsync(worker);
        });
        Assert.Throws<ArgumentException>(() =>
        {
            _ = RealConcurrencyHarness.RunAsync(worker, null!);
        });
        Assert.Throws<ArgumentException>(() =>
        {
            _ = RealConcurrencyHarness.RunAsync<int>(() => Task.FromResult(1));
        });
        Assert.Equal(0, started);
    }

    [Fact]
    public async Task RunAsync_StartsBothWorkersBeforeEitherCanCompleteAndKeepsInputOrder()
    {
        var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int[] results = await RealConcurrencyHarness.RunAsync(
            async () =>
            {
                firstEntered.SetResult();
                await secondEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                return 11;
            },
            async () =>
            {
                secondEntered.SetResult();
                await firstEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                return 22;
            });
        Assert.Equal([11, 22], results);
    }

    [Fact]
    public async Task RunAsync_SynchronousFailureStillDrainsOtherWorkerBeforePropagating()
    {
        var failed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bool cleaned = false;
        Task pending = RealConcurrencyHarness.RunAsync(
            () =>
            {
                failed.SetResult();
                throw new InvalidOperationException("worker-failure");
            },
            async () =>
            {
                await release.Task;
                cleaned = true;
            });
        await failed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(pending.IsCompleted);
        release.SetResult();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => pending);
        Assert.Equal("worker-failure", error.Message);
        Assert.True(cleaned);
    }

    [Fact]
    public async Task RunAsync_CancellationDrainsOtherWorkerAndRemainsCanceled()
    {
        using var cancellation = new CancellationTokenSource();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bool cleaned = false;
        Task pending = RealConcurrencyHarness.RunAsync(
            async () =>
            {
                entered.SetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellation.Token);
            },
            async () =>
            {
                await release.Task;
                cleaned = true;
            });
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        Assert.False(pending.IsCompleted);
        release.SetResult();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.True(pending.IsCanceled);
        Assert.True(cleaned);
    }

    [Fact]
    public async Task RunInterleavedAsync_ControllerFailureReleasesAndDrainsActualOperation()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bool completed = false;
        Task<int>? actual = null;
        Task pending = RealConcurrencyHarness.RunInterleavedAsync(
            () => actual = OperateAsync(),
            async operation =>
            {
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                Assert.Same(actual, operation);
                Assert.False(operation.IsCompleted);
                throw new InvalidOperationException("controller-failure");
            },
            () => release.TrySetResult());
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => pending);
        Assert.Equal("controller-failure", error.Message);
        Assert.True(completed);

        async Task<int> OperateAsync()
        {
            entered.SetResult();
            await release.Task;
            completed = true;
            return 1;
        }
    }

    [Fact]
    public async Task RunInterleavedAsync_SynchronousOperationFailureDoesNotStrandControllerOrCleanup()
    {
        bool cleaned = false;
        Task pending = RealConcurrencyHarness.RunInterleavedAsync<int>(
            () => throw new InvalidOperationException("operation-start-failure"),
            _ => Task.CompletedTask,
            () => cleaned = true);
        await Assert.ThrowsAsync<InvalidOperationException>(() => pending.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.True(cleaned);

        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bool returned = false;
        Task blockedStart = RealConcurrencyHarness.RunInterleavedAsync(
            () =>
            {
                release.Task.GetAwaiter().GetResult();
                returned = true;
                return Task.FromResult(1);
            },
            _ => throw new InvalidOperationException("A blocking operation must not reach its controller."),
            () => release.TrySetResult(),
            startupTimeout: TimeSpan.FromMilliseconds(100));
        await Assert.ThrowsAsync<TimeoutException>(() => blockedStart.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.True(returned);
    }

    [Fact]
    public void Run_ExecutesEveryRequestedWorkerExactlyOnce()
    {
        int[] hits = new int[20_000];
        RealConcurrencyHarness.Run(0, hits.Length, index => Interlocked.Increment(ref hits[index]));
        Assert.All(hits, hit => Assert.Equal(1, hit));
    }
}
