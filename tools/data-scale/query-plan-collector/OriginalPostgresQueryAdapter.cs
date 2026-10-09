#if QUERY_PRODUCER_INTAKE_LINKED
using System.Data.Common;

using FsusBlog.QueryEvidence;
using FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>Consumes the original callback tuple; never allocates, writes or reconstructs its inputs.</summary>
internal static class OriginalPostgresQueryAdapter
{
    // This exact delegate can be supplied to the original ProduceAndConsumeResolvedAsync.
    // The caller retains its original pre-sealing batch and independently supplied business clock.
    internal static Func<DataScalePostgresArticleProduction, ArticleScalePlan, ArticleScaleResolvedGraphBatch,
        DbConnection, DataScaleBatchCheckpointIdentity, ReadOnlyMemory<byte>, string, CancellationToken,
        Task<IReadOnlyList<ResolvedExpectedArticle>>> CreateExpectedConsumer(
        DataScaleBatchCheckpointStore store, IReadOnlyList<ArticleScaleArticleGraph> factoryBatch, DateTime businessEpochUtc)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(factoryBatch);
        if (businessEpochUtc.Kind != DateTimeKind.Utc)
        {
            throw new InvalidOperationException("query_expected_business_epoch_not_utc");
        }
        if (factoryBatch.Count is < 1 or > 1000)
        {
            throw new InvalidOperationException("query_expected_factory_batch_bound_invalid");
        }
        var coordinates = Array.AsReadOnly(factoryBatch.ToArray());
        return async (production, plan, resolved, live, current, key, allocationEvidence, token) =>
        {
            QueryPostgresProducerInspection inspection = await InspectHandoffAsync(store,
                production, plan, resolved, live, current, key, allocationEvidence, token).ConfigureAwait(false);
            // Even genuinely matched components retain the original admission refusal.
            // No actual production graph or HTTP payload is used as expected content.
            inspection.ThrowBeforeQueryExecution();
            return CanonicalQueryExpectedArticles.ProjectResolvedBatch(plan, coordinates, resolved,
                production.NativeBindings, businessEpochUtc);
        };
    }

    internal static async Task<QueryPostgresProducerInspection> InspectHandoffAsync(
        DataScaleBatchCheckpointStore store, DataScalePostgresArticleProduction production,
        ArticleScalePlan plan, ArticleScaleResolvedGraphBatch resolved, DbConnection live,
        DataScaleBatchCheckpointIdentity current, ReadOnlyMemory<byte> key, string allocationEvidence,
        CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(production);
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(resolved);
        ArgumentNullException.ThrowIfNull(live);
        ArgumentNullException.ThrowIfNull(current);
        ArgumentException.ThrowIfNullOrWhiteSpace(allocationEvidence);
        // Reopen the original exact-address files. A digest or callback success is not admission.
        await store.VerifyNativeAllocationEvidenceAsync(allocationEvidence, production.NativeAllocation,
            production.NativeBindings, token).ConfigureAwait(false);
        DataScaleBatchCheckpoint checkpoint = production.Execution.Checkpoint
            ?? throw new InvalidOperationException("article_producer_committed_checkpoint_missing");
        DataScaleBatchCheckpoint persisted = await store.ReadAsync(checkpoint.Signature, current, key, token).ConfigureAwait(false);
        persisted.Validate(current, key.Span, DataScaleBatchCheckpointStage.Committed);
        token.ThrowIfCancellationRequested();
        return QueryPostgresProducerIntake.Inspect(production, plan, resolved, live, current, key.Span);
    }
}
#endif
