using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Taxonomy;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;
using StackExchange.Redis;

namespace FsusBlog.Server.Services;

public interface IArticleMutationSideEffectCoordinator
{
    Task BeginPublicMutationFenceAsync(int? articleId, CancellationToken cancellationToken = default);

    Task CommitPublicMutationFenceAsync(
        int? articleId,
        string reason,
        CancellationToken cancellationToken = default);

    Task RecoverAbortedPublicMutationFenceAsync(
        int? articleId,
        string reason,
        CancellationToken cancellationToken = default);

    Task AfterCreatedAsync(Article article, int articleId, ArticleListItemResponse? preview);

    Task AfterUpdatedAsync(int articleId, ArticleListItemResponse? preview);

    Task AfterDeletedAsync(int articleId);

    Task AfterRestoredAsync(int articleId, ArticleListItemResponse? preview);

    Task AfterPermanentlyDeletedAsync(int articleId, IEnumerable<string> imageUrls, CancellationToken cancellationToken);

    Task AfterTrashClearedAsync(
        IReadOnlyCollection<int> articleIds,
        IReadOnlyDictionary<int, string> articleBodies,
        CancellationToken cancellationToken);

    Task<ArticleMutationReplayResult> ReplayOutboxAsync(
        int articleId,
        string eventType,
        string outboxEventId,
        IReadOnlySet<string> completedEdges,
        CancellationToken cancellationToken);
}

public static class ArticleMutationReplayEdges
{
    public const string PublicAotInvalidation = "public-aot-invalidation";
    public const string HttpCacheInvalidation = "http-cache-invalidation";
    public const string SearchProjection = "search-projection";
    public const string ArticleDetailAeds = "article-detail-aeds";
    public const string TaxonomyProjection = "taxonomy-projection";
    public const string PublicArtifactRevocation = "public-artifact-revocation";
    public const string PublicHotRead = "public-hot-read";
    public const string IntegrityProof = "integrity-proof";
    public const string Notification = "notification";

    public static readonly IReadOnlySet<string> Required = new HashSet<string>(StringComparer.Ordinal)
    {
        PublicAotInvalidation,
        HttpCacheInvalidation,
        SearchProjection,
        ArticleDetailAeds,
        TaxonomyProjection,
        PublicArtifactRevocation,
        PublicHotRead
    };
}

internal static class ArticleMutationEventTypes
{
    internal const string Created = "created";
    internal const string Updated = "updated";
    internal const string Deleted = "deleted";
    internal const string Restored = "restored";
    internal const string PermanentlyDeleted = "permanently-deleted";
    internal const string TrashCleared = "trash-cleared";
    internal const string ScheduledPublished = "scheduled-published";
    internal const string CategoryUpdated = "category-updated";
    internal const string TagUpdated = "tag-updated";
    internal const string RightsProofUpdated = "rights-proof-updated";

    internal static readonly IReadOnlySet<string> Supported = new HashSet<string>(StringComparer.Ordinal)
    {
        Created,
        Updated,
        Deleted,
        Restored,
        PermanentlyDeleted,
        TrashCleared,
        ScheduledPublished,
        CategoryUpdated,
        TagUpdated,
        RightsProofUpdated
    };
}

public static class ArticleMutationDeliveryKey
{
    public static string Build(string outboxEventId, string edgeName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(outboxEventId);
        ArgumentException.ThrowIfNullOrWhiteSpace(edgeName);
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(string.Concat(outboxEventId, ":", edgeName)));
        return Convert.ToHexString(digest).ToLowerInvariant();
    }
}

public sealed record ArticleMutationReplayResult(
    bool IsSuccess,
    string? Error,
    IReadOnlySet<string> CompletedEdges,
    IReadOnlyDictionary<string, string> FailedEdges)
{
    public static ArticleMutationReplayResult Success(IReadOnlySet<string> completedEdges)
        => new(true, null, completedEdges, new Dictionary<string, string>(StringComparer.Ordinal));

    public static ArticleMutationReplayResult Success(
        IReadOnlySet<string> completedEdges,
        IReadOnlyDictionary<string, string> failedEdges)
        => new(true, null, completedEdges, failedEdges);

    public static ArticleMutationReplayResult Failed(
        string error,
        IReadOnlySet<string> completedEdges,
        IReadOnlyDictionary<string, string> failedEdges)
        => new(false, error, completedEdges, failedEdges);
}

