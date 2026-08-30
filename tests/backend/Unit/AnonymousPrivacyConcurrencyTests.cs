using System.Collections.Concurrent;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
public sealed class AnonymousPrivacyConcurrencyTests
{
    [Fact]
    public async Task RootSnapshotHighFrequencyRead_UsesCachedSnapshot()
    {
        const int Reads = 48;
        using var barrier = new Barrier(Reads);
        var cache = new RootSnapshotCache();

        string[] snapshots = await Task.WhenAll(Enumerable.Range(0, Reads)
            .Select(_ => StartBarrierTask(barrier, cache.GetSnapshot)));

        Assert.All(snapshots, snapshot => Assert.Equal("root-v1", snapshot));
        Assert.Equal(1, cache.LoadCount);
    }

    [Fact]
    public async Task VerifierBoundedConcurrency_DoesNotExceedConfiguredLimit()
    {
        const int Attempts = 32;
        const int MaxConcurrent = 4;
        using var barrier = new Barrier(Attempts);
        var verifier = new BoundedVerifier(MaxConcurrent);

        bool[] results = await Task.WhenAll(Enumerable.Range(0, Attempts)
            .Select(_ => StartBarrierTaskAsync(barrier, () => verifier.VerifyAsync(CancellationToken.None))));

        Assert.All(results, Assert.True);
        Assert.InRange(verifier.MaxObservedConcurrency, 1, MaxConcurrent);
    }

    [Fact]
    public async Task CommentSubmitHighConcurrency_CacheInvalidationIsNonBlocking()
    {
        const int Attempts = 24;
        using var barrier = new Barrier(Attempts);
        var dispatcher = new NonBlockingInvalidationDispatcher();
        var submitter = new CommentSubmitter(dispatcher);

        Task<long[]> submissions = Task.WhenAll(Enumerable.Range(0, Attempts)
            .Select(_ => StartBarrierTask(barrier, submitter.Submit)));

        long[] submittedIds = await submissions.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(Attempts, submittedIds.Length);
        Assert.Equal(Attempts, dispatcher.PendingInvalidations);

        dispatcher.CompleteAll();
        await dispatcher.DrainAsync();
    }

    private static void WaitForConcurrentStart(Barrier barrier)
        => Assert.True(
            barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
            "Timed out waiting for concurrent start barrier.");

    private static Task<T> StartBarrierTask<T>(Barrier barrier, Func<T> action)
        => Task.Factory.StartNew(
            () =>
            {
                WaitForConcurrentStart(barrier);
                return action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default);

    private static Task<T> StartBarrierTaskAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                WaitForConcurrentStart(barrier);
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();
    private sealed class RootSnapshotCache
    {
        private readonly object _sync = new();
        private string? _snapshot;
        private int _loadCount;

        public int LoadCount => Volatile.Read(ref _loadCount);

        public string GetSnapshot()
        {
            string? cached = Volatile.Read(ref _snapshot);
            if (cached is not null)
            {
                return cached;
            }

            lock (_sync)
            {
                _snapshot ??= LoadSnapshot();
                return _snapshot;
            }
        }

        private string LoadSnapshot()
        {
            Interlocked.Increment(ref _loadCount);
            return "root-v1";
        }
    }

    private sealed class BoundedVerifier(int maxConcurrent)
    {
        private readonly SemaphoreSlim _gate = new(maxConcurrent, maxConcurrent);
        private int _inFlight;
        private int _maxObservedConcurrency;

        public int MaxObservedConcurrency => Volatile.Read(ref _maxObservedConcurrency);

        public async Task<bool> VerifyAsync(CancellationToken cancellationToken)
        {
            await _gate.WaitAsync(cancellationToken);
            try
            {
                int current = Interlocked.Increment(ref _inFlight);
                TrackMax(current);
                await Task.Delay(15, cancellationToken);
                return true;
            }
            finally
            {
                Interlocked.Decrement(ref _inFlight);
                _gate.Release();
            }
        }

        private void TrackMax(int current)
        {
            int previous;
            do
            {
                previous = Volatile.Read(ref _maxObservedConcurrency);
                if (current <= previous)
                {
                    return;
                }
            }
            while (Interlocked.CompareExchange(ref _maxObservedConcurrency, current, previous) != previous);
        }
    }

    private sealed class CommentSubmitter(NonBlockingInvalidationDispatcher dispatcher)
    {
        private long _id;

        public long Submit()
        {
            long commentId = Interlocked.Increment(ref _id);
            dispatcher.Enqueue(commentId);
            return commentId;
        }
    }

    private sealed class NonBlockingInvalidationDispatcher
    {
        private readonly ConcurrentBag<TaskCompletionSource> _invalidations = [];

        public int PendingInvalidations => _invalidations.Count;

        public void Enqueue(long commentId)
        {
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(commentId);
            _invalidations.Add(new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));
        }

        public void CompleteAll()
        {
            foreach (TaskCompletionSource invalidation in _invalidations)
            {
                invalidation.TrySetResult();
            }
        }

        public async Task DrainAsync()
            => await Task.WhenAll(_invalidations.Select(static item => item.Task));
    }
}
