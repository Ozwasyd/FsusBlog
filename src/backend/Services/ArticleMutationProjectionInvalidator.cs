using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Services.Taxonomy;

using StackExchange.Redis;

namespace FsusBlog.Server.Services;

public sealed class ArticleMutationProjectionInvalidator(
    IConnectionMultiplexer redisConnection,
    IRuntimeKeyScope runtimeKeyScope,
    ICacheInvalidationStore cache,
    ITaxonomyCountProjectionService taxonomyProjection,
    IArticleDetailAedsArtifactProjector articleDetailArtifacts,
    IPublicArtifactRevocationCoordinator publicArtifactRevocations,
    PublicHotArtifactUpdateQueue publicHotUpdates,
    ILogger<ArticleMutationProjectionInvalidator> logger)
{
    private readonly IDatabase _redis = redisConnection.GetDatabase();

    public Task RevokeArticleAsync(int articleId, CancellationToken cancellationToken = default)
        => publicArtifactRevocations.RevokeArticleAsync(articleId, cancellationToken);

    public Task RevokeAllAsync(CancellationToken cancellationToken = default)
        => publicArtifactRevocations.RevokeAllAsync(cancellationToken);

    public Task ReconcileTaxonomyAsync(int articleId, CancellationToken cancellationToken = default)
        => taxonomyProjection.ReconcileArticleAsync(articleId, cancellationToken);

    public Task GenerateDetailAsync(int articleId, CancellationToken cancellationToken = default)
        => articleDetailArtifacts.GenerateAndStoreAsync(articleId, cancellationToken);

    public Task GenerateDetailAsync(
        int articleId,
        ArticleMutationVersionReference version,
        CancellationToken cancellationToken = default)
        => articleDetailArtifacts is IVersionedArticleDetailAedsArtifactProjector versionedProjector
            ? versionedProjector.GenerateAndStoreAsync(articleId, version, cancellationToken)
            : articleDetailArtifacts.GenerateAndStoreAsync(articleId, cancellationToken);

    public Task RemoveDetailAsync(int articleId, CancellationToken cancellationToken = default)
        => articleDetailArtifacts.RemoveAsync(articleId, cancellationToken);

    public Task RemoveDetailCacheAsync(int articleId, CancellationToken cancellationToken = default)
        => cache.RemoveAsync(CachePolicyId.ArticleDetail, articleId, cancellationToken);

    public Task RemoveTopArticleAsync(int articleId)
        => _redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), articleId);

    public Task RestoreTopArticleAsync(int articleId, int views)
        => _redis.SortedSetAddAsync(RedisKey("blog:top_articles"), articleId, views);

    public Task<PublicHotArtifactEnqueueResult> QueuePublicHotUpdateAsync(
        int? articleId,
        string reason,
        bool required = false,
        long? expectedReleaseId = null)
    {
        PublicHotArtifactEnqueueResult result = publicHotUpdates.Enqueue(articleId, reason, expectedReleaseId);
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

    public async Task EnsurePublicHotUpdateQueuedAsync(
        int? articleId,
        string reason,
        long? expectedReleaseId = null)
    {
        PublicHotArtifactEnqueueResult result = await QueuePublicHotUpdateAsync(
                articleId,
                reason,
                required: true,
                expectedReleaseId: expectedReleaseId)
            .ConfigureAwait(false);
        if (!result.Accepted)
        {
            throw new InvalidOperationException($"public-hot-read update enqueue failed: {result.Status}");
        }
    }

    private string RedisKey(string key)
        => runtimeKeyScope.PrefixKey(key);
}
