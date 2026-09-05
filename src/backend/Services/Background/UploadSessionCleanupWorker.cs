using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Services.Background;

public sealed class UploadSessionCleanupQueue
{
    internal const int SignalCapacity = 64;
    private static readonly TimeSpan s_defaultMinSignalInterval = TimeSpan.FromSeconds(45);
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _minSignalInterval;
    private long _lastAcceptedSignalTicks;
    private int _overflowedSignal;
    private int _inFlight;
    private int _retryPending;
    private readonly Channel<byte> _requests = Channel.CreateBounded<byte>(new BoundedChannelOptions(SignalCapacity)
    {
        SingleReader = true,
        SingleWriter = false,
        FullMode = BoundedChannelFullMode.Wait
    });

    public UploadSessionCleanupQueue(TimeProvider? timeProvider = null, TimeSpan? minSignalInterval = null)
    {
        _timeProvider = timeProvider ?? TimeProvider.System;
        _minSignalInterval = minSignalInterval ?? s_defaultMinSignalInterval;
    }

    public bool TryRequestScan()
    {
        if (!TryAcquireSignalWindow())
        {
            FsusObservability.RecordUploadSessionCleanupSignal("dropped");
            return false;
        }

        if (_requests.Writer.TryWrite(0))
        {
            FsusObservability.RecordUploadSessionCleanupSignal("accepted");
            return true;
        }

        Volatile.Write(ref _overflowedSignal, 1);
        FsusObservability.RecordUploadSessionCleanupSignal("coalesced");
        return false;
    }

    private bool TryAcquireSignalWindow()
    {
        if (_minSignalInterval <= TimeSpan.Zero)
        {
            return true;
        }

        long nowTicks = _timeProvider.GetUtcNow().UtcTicks;
        while (true)
        {
            long lastTicks = Volatile.Read(ref _lastAcceptedSignalTicks);
            if (lastTicks > 0 && nowTicks - lastTicks < _minSignalInterval.Ticks)
            {
                return false;
            }

            if (Interlocked.CompareExchange(ref _lastAcceptedSignalTicks, nowTicks, lastTicks) == lastTicks)
            {
                return true;
            }
        }
    }

    internal int DrainPendingSignals()
    {
        int drained = 0;
        while (_requests.Reader.TryRead(out _))
        {
            drained++;
        }

        return drained;
    }

    internal bool ConsumeOverflowedSignal()
        => Interlocked.Exchange(ref _overflowedSignal, 0) == 1;

    internal bool HasPendingSignals => _requests.Reader.TryPeek(out _);

    public int PendingSignalCount
        => (_requests.Reader.CanCount ? _requests.Reader.Count : (HasPendingSignals ? 1 : 0))
            + (Volatile.Read(ref _overflowedSignal) == 1 ? 1 : 0)
            + InFlightCount + Volatile.Read(ref _retryPending);

    public int InFlightCount => Volatile.Read(ref _inFlight);

    internal void BeginScan()
    {
        Interlocked.Increment(ref _inFlight);
        Interlocked.Exchange(ref _retryPending, 0);
    }

    internal void EndScan(bool completed)
    {
        if (!completed)
        {
            Volatile.Write(ref _retryPending, 1);
        }

        Interlocked.Decrement(ref _inFlight);
    }

    internal ChannelReader<byte> Reader => _requests.Reader;
}

public sealed class UploadSessionCleanupWorker : BackgroundService
{
    private static readonly TimeSpan s_scanInterval = TimeSpan.FromMinutes(5);
    private readonly UploadSessionCleanupQueue _queue;
    private readonly ILogger<UploadSessionCleanupWorker> _logger;
    private readonly TimeProvider _timeProvider;
    private readonly IBackgroundWorkerLease _workerLease;
    private readonly Func<CancellationToken, Task> _cleanupAction;

