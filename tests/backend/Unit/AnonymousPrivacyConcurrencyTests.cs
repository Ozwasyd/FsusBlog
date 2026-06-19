using System.Collections.Concurrent;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
public sealed class AnonymousPrivacyConcurrencyTests
{
    [Fact]
    public async Task SameNullifierAndScopeConcurrentSubmit_AllowsOnlyPolicyLimit()
    {
        const int attempts = 24;
        const int limit = 2;
        using var barrier = new Barrier(attempts);
        var limiter = new ScopedNullifierLimiter(limit);

        bool[] results = await Task.WhenAll(Enumerable.Range(0, attempts)
            .Select(_ => StartBarrierTask(barrier, () => limiter.TryAccept("nullifier-a", "article:42"))));

        Assert.Equal(limit, results.Count(static value => value));
        Assert.Equal(attempts - limit, results.Count(static value => !value));
    }

    [Fact]
    public async Task SameTicketConcurrentConsume_SucceedsOnce()
    {
        const int attempts = 24;
        using var barrier = new Barrier(attempts);
        var tickets = new SingleUseTicketStore();
        tickets.Add("ticket-1");

        bool[] results = await Task.WhenAll(Enumerable.Range(0, attempts)
            .Select(_ => StartBarrierTask(barrier, () => tickets.TryConsume("ticket-1"))));

        Assert.Equal(1, results.Count(static value => value));
        Assert.Equal(attempts - 1, results.Count(static value => !value));
    }

    [Fact]
    public async Task RootSnapshotHighFrequencyRead_UsesCachedSnapshot()
    {
        const int reads = 48;
        using var barrier = new Barrier(reads);
        var cache = new RootSnapshotCache();

        string[] snapshots = await Task.WhenAll(Enumerable.Range(0, reads)
            .Select(_ => StartBarrierTask(barrier, cache.GetSnapshot)));

        Assert.All(snapshots, snapshot => Assert.Equal("root-v1", snapshot));
        Assert.Equal(1, cache.LoadCount);
    }

    [Fact]
    public async Task VerifierBoundedConcurrency_DoesNotExceedConfiguredLimit()
    {
        const int attempts = 32;
        const int maxConcurrent = 4;
        using var barrier = new Barrier(attempts);
        var verifier = new BoundedVerifier(maxConcurrent);

        bool[] results = await Task.WhenAll(Enumerable.Range(0, attempts)
            .Select(_ => StartBarrierTaskAsync(barrier, () => verifier.VerifyAsync(CancellationToken.None))));

        Assert.All(results, Assert.True);
        Assert.InRange(verifier.MaxObservedConcurrency, 1, maxConcurrent);
    }

    [Fact]
    public async Task AnonymousTicketEndpointCheapReject_SkipsExpensiveProofWorkUnderLoad()
    {
        const int attempts = 32;
        using var barrier = new Barrier(attempts);
        var endpoint = new CheapRejectAnonymousTicketEndpoint();

        bool[] results = await Task.WhenAll(Enumerable.Range(0, attempts).Select(index =>
            StartBarrierTask(barrier, () =>
            {
                var headers = index % 2 == 0
                    ? new Dictionary<string, string> { ["Cookie"] = "fsus=session" }
                    : new Dictionary<string, string> { ["Authorization"] = "Bearer token" };
                return endpoint.TryIssue(headers);
            })));

        Assert.DoesNotContain(true, results);
        Assert.Equal(0, endpoint.ExpensiveProofCalls);
        Assert.Equal(0, endpoint.NullifierReservationCalls);
    }

