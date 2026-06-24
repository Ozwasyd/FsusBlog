using System.Threading.Channels;
using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Services.Background;

public sealed class UploadSessionCleanupQueue
{
    private readonly Channel<byte> _requests = Channel.CreateBounded<byte>(new BoundedChannelOptions(1)
    {
        SingleReader = true,
        SingleWriter = false,
        FullMode = BoundedChannelFullMode.DropWrite
    });

    public bool TryRequestScan() => _requests.Writer.TryWrite(0);

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
                    while (queue.Reader.TryRead(out _))
                    {
                    }

                    signalTask = queue.Reader.WaitToReadAsync(stoppingToken).AsTask();
                }
                else
                {
                    break;
                }

                await workerLease.TryRunAsLeaderAsync("upload-session-cleanup-worker", RunCleanupOnceAsync, stoppingToken)
                    .ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
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
