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

    public async Task<PublicHotArtifactEnqueueResult> QueuePublicHotUpdateAsync(
        int? articleId,
        string reason,
        long? expectedReleaseId = null)
    {
        PublicHotArtifactEnqueueResult result = await publicHotUpdates.EnqueueAsync(
                PublicHotArtifactDeliveryClass.RequiredContent,
                articleId,
                reason,
                expectedReleaseId)
            .ConfigureAwait(false);
        PublicHotArtifactDeliveryReceipt.RequireDurable(result, $"public-hot-read-projection:{reason}");
        if (result.Status is PublicHotArtifactDeliveryStatus.PersistedDirty
            or PublicHotArtifactDeliveryStatus.Coalesced)
        {
            logger.LogInformation(
                "public-hot-projection-persisted-for-replay {Reason} {DeliveryStatus}",
                reason,
                result.Status);
        }

        return result;
    }

    public async Task EnsurePublicHotUpdateQueuedAsync(
        int? articleId,
        string reason,
        long? expectedReleaseId = null)
    {
        PublicHotArtifactEnqueueResult result = await QueuePublicHotUpdateAsync(
                articleId,
                reason,
                expectedReleaseId: expectedReleaseId)
            .ConfigureAwait(false);
        PublicHotArtifactDeliveryReceipt.RequireDurable(result, $"required-projection:{reason}");
    }

    private string RedisKey(string key)
        => runtimeKeyScope.PrefixKey(key);
}