public sealed class ArticleSearchProjector(ISearchIndexService searchIndex)
{
    public Task ProjectAsync(Article article)
        => ArticlePublication.IsPubliclyVisible(article, DateTime.UtcNow)
            ? searchIndex.AddOrUpdateIndexAsync(article)
            : searchIndex.DeleteIndexAsync(article.Id);

    public Task DeleteAsync(int articleId)
        => searchIndex.DeleteIndexAsync(articleId);
}

public sealed class ArticleRealtimeNotifier(IMessageRealtimePublisher messagePublisher)
{
    public Task PushChangedAsync(
        int articleId,
        string action,
        ArticleListItemResponse? preview = null,
        string? idempotencyKey = null)
        => messagePublisher.PushArticleChangedAsync(
            new ArticleNoticeDto(articleId, action, DateTime.UtcNow, preview),
            idempotencyKey);
}

public sealed class ArticleAssetCleanupPolicy(IFileService fileService)
{
    private const int MaxDeleteParallelism = 5;

    public async Task DeleteIllustrationsAsync(IEnumerable<string> imageUrls, CancellationToken cancellationToken = default)
    {
        string[] uniqueUrls = imageUrls
            .Where(static url => !string.IsNullOrWhiteSpace(url))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (uniqueUrls.Length == 0)
        {
            return;
        }

        await Parallel.ForEachAsync(
            uniqueUrls,
            new ParallelOptions { MaxDegreeOfParallelism = MaxDeleteParallelism, CancellationToken = cancellationToken },
            async (url, _) => await fileService.DeleteImageAsync(url));
    }
}

