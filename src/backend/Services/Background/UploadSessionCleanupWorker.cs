using System.Threading.Channels;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Services.Background;

public sealed class UploadSessionCleanupQueue
{
    internal const int SignalCapacity = 64;
    private static readonly TimeSpan DefaultMinSignalInterval = TimeSpan.FromSeconds(45);
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _minSignalInterval;
    private long _lastAcceptedSignalTicks;
    private int _overflowedSignal;
    private readonly Channel<byte> _requests = Channel.CreateBounded<byte>(new BoundedChannelOptions(SignalCapacity)
    {
        SingleReader = true,
        SingleWriter = false,
        FullMode = BoundedChannelFullMode.Wait
    });

    public UploadSessionCleanupQueue(TimeProvider? timeProvider = null, TimeSpan? minSignalInterval = null)
    {
        _timeProvider = timeProvider ?? TimeProvider.System;
        _minSignalInterval = minSignalInterval ?? DefaultMinSignalInterval;
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
            + (Volatile.Read(ref _overflowedSignal) == 1 ? 1 : 0);

    internal ChannelReader<byte> Reader => _requests.Reader;
}

public sealed class UploadSessionCleanupWorker : BackgroundService
{
    private static readonly TimeSpan ScanInterval = TimeSpan.FromMinutes(5);
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
        using PeriodicTimer timer = new(ScanInterval, _timeProvider);
        Task<bool> timerTask = timer.WaitForNextTickAsync(stoppingToken).AsTask();
        Task<bool> signalTask = _queue.Reader.WaitToReadAsync(stoppingToken).AsTask();

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                Task completed = await Task.WhenAny(timerTask, signalTask).ConfigureAwait(false);
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

                await RunCleanupUntilSignalsFlushedAsync(stoppingToken).ConfigureAwait(false);
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

    internal async Task RunCleanupUntilSignalsFlushedAsync(CancellationToken stoppingToken)
    {
        stoppingToken.ThrowIfCancellationRequested();
        bool runAgain;
        do
        {
            _queue.DrainPendingSignals();
            bool ran = await _workerLease.TryRunAsLeaderAsync("upload-session-cleanup-worker", RunCleanupOnceAsync, stoppingToken)
                .ConfigureAwait(false);
            runAgain = ran && (_queue.ConsumeOverflowedSignal() || _queue.HasPendingSignals);
        }
        while (runAgain && !stoppingToken.IsCancellationRequested);
    }

    internal async Task RunCleanupOnceAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _cleanupAction(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "upload-session-cleanup-failed");
        }
    }

    private static async Task RunScopedCleanupAsync(
        IServiceScopeFactory scopeFactory,
        IActiveReleaseCommitGuard activeReleaseCommitGuard,
        CancellationToken cancellationToken)
    {
        await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
        var fileService = scope.ServiceProvider.GetRequiredService<FileService>();
        await fileService.CleanupExpiredSessionsAsync(
            cancellationToken,
            beforeCommit: commitToken => activeReleaseCommitGuard.EnsureCurrentAsync(commitToken)).ConfigureAwait(false);
    }
}
