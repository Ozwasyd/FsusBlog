using System.Threading.Channels;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;

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

    internal ChannelReader<byte> Reader => _requests.Reader;
}

public sealed class UploadSessionCleanupWorker(
    UploadSessionCleanupQueue queue,
    IServiceScopeFactory scopeFactory,
    ILogger<UploadSessionCleanupWorker> logger,
    TimeProvider timeProvider,
    IBackgroundWorkerLease workerLease) : BackgroundService
{
    private static readonly TimeSpan ScanInterval = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using PeriodicTimer timer = new(ScanInterval, timeProvider);
        Task<bool> timerTask = timer.WaitForNextTickAsync(stoppingToken).AsTask();
        Task<bool> signalTask = queue.Reader.WaitToReadAsync(stoppingToken).AsTask();

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
                    signalTask = queue.Reader.WaitToReadAsync(stoppingToken).AsTask();
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    private async Task RunCleanupUntilSignalsFlushedAsync(CancellationToken stoppingToken)
    {
        bool runAgain;
        do
        {
            queue.DrainPendingSignals();
            bool ran = await workerLease.TryRunAsLeaderAsync("upload-session-cleanup-worker", RunCleanupOnceAsync, stoppingToken)
                .ConfigureAwait(false);
            runAgain = ran && queue.ConsumeOverflowedSignal();
        }
        while (runAgain && !stoppingToken.IsCancellationRequested);
    }

    internal async Task RunCleanupOnceAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            var fileService = scope.ServiceProvider.GetRequiredService<FileService>();
            await fileService.CleanupExpiredSessionsAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "upload-session-cleanup-failed");
        }
    }
}