public sealed class ArticleMutationSideEffectCoordinator(
    ISqlSugarClient db,
    IConnectionMultiplexer redisConnection,
    IRuntimeKeyScope runtimeKeyScope,
    IUnifiedCache cache,
    ArticleSearchProjector searchProjector,
    ITaxonomyCountProjectionService taxonomyProjection,
    IArticleDetailAedsArtifactProjector articleDetailArtifacts,
    IPublicArtifactRevocationCoordinator publicArtifactRevocations,
    IPublicMutationFenceLease mutationFenceLease,
    PublicHotArtifactUpdateQueue publicHotUpdates,
    IIntegrityProofScheduler integrityProofScheduler,
    ArticleRealtimeNotifier realtimeNotifier,
    ArticleAssetCleanupPolicy assetCleanupPolicy,
    ILogger<ArticleMutationSideEffectCoordinator> logger) : IArticleMutationSideEffectCoordinator
{
    private readonly IDatabase _redis = redisConnection.GetDatabase();

    public async Task BeginPublicMutationFenceAsync(
        int? articleId,
        CancellationToken cancellationToken = default)
    {
        int lockKey = NormalizeFenceKey(articleId);
        await mutationFenceLease.AcquireAsync(lockKey, cancellationToken).ConfigureAwait(false);
        try
        {
            if (articleId is > 0)
            {
                await publicArtifactRevocations
                    .BeginArticleMutationFenceAsync(articleId.Value, cancellationToken)
                    .ConfigureAwait(false);
            }
            else
            {
                await publicArtifactRevocations
                    .BeginGlobalMutationFenceAsync(cancellationToken)
                    .ConfigureAwait(false);
            }
        }
        catch
        {
            await ReleaseMutationFenceLeaseAsync(lockKey).ConfigureAwait(false);
            throw;
        }
    }

    public Task CommitPublicMutationFenceAsync(
        int? articleId,
        string reason,
        CancellationToken cancellationToken = default)
        => PromoteAndReleasePublicMutationFenceAsync(articleId, reason, cancellationToken);

    public Task RecoverAbortedPublicMutationFenceAsync(
        int? articleId,
        string reason,
        CancellationToken cancellationToken = default)
        => PromoteAndReleasePublicMutationFenceAsync(articleId, reason, cancellationToken);

    private async Task PromoteAndReleasePublicMutationFenceAsync(
        int? articleId,
        string reason,
        CancellationToken cancellationToken)
    {
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (articleId is > 0)
            {
                await publicArtifactRevocations
                    .RevokeArticleAsync(articleId.Value, cancellationToken)
                    .ConfigureAwait(false);
            }
            else
            {
                await publicArtifactRevocations
                    .RevokeAllAsync(cancellationToken)
                    .ConfigureAwait(false);
            }

            string normalized = string.IsNullOrWhiteSpace(reason) ? "mutation-fence-committed" : reason;
            PublicHotArtifactEnqueueResult result = publicHotUpdates.Enqueue(
                articleId is > 0 ? articleId : null,
                normalized);
            if (!result.Accepted)
            {
                logger.LogWarning(
                    "public-hot-read-mutation-fence-rebuild-enqueue-failed {ArticleId} {Reason} {Status}",
                    articleId,
                    normalized,
                    result.Status);
            }
        }
        finally
        {
            await ReleaseMutationFenceLeaseAsync(NormalizeFenceKey(articleId)).ConfigureAwait(false);
        }
    }

    private async Task ReleaseMutationFenceLeaseAsync(int articleId)
    {
        try
        {
            await mutationFenceLease.ReleaseAsync(articleId, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "public-mutation-fence-lease-release-failed {ArticleId}", articleId);
        }
    }

    private static int NormalizeFenceKey(int? articleId) => articleId is > 0 ? articleId.Value : 0;

    public Task AfterCreatedAsync(Article article, int articleId, ArticleListItemResponse? preview)
        => ExecuteAsync(
            async () =>
            {
                article.Id = articleId;
                bool isPublic = ArticlePublication.IsPubliclyVisible(article, DateTime.UtcNow);
                if (isPublic)
                {
                    await CommitPublicMutationFenceAsync(
                            null,
                            "article-created",
                            CancellationToken.None)
                        .ConfigureAwait(false);
                }
                await RunSideEffectsSequentiallyAsync(
                    () => searchProjector.ProjectAsync(article),
                    () => taxonomyProjection.ReconcileArticleAsync(articleId),
                    () => articleDetailArtifacts.GenerateAndStoreAsync(articleId),
                    () => QueuePublicHotUpdateAsync(isPublic ? null : articleId, "article-created"),
                    () => realtimeNotifier.PushChangedAsync(articleId, "Created", preview));
            },
            "article-create-sync");

    public Task AfterUpdatedAsync(int articleId, ArticleListItemResponse? preview)
        => ExecuteAsync(
            async () =>
            {
                try
                {
                    await publicArtifactRevocations.RevokeArticleAsync(articleId).ConfigureAwait(false);
                }
                finally
                {
                    await ReleaseMutationFenceLeaseAsync(articleId).ConfigureAwait(false);
                }

                Article? article = await LoadArticleWithContentAsync(articleId);
                if (article is null)
                {
                    return;
                }

                await RunSideEffectsSequentiallyAsync(
                    () => searchProjector.ProjectAsync(article),
                    () => taxonomyProjection.ReconcileArticleAsync(articleId),
                    () => articleDetailArtifacts.GenerateAndStoreAsync(articleId),
                    () => QueuePublicHotUpdateAsync(articleId, "article-updated"),
                    () => realtimeNotifier.PushChangedAsync(articleId, "Updated", preview));
            },
            "article-update-sync");

    public Task AfterDeletedAsync(int articleId)
        => ExecuteAsync(
            async () =>
            {
                try
                {
                    await publicArtifactRevocations.RevokeArticleAsync(articleId).ConfigureAwait(false);
                }
                finally
                {
                    await ReleaseMutationFenceLeaseAsync(articleId).ConfigureAwait(false);
                }
                await RunSideEffectsSequentiallyAsync(
                    () => searchProjector.DeleteAsync(articleId),
                    () => taxonomyProjection.ReconcileArticleAsync(articleId),
                    () => articleDetailArtifacts.RemoveAsync(articleId),
                    () => QueuePublicHotUpdateAsync(articleId, "article-deleted"),
                    () => _redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), articleId),
                    () => realtimeNotifier.PushChangedAsync(articleId, "Deleted"));
            },
            "article-delete-sync");

    public Task AfterRestoredAsync(int articleId, ArticleListItemResponse? preview)
        => ExecuteAsync(
            async () =>
            {
                Article? article = await LoadArticleWithContentAsync(articleId);
                if (article is null)
                {
                    return;
                }

                await RunSideEffectsSequentiallyAsync(
                    () => searchProjector.ProjectAsync(article),
                    () => taxonomyProjection.ReconcileArticleAsync(articleId),
                    () => articleDetailArtifacts.GenerateAndStoreAsync(articleId),
                    () => QueuePublicHotUpdateAsync(articleId, "article-restored"),
                    () => _redis.SortedSetAddAsync(RedisKey("blog:top_articles"), articleId, article.Views),
                    () => realtimeNotifier.PushChangedAsync(articleId, "Restored", preview));
            },
            "article-restore-sync");

    public Task AfterPermanentlyDeletedAsync(int articleId, IEnumerable<string> imageUrls, CancellationToken cancellationToken)
        => ExecuteAsync(
            async () =>
            {
                await publicArtifactRevocations.RevokeArticleAsync(articleId, cancellationToken).ConfigureAwait(false);
                await RunSideEffectsSequentiallyAsync(
                    () => searchProjector.DeleteAsync(articleId),
                    () => taxonomyProjection.ReconcileArticleAsync(articleId, cancellationToken),
                    () => articleDetailArtifacts.RemoveAsync(articleId),
                    () => QueuePublicHotUpdateAsync(articleId, "article-permanently-deleted"),
                    () => _redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), articleId),
                    () => realtimeNotifier.PushChangedAsync(articleId, "Deleted"));

                await assetCleanupPolicy.DeleteIllustrationsAsync(imageUrls, cancellationToken);
            },
            "article-permanent-delete-sync");

    public Task AfterTrashClearedAsync(
        IReadOnlyCollection<int> articleIds,
        IReadOnlyDictionary<int, string> articleBodies,
        CancellationToken cancellationToken)
        => ExecuteAsync(
            async () =>
            {
                await publicArtifactRevocations.RevokeAllAsync(cancellationToken).ConfigureAwait(false);
                foreach (int[] chunk in articleIds.Chunk(128))
                {
                    foreach (int articleId in chunk)
                    {
                        await RunSideEffectsSequentiallyAsync(
                            () => _redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), articleId),
                            () => cache.RemoveAsync(CachePolicyId.ArticleDetail, articleId, cancellationToken),
                            () => taxonomyProjection.ReconcileArticleAsync(articleId, cancellationToken),
                            () => articleDetailArtifacts.RemoveAsync(articleId, cancellationToken),
                            () => searchProjector.DeleteAsync(articleId));
                    }
                }

                await QueuePublicHotUpdateAsync(null, "article-trash-cleared");

                var imageUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (string body in articleBodies.Values)
                {
                    foreach (string url in ImageHelper.ExtractIllustrationUrls(body))
                    {
                        imageUrls.Add(url);
                    }
                }

                await assetCleanupPolicy.DeleteIllustrationsAsync(imageUrls, cancellationToken);
            },
            "article-clear-trash-sync");

    public async Task<ArticleMutationReplayResult> ReplayOutboxAsync(
        int articleId,
        string eventType,
        string outboxEventId,
        IReadOnlySet<string> completedEdges,
        CancellationToken cancellationToken)
    {
        var completed = new HashSet<string>(completedEdges, StringComparer.Ordinal);
        var completedDuringReplay = new HashSet<string>(StringComparer.Ordinal);
        var failed = new Dictionary<string, string>(StringComparer.Ordinal);
        async Task<bool> RunEdgeAsync(string edgeName, Func<Task> effect)
        {
            if (completed.Contains(edgeName))
            {
                return true;
            }

            try
            {
                await effect().ConfigureAwait(false);
                completed.Add(edgeName);
                completedDuringReplay.Add(edgeName);
                return true;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                string error = NormalizeReplayError(ex);
                failed[edgeName] = error;
                logger.LogError(
                    ex,
                    "article-outbox-replay-edge-failed {ArticleId} {EventType} {EdgeName} {Error}",
                    articleId,
                    eventType,
                    edgeName,
                    error);
                return false;
            }
        }

        async Task RunOptionalEdgeAsync(string edgeName, Func<Task> effect)
        {
            if (completed.Contains(edgeName))
            {
                return;
            }

            try
            {
                await effect().ConfigureAwait(false);
                completed.Add(edgeName);
                completedDuringReplay.Add(edgeName);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                string error = NormalizeReplayError(ex);
                failed[edgeName] = error;
                logger.LogWarning(
                    ex,
                    "article-outbox-replay-optional-edge-failed {ArticleId} {EventType} {EdgeName} {Error}",
                    articleId,
                    eventType,
                    edgeName,
                    error);
            }
        }

        async Task ScheduleIntegrityProofIfRequiredEdgesCompleteAsync(string normalized)
        {
            if (string.Equals(normalized, ArticleMutationEventTypes.RightsProofUpdated, StringComparison.Ordinal))
            {
                return;
            }

            if (!ArticleMutationReplayEdges.Required.All(completed.Contains))
            {
                return;
            }

            await RunOptionalEdgeAsync(ArticleMutationReplayEdges.IntegrityProof, () =>
                    integrityProofScheduler.ScheduleFromOutboxAsync(articleId, normalized, completed, cancellationToken))
                .ConfigureAwait(false);
        }

        try
        {
            string normalized = TextHelpers.LowerTrimmed(eventType) ?? string.Empty;
            if (normalized is ArticleMutationEventTypes.Deleted
                or ArticleMutationEventTypes.PermanentlyDeleted
                or ArticleMutationEventTypes.TrashCleared)
            {
                return await ReplayDeletedArticleEdgesAsync(normalized).ConfigureAwait(false);
            }

            Article? article = await LoadArticleWithContentAsync(articleId).ConfigureAwait(false);
            if (article is null)
            {
                return await ReplayMissingArticleEdgesAsync(normalized).ConfigureAwait(false);
            }

            string action = normalized switch
            {
                ArticleMutationEventTypes.Created => "Created",
                ArticleMutationEventTypes.Restored => "Restored",
                _ => "Updated"
            };

            if (!await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicArtifactRevocation,
                        () => publicArtifactRevocations.RevokeArticleAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(ArticleMutationReplayEdges.SearchProjection, () => searchProjector.ProjectAsync(article))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.TaxonomyProjection,
                        () => taxonomyProjection.ReconcileArticleAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.ArticleDetailAeds,
                        () => articleDetailArtifacts.GenerateAndStoreAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicHotRead,
                        async () =>
                        {
                            await EnsurePublicHotUpdateQueuedAsync(
                                    normalized is ArticleMutationEventTypes.Created or ArticleMutationEventTypes.ScheduledPublished
                                        ? null
                                        : articleId,
                                    $"outbox-{normalized}")
                                .ConfigureAwait(false);
                            if (normalized == ArticleMutationEventTypes.Restored)
                            {
                                await _redis.SortedSetAddAsync(RedisKey("blog:top_articles"), articleId, article.Views)
                                    .ConfigureAwait(false);
                            }
                        })
                    .ConfigureAwait(false)
            )
            {
                return FailedResult();
            }

            await ScheduleIntegrityProofIfRequiredEdgesCompleteAsync(normalized).ConfigureAwait(false);

            if (!await RunEdgeAsync(
                    ArticleMutationReplayEdges.Notification,
                    () => realtimeNotifier.PushChangedAsync(
                        articleId,
                        action,
                        idempotencyKey: ArticleMutationDeliveryKey.Build(outboxEventId, ArticleMutationReplayEdges.Notification)))
                .ConfigureAwait(false))
            {
                return FailedResult();
            }

            return ArticleMutationReplayResult.Success(completedDuringReplay, failed);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            string error = NormalizeReplayError(ex);
            logger.LogError(ex, "article-outbox-replay-failed {ArticleId} {EventType} {Error}", articleId, eventType, error);
            failed["article-outbox-replay"] = error;
            return ArticleMutationReplayResult.Failed(error, completedDuringReplay, failed);
        }

        async Task<ArticleMutationReplayResult> ReplayDeletedArticleEdgesAsync(string normalized)
        {
            if (!await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicArtifactRevocation,
                        () => publicArtifactRevocations.RevokeArticleAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(ArticleMutationReplayEdges.SearchProjection, () => searchProjector.DeleteAsync(articleId))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.TaxonomyProjection,
                        () => taxonomyProjection.ReconcileArticleAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.ArticleDetailAeds,
                        () => articleDetailArtifacts.RemoveAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicHotRead,
                        async () =>
                        {
                            await EnsurePublicHotUpdateQueuedAsync(articleId, $"outbox-{normalized}").ConfigureAwait(false);
                            await _redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), articleId).ConfigureAwait(false);
                        })
                    .ConfigureAwait(false)
            )
            {
                return FailedResult();
            }

            await ScheduleIntegrityProofIfRequiredEdgesCompleteAsync(normalized).ConfigureAwait(false);

            if (!await RunEdgeAsync(
                    ArticleMutationReplayEdges.Notification,
                    () => realtimeNotifier.PushChangedAsync(
                        articleId,
                        "Deleted",
                        idempotencyKey: ArticleMutationDeliveryKey.Build(outboxEventId, ArticleMutationReplayEdges.Notification)))
                .ConfigureAwait(false))
            {
                return FailedResult();
            }

            return ArticleMutationReplayResult.Success(completedDuringReplay, failed);
        }

        async Task<ArticleMutationReplayResult> ReplayMissingArticleEdgesAsync(string normalized)
        {
            if (!await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicArtifactRevocation,
                        () => publicArtifactRevocations.RevokeArticleAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(ArticleMutationReplayEdges.SearchProjection, () => searchProjector.DeleteAsync(articleId))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.TaxonomyProjection,
                        () => taxonomyProjection.ReconcileArticleAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.ArticleDetailAeds,
                        () => articleDetailArtifacts.RemoveAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicHotRead,
                        async () =>
                        {
                            await EnsurePublicHotUpdateQueuedAsync(articleId, $"outbox-{normalized}").ConfigureAwait(false);
                            await _redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), articleId).ConfigureAwait(false);
                        })
                    .ConfigureAwait(false))
            {
                return FailedResult();
            }

            await ScheduleIntegrityProofIfRequiredEdgesCompleteAsync(normalized).ConfigureAwait(false);

            return ArticleMutationReplayResult.Success(completedDuringReplay, failed);
        }

        ArticleMutationReplayResult FailedResult()
        {
            string error = failed.Count == 0
                ? "article mutation replay edge failed"
                : string.Join("; ", failed.Select(static item => $"{item.Key}: {item.Value}"));
            return ArticleMutationReplayResult.Failed(NormalizeReplayError(error), completedDuringReplay, failed);
        }
    }

    private async Task<Article?> LoadArticleWithContentAsync(int articleId)
    {
        Article? article = await db.Queryable<Article>().ClearFilter().InSingleAsync(articleId);
        if (article is null)
        {
            return null;
        }

        article.Content = await db.Queryable<ArticleBody>()
            .Where(it => it.ArticleId == articleId)
            .Select(it => it.MarkdownContent)
            .FirstAsync()
            ?? string.Empty;
        return article;
    }

    private Task ExecuteAsync(Func<Task> action, string operation)
        => BoundaryExecutor.ExecuteAsync(action, logger, operation, LogLevel.Error);

    private static async Task RunSideEffectsSequentiallyAsync(params Func<Task>[] effects)
    {
        foreach (Func<Task> effect in effects)
        {
            await effect().ConfigureAwait(false);
        }
    }

    private string RedisKey(string key)
        => runtimeKeyScope.PrefixKey(key);

    private static string NormalizeReplayError(Exception ex)
        => NormalizeReplayError(ex.Message);

    private static string NormalizeReplayError(string error)
        => error.Length <= 1024 ? error : error[..1024];

    private Task<PublicHotArtifactEnqueueResult> QueuePublicHotUpdateAsync(int? articleId, string reason, bool required = false)
    {
        PublicHotArtifactEnqueueResult result = publicHotUpdates.Enqueue(articleId, reason);
        if (!result.Accepted)
        {
            logger.LogWarning(
                "public-hot-read-update-enqueue-failed {ArticleId} {Reason} {Mode} {Status}",
                articleId,
                result.Reason,
                required ? "required" : "best-effort",
                result.Status);
        }

        return Task.FromResult(result);
    }

    private async Task EnsurePublicHotUpdateQueuedAsync(int? articleId, string reason)
    {
        PublicHotArtifactEnqueueResult result = await QueuePublicHotUpdateAsync(articleId, reason, required: true)
            .ConfigureAwait(false);
        if (!result.Accepted)
        {
            throw new InvalidOperationException($"public-hot-read update enqueue failed: {result.Status}");
        }
    }
}
