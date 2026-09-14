using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Infrastructure.Distributed;

public interface IArticleViewProjectionObligationCoordinator
{
    Task<DistributedInvalidationEvent?> PrepareAsync(
        IReadOnlyDictionary<int, int> authoritativeViews,
        CancellationToken cancellationToken = default);

    Task<DistributedInvalidationPublishResult?> PublishPreparedAsync(
        DistributedInvalidationEvent? invalidation,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Creates the exact durable event inside the caller's PostgreSQL transaction,
/// then publishes that same payload after commit. PostgreSQL remains the replay
/// truth when transport publication or the source process fails after commit.
/// </summary>
public sealed class ArticleViewProjectionObligationCoordinator(
    DistributedInvalidationEventFactory eventFactory,
    DistributedInvalidationOptions options,
    IDistributedInvalidationDeliveryLedger ledger,
    IDistributedInvalidationPublisher publisher) : IArticleViewProjectionObligationCoordinator
{
    public async Task<DistributedInvalidationEvent?> PrepareAsync(
        IReadOnlyDictionary<int, int> authoritativeViews,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(authoritativeViews);
        if (authoritativeViews.Count == 0 || !options.Enabled)
        {
            return null;
        }

        KeyValuePair<int, int>[] normalized = authoritativeViews
            .OrderBy(static pair => pair.Key)
            .ToArray();
        if (normalized.Any(static pair => pair.Key <= 0 || pair.Value <= 0))
        {
            throw new ArgumentOutOfRangeException(
                nameof(authoritativeViews),
                "Article view projection identities and values must be positive.");
        }

        var request = new DistributedInvalidationRequest(
            DistributedInvalidationEventKinds.ArticleViewProjection,
            [],
            [],
            normalized.Select(static pair =>
                DistributedInvalidationTargetResolver.FormatArticleViewProjectionTarget(
                    pair.Key,
                    pair.Value,
                    pair.Value)).ToArray());
        DistributedInvalidationEvent invalidation = eventFactory.Create(request);
        await ledger.PrepareOutboxAsync(
            invalidation,
            options.Topology ?? throw new InvalidOperationException("distributed_invalidation_topology_required"),
            cancellationToken).ConfigureAwait(false);
        return invalidation;
    }

    public Task<DistributedInvalidationPublishResult?> PublishPreparedAsync(
        DistributedInvalidationEvent? invalidation,
        CancellationToken cancellationToken = default)
        => invalidation is null
            ? Task.FromResult<DistributedInvalidationPublishResult?>(null)
            : PublishCoreAsync(invalidation, cancellationToken);

    private async Task<DistributedInvalidationPublishResult?> PublishCoreAsync(
        DistributedInvalidationEvent invalidation,
        CancellationToken cancellationToken)
        => await publisher.PublishPreparedAsync(invalidation, cancellationToken).ConfigureAwait(false);
}
