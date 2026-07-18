using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Background;

using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UploadSessionCleanupWorkerBehaviorTests
{
    [Fact]
    public async Task RunCleanupUntilSignalsFlushedAsync_OverflowRequestsASecondScan()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        for (int i = 0; i <= UploadSessionCleanupQueue.SignalCapacity; i++)
        {
            queue.TryRequestScan();
        }

        int cleanupRuns = 0;
        var lease = new RecordingLease();
        var worker = CreateWorker(queue, lease, _ =>
        {
            Interlocked.Increment(ref cleanupRuns);
            return Task.CompletedTask;
        });

        await worker.RunCleanupUntilSignalsFlushedAsync(CancellationToken.None);

        Assert.Equal(2, cleanupRuns);
        Assert.Equal(2, lease.Attempts);
        Assert.False(queue.ConsumeOverflowedSignal());
        Assert.False(queue.HasPendingSignals);
    }

    [Fact]
    public async Task RunCleanupUntilSignalsFlushedAsync_SignalDuringCleanupIsNotLost()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        Assert.True(queue.TryRequestScan());
        int cleanupRuns = 0;
        var worker = CreateWorker(queue, new RecordingLease(), _ =>
        {
            if (Interlocked.Increment(ref cleanupRuns) == 1)
            {
                Assert.True(queue.TryRequestScan());
            }

            return Task.CompletedTask;
        });

        await worker.RunCleanupUntilSignalsFlushedAsync(CancellationToken.None);

        Assert.Equal(2, cleanupRuns);
        Assert.False(queue.HasPendingSignals);
    }

    [Fact]
    public async Task RunCleanupUntilSignalsFlushedAsync_LeaseDeniedPreservesOverflowForNextLeaderAttempt()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        for (int i = 0; i <= UploadSessionCleanupQueue.SignalCapacity; i++)
        {
            queue.TryRequestScan();
        }

        int cleanupRuns = 0;
        var lease = new RecordingLease { AllowRun = false };
        var worker = CreateWorker(queue, lease, _ =>
        {
            Interlocked.Increment(ref cleanupRuns);
            return Task.CompletedTask;
        });

        await worker.RunCleanupUntilSignalsFlushedAsync(CancellationToken.None);
        lease.AllowRun = true;
        await worker.RunCleanupUntilSignalsFlushedAsync(CancellationToken.None);

        Assert.Equal(2, cleanupRuns);
        Assert.Equal(3, lease.Attempts);
        Assert.False(queue.ConsumeOverflowedSignal());
    }

    [Fact]
    public async Task RunCleanupUntilSignalsFlushedAsync_PreCancelledTokenSkipsLeaseAndCleanup()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        Assert.True(queue.TryRequestScan());
        int cleanupRuns = 0;
        var lease = new RecordingLease();
        var worker = CreateWorker(queue, lease, _ =>
        {
            Interlocked.Increment(ref cleanupRuns);
            return Task.CompletedTask;
        });
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            worker.RunCleanupUntilSignalsFlushedAsync(cancellation.Token));

        Assert.Equal(0, cleanupRuns);
        Assert.Equal(0, lease.Attempts);
        Assert.True(queue.HasPendingSignals);
    }

    private static UploadSessionCleanupWorker CreateWorker(
        UploadSessionCleanupQueue queue,
        RecordingLease lease,
        Func<CancellationToken, Task> cleanup)
        => new(
            queue,
            NullLogger<UploadSessionCleanupWorker>.Instance,
            TimeProvider.System,
            lease,
            cleanup);

    private sealed class RecordingLease : IBackgroundWorkerLease
    {
        public bool AllowRun { get; set; } = true;
        public int Attempts
        {
            get; private set;
        }

        public async Task<bool> TryRunAsLeaderAsync(
            string workerName,
            Func<CancellationToken, Task> action,
            CancellationToken cancellationToken = default)
        {
            Assert.Equal("upload-session-cleanup-worker", workerName);
            Attempts++;
            if (!AllowRun)
            {
                return false;
            }

            await action(cancellationToken);
            return true;
        }
    }
}