    [Fact]
    public async Task CommentSubmitHighConcurrency_CacheInvalidationIsNonBlocking()
    {
        const int attempts = 24;
        using var barrier = new Barrier(attempts);
        var dispatcher = new NonBlockingInvalidationDispatcher();
        var submitter = new CommentSubmitter(dispatcher);

        Task<long[]> submissions = Task.WhenAll(Enumerable.Range(0, attempts)
            .Select(_ => StartBarrierTask(barrier, submitter.Submit)));

        long[] submittedIds = await submissions.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(attempts, submittedIds.Length);
        Assert.Equal(attempts, dispatcher.PendingInvalidations);

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

    private sealed class ScopedNullifierLimiter(int limit)
    {
        private readonly object sync = new();
        private readonly Dictionary<string, int> counts = [];

        public bool TryAccept(string nullifierHash, string scope)
        {
            string key = $"{scope}:{nullifierHash}";
            lock (sync)
            {
                counts.TryGetValue(key, out int count);
                if (count >= limit)
                {
                    return false;
                }

                counts[key] = count + 1;
                return true;
            }
        }
    }

    private sealed class SingleUseTicketStore
    {
        private readonly ConcurrentDictionary<string, byte> tickets = new(StringComparer.Ordinal);

        public void Add(string ticket)
            => tickets[ticket] = 1;

        public bool TryConsume(string ticket)
            => tickets.TryRemove(ticket, out _);
    }

    private sealed class RootSnapshotCache
    {
        private readonly object sync = new();
        private string? snapshot;
        private int loadCount;

        public int LoadCount => Volatile.Read(ref loadCount);

        public string GetSnapshot()
        {
            string? cached = Volatile.Read(ref snapshot);
            if (cached is not null)
            {
                return cached;
            }

            lock (sync)
            {
                snapshot ??= LoadSnapshot();
                return snapshot;
            }
        }

        private string LoadSnapshot()
        {
            Interlocked.Increment(ref loadCount);
            return "root-v1";
        }
    }

    private sealed class BoundedVerifier(int maxConcurrent)
    {
        private readonly SemaphoreSlim gate = new(maxConcurrent, maxConcurrent);
        private int inFlight;
        private int maxObservedConcurrency;

        public int MaxObservedConcurrency => Volatile.Read(ref maxObservedConcurrency);

        public async Task<bool> VerifyAsync(CancellationToken cancellationToken)
        {
            await gate.WaitAsync(cancellationToken);
            try
            {
                int current = Interlocked.Increment(ref inFlight);
                TrackMax(current);
                await Task.Delay(15, cancellationToken);
                return true;
            }
            finally
            {
                Interlocked.Decrement(ref inFlight);
                gate.Release();
            }
        }

        private void TrackMax(int current)
        {
            int previous;
            do
            {
                previous = Volatile.Read(ref maxObservedConcurrency);
                if (current <= previous)
                {
                    return;
                }
            }
            while (Interlocked.CompareExchange(ref maxObservedConcurrency, current, previous) != previous);
        }
    }

    private sealed class CheapRejectAnonymousTicketEndpoint
    {
        private int expensiveProofCalls;
        private int nullifierReservationCalls;

        public int ExpensiveProofCalls => Volatile.Read(ref expensiveProofCalls);
        public int NullifierReservationCalls => Volatile.Read(ref nullifierReservationCalls);

        public bool TryIssue(IReadOnlyDictionary<string, string> headers)
        {
            if (headers.ContainsKey("Cookie") || headers.ContainsKey("Authorization"))
            {
                return false;
            }

            Interlocked.Increment(ref expensiveProofCalls);
            Interlocked.Increment(ref nullifierReservationCalls);
            return true;
        }
    }

    private sealed class CommentSubmitter(NonBlockingInvalidationDispatcher dispatcher)
    {
        private long id;

        public long Submit()
        {
            long commentId = Interlocked.Increment(ref id);
            dispatcher.Enqueue(commentId);
            return commentId;
        }
    }

    private sealed class NonBlockingInvalidationDispatcher
    {
        private readonly ConcurrentBag<TaskCompletionSource> invalidations = [];

        public int PendingInvalidations => invalidations.Count;

        public void Enqueue(long commentId)
        {
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(commentId);
            invalidations.Add(new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));
        }

        public void CompleteAll()
        {
            foreach (TaskCompletionSource invalidation in invalidations)
            {
                invalidation.TrySetResult();
            }
        }

        public async Task DrainAsync()
            => await Task.WhenAll(invalidations.Select(static item => item.Task));
    }
}
