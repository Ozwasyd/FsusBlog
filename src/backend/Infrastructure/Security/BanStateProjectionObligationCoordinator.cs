using FsusBlog.Server.Infrastructure.Distributed;

namespace FsusBlog.Server.Infrastructure.Security;

public interface IBanStateProjectionObligationCoordinator
{
    Task<DistributedInvalidationEvent?> PrepareAsync(
        IReadOnlyCollection<BanStateProjectionUpdate> updates,
        CancellationToken cancellationToken = default);

    Task<DistributedInvalidationPublishResult?> ApplyLocalAndPublishPreparedAsync(
        DistributedInvalidationEvent? invalidation,
        IReadOnlyCollection<BanStateProjectionUpdate> updates,
        CancellationToken cancellationToken = default);
}

public sealed class BanStateProjectionObligationCoordinator(
    DistributedInvalidationEventFactory eventFactory,
    DistributedInvalidationOptions options,
    IDistributedInvalidationDeliveryLedger ledger,
    IDistributedInvalidationPublisher publisher,
    BanStateProjection projection,
    BanStateProjectionRuntimeState runtimeState) : IBanStateProjectionObligationCoordinator
{
    public async Task<DistributedInvalidationEvent?> PrepareAsync(
        IReadOnlyCollection<BanStateProjectionUpdate> updates,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(updates);
        if (updates.Count == 0 || !options.Enabled)
        {
            return null;
        }

        BanStateProjectionUpdate[] normalized = updates
            .OrderBy(static update => update.AccountSubjectHash, StringComparer.Ordinal)
            .ToArray();
        var request = new DistributedInvalidationRequest(
            DistributedInvalidationEventKinds.BanStateProjection,
            [],
            [],
            normalized.Select(DistributedInvalidationTargetResolver.FormatBanStateProjectionTarget).ToArray());
        DistributedInvalidationEvent invalidation = eventFactory.Create(request);
        await ledger.PrepareOutboxAsync(
            invalidation,
            options.Topology ?? throw new InvalidOperationException("distributed_invalidation_topology_required"),
            cancellationToken).ConfigureAwait(false);
        runtimeState.RecordDurablePrepared();
        return invalidation;
    }

    public async Task<DistributedInvalidationPublishResult?> ApplyLocalAndPublishPreparedAsync(
        DistributedInvalidationEvent? invalidation,
        IReadOnlyCollection<BanStateProjectionUpdate> updates,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(updates);
        foreach (BanStateProjectionUpdate update in updates)
        {
            BanStateProjectionApplyResult result = projection.Apply(update);
            if (result is BanStateProjectionApplyResult.RejectedInvalid
                or BanStateProjectionApplyResult.FailedClosedConflict
                or BanStateProjectionApplyResult.RejectedOverBudget)
            {
                throw new InvalidOperationException($"ban_projection_local_apply_failed:{result}");
            }
            runtimeState.RecordLocalMutation();
        }

        if (invalidation is null)
        {
            return null;
        }

        try
        {
            DistributedInvalidationPublishResult result = await publisher
                .PublishPreparedAsync(invalidation, cancellationToken)
                .ConfigureAwait(false);
            if (result.Status == DistributedInvalidationPublishStatus.Degraded)
            {
                runtimeState.RecordPublishFailure();
            }
            return result;
        }
        catch (Exception exception)
        {
            runtimeState.RecordPublishFailure();
            return new DistributedInvalidationPublishResult(
                DistributedInvalidationPublishStatus.Degraded,
                invalidation.EventId,
                $"durable_replay_pending:{exception.GetType().Name}",
                invalidation);
        }
    }
}
