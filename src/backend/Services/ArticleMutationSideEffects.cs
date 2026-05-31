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
                await Task.WhenAll(
                    searchProjector.ProjectAsync(article),
                    articleDetailArtifacts.GenerateAndStoreAsync(articleId),
                    QueuePublicHotUpdateAsync(articleId, "article-created"),
                    realtimeNotifier.PushChangedAsync(articleId, "Created", preview));
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

                await Task.WhenAll(
                    searchProjector.ProjectAsync(article),
                    articleDetailArtifacts.GenerateAndStoreAsync(articleId),
                    QueuePublicHotUpdateAsync(articleId, "article-updated"),
                    realtimeNotifier.PushChangedAsync(articleId, "Updated", preview));
            },
            "article-update-sync");

    public Task AfterDeletedAsync(int articleId)
        => ExecuteAsync(
            async () =>
            {
                await Task.WhenAll(
                    searchProjector.DeleteAsync(articleId),
                    articleDetailArtifacts.RemoveAsync(articleId),
                    QueuePublicHotUpdateAsync(articleId, "article-deleted"),
                    _redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), articleId),
                    realtimeNotifier.PushChangedAsync(articleId, "Deleted"));
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

                await Task.WhenAll(
                    searchProjector.ProjectAsync(article),
                    articleDetailArtifacts.GenerateAndStoreAsync(articleId),
                    QueuePublicHotUpdateAsync(articleId, "article-restored"),
                    _redis.SortedSetAddAsync(RedisKey("blog:top_articles"), articleId, article.Views),
                    realtimeNotifier.PushChangedAsync(articleId, "Restored", preview));
            },
            "article-restore-sync");

    public Task AfterPermanentlyDeletedAsync(int articleId, IEnumerable<string> imageUrls, CancellationToken cancellationToken)
        => ExecuteAsync(
            async () =>
            {
                await Task.WhenAll(
                    searchProjector.DeleteAsync(articleId),
                    articleDetailArtifacts.RemoveAsync(articleId),
                    QueuePublicHotUpdateAsync(articleId, "article-permanently-deleted"),
                    _redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), articleId),
                    realtimeNotifier.PushChangedAsync(articleId, "Deleted"));

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
                    var tasks = new List<Task>(chunk.Length * 3);
                    foreach (int articleId in chunk)
                    {
                        tasks.Add(_redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), articleId));
                        tasks.Add(cache.RemoveAsync(CachePolicyId.ArticleDetail, articleId.ToString(), cancellationToken));
                        tasks.Add(articleDetailArtifacts.RemoveAsync(articleId, cancellationToken));
                        tasks.Add(searchProjector.DeleteAsync(articleId));
                    }

                    await Task.WhenAll(tasks);
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

    private string RedisKey(string key)
        => runtimeKeyScope.PrefixKey(key);

    private Task QueuePublicHotUpdateAsync(int? articleId, string reason)
    {
        if (!publicHotUpdates.TryEnqueue(articleId, reason))
        {
            logger.LogWarning("public-hot-read-update-enqueue-failed {ArticleId} {Reason}", articleId, reason);
        }

        return Task.CompletedTask;
    }
}
