using System.Data.Common;
using System.Text.Json;

using SqlSugar;

namespace FsusBlog.Migration;

public sealed record OfflineMigrationExecutionResult(
    string Status,
    OfflineMigrationPhase? Phase,
    IReadOnlyList<string> MigrationIds,
    IReadOnlyList<string> Codes);

internal static class OfflineMigrationExecutor
{
    private const int MaximumBackfillBatches = 100;

    public static async Task<OfflineMigrationExecutionResult> RunAsync(
        OfflineMigrationCommandOptions command,
        string connectionString,
        string releaseId,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors =
            SchemaMigrationManifest.Current.Descriptors;
        IReadOnlyDictionary<string, OfflineMigrationClassification> classifications =
            OfflineMigrationCatalogEntries.Classifications;

        string[] unclassified = descriptors
            .Where(descriptor => !classifications.ContainsKey(descriptor.MigrationId))
            .Select(static descriptor => descriptor.MigrationId)
            .ToArray();
        if (unclassified.Length > 0)
        {
            return Failed(command.Phase, unclassified.Select(static id => $"schema_offline_catalog_missing:{id}"));
        }

        using ISqlSugarClient db = OfflineMigrationHost.CreateDatabase(connectionString);
        bool lockHeld = false;
        try
        {
            if (!command.DryRun && command.Phase != OfflineMigrationPhase.Contract)
            {
                lockHeld = await AcquireLockAsync(db, cancellationToken).ConfigureAwait(false);
                if (!lockHeld)
                {
                    return Failed(command.Phase, ["schema_offline_lock_busy"]);
                }

                await OfflineMigrationStateStore.EnsureControlTablesAsync(db, cancellationToken).ConfigureAwait(false);
            }

            IReadOnlySet<string> applied =
                await OfflineMigrationStateStore.ReadAppliedMigrationIdsAsync(db, cancellationToken).ConfigureAwait(false);

            return command.Phase switch
            {
                OfflineMigrationPhase.Expand => await ExecuteExpandAsync(
                    command,
                    descriptors,
                    classifications,
                    applied,
                    db,
                    releaseId,
                    cancellationToken).ConfigureAwait(false),
                OfflineMigrationPhase.Backfill => await ExecuteBackfillAsync(
                    command,
                    classifications,
                    applied,
                    db,
                    cancellationToken).ConfigureAwait(false),
                // Contract requires the backup-evidence gate (fresh backup age,
                // n-1 verification, no slot switch in progress). That gate has
                // not been ported to the offline host yet, so the phase fails
                // closed rather than executing destructive work unguarded.
                OfflineMigrationPhase.Contract => Failed(command.Phase, ["schema_offline_contract_not_supported"]),
                _ => Failed(command.Phase, ["schema_offline_phase_invalid"])
            };
        }
        finally
        {
            if (lockHeld)
            {
                await ReleaseLockAsync(db).ConfigureAwait(false);
            }
        }
    }

    private static async Task<OfflineMigrationExecutionResult> ExecuteExpandAsync(
        OfflineMigrationCommandOptions command,
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors,
        IReadOnlyDictionary<string, OfflineMigrationClassification> classifications,
        IReadOnlySet<string> applied,
        ISqlSugarClient db,
        string releaseId,
        CancellationToken cancellationToken)
    {
        OfflineMigrationClassification[] legacyPending = descriptors
            .Where(descriptor =>
                !applied.Contains(descriptor.MigrationId)
                && classifications[descriptor.MigrationId].LegacyBootstrapOnly)
            .Select(descriptor => classifications[descriptor.MigrationId])
            .ToArray();
        if (legacyPending.Length > 0)
        {
            return Failed(
                command.Phase,
                legacyPending.Select(static item => $"schema_legacy_bootstrap_required:{item.MigrationId}"));
        }

        ISchemaMigrationDescriptor[] selected = descriptors
            .Where(descriptor =>
                !applied.Contains(descriptor.MigrationId)
                && classifications[descriptor.MigrationId].Phase == OfflineMigrationPhase.Expand)
            .ToArray();

        string[] destructive = selected
            .Where(descriptor => descriptor.Steps.Any(static step => step is DropColumnStep or DropTableStep))
            .Select(static descriptor => descriptor.MigrationId)
            .ToArray();
        if (destructive.Length > 0)
        {
            return Failed(
                command.Phase,
                destructive.Select(static id => $"schema_expand_destructive_operation:{id}"));
        }

        if (command.DryRun)
        {
            return new OfflineMigrationExecutionResult(
                "dry_run",
                command.Phase,
                selected.Select(static descriptor => descriptor.MigrationId).ToArray(),
                []);
        }

        foreach (ISchemaMigrationDescriptor descriptor in selected)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                DestructiveMigrationProofs.ValidateDescriptor(
                    descriptor,
                    DateTimeOffset.UtcNow,
                    freshBootstrap: false);
                await SchemaMigrationTransactionExecutor.ExecuteAsync(
                    db,
                    descriptor,
                    (step, token) => step.ExecuteAsync(db, token),
                    cancellationToken).ConfigureAwait(false);
                await OfflineMigrationStateStore.MarkAppliedAsync(
                    db,
                    descriptor.MigrationId,
                    descriptor.Checksum,
                    releaseId,
                    succeeded: true,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                try
                {
                    await OfflineMigrationStateStore.MarkAppliedAsync(
                        db,
                        descriptor.MigrationId,
                        descriptor.Checksum,
                        releaseId,
                        succeeded: false,
                        cancellationToken).ConfigureAwait(false);
                }
                catch
                {
                    // Preserve the original failure as the reported code.
                }

                throw new InvalidOperationException(
                    $"schema_offline_migration_failed:{descriptor.MigrationId}",
                    exception);
            }
        }