    public UploadSessionCleanupWorker(
        UploadSessionCleanupQueue queue,
        IServiceScopeFactory scopeFactory,
        ILogger<UploadSessionCleanupWorker> logger,
        TimeProvider timeProvider,
        IBackgroundWorkerLease workerLease,
        IActiveReleaseCommitGuard activeReleaseCommitGuard)
        : this(
            queue,
            logger,
            timeProvider,
            workerLease,
            token => RunScopedCleanupAsync(scopeFactory, activeReleaseCommitGuard, token))
    {
    }

    internal UploadSessionCleanupWorker(
        UploadSessionCleanupQueue queue,
        ILogger<UploadSessionCleanupWorker> logger,
        TimeProvider timeProvider,
        IBackgroundWorkerLease workerLease,
        Func<CancellationToken, Task> cleanupAction)
    {
        _queue = queue ?? throw new ArgumentNullException(nameof(queue));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
        _workerLease = workerLease ?? throw new ArgumentNullException(nameof(workerLease));
        _cleanupAction = cleanupAction ?? throw new ArgumentNullException(nameof(cleanupAction));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using PeriodicTimer timer = new(s_scanInterval, _timeProvider);
        bool scanSucceeded = await RunCleanupUntilSignalsFlushedAsync(stoppingToken).ConfigureAwait(false);
        Task<bool> timerTask = timer.WaitForNextTickAsync(stoppingToken).AsTask();
        Task<bool> signalTask = _queue.Reader.WaitToReadAsync(stoppingToken).AsTask();

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                Task completed = scanSucceeded
                    ? await Task.WhenAny(timerTask, signalTask).ConfigureAwait(false)
                    : timerTask;
                bool refreshSignalTask = false;
                if (completed == timerTask)
                {
                    if (!await timerTask.ConfigureAwait(false))
                    {
                        break;
                    }

                    timerTask = timer.WaitForNextTickAsync(stoppingToken).AsTask();
                }
                else if (await signalTask.ConfigureAwait(false))
                {
                    refreshSignalTask = true;
                }
                else
                {
                    break;
                }

                scanSucceeded = await RunCleanupUntilSignalsFlushedAsync(stoppingToken).ConfigureAwait(false);
                if (refreshSignalTask)
                {
                    signalTask = _queue.Reader.WaitToReadAsync(stoppingToken).AsTask();
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    internal async Task<bool> RunCleanupUntilSignalsFlushedAsync(CancellationToken stoppingToken)
    {
        stoppingToken.ThrowIfCancellationRequested();
        bool runAgain;
        bool completed;
        bool ran;
        do
        {
            completed = false;
            ran = await _workerLease.TryRunAsLeaderAsync("upload-session-cleanup-worker", async token =>
            {
                _queue.BeginScan();
                try
                {
                    _queue.DrainPendingSignals();
                    completed = await RunCleanupOnceAsync(token).ConfigureAwait(false);
                }
                finally
                {
                    _queue.EndScan(completed);
                }
            }, stoppingToken)
                .ConfigureAwait(false);
            runAgain = ran && completed && (_queue.ConsumeOverflowedSignal() || _queue.HasPendingSignals);
        }
        while (runAgain && !stoppingToken.IsCancellationRequested);

        return ran && completed;
    }

    internal async Task<bool> RunCleanupOnceAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _cleanupAction(cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return true;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return false;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "upload-session-cleanup-failed");
            return false;
        }
    }

    private static async Task RunScopedCleanupAsync(
        IServiceScopeFactory scopeFactory,
        IActiveReleaseCommitGuard activeReleaseCommitGuard,
        CancellationToken cancellationToken)
    {
        await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
            scopeFactory,
            "upload_session_cleanup");
        var fileService = scope.ServiceProvider.GetRequiredService<FileService>();
        await fileService.CleanupExpiredSessionsAsync(
            cancellationToken,
            beforeCommit: commitToken => activeReleaseCommitGuard.EnsureCurrentAsync(commitToken)).ConfigureAwait(false);
    }
}
