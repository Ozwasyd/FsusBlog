using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Modules.Endpoints.Binary;

namespace FsusBlog.Server.Infrastructure.Testing;

internal sealed record RuntimeCacheChurnDeliveryObservation(
    BinaryEndpoints.CategoryMutationReceipt Mutation,
    PublicHotArtifactObligation Obligation,
    string ObservedScope,
    bool ExactObligationPublished)
{
    // An exact delivery completion is only one postcondition. Neither this
    // store nor the mutation helper issues a business-epoch or artifact binding.
    internal string? BusinessEpochBinding => null;
    internal string? CommonGenerationBinding => null;
    internal bool CountsAsReleaseFinal => false;
}

internal static class RuntimeCacheChurnDeliveryBinding
{
    internal static async Task<RuntimeCacheChurnDeliveryObservation> ObserveAsync(
        BinaryEndpoints.CategoryMutationReceipt mutation,
        IPublicHotArtifactObligationStore obligations,
        IRuntimeKeyScope runtimeKeyScope,
        string testNamespace,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(mutation);
        ArgumentNullException.ThrowIfNull(obligations);
        ArgumentNullException.ThrowIfNull(runtimeKeyScope);
        cancellationToken.ThrowIfCancellationRequested();
        if (!HttpTestSessionKeyScope.IsValidSessionId(testNamespace)
            || runtimeKeyScope.ScopeToken != testNamespace)
        {
            throw new InvalidOperationException("cache_churn_delivery_scope_mismatch");
        }
        if (mutation.Outcome is not (BinaryEndpoints.CategoryMutationOutcome.Created or BinaryEndpoints.CategoryMutationOutcome.Deleted)
            || mutation.CategoryId <= 0 || string.IsNullOrWhiteSpace(mutation.MutationId)
            || mutation.Delivery is not PublicHotArtifactEnqueueResult enqueue
            || !BinaryEndpoints.IsRequiredTaxonomyDeliveryDurable(enqueue)
            || enqueue.DeliveryGeneration <= 0 || string.IsNullOrWhiteSpace(enqueue.ObligationId))
        {
            throw new InvalidOperationException("cache_churn_mutation_delivery_receipt_unavailable");
        }

        // Read the canonical store only. A later/coalesced active record cannot
        // substitute for the exact target retained by this business mutation.
        PublicHotArtifactObligation obligation = await obligations.GetActiveAsync(cancellationToken)
            ?? throw new InvalidOperationException("cache_churn_exact_obligation_unavailable");
        if (obligation.ObligationId != enqueue.ObligationId
            || obligation.TargetGeneration != enqueue.DeliveryGeneration
            || !obligation.RequiresFullRebuild)
        {
            throw new InvalidOperationException("cache_churn_exact_obligation_binding_mismatch");
        }
        if (obligation.State is not (PublicHotArtifactObligationState.Pending
                or PublicHotArtifactObligationState.Processing or PublicHotArtifactObligationState.Published)
            || obligation.AttemptNumber is < 0 or > 1
            || obligation.LastFailureKind != PublicHotArtifactFailureKind.None
            || obligation.Attempts.Any(static attempt => attempt.AttemptNumber != 1
                || attempt.FailureKind != PublicHotArtifactFailureKind.None))
        {
            throw new InvalidOperationException("cache_churn_obligation_attempt_failed");
        }
        bool published = obligation.State == PublicHotArtifactObligationState.Published;
        if (published && (obligation.AttemptNumber != 1
            || obligation.PublishedGeneration != enqueue.DeliveryGeneration
            || !Enum.GetValues<PublicHotArtifactAttemptStage>().All(stage =>
                obligation.Attempts.Any(attempt => attempt.Stage == stage))))
        {
            throw new InvalidOperationException("cache_churn_exact_obligation_publication_incomplete");
        }
        return new(mutation, obligation, runtimeKeyScope.ScopeToken, published);
    }
}
