using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using SqlSugar;

namespace FsusBlog.Server.Services.Background;

public sealed class ArticleMutationOutboxDispatcher(
    IServiceScopeFactory scopeFactory,
    ILogger<ArticleMutationOutboxDispatcher> logger,
    TimeProvider timeProvider) : BackgroundService
{
    private const int BatchSize = 50;
    private const int PoisonRetryThreshold = 10;
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using PeriodicTimer timer = new(PollInterval, timeProvider);
        while (!stoppingToken.IsCancellationRequested)
        {
            await ProcessPendingAsync(stoppingToken).ConfigureAwait(false);
            try
            {
                await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    internal async Task<int> ProcessPendingAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            IDbConcurrencyGate dbGate = scope.ServiceProvider.GetRequiredService<IDbConcurrencyGate>();
            ICacheInvalidationDispatcher cacheInvalidation = scope.ServiceProvider.GetRequiredService<ICacheInvalidationDispatcher>();
            IPublicAotInvalidationService publicAotInvalidation =
                scope.ServiceProvider.GetRequiredService<IPublicAotInvalidationService>();
            IArticleMutationSideEffectCoordinator coordinator =
                scope.ServiceProvider.GetRequiredService<IArticleMutationSideEffectCoordinator>();

            DateTime now = timeProvider.GetUtcNow().UtcDateTime;
            List<ArticleMutationOutboxEvent> pending = await dbGate.ExecuteAsync(
                "article-outbox-read",
                gateCt => db.Queryable<ArticleMutationOutboxEvent>()
                    .Where(e => e.AggregateType == "article"
                        && (e.Status == "pending" || e.Status == "processing")
                        && e.NextRetryAt <= now)
                    .OrderBy(e => e.Id)
                    .Take(BatchSize)
                    .ToListAsync(gateCt),
                _ => Task.FromResult(new List<ArticleMutationOutboxEvent>()),
                cancellationToken).ConfigureAwait(false);

            int processed = 0;
            foreach (ArticleMutationOutboxEvent item in pending)
            {
                cancellationToken.ThrowIfCancellationRequested();
                bool ok = await ProcessOneAsync(db, dbGate, cacheInvalidation, publicAotInvalidation, coordinator, item, cancellationToken)
                    .ConfigureAwait(false);
                if (ok)
                {
                    processed++;
                }
            }

            return processed;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return 0;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "article-mutation-outbox-dispatcher-failed");
            return 0;
        }
    }

    private async Task<bool> ProcessOneAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        ICacheInvalidationDispatcher cacheInvalidation,
        IPublicAotInvalidationService publicAotInvalidation,
        IArticleMutationSideEffectCoordinator coordinator,
        ArticleMutationOutboxEvent item,
        CancellationToken cancellationToken)
    {
        DateTime claimNow = timeProvider.GetUtcNow().UtcDateTime;
        DateTime claimDeadline = claimNow.AddMinutes(5);
        int claimed = await dbGate.ExecuteAsync(
            "article-outbox-claim",
            gateCt => db.Updateable<ArticleMutationOutboxEvent>()
                .SetColumns(e => e.Status == "processing")
                .SetColumns(e => e.NextRetryAt == claimDeadline)
                .Where(e => e.Id == item.Id
                    && (e.Status == "pending" || e.Status == "processing")
                    && e.NextRetryAt <= claimNow)
                .ExecuteCommandAsync(gateCt),
            _ => Task.FromResult(0),
            cancellationToken).ConfigureAwait(false);
        if (claimed == 0)
        {
            return false;
        }

        try
        {
            ArticleMutationAotScope aotScope = await LoadAotScopeAsync(db, dbGate, item.AggregateId, cancellationToken)
                .ConfigureAwait(false);
            await publicAotInvalidation.InvalidateArticleMutationAsync(
                    item.AggregateId,
                    aotScope.CategoryIds,
                    aotScope.TagIds,
                    cancellationToken)
                .ConfigureAwait(false);
            await cacheInvalidation.InvalidateArticleMutationAsync(item.AggregateId, cancellationToken)
                .ConfigureAwait(false);
            await coordinator.ReplayOutboxAsync(item.AggregateId, item.EventType, cancellationToken)
                .ConfigureAwait(false);

            DateTime processedAt = timeProvider.GetUtcNow().UtcDateTime;
            await dbGate.ExecuteAsync(
                "article-outbox-complete",
                gateCt => db.Updateable<ArticleMutationOutboxEvent>()
                    .SetColumns(e => e.Status == "processed")
                    .SetColumns(e => e.ProcessedAt == processedAt)
                    .SetColumns(e => e.LastError == null)
                    .Where(e => e.Id == item.Id)
                    .ExecuteCommandAsync(gateCt),
                _ => Task.FromResult(0),
                cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            int nextRetryCount = item.RetryCount + 1;
            string status = nextRetryCount >= PoisonRetryThreshold ? "poison" : "pending";
            DateTime nextRetryAt = timeProvider.GetUtcNow().UtcDateTime.Add(ComputeBackoff(nextRetryCount));
            string lastError = ex.Message.Length <= 1024 ? ex.Message : ex.Message[..1024];
            await dbGate.ExecuteAsync(
                "article-outbox-retry",
                gateCt => db.Updateable<ArticleMutationOutboxEvent>()
                    .SetColumns(e => e.Status == status)
                    .SetColumns(e => e.RetryCount == nextRetryCount)
                    .SetColumns(e => e.NextRetryAt == nextRetryAt)
                    .SetColumns(e => e.LastError == lastError)
                    .Where(e => e.Id == item.Id)
                    .ExecuteCommandAsync(gateCt),
                _ => Task.FromResult(0),
                cancellationToken).ConfigureAwait(false);
            logger.LogWarning(
                ex,
                "article-mutation-outbox-retry {OutboxId} {ArticleId} {EventType} {RetryCount} {Status}",
                item.Id,
                item.AggregateId,
                item.EventType,
                nextRetryCount,
                status);
            return false;
        }
    }

    private static async Task<ArticleMutationAotScope> LoadAotScopeAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        int articleId,
        CancellationToken cancellationToken)
    {
        if (articleId <= 0)
        {
            return ArticleMutationAotScope.Empty;
        }

        int categoryId = await dbGate.ExecuteAsync(
                "article-outbox-aot-scope-category",
                gateCt => db.Queryable<Article>()
                    .ClearFilter()
                    .Where(article => article.Id == articleId)
                    .Select(article => article.CategoryId)
                    .FirstAsync(gateCt),
                _ => Task.FromResult(0),
                cancellationToken)
            .ConfigureAwait(false);

        List<int> tagIds = await dbGate.ExecuteAsync(
                "article-outbox-aot-scope-tags",
                gateCt => db.Queryable<ArticleTag>()
                    .Where(articleTag => articleTag.ArticleId == articleId)
                    .Select(articleTag => articleTag.TagId)
                    .ToListAsync(gateCt),
                _ => Task.FromResult(new List<int>()),
                cancellationToken)
            .ConfigureAwait(false);

        return new ArticleMutationAotScope(
            categoryId > 0 ? [categoryId] : [],
            tagIds);
    }

    private static TimeSpan ComputeBackoff(int retryCount)
        => TimeSpan.FromSeconds(Math.Min(300, Math.Pow(2, Math.Clamp(retryCount, 1, 8))));

    private sealed record ArticleMutationAotScope(IReadOnlyList<int> CategoryIds, IReadOnlyList<int> TagIds)
    {
        public static readonly ArticleMutationAotScope Empty = new([], []);
    }
}
