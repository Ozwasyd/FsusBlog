using System.Data.Common;
using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Articles;

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
    IFileService fileService,
    TimeProvider timeProvider,
    ILogger<ArticleAssetCleanupService> logger)
{
    internal const int DefaultBatchSize = 32;

    public async Task<int> RebuildReferenceLedgerAsync(CancellationToken cancellationToken = default)
    {
        var store = new ArticleAssetReferenceStore(db, timeProvider);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await store.RebuildAllAsync(cancellationToken).ConfigureAwait(false);
            return await db.Queryable<ArticleAssetReference>().CountAsync(cancellationToken);
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Article asset reference rebuild failed.", transaction.ErrorException);
        }

        return transaction.Data;
    }

    public async Task<int> ProcessDueAsync(int maxItems = DefaultBatchSize, CancellationToken cancellationToken = default)
    {
        int processed = 0;
        for (int index = 0; index < Math.Clamp(maxItems, 1, 256); index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string? candidateUrl = null;
            var store = new ArticleAssetReferenceStore(db, timeProvider);
            var transaction = await db.Ado.UseTranAsync(async () =>
            {
                using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                    """
                    SELECT normalized_url
                    FROM article_asset_cleanup_queue
                    WHERE not_before_utc <= @NowUtc
                    ORDER BY not_before_utc, normalized_url
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED;
                    """,
                    new SugarParameter("@NowUtc", timeProvider.GetUtcNow().UtcDateTime));
                if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    return false;
                }

                candidateUrl = reader.ReadString("normalized_url");
                await reader.DisposeAsync().ConfigureAwait(false);
                await store.ReconcileUrlsAsync([candidateUrl], cancellationToken).ConfigureAwait(false);
                bool referenced = await db.Queryable<ArticleAssetReference>()
                    .Where(reference => reference.NormalizedUrl == candidateUrl)
                    .AnyAsync(cancellationToken);
                if (referenced)
                {
                    await DeleteQueueItemAsync(candidateUrl, cancellationToken).ConfigureAwait(false);
                    return true;
                }

                // File deletion deliberately stays inside the URL-locked transaction. Writers use
                // the same advisory lock, so no new authoritative reference can commit between the
                // final zero-reference check and the idempotent local delete.
                _ = await fileService.DeleteImageAsync(candidateUrl).ConfigureAwait(false);
                await DeleteQueueItemAsync(candidateUrl, cancellationToken).ConfigureAwait(false);
                return true;
            }).ConfigureAwait(false);

            if (!transaction.IsSuccess)
            {
                if (candidateUrl is not null)
                {
                    await RecordFailureAsync(candidateUrl, transaction.ErrorException, cancellationToken).ConfigureAwait(false);
                }

                logger.LogWarning(transaction.ErrorException, "article-asset-cleanup-item-failed {AssetUrl}", candidateUrl);
                break;
            }

            if (!transaction.Data)
            {
                break;
            }

            processed++;
        }

        return processed;
    }

    private Task<int> DeleteQueueItemAsync(string normalizedUrl, CancellationToken cancellationToken)
        => db.Deleteable<ArticleAssetCleanupQueueItem>()
            .Where(item => item.NormalizedUrl == normalizedUrl)
            .ExecuteCommandAsync(cancellationToken);

    private async Task RecordFailureAsync(string normalizedUrl, Exception? exception, CancellationToken cancellationToken)
    {
        string error = exception?.Message ?? "asset cleanup failed";
        if (error.Length > 512)
        {
            error = error[..512];
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article_asset_cleanup_queue
            SET attempt_count = attempt_count + 1,
                last_error = @LastError,
                not_before_utc = @NotBeforeUtc,
                updated_at_utc = @UpdatedAtUtc
            WHERE normalized_url = @NormalizedUrl;
            """,
            new SugarParameter("@NormalizedUrl", normalizedUrl),
            new SugarParameter("@LastError", error),
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
