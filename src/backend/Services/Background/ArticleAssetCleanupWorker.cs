using System.Data.Common;
using System.Threading.Channels;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;

using SqlSugar;

namespace FsusBlog.Server.Services.Background;

public sealed class ArticleAssetCleanupQueue
{
    private readonly Channel<byte> _signals = Channel.CreateBounded<byte>(new BoundedChannelOptions(1)
    {
        SingleReader = true,
        SingleWriter = false,
        FullMode = BoundedChannelFullMode.DropWrite
    });

    public bool TryRequestScan() => _signals.Writer.TryWrite(0);

    internal int QueuedCount
        => _signals.Reader.CanCount ? _signals.Reader.Count : (_signals.Reader.TryPeek(out _) ? 1 : 0);

    internal void Drain()
    {
        while (_signals.Reader.TryRead(out _))
        {
        }
    }

    internal ChannelReader<byte> Reader => _signals.Reader;
}

public sealed class ArticleAssetCleanupService(
    ISqlSugarClient db,
    IAssetStore assetStore,
    TimeProvider timeProvider,
    ILogger<ArticleAssetCleanupService> logger)
{
    internal const int DefaultBatchSize = 32;

    public async Task<int> RebuildReferenceLedgerAsync(CancellationToken cancellationToken = default)
        => await db.Queryable<ContentAssetReference>().CountAsync(cancellationToken);

    public async Task<int> ProcessDueAsync(int maxItems = DefaultBatchSize, CancellationToken cancellationToken = default)
    {
        int processed = 0;
        for (int index = 0; index < Math.Clamp(maxItems, 1, 256); index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AssetId? candidateAssetId = null;
            var claim = await db.Ado.UseTranAsync(async () =>
            {
                using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                    """
                    SELECT asset_id
                    FROM content_asset_cleanup_queue
                    WHERE not_before_utc <= @NowUtc
                    ORDER BY not_before_utc, asset_id
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED;
                    """,
                    new SugarParameter("@NowUtc", timeProvider.GetUtcNow().UtcDateTime));
                if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    return false;
                }

                candidateAssetId = AssetId.FromGuid(reader.GetGuid(reader.GetOrdinal("asset_id")));
                await reader.DisposeAsync().ConfigureAwait(false);
                await db.Ado.ExecuteCommandAsync(
                    "UPDATE content_asset_cleanup_queue SET not_before_utc = @LeaseUntilUtc WHERE asset_id = @AssetId;",
                    new SugarParameter("@LeaseUntilUtc", timeProvider.GetUtcNow().UtcDateTime.AddMinutes(5)),
                    new SugarParameter("@AssetId", candidateAssetId.Value.Value)).ConfigureAwait(false);
                return true;
            }).ConfigureAwait(false);

            if (!claim.IsSuccess)
            {
                logger.LogWarning(claim.ErrorException, "content-asset-cleanup-claim-failed");
                break;
            }

            if (!claim.Data || candidateAssetId is null)
            {
                break;
            }

            try
            {
                AssetDeleteOutcome outcome = await assetStore.DeleteAsync(candidateAssetId.Value, cancellationToken)
                    .ConfigureAwait(false);
                if (outcome.Result == AssetDeleteResult.Referenced)
                {
                    await CancelCleanupAsync(candidateAssetId.Value, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                await RecordFailureAsync(candidateAssetId.Value, ex, cancellationToken).ConfigureAwait(false);
                logger.LogWarning(ex, "content-asset-cleanup-item-failed {AssetId}", candidateAssetId);
                break;
            }

            processed++;
        }

        return processed;
    }

    private Task<int> CancelCleanupAsync(AssetId assetId, CancellationToken cancellationToken)
        => db.Deleteable<ContentAssetCleanupQueueItem>()
            .Where(item => item.AssetId == assetId.Value
                && (item.LastError == null || item.LastError != ContentAssetCleanupMarkers.DeletePending))
            .ExecuteCommandAsync(cancellationToken);

    private async Task RecordFailureAsync(AssetId assetId, Exception? exception, CancellationToken cancellationToken)
    {
        string error = exception?.Message ?? "asset cleanup failed";
        if (error.Length > 512)
        {
            error = error[..512];
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE content_asset_cleanup_queue
            SET attempt_count = attempt_count + 1,
                last_error = CASE WHEN last_error = @DeletePendingMarker
                    THEN last_error ELSE @LastError END,
                not_before_utc = @NotBeforeUtc,
                updated_at_utc = @UpdatedAtUtc
            WHERE asset_id = @AssetId;
            """,
            new SugarParameter("@AssetId", assetId.Value),
            new SugarParameter("@LastError", error),
            new SugarParameter("@DeletePendingMarker", ContentAssetCleanupMarkers.DeletePending),
            new SugarParameter("@NotBeforeUtc", now.AddMinutes(15)),
            new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);
    }
}

public sealed class ArticleAssetCleanupWorker(
    ArticleAssetCleanupQueue queue,
    IServiceScopeFactory scopeFactory,
    ILogger<ArticleAssetCleanupWorker> logger,
    TimeProvider timeProvider) : BackgroundService
{
    private static readonly TimeSpan s_scanInterval = TimeSpan.FromMinutes(15);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await RunOnceAsync(rebuildLedger: true, stoppingToken).ConfigureAwait(false);
        using PeriodicTimer timer = new(s_scanInterval, timeProvider);
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
                else
                {
                    if (!await signalTask.ConfigureAwait(false))
                    {
                        break;
                    }
                    queue.Drain();
                    signalTask = queue.Reader.WaitToReadAsync(stoppingToken).AsTask();
                }

                await RunOnceAsync(rebuildLedger: false, stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    internal async Task RunOnceAsync(bool rebuildLedger, CancellationToken cancellationToken)
    {
        try
        {
            await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
                scopeFactory,
                "article_asset_cleanup");
            ArticleAssetCleanupService cleanup = scope.ServiceProvider.GetRequiredService<ArticleAssetCleanupService>();
            if (rebuildLedger)
            {
                _ = await cleanup.RebuildReferenceLedgerAsync(cancellationToken).ConfigureAwait(false);
            }
            _ = await cleanup.ProcessDueAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "article-asset-cleanup-cycle-failed");
        }
    }
}
