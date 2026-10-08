using System.Data.Common;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

internal sealed record DataScaleArticleBatchExecution(
    DataScaleBulkExecution Transport,
    DataScaleBatchCheckpoint? Checkpoint,
    bool AlreadyPresent,
    bool CleanupEligible)
{
    // Logical refs, native allocation provenance, admission and full semantic checks are separate gates.
    internal bool CompleteSeedAccepted => false;
}

/// <summary>Canonical physical batch host; no backend, cache, publication service or second SQL writer.</summary>
internal static class DataScaleArticleBatchWriter
{
    internal static async Task<DataScaleArticleBatchExecution> WriteAsync(
        DbConnection connection, DataScaleBulkProvider provider, DataScaleArticleBatchAuthority authority,
        DataScaleBatchCheckpoint? previous, ReadOnlyMemory<byte> taskKey,
        Func<DataScaleBatchCheckpoint, CancellationToken, Task> persistCheckpoint,
        CancellationToken cancellationToken)
    {
        DataScaleBatchCheckpointIdentity identity = authority.Identity(connection, provider);
        byte[] key = taskKey.ToArray();
        previous?.Validate(identity, key, DataScaleBatchCheckpointStage.Prepared,
            DataScaleBatchCheckpointStage.CommitPending, DataScaleBatchCheckpointStage.Committed,
            DataScaleBatchCheckpointStage.RolledBack);
        DataScaleBatchCheckpoint? saved = previous;
        bool present = false;
        DataScaleArticlePhysicalBatch batch = authority.Batch;
        if (DataScalePhysicalBatchReadback.ExpectedDigest(batch) != identity.PhysicalDigest)
        {
            throw new InvalidOperationException("batch_frozen_input_changed");
        }
        DataScaleArticlePhysicalWritePlan writes = DataScaleArticlePhysicalProjection.PrepareWrites(batch);
        async Task Save(DataScaleBatchCheckpointStage stage, CancellationToken token)
        {
            DataScaleBatchCheckpoint next = DataScaleBatchCheckpoint.Seal(identity, stage, key);
            await persistCheckpoint(next, token).ConfigureAwait(false);
            saved = next;
        }
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, provider, writes.Inserts, writes.DeferredUpdates, identity.PhysicalDigest,
            async (db, transaction, token) =>
            {
                DataScaleBulkPostconditions observed = await DataScalePhysicalBatchReadback.ObserveAsync(
                    db, transaction, provider, batch, token).ConfigureAwait(false);
                if (!present && observed.Violations.Count == 0 && observed.SemanticDigest == identity.PhysicalDigest)
                {
                    // Durable intent precedes commit; a missing terminal is never a fabricated acknowledgement.
                    await Save(DataScaleBatchCheckpointStage.CommitPending, token).ConfigureAwait(false);
                }
                return observed;
            },
            async (db, transaction, token) =>
            {
                DataScalePhysicalRecoveryObservation observed = await DataScalePhysicalBatchReadback.ObserveRecoveryAsync(
                    db, transaction, provider, batch, token).ConfigureAwait(false);
                if (observed.State == DataScalePhysicalRecoveryState.Exact
                    && previous?.Stage is DataScaleBatchCheckpointStage.Committed or DataScaleBatchCheckpointStage.CommitPending)
                {
                    present = true;
                    return false;
                }
                if (observed.State != DataScalePhysicalRecoveryState.Empty
                    || previous?.Stage == DataScaleBatchCheckpointStage.Committed)
                {
                    throw new InvalidOperationException("batch_recovery_conflict_or_terminal_drift");
                }
                await Save(DataScaleBatchCheckpointStage.Prepared, token).ConfigureAwait(false);
                return true;
            }, cancellationToken).ConfigureAwait(false);
        if (result.State == DataScaleBulkCommitState.Committed && !present)
        {
            // Caller cancellation after commit must not erase the known acknowledgement.
            using var publication = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            try
            {
                await Save(DataScaleBatchCheckpointStage.Committed, publication.Token).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Retain CommitPending: its exact rows can be observed, but cleanup stays refused.
                return new(result, saved, false, false);
            }
        }
        else if (result.State == DataScaleBulkCommitState.RolledBack && !present
            && saved?.Stage is DataScaleBatchCheckpointStage.Prepared or DataScaleBatchCheckpointStage.CommitPending)
        {
            using var publication = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            try
            {
                await Save(DataScaleBatchCheckpointStage.RolledBack, publication.Token).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Retain the previously durable intent; failed publication is not a false terminal.
            }
        }
        return new(result, saved, present,
            result.State == DataScaleBulkCommitState.Committed && saved?.Stage == DataScaleBatchCheckpointStage.Committed);
    }

    // Validation alone never deletes. CommitPending/unknown acknowledgement cannot gain cleanup custody.
    internal static async Task<DataScalePhysicalRecoveryObservation> ValidateCleanupAsync(
        DbConnection connection, DbTransaction transaction, DataScaleBulkProvider provider,
        DataScaleArticleBatchAuthority authority, DataScaleBatchCheckpoint checkpoint,
        ReadOnlyMemory<byte> taskKey, CancellationToken cancellationToken)
    {
        checkpoint.Validate(authority.Identity(connection, provider), taskKey.Span, DataScaleBatchCheckpointStage.Committed);
        if (DataScalePhysicalBatchReadback.ExpectedDigest(authority.Batch) != checkpoint.Identity.PhysicalDigest)
        {
            throw new InvalidOperationException("batch_frozen_input_changed");
        }
        DataScalePhysicalRecoveryObservation observed = await DataScalePhysicalBatchReadback.ObserveRecoveryAsync(
            connection, transaction, provider, authority.Batch, cancellationToken).ConfigureAwait(false);
        if (observed.State != DataScalePhysicalRecoveryState.Exact)
        {
            throw new InvalidOperationException("cleanup_owned_graph_not_exact");
        }
        return observed;
    }
}
