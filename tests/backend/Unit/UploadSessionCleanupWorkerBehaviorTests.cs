using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Services.Background;

using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests.Unit;

public sealed class UploadSessionCleanupWorkerBehaviorTests
{
    [Fact]
    public async Task ExecuteAsync_RunsCleanupAtStartupBeforeWaitingForTheFirstInterval()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        int cleanupRuns = 0;
        var cleanupStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var worker = CreateWorker(queue, new RecordingLease(), _ =>
        {
            Interlocked.Increment(ref cleanupRuns);
            cleanupStarted.TrySetResult();
            return Task.CompletedTask;
        });
        using var cancellation = new CancellationTokenSource();

        await worker.StartAsync(cancellation.Token);
        await cleanupStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await cancellation.CancelAsync();
        await worker.StopAsync(CancellationToken.None);

        Assert.True(cleanupRuns >= 1);
    }

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

    [Fact]
    public async Task RunCleanupUntilSignalsFlushedAsync_LeaseDeniedPreservesQueuedSignal()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        Assert.True(queue.TryRequestScan());
        var worker = CreateWorker(queue, new RecordingLease { AllowRun = false },
            _ => throw new InvalidOperationException("Lease must not run cleanup."));

        await worker.RunCleanupUntilSignalsFlushedAsync(CancellationToken.None);

        Assert.True(queue.HasPendingSignals);
        Assert.Equal(2, queue.PendingSignalCount);
        Assert.Equal(0, queue.InFlightCount);
    }

    [Fact]
    public async Task RunCleanupUntilSignalsFlushedAsync_DequeueKeepsBlockedScanObservable()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        Assert.True(queue.TryRequestScan());
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var worker = CreateWorker(queue, new RecordingLease(), async _ =>
        {
            started.SetResult();
            await release.Task;
        });

        Task scan = worker.RunCleanupUntilSignalsFlushedAsync(CancellationToken.None);
        try
        {
            await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(queue.HasPendingSignals);
            Assert.Equal(1, queue.InFlightCount);
            Assert.Equal(1, queue.PendingSignalCount);
        }
        finally
        {
            release.TrySetResult();
            await scan.WaitAsync(TimeSpan.FromSeconds(5));
        }

        Assert.Equal(0, queue.InFlightCount);
        Assert.Equal(0, queue.PendingSignalCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RunCleanupUntilSignalsFlushedAsync_FailureRetainsRetryUntilSuccessfulScan(bool cancel)
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        Assert.True(queue.TryRequestScan());
        using var cancellation = new CancellationTokenSource();
        int attempts = 0;
        var worker = CreateWorker(queue, new RecordingLease(), token =>
        {
            if (++attempts == 1)
            {
                if (cancel)
                {
                    cancellation.Cancel();
                    token.ThrowIfCancellationRequested();
                }

                throw new IOException("Cleanup storage unavailable.");
            }

            return Task.CompletedTask;
        });

        await worker.RunCleanupUntilSignalsFlushedAsync(cancellation.Token);

        Assert.Equal(1, attempts);
        Assert.False(queue.HasPendingSignals);
        Assert.Equal(0, queue.InFlightCount);
        Assert.Equal(1, queue.PendingSignalCount);

        await worker.RunCleanupUntilSignalsFlushedAsync(CancellationToken.None);

        Assert.Equal(2, attempts);
        Assert.Equal(0, queue.PendingSignalCount);
    }

    [Fact]
    public async Task DrainAsync_DoesNotDiscardUnprocessedScanSignals()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        Assert.True(queue.TryRequestScan());
        var participant = new UploadCleanupReleaseDrainParticipant(queue, TimeProvider.System);
        using var cancellation = new CancellationTokenSource();

        Task drain = participant.DrainAsync(cancellation.Token);
        try
        {
            Assert.False(drain.IsCompleted);
            Assert.True(queue.HasPendingSignals);
            Assert.Equal(2, participant.Snapshot().PendingCount);
        }
        finally
        {
            await cancellation.CancelAsync();
        }

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => drain);
        Assert.True(queue.HasPendingSignals);

        var worker = CreateWorker(queue, new RecordingLease(), _ => Task.CompletedTask);
        await worker.RunCleanupUntilSignalsFlushedAsync(CancellationToken.None);
        await participant.DrainAsync(CancellationToken.None);
        Assert.Equal(0, participant.Snapshot().PendingCount);
    }

    [Fact]
    public async Task StartupScan_LeaseDeniedWithoutSignalsKeepsDrainPending()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        var lease = new RecordingLease { AllowRun = false };
        int scans = 0;
        var worker = CreateWorker(queue, lease, _ =>
        {
            scans++;
            return Task.CompletedTask;
        });
        var participant = new UploadCleanupReleaseDrainParticipant(queue, TimeProvider.System);

        Assert.False(queue.HasPendingSignals);
        Assert.False(await worker.RunCleanupUntilSignalsFlushedAsync(CancellationToken.None));
        Assert.Equal(0, scans);
        Assert.Equal(1, lease.Attempts);
        Assert.Equal(1, participant.Snapshot().PendingCount);
        Assert.Equal("pending", participant.Snapshot().Status);

        lease.AllowRun = true;
        Assert.True(await worker.RunCleanupUntilSignalsFlushedAsync(CancellationToken.None));

        Assert.Equal(1, scans);
        Assert.Equal(0, participant.Snapshot().PendingCount);
        Assert.Equal("drained", participant.Snapshot().Status);
    }

    [Fact]
    public async Task ExecuteAsync_StartupLeaseDeniedWaitsForTimerBeforeRecovery()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        var clock = new ScanTimeProvider();
        var attempted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var recovered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var lease = new RecordingLease { AllowRun = false, OnAttempt = () => attempted.TrySetResult() };
        int scans = 0;
        using var worker = new UploadSessionCleanupWorker(
            queue, NullLogger<UploadSessionCleanupWorker>.Instance, clock, lease, _ =>
            {
                Interlocked.Increment(ref scans);
                recovered.TrySetResult();
                return Task.CompletedTask;
            });

        await worker.StartAsync(CancellationToken.None);
        try
        {
            await attempted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(0, scans);
            Assert.Equal(1, queue.PendingSignalCount);
            Assert.Equal(1, lease.Attempts);

            lease.AllowRun = true;
            clock.Tick();
            await recovered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally
        {
            await worker.StopAsync(CancellationToken.None);
        }

        Assert.Equal(1, scans);
        Assert.Equal(2, lease.Attempts);
    }

    private sealed class ScanTimeProvider : TimeProvider
    {
        private TimerCallback? _callback;
        private object? _state;

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            _callback = callback;
            _state = state;
            return new ScanTimer();
        }

        public void Tick() => _callback!(_state);

        private sealed class ScanTimer : ITimer
        {
            public bool Change(TimeSpan dueTime, TimeSpan period) => true;
            public void Dispose()
            {
            }
            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
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
        public Action? OnAttempt
        {
            get; set;
        }
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
            bool allowRun = AllowRun;
            OnAttempt?.Invoke();
            if (!allowRun)
            {
                return false;
            }

            await action(cancellationToken);
            return true;
        }
    }
}
