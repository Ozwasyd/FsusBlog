using FsusBlog.Server.Infrastructure.Distributed;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// Coordinates preparation of ban-state delivery obligations and post-commit local application.
/// The caller owns the authority transaction and must commit before applying and publishing;
/// publication does not establish acknowledgement by every node.
/// </summary>
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

/// <summary>
/// Prepares the existing delivery-ledger outbox, applies committed facts to the local projection,
/// and attempts publication while retaining durable replay after publication failure.
/// This coordinator neither commits the caller's transaction nor owns a background queue.
/// </summary>
public sealed class BanStateProjectionObligationCoordinator(
    DistributedInvalidationEventFactory eventFactory,
    DistributedInvalidationOptions options,
    IDistributedInvalidationDeliveryLedger ledger,
    IDistributedInvalidationPublisher publisher,
    BanStateProjection projection,
    BanStateProjectionRuntimeState runtimeState) : IBanStateProjectionObligationCoordinator
{
    /// <summary>
    /// Sorts subject targets ordinally and prepares their outbox obligation in the caller's
    /// authority transaction. Successful preparation is not proof of commit or delivery.
    /// </summary>
    /// <param name="updates">Authority facts to include in the prepared event; must not be null.</param>
    /// <param name="cancellationToken">Cancellation passed to delivery-ledger preparation.</param>
    /// <returns>The prepared event, or null for empty updates or disabled distributed invalidation.</returns>
    /// <exception cref="ArgumentNullException">The updates collection is null.</exception>
    /// <exception cref="InvalidOperationException">Enabled invalidation has no configured topology.</exception>
    /// <remarks>Ledger failures propagate; the preparation counter advances only after preparation returns.</remarks>
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

    /// <summary>
    /// Applies committed updates locally before attempting publication of the prepared event.
    /// Invalid, conflicting or over-budget local updates abort before publication; earlier
    /// local applications are not rolled back. Stale and duplicate facts are accepted as converged.
    /// </summary>
    /// <param name="invalidation">The previously prepared event, or null for local-only application.</param>
    /// <param name="updates">Committed authority facts to apply in enumeration order; must not be null.</param>
    /// <param name="cancellationToken">Cancellation passed to publication, not to local application.</param>
    /// <returns>
    /// Null after local-only application; otherwise the publisher result. Publication exceptions,
    /// including cancellation, become a degraded result indicating pending durable replay.
    /// </returns>
    /// <exception cref="ArgumentNullException">The updates collection is null.</exception>
    /// <exception cref="InvalidOperationException">A local update is invalid, conflicting or over budget.</exception>
    /// <remarks>A publication result is not an all-node acknowledgement or completion of ledger replay.</remarks>
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