        return new OfflineMigrationExecutionResult(
            "ok",
            command.Phase,
            selected.Select(static descriptor => descriptor.MigrationId).ToArray(),
            []);
    }

    private static async Task<OfflineMigrationExecutionResult> ExecuteBackfillAsync(
        OfflineMigrationCommandOptions command,
        IReadOnlyDictionary<string, OfflineMigrationClassification> classifications,
        IReadOnlySet<string> applied,
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        string migrationId = command.MigrationId!;
        if (!classifications.TryGetValue(migrationId, out OfflineMigrationClassification? classification)
            || classification.Phase != OfflineMigrationPhase.Backfill)
        {
            return Failed(command.Phase, [$"schema_migration_not_found_for_phase:{migrationId}"]);
        }

        if (applied.Contains(migrationId))
        {
            return new OfflineMigrationExecutionResult("ok", command.Phase, [migrationId], []);
        }

        if (migrationId == AccountSubjectHashOnlineBackfillHandler.BackfillMigrationId)
        {
            var handler = new AccountSubjectHashOnlineBackfillHandler(db);
            return await ExecuteBackfillBatchesAsync(
                command,
                classification,
                migrationId,
                handler,
                db,
                cancellationToken).ConfigureAwait(false);
        }

        return Failed(command.Phase, [$"schema_backfill_handler_missing:{migrationId}"]);
    }

    private static async Task<OfflineMigrationExecutionResult> ExecuteBackfillBatchesAsync(
        OfflineMigrationCommandOptions command,
        OfflineMigrationClassification classification,
        string migrationId,
        IOnlineSchemaBackfillHandler handler,
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        if (command.DryRun)
        {
            return new OfflineMigrationExecutionResult("dry_run", command.Phase, [migrationId], []);
        }

        OfflineMigrationStateStore.BackfillSnapshot? snapshot =
            await OfflineMigrationStateStore.ReadBackfillAsync(db, migrationId, cancellationToken).ConfigureAwait(false);
        string? resumeToken = snapshot?.ResumeToken;
        long rowsProcessed = snapshot?.RowsProcessed ?? 0;
        long failureCount = snapshot?.FailureCount ?? 0;
        int batchSize = classification.BatchSize ?? 1000;

        for (int batchNumber = 0; batchNumber < MaximumBackfillBatches; batchNumber++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            OnlineSchemaBackfillBatchResult batch;
            try
            {
                batch = await handler.ExecuteBatchAsync(resumeToken, batchSize, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                await OfflineMigrationStateStore.SaveBackfillAsync(
                    db,
                    new OfflineMigrationStateStore.BackfillSnapshot(
                        migrationId,
                        "failed",
                        resumeToken,
                        rowsProcessed,
                        failureCount + 1,
                        DateTimeOffset.UtcNow),
                    cancellationToken).ConfigureAwait(false);
                throw new InvalidOperationException(
                    $"schema_offline_backfill_failed:{migrationId}",
                    exception);
            }

            if (!batch.Complete && batch.RowsProcessed <= 0
                && string.Equals(batch.ResumeToken, resumeToken, StringComparison.Ordinal))
            {
                return Failed(command.Phase, ["schema_backfill_no_progress"]);
            }

            rowsProcessed += batch.RowsProcessed;
            resumeToken = batch.ResumeToken;
            await OfflineMigrationStateStore.SaveBackfillAsync(
                db,
                new OfflineMigrationStateStore.BackfillSnapshot(
                    migrationId,
                    "running",
                    resumeToken,
                    rowsProcessed,
                    failureCount,
                    DateTimeOffset.UtcNow),
                cancellationToken).ConfigureAwait(false);

            if (!batch.Complete)
            {
                continue;
            }

            bool verified = await handler.VerifyAsync(cancellationToken).ConfigureAwait(false);
            await OfflineMigrationStateStore.SaveBackfillAsync(
                db,
                new OfflineMigrationStateStore.BackfillSnapshot(
                    migrationId,
                    verified ? "completed" : "verification_failed",
                    resumeToken,
                    rowsProcessed,
                    verified ? failureCount : failureCount + 1,
                    DateTimeOffset.UtcNow,
                    verified ? DateTimeOffset.UtcNow : null),
                cancellationToken).ConfigureAwait(false);
            if (!verified)
            {
                return Failed(command.Phase, ["schema_backfill_verification_failed"]);
            }

            return new OfflineMigrationExecutionResult("ok", command.Phase, [migrationId], []);
        }

        return new OfflineMigrationExecutionResult("paused", command.Phase, [migrationId], []);
    }

    private static async Task<bool> AcquireLockAsync(ISqlSugarClient db, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT pg_try_advisory_lock(hashtext(@name))",
            new SugarParameter[] { new SugarParameter("@name", OfflineMigrationHost.StateLockConstant) }).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return false;
        }

        return reader.GetBoolean(0);
    }

    private static async Task ReleaseLockAsync(ISqlSugarClient db)
        => await db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_unlock(hashtext(@name))",
            new SugarParameter[] { new SugarParameter("@name", OfflineMigrationHost.StateLockConstant) }).ConfigureAwait(false);

    private static OfflineMigrationExecutionResult Failed(
        OfflineMigrationPhase phase,
        IEnumerable<string> codes)
        => new("failed", phase, [], [.. codes]);
}
