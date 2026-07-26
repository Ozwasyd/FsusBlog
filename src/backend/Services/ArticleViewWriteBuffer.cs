using System.Collections.Concurrent;

using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Services;

public sealed record ArticleViewFlushResult(int AcceptedDelta, IReadOnlySet<int> UpdatedArticleIds);

public sealed record ArticleViewBufferSnapshot(int PendingArticleCount, long PendingDelta);

public interface IArticleViewFlushSink
{
    ValueTask<IReadOnlySet<int>> FlushArticleViewsAsync(
        IReadOnlyDictionary<int, int> articleCounts,
        CancellationToken cancellationToken = default);
}

public interface IArticleViewWriteBuffer
{
    ValueTask EnqueueAsync(int articleId, int delta = 1, CancellationToken cancellationToken = default);

    Task<ArticleViewFlushResult> FlushAsync(CancellationToken cancellationToken = default);
}

public sealed class ArticleViewWriteBuffer(
    IServiceScopeFactory scopeFactory,
    ILogger<ArticleViewWriteBuffer> logger) : IArticleViewWriteBuffer
{
    private readonly ConcurrentDictionary<int, int> _pending = new();

    public ArticleViewBufferSnapshot CreateSnapshot()
    {
        KeyValuePair<int, int>[] pending = _pending.ToArray();
        return new ArticleViewBufferSnapshot(
            pending.Length,
            pending.Sum(static item => (long)Math.Max(0, item.Value)));
    }

    public ValueTask EnqueueAsync(int articleId, int delta = 1, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (articleId <= 0 || delta <= 0)
        {
            return ValueTask.CompletedTask;
        }

        _pending.AddOrUpdate(articleId, delta, (_, current) => current + delta);
        return ValueTask.CompletedTask;
    }

    public async Task<ArticleViewFlushResult> FlushAsync(CancellationToken cancellationToken = default)
    {
        KeyValuePair<int, int>[] snapshot = _pending.ToArray();
        if (snapshot.Length == 0)
        {
            return new ArticleViewFlushResult(0, new HashSet<int>());
        }

        var batch = new Dictionary<int, int>(snapshot.Length);
        foreach ((int articleId, int delta) in snapshot)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (articleId <= 0 || delta <= 0 || !_pending.TryRemove(articleId, out int removedDelta))
            {
                continue;
            }

            if (removedDelta > 0)
            {
                batch[articleId] = removedDelta;
            }
        }

        if (batch.Count == 0)
        {
            return new ArticleViewFlushResult(0, new HashSet<int>());
        }

        try
        {
            using IServiceScope scope = scopeFactory.CreateScope();
            var sink = scope.ServiceProvider.GetRequiredService<IArticleViewFlushSink>();
            IReadOnlySet<int> updated = await sink.FlushArticleViewsAsync(batch, cancellationToken).ConfigureAwait(false);
            return new ArticleViewFlushResult(batch.Values.Sum(), updated);
        }
        catch
        {
            foreach ((int articleId, int delta) in batch)
            {
                _pending.AddOrUpdate(articleId, delta, (_, current) => current + delta);
            }

            logger.LogWarning("article-view-flush-failed-requeued {ArticleCount} {Delta}", batch.Count, batch.Values.Sum());
            throw;
        }
    }
}

public sealed class ArticleServiceViewFlushSink(
    IArticleCoreService articleService,
    IHotStatsInvalidationCoalescer hotStatsInvalidation,
    PublicHotArtifactUpdateQueue publicHotUpdates,
    ILogger<ArticleServiceViewFlushSink> logger) : IArticleViewFlushSink
{
    public async ValueTask<IReadOnlySet<int>> FlushArticleViewsAsync(
        IReadOnlyDictionary<int, int> articleCounts,
        CancellationToken cancellationToken = default)
    {
        var result = await articleService
            .IncreaseViewCountsAsync(new ArticleViewCountBatchCommand(articleCounts), cancellationToken)
            .ConfigureAwait(false);
        IReadOnlySet<int> updatedArticleIds = result.IsSuccess && result.Value is not null
            ? result.Value
            : new HashSet<int>();
        if (updatedArticleIds.Count == 0)
        {
            return updatedArticleIds;
        }

        const string Reason = "article-view-projection-buffer-flush";
        await hotStatsInvalidation.MarkStatsDirtyAsync(Reason, cancellationToken).ConfigureAwait(false);
        await hotStatsInvalidation.MarkHotArticlesDirtyAsync(Reason, cancellationToken).ConfigureAwait(false);
        foreach (int articleId in updatedArticleIds)
        {
            PublicHotArtifactEnqueueResult delivery = await publicHotUpdates.EnqueueAsync(
                    PublicHotArtifactDeliveryClass.BestEffortView,
                    articleId,
                    Reason,
                    cancellationToken: CancellationToken.None)
                .ConfigureAwait(false);
            PublicHotArtifactDeliveryReceipt.RequireDurable(delivery, Reason);
            if (delivery.Status is PublicHotArtifactDeliveryStatus.PersistedDirty
                or PublicHotArtifactDeliveryStatus.Coalesced)
            {
                logger.LogInformation(
                    "article-view-public-hot-persisted-for-replay {ArticleId} {DeliveryStatus}",
                    articleId,
                    delivery.Status);
            }
        }

        return updatedArticleIds;
    }
}

public sealed class ArticleViewFlushWorker(
    IArticleViewWriteBuffer buffer,
    ILogger<ArticleViewFlushWorker> logger) : BackgroundService
{
    private static readonly TimeSpan s_flushInterval = TimeSpan.FromSeconds(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(s_flushInterval);
        while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
        {
            await FlushPendingAsync(stoppingToken).ConfigureAwait(false);
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await FlushPendingAsync(cancellationToken).ConfigureAwait(false);
        await base.StopAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task FlushPendingAsync(CancellationToken cancellationToken)
    {
        try
        {
            ArticleViewFlushResult result = await buffer.FlushAsync(cancellationToken).ConfigureAwait(false);
            if (result.AcceptedDelta > 0)
            {
                logger.LogDebug("article-view-flush {ArticleCount} {Delta}", result.UpdatedArticleIds.Count, result.AcceptedDelta);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "article-view-flush-worker-cycle-failed");
        }
    }
}
