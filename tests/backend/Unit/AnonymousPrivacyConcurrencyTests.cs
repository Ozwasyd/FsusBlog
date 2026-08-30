using System.Collections.Concurrent;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
public sealed class AnonymousPrivacyConcurrencyTests
{
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
