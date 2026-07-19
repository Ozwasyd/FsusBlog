using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

namespace FsusBlog.Server.Services;

public interface IArticlePublicMutationFence
{
    Task BeginPublicMutationFenceAsync(int? articleId, CancellationToken cancellationToken = default);

    Task CommitPublicMutationFenceAsync(
        int? articleId,
        string reason,
        CancellationToken cancellationToken = default);

    Task CompleteArticleMutationFenceAsync(
        int articleId,
        CancellationToken cancellationToken = default);

    Task RecoverAbortedPublicMutationFenceAsync(
        int? articleId,
        string reason,
        CancellationToken cancellationToken = default);
}

public sealed class ArticlePublicMutationFence(
    IPublicMutationFenceLease mutationFenceLease,
    IPublicArtifactRevocationCoordinator publicArtifactRevocations,
    PublicHotArtifactUpdateQueue publicHotUpdates,
    ILogger<ArticlePublicMutationFence> logger) : IArticlePublicMutationFence
{
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
            await ReleaseAsync(lockKey).ConfigureAwait(false);
            throw;
        }
    }

    public Task CommitPublicMutationFenceAsync(
        int? articleId,
        string reason,
        CancellationToken cancellationToken = default)
        => PromoteAndReleaseAsync(articleId, reason, cancellationToken);

    public async Task CompleteArticleMutationFenceAsync(
        int articleId,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await publicArtifactRevocations
                .RevokeArticleAsync(articleId, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            await ReleaseAsync(articleId).ConfigureAwait(false);
        }
    }

    public Task RecoverAbortedPublicMutationFenceAsync(
        int? articleId,
        string reason,
        CancellationToken cancellationToken = default)
        => PromoteAndReleaseAsync(articleId, reason, cancellationToken);

    private async Task PromoteAndReleaseAsync(
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
            await ReleaseAsync(NormalizeFenceKey(articleId)).ConfigureAwait(false);
        }
    }

    private async Task ReleaseAsync(int articleId)
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
}
