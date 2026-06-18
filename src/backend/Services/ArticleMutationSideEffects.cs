using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;
using StackExchange.Redis;

namespace FsusBlog.Server.Services;

public interface IArticleMutationSideEffectCoordinator
{
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
        IReadOnlySet<string> completedEdges,
        CancellationToken cancellationToken);
}

public static class ArticleMutationReplayEdges
{
    public const string PublicAotInvalidation = "public-aot-invalidation";
    public const string HttpCacheInvalidation = "http-cache-invalidation";
    public const string SearchProjection = "search-projection";
    public const string ArticleDetailAeds = "article-detail-aeds";
    public const string PublicHotRead = "public-hot-read";
    public const string Notification = "notification";

    public static readonly IReadOnlySet<string> Required = new HashSet<string>(StringComparer.Ordinal)
    {
        PublicAotInvalidation,
        HttpCacheInvalidation,
        SearchProjection,
        ArticleDetailAeds,
        PublicHotRead
    };
}

public sealed record ArticleMutationReplayResult(
    bool IsSuccess,
    string? Error,
    IReadOnlySet<string> CompletedEdges,
    IReadOnlyDictionary<string, string> FailedEdges)
{
    public static ArticleMutationReplayResult Success(IReadOnlySet<string> completedEdges)
        => new(true, null, completedEdges, new Dictionary<string, string>(StringComparer.Ordinal));

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
    public Task PushChangedAsync(int articleId, string action, ArticleListItemResponse? preview = null)
        => messagePublisher.PushArticleChangedAsync(new ArticleNoticeDto(articleId, action, DateTime.UtcNow, preview));
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
    IArticleDetailAedsArtifactProjector articleDetailArtifacts,
    PublicHotArtifactUpdateQueue publicHotUpdates,
    ArticleRealtimeNotifier realtimeNotifier,
    ArticleAssetCleanupPolicy assetCleanupPolicy,
    ILogger<ArticleMutationSideEffectCoordinator> logger) : IArticleMutationSideEffectCoordinator
{
    private readonly IDatabase _redis = redisConnection.GetDatabase();

    public Task AfterCreatedAsync(Article article, int articleId, ArticleListItemResponse? preview)
        => ExecuteAsync(
            async () =>
            {
                article.Id = articleId;
                await RunSideEffectsSequentiallyAsync(
                    () => searchProjector.ProjectAsync(article),
                    () => articleDetailArtifacts.GenerateAndStoreAsync(articleId),
                    () => QueuePublicHotUpdateAsync(articleId, "article-created"),
                    () => realtimeNotifier.PushChangedAsync(articleId, "Created", preview));
            },
            "article-create-sync");

    public Task AfterUpdatedAsync(int articleId, ArticleListItemResponse? preview)
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
                    () => articleDetailArtifacts.GenerateAndStoreAsync(articleId),
                    () => QueuePublicHotUpdateAsync(articleId, "article-updated"),
                    () => realtimeNotifier.PushChangedAsync(articleId, "Updated", preview));
            },
            "article-update-sync");

    public Task AfterDeletedAsync(int articleId)
        => ExecuteAsync(
            async () =>
            {
                await RunSideEffectsSequentiallyAsync(
                    () => searchProjector.DeleteAsync(articleId),
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
                await RunSideEffectsSequentiallyAsync(
                    () => searchProjector.DeleteAsync(articleId),
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
                foreach (int[] chunk in articleIds.Chunk(128))
                {
                    foreach (int articleId in chunk)
                    {
                        await RunSideEffectsSequentiallyAsync(
                            () => _redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), articleId),
                            () => cache.RemoveAsync(CachePolicyId.ArticleDetail, articleId.ToString(), cancellationToken),
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

        try
        {
            string normalized = eventType.Trim().ToLowerInvariant();
            if (normalized is "deleted" or "permanently-deleted" or "trash-cleared")
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
                "created" => "Created",
                "restored" => "Restored",
                _ => "Updated"
            };

            if (!await RunEdgeAsync(ArticleMutationReplayEdges.SearchProjection, () => searchProjector.ProjectAsync(article))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.ArticleDetailAeds,
                        () => articleDetailArtifacts.GenerateAndStoreAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicHotRead,
                        async () =>
                        {
                            await QueuePublicHotUpdateAsync(articleId, $"outbox-{normalized}").ConfigureAwait(false);
                            if (normalized == "restored")
                            {
                                await _redis.SortedSetAddAsync(RedisKey("blog:top_articles"), articleId, article.Views)
                                    .ConfigureAwait(false);
                            }
                        })
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(ArticleMutationReplayEdges.Notification, () => realtimeNotifier.PushChangedAsync(articleId, action))
                    .ConfigureAwait(false))
            {
                return FailedResult();
            }

            return ArticleMutationReplayResult.Success(completedDuringReplay);
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
            if (!await RunEdgeAsync(ArticleMutationReplayEdges.SearchProjection, () => searchProjector.DeleteAsync(articleId))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.ArticleDetailAeds,
                        () => articleDetailArtifacts.RemoveAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicHotRead,
                        async () =>
                        {
                            await QueuePublicHotUpdateAsync(articleId, $"outbox-{normalized}").ConfigureAwait(false);
                            await _redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), articleId).ConfigureAwait(false);
                        })
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(ArticleMutationReplayEdges.Notification, () => realtimeNotifier.PushChangedAsync(articleId, "Deleted"))
                    .ConfigureAwait(false))
            {
                return FailedResult();
            }

            return ArticleMutationReplayResult.Success(completedDuringReplay);
        }

        async Task<ArticleMutationReplayResult> ReplayMissingArticleEdgesAsync(string normalized)
        {
            if (!await RunEdgeAsync(ArticleMutationReplayEdges.SearchProjection, () => searchProjector.DeleteAsync(articleId))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.ArticleDetailAeds,
                        () => articleDetailArtifacts.RemoveAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicHotRead,
                        async () =>
                        {
                            await QueuePublicHotUpdateAsync(articleId, $"outbox-{normalized}").ConfigureAwait(false);
                            await _redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), articleId).ConfigureAwait(false);
                        })
                    .ConfigureAwait(false))
            {
                return FailedResult();
            }

            return ArticleMutationReplayResult.Success(completedDuringReplay);
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

    private Task QueuePublicHotUpdateAsync(int? articleId, string reason)
    {
        if (!publicHotUpdates.TryEnqueue(articleId, reason))
        {
            logger.LogWarning("public-hot-read-update-enqueue-failed {ArticleId} {Reason}", articleId, reason);
        }

        return Task.CompletedTask;
    }
}
