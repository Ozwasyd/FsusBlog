using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Text.Json;
using System.Text.RegularExpressions;

using SqlSugar;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

public sealed record OfflineMigrationExecutionResult(
    string Status,
    OfflineMigrationPhase? Phase,
    IReadOnlyList<string> MigrationIds,
    IReadOnlyList<string> Codes);

internal static class OfflineMigrationExecutor
{
    private const int MaximumBackfillBatches = 100;

    private static readonly string[] s_destructiveSqlTokens =
    [
        " DROP COLUMN ",
        " DROP TABLE ",
        " DROP INDEX ",
        " RENAME COLUMN ",
        " RENAME TO ",
        " SET NOT NULL",
        " ALTER COLUMN ",
        " TRUNCATE ",
        " DELETE FROM "
    ];

    // This is the existing domain executor's sealed route, not the historical online
    // Contract phase. CLI integration remains blocked until real operation owners exist.
    internal static async Task<OfflineMigrationApplyResult> ApplyAsync(
        VerifiedOfflineMigrationPlan verified, CurrentSchemaArtifactReference artifact,
        OfflineMigrationApplyRequest request, DbConnection connection,
        IOfflineMigrationPlanAdmission admission, IOfflineMigrationApplyOperationRegistry registry,
        CancellationToken cancellationToken, OfflineMigrationPostgreSqlWriteLock? postgreSqlWriteLock = null,
        OfflineMigrationApplyHooks? hooks = null)
    {
        OfflineMigrationPlan plan = verified.Plan;
        OfflineMigrationApplyJournalVerifier progress;
        try
        {
            progress = new OfflineMigrationApplyJournalVerifier(plan, artifact, request.InvocationId);
        }
        catch (InvalidOperationException)
        {
            return new(OfflineMigrationApplyStatus.Failed, artifact, plan.ContentDigest, plan.Source.Database, null, [],
                ["offline_apply_plan_binding_invalid"]);
        }
        if (!OfflineMigrationApplyNativeSession.ConnectionMatches(connection, plan.Source.Database.Provider))
        {
            return Result(OfflineMigrationApplyStatus.Failed, "offline_apply_native_connection_mismatch");
        }

        if (connection.State != ConnectionState.Open || request.Attempt < 1
            || request.InvocationId.Length > 160 || request.InvocationId.Any(char.IsControl)
            || (plan.OrderedSteps.Any(step => step.Destructive) && !request.ConfirmDestructive))
        {
            return Result(OfflineMigrationApplyStatus.Failed, "offline_apply_admission_options_invalid");
        }

        if (request.CleanupBudget is not { } cleanupBudget || cleanupBudget <= TimeSpan.Zero)
        {
            return Result(OfflineMigrationApplyStatus.Failed, "offline_apply_cleanup_budget_required");
        }

        try
        {
            // Use the runtime timer's actual supported range, not an invented migration
            // throughput/test-policy threshold. Missing/infinite budgets are never admitted.
            using var budgetValidation = new CancellationTokenSource(cleanupBudget);
        }
        catch (ArgumentOutOfRangeException)
        {
            return Result(OfflineMigrationApplyStatus.Failed, "offline_apply_cleanup_budget_invalid");
        }

        bool locked = false;
        bool commitUnknown = false;
        bool started = false;
        bool admissionWritesStarted = false;
        var operations = new Dictionary<string, OfflineMigrationApplyOperation>(StringComparer.Ordinal);
        var cleanupCodes = new List<string>();
        Exception? firstFailure = null;
        string? firstFailureCode = null;
        bool transactionBodyCompleted = false;
        void RememberFirstFailure(Exception failure)
        {
            if (failure.Data[OfflineMigrationStateStore.JournalCleanupFailuresKey]
                is "offline_apply_journal_command_disposal_failed")
                cleanupCodes.Add("offline_apply_journal_command_disposal_failed");
            if (failure.Data[OfflineMigrationApplyNativeSession.OwnedScopeCleanupFailuresKey]
                is "offline_apply_owned_scope_cleanup_failed")
                cleanupCodes.Add("offline_apply_owned_scope_cleanup_failed");
            if (firstFailure is null)
            {
                firstFailure = failure;
                firstFailureCode = failure is OperationCanceledException && cancellationToken.IsCancellationRequested
                    ? "offline_apply_cancelled" : "offline_apply_rejected";
            }
        }
        CancellationTokenSource? cleanupCancellation = null;
        CancellationToken CleanupToken()
        {
            // One independent deadline for all cleanup work, beginning at its first boundary,
            // not a new timeout per statement and not linked to the cancelled main request.
            cleanupCancellation ??= new CancellationTokenSource(cleanupBudget);
            return cleanupCancellation.Token;
        }
        var native = new OfflineMigrationApplyNativeSession(connection, plan.Source.Database.Provider,
            cancellationToken, CleanupToken, postgreSqlWriteLock, hooks);

        Task RevalidateAdmissionAsync(DbTransaction transaction)
            => native.SupportsOwnedReadContext
                ? native.WithOwnedReadScopeAsync(transaction, (context, token) =>
                    admission.RevalidateAsync(verified, artifact, progress, context, token), cancellationToken)
                : admission.RevalidateAsync(verified, artifact, progress, connection, transaction, cancellationToken);
        ValueTask<DbTransaction> BeginAdmissionAsync()
            => native.SupportsOwnedReadContext ? native.BeginOwnedReadAsync(cancellationToken)
                : native.BeginAsync(cancellationToken); // Original non-native fixtures do not mint native read authority.

        async Task<OfflineMigrationApplyResult> ExecuteCoreAsync()
        {
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                locked = await native.AcquireAsync(cancellationToken).ConfigureAwait(false);

                if (!locked)
                {
                    return Result(OfflineMigrationApplyStatus.Failed, "offline_apply_lock_busy");
                }

                // Resolve the entire compiled provider closure before journal/control/business
                // writes. The registry cannot add ad-hoc SQL from a plan or CLI argument.
                progress.BindOperationOwners(registry);
                foreach (OfflineMigrationStep step in plan.OrderedSteps)
                {
                    foreach (OfflineMigrationProviderOperation identity in step.Operations)
                    {
                        OfflineMigrationApplyOperation resolved = registry.Resolve(step, identity);
                        if (resolved.Identity != identity)
                        {
                            throw new InvalidOperationException("offline_apply_operation_binding_changed");
                        }

                        if (identity.Provider == plan.Source.Database.Provider)
                        {
                            resolved.RequireAtomicNativeExecution();
                            if ((resolved is OfflineMigrationArticleMediaOperation) != progress.RequiresMedia(step.StepId))
                                throw new InvalidOperationException("offline_apply_operation_binding_changed");
                            operations.Add(step.StepId, resolved);
                        }
                    }
                }

                await using (DbTransaction admissionTransaction = await BeginAdmissionAsync().ConfigureAwait(false))
                {
                    try
                    {
                        await OfflineMigrationStateStore.ReadApplyJournalAsync(connection, admissionTransaction,
                            plan.ContentDigest, plan.Source.Database, request, progress, cancellationToken).ConfigureAwait(false);
                        await RevalidateAdmissionAsync(admissionTransaction).ConfigureAwait(false);
                        await VerifyRecordedStepsAsync(admissionTransaction).ConfigureAwait(false);
                        if (progress.Completed)
                        {
                            await admissionTransaction.RollbackAsync(CleanupToken()).ConfigureAwait(false);
                            transactionBodyCompleted = true;
                            return Result(OfflineMigrationApplyStatus.NoOpVerified);
                        }

                        int previousAttempt = progress.Last?.Attempt ?? 0;
                        if (request.Attempt != previousAttempt + 1)
                        {
                            throw new InvalidOperationException("offline_apply_attempt_not_successor");
                        }

                        OfflineMigrationApplyJournalVerifier staged = progress.Fork();
                        admissionWritesStarted = true;
                        await OfflineMigrationStateStore.EnsureApplyJournalAsync(connection, admissionTransaction,
                            cancellationToken).ConfigureAwait(false);
                        if (progress.Last is
                            {
                                State: OfflineMigrationApplyJournalState.AttemptStarted
                            or OfflineMigrationApplyJournalState.TransactionCommitted
                            or OfflineMigrationApplyJournalState.BatchCommitted
                            or OfflineMigrationApplyJournalState.StepVerified
                            or OfflineMigrationApplyJournalState.MediaPrepared
                            or OfflineMigrationApplyJournalState.MediaPublished
                            } interrupted)
                        {
                            await AppendAsync(staged, admissionTransaction, Control(staged,
                                OfflineMigrationApplyJournalState.RecoveryRequired, interrupted.Attempt,
                                "offline_apply_prior_attempt_interrupted"), cancellationToken).ConfigureAwait(false);
                        }

                        await AppendAsync(staged, admissionTransaction, Control(staged,
                            OfflineMigrationApplyJournalState.AttemptStarted, request.Attempt), cancellationToken).ConfigureAwait(false);
                        cancellationToken.ThrowIfCancellationRequested();
                        commitUnknown = true;
                        await admissionTransaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                        commitUnknown = false;
                        progress = staged;
                        started = true;
                        admissionWritesStarted = false;
                        transactionBodyCompleted = true;
                    }
                    catch (Exception originalFailure)
                    {
                        RememberFirstFailure(originalFailure);
                        throw;
                    }
                }

                while (progress.StepProofs.Length < plan.OrderedSteps.Length)
                {
                    transactionBodyCompleted = false;
                    cancellationToken.ThrowIfCancellationRequested();
                    OfflineMigrationStep step = plan.OrderedSteps[progress.StepProofs.Length];
                    OfflineMigrationProviderOperation identity = step.Operations.Single(
                        value => value.Provider == plan.Source.Database.Provider);
                    OfflineMigrationApplyOperation operation = operations[step.StepId];
                    if (operation is OfflineMigrationArticleMediaOperation mediaOperation
                        && progress.PendingMedia is null && progress.PendingUnit is null)
                    {
                        // Durable preparation precedes filesystem publication and graph writes.
                        // Only Core opens/commits this transaction on its original locked session.
                        await PrepareMediaAsync(step, mediaOperation).ConfigureAwait(false);
                        transactionBodyCompleted = false;
                    }
                    await using DbTransaction transaction = await BeginAdmissionAsync().ConfigureAwait(false);
                    try
                    {
                        await RevalidateAdmissionAsync(transaction).ConfigureAwait(false);
                        OfflineMigrationApplyJournalVerifier staged = progress.Fork();
                        OfflineMigrationApplyJournalEntry? previousUnit = progress.PendingUnit;
                        string beforePredicate = previousUnit is null ? step.SourcePrecondition
                            : previousUnit.UnitComplete ? step.TargetPostcondition : step.ResumePolicy.ReplayPostcondition;
                        OfflineMigrationPredicateObservation before = await operation.ObserveAsync(beforePredicate,
                            connection, transaction, cancellationToken).ConfigureAwait(false);
                        ValidateObservation(before, beforePredicate, identity);
                        if (previousUnit?.UnitComplete == true)
                        {
                            // The final unit committed before interruption. Verify actual target
                            // facts, then append only the missing step proof; do not repeat effects.
                            OfflineMigrationApplyJournalEntry proof = previousUnit with
                            {
                                Sequence = (staged.Last?.Sequence ?? 0) + 1,
                                Attempt = request.Attempt,
                                State = OfflineMigrationApplyJournalState.StepVerified,
                                Before = before,
                                After = before,
                                PreviousDigest = staged.Last?.ContentDigest ?? OfflineMigrationApplyJournalVerifier.GenesisDigest,
                                ContentDigest = string.Empty,
                                RecordedAt = DateTimeOffset.UtcNow
                            };
                            await AppendAsync(staged, transaction, proof, cancellationToken).ConfigureAwait(false);
                        }
                        else
                        {
                            OfflineMigrationMediaJournalEvidence? mediaEvidence = null;
                            OfflineMigrationApplyUnit unit;
                            if (operation is OfflineMigrationArticleMediaOperation actualMedia)
                            {
                                OfflineMigrationMediaJournalEvidence binding = await actualMedia.GetMediaBindingAsync(
                                    verified, artifact, request.InvocationId, connection, transaction, cancellationToken).ConfigureAwait(false);
                                if (binding != progress.PendingMedia?.Media)
                                    throw new InvalidOperationException("offline_apply_media_binding_changed");
                                OfflineMigrationApplyUnit? mediaUnit = null;
                                async Task ExecuteOriginalMediaAsync(
                                    OfflineMigrationApplyNativeSession.OwnedReadContext? context, CancellationToken token)
                                {
                                    var journal = new OfflineMigrationArticleMediaJournal(progress, staged, connection,
                                        transaction, request.Attempt, context);
                                    mediaUnit = await actualMedia.ExecuteMediaAsync(step, previousUnit, connection,
                                        transaction, journal, token).ConfigureAwait(false);
                                    if (!mediaUnit.Complete)
                                        throw new InvalidOperationException("offline_apply_media_transaction_incomplete");
                                    hooks?.RequireCompleted();
                                    mediaEvidence = journal.RequirePublished();
                                }
                                if (native.SupportsOwnedReadContext)
                                    await native.WithOwnedReadScopeAsync(transaction, (context, token) =>
                                        ExecuteOriginalMediaAsync(context, token), cancellationToken).ConfigureAwait(false);
                                else
                                    await ExecuteOriginalMediaAsync(null, cancellationToken).ConfigureAwait(false);
                                unit = mediaUnit ?? throw new InvalidOperationException("offline_apply_media_transaction_incomplete");
                            }
                            else
                                unit = await operation.ExecuteAsync(step, previousUnit,
                                    connection, transaction, cancellationToken).ConfigureAwait(false);
                            hooks?.RequireCompleted();
                            string afterPredicate = unit.Complete ? step.TargetPostcondition : step.ResumePolicy.ReplayPostcondition;
                            OfflineMigrationPredicateObservation after = await operation.ObserveAsync(afterPredicate,
                                connection, transaction, cancellationToken).ConfigureAwait(false);
                            ValidateObservation(after, afterPredicate, identity);
                            var committed = new OfflineMigrationApplyJournalEntry(
                                mediaEvidence is null ? OfflineMigrationApplyJournalVerifier.Format : OfflineMigrationApplyJournalVerifier.MediaFormat,
                                artifact, plan.ContentDigest, plan.Source.Database,
                                request.InvocationId, (staged.Last?.Sequence ?? 0) + 1, request.Attempt,
                                step.StepId, identity.OperationReference, identity.Mode,
                                identity.Mode == OfflineMigrationExecutionMode.Transaction
                                    ? OfflineMigrationApplyJournalState.TransactionCommitted : OfflineMigrationApplyJournalState.BatchCommitted,
                                step.IdempotencyDefinition, unit.WatermarkBefore, unit.WatermarkAfter, unit.HighWatermark,
                                unit.RowsProcessed, unit.ExpectedRows, unit.Complete, before, after,
                                staged.Last?.ContentDigest ?? OfflineMigrationApplyJournalVerifier.GenesisDigest,
                                string.Empty, null, DateTimeOffset.UtcNow)
                            {
                                Media = mediaEvidence
                            };
                            await AppendAsync(staged, transaction, committed, cancellationToken).ConfigureAwait(false);
                            if (unit.Complete)
                            {
                                await AppendAsync(staged, transaction, committed with
                                {
                                    Sequence = (staged.Last?.Sequence ?? 0) + 1,
                                    State = OfflineMigrationApplyJournalState.StepVerified,
                                    PreviousDigest = staged.Last!.ContentDigest
                                }, cancellationToken).ConfigureAwait(false);
                            }
                        }

                        cancellationToken.ThrowIfCancellationRequested();
                        commitUnknown = true;
                        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                        commitUnknown = false;
                        progress = staged;
                        transactionBodyCompleted = true;
                    }
                    catch (Exception originalFailure)
                    {
                        RememberFirstFailure(originalFailure);
                        if (!commitUnknown)
                        {
                            try
                            {
                                await transaction.RollbackAsync(CleanupToken()).ConfigureAwait(false);
                            }
                            catch
                            {
                                commitUnknown = true;
                                cleanupCodes.Add("offline_apply_rollback_terminal_unknown");
                            }
                        }

                        throw;
                    }
                }

                transactionBodyCompleted = false;
                await using (DbTransaction terminalTransaction = await BeginAdmissionAsync().ConfigureAwait(false))
                {
                    try
                    {
                        await RevalidateAdmissionAsync(terminalTransaction).ConfigureAwait(false);
                        await VerifyRecordedStepsAsync(terminalTransaction).ConfigureAwait(false);
                        OfflineMigrationApplyJournalVerifier staged = progress.Fork();
                        await AppendAsync(staged, terminalTransaction, Control(staged,
                            OfflineMigrationApplyJournalState.ApplyCompleted, request.Attempt), cancellationToken).ConfigureAwait(false);
                        cancellationToken.ThrowIfCancellationRequested();
                        commitUnknown = true;
                        await terminalTransaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                        commitUnknown = false;
                        progress = staged;
                        transactionBodyCompleted = true;
                    }
                    catch (Exception originalFailure)
                    {
                        RememberFirstFailure(originalFailure);
                        throw;
                    }
                }

                return Result(OfflineMigrationApplyStatus.Completed);
            }
            catch (Exception failure)
            {
                // Never publish provider messages, SQL parameters, private facts or connection
                // strings. Ambiguous commit/rollback requires exact re-reading or backup restore,
                // not a guessed retry or a marker claiming effects did not commit.
                if ((firstFailure is not null && !ReferenceEquals(firstFailure, failure))
                    || (firstFailure is null && transactionBodyCompleted))
                {
                    cleanupCodes.Add("offline_apply_disposal_terminal_unknown");
                    commitUnknown = true;
                }

                RememberFirstFailure(failure);
                commitUnknown |= admissionWritesStarted;
                bool cancelled = firstFailureCode == "offline_apply_cancelled";
                string code = firstFailureCode!;
                if (started && !commitUnknown)
                {
                    try
                    {
                        await using DbTransaction terminal = await native.BeginCleanupAsync(CleanupToken()).ConfigureAwait(false);
                        OfflineMigrationApplyJournalVerifier staged = progress.Fork();
                        await AppendAsync(staged, terminal, Control(staged,
                            cancelled ? OfflineMigrationApplyJournalState.AttemptCancelled : OfflineMigrationApplyJournalState.AttemptFailed,
                            request.Attempt, code), CleanupToken()).ConfigureAwait(false);
                        await terminal.CommitAsync(CleanupToken()).ConfigureAwait(false);
                        progress = staged;
                    }
                    catch
                    {
                        return Result(OfflineMigrationApplyStatus.RecoveryRequired, code, "offline_apply_terminal_persistence_unknown");
                    }
                }

                return commitUnknown ? Result(OfflineMigrationApplyStatus.RecoveryRequired, code, "offline_apply_commit_outcome_unknown")
                    : Result(cancelled ? OfflineMigrationApplyStatus.Cancelled : OfflineMigrationApplyStatus.Failed, code);
            }
        }

        OfflineMigrationApplyResult outcome;
        try
        {
            outcome = await ExecuteCoreAsync().ConfigureAwait(false);
        }
        finally
        {
            if (locked || native.CleanupRequired)
            {
                try
                {
                    if (!await native.ReleaseAsync(CleanupToken()).ConfigureAwait(false))
                    {
                        cleanupCodes.Add("offline_apply_unlock_not_observed");
                    }
                }
                catch
                {
                    // Do not call unbounded Close or start a background disposal and claim
                    // completion. The native owner must observe actual session/transaction
                    // disposal; that deadline integration is still a before-runtime gate.
                    cleanupCodes.Add("offline_apply_session_cleanup_required");
                }
            }

            if (cleanupCancellation?.IsCancellationRequested == true)
            {
                cleanupCodes.Add("offline_apply_cleanup_budget_exhausted");
            }

            cleanupCancellation?.Dispose();
        }

        return cleanupCodes.Count == 0 ? outcome : outcome with
        {
            Status = OfflineMigrationApplyStatus.RecoveryRequired,
            Codes = outcome.Codes.Concat(cleanupCodes).Distinct(StringComparer.Ordinal).ToImmutableArray()
        };

        OfflineMigrationApplyResult Result(OfflineMigrationApplyStatus status, params string[] codes)
            => new(status, artifact, plan.ContentDigest, plan.Source.Database,
                progress.Last is null ? null : new(OfflineMigrationApplyJournalVerifier.Reference(progress.Last),
                    request.InvocationId, progress.Last.Sequence), progress.StepProofs, codes.ToImmutableArray());

        async Task PrepareMediaAsync(OfflineMigrationStep step, OfflineMigrationArticleMediaOperation operation)
        {
            await using DbTransaction preparation = await BeginAdmissionAsync().ConfigureAwait(false);
            try
            {
                await RevalidateAdmissionAsync(preparation).ConfigureAwait(false);
                OfflineMigrationPredicateObservation before = await operation.ObserveAsync(
                    step.SourcePrecondition, connection, preparation, cancellationToken).ConfigureAwait(false);
                ValidateObservation(before, step.SourcePrecondition, operation.Identity);
                OfflineMigrationMediaJournalEvidence media = await operation.GetMediaBindingAsync(
                    verified, artifact, request.InvocationId, connection, preparation, cancellationToken).ConfigureAwait(false);
                OfflineMigrationApplyJournalVerifier staged = progress.Fork();
                OfflineMigrationApplyJournalEntry entry = Control(staged,
                    OfflineMigrationApplyJournalState.MediaPrepared, request.Attempt) with
                {
                    Format = OfflineMigrationApplyJournalVerifier.MediaFormat,
                    StepId = step.StepId,
                    OperationReference = operation.Identity.OperationReference,
                    Mode = operation.Identity.Mode,
                    IdempotencyKey = step.IdempotencyDefinition,
                    Before = before,
                    Media = media
                };
                await AppendAsync(staged, preparation, entry, cancellationToken).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                commitUnknown = true;
                await preparation.CommitAsync(cancellationToken).ConfigureAwait(false);
                commitUnknown = false;
                progress = staged;
                transactionBodyCompleted = true;
            }
            catch (Exception originalFailure)
            {
                RememberFirstFailure(originalFailure);
                if (!commitUnknown)
                {
                    try
                    {
                        await preparation.RollbackAsync(CleanupToken()).ConfigureAwait(false);
                    }
                    catch
                    {
                        commitUnknown = true;
                        cleanupCodes.Add("offline_apply_rollback_terminal_unknown");
                    }
                }
                throw;
            }
        }

        async Task VerifyRecordedStepsAsync(DbTransaction transaction)
        {
            foreach (OfflineMigrationApplyJournalEntry recorded in progress.StepProofs)
            {
                OfflineMigrationStep step = plan.OrderedSteps.Single(value => value.StepId == recorded.StepId);
                OfflineMigrationProviderOperation identity = step.Operations.Single(value => value.Provider == plan.Source.Database.Provider);
                OfflineMigrationPredicateObservation actual = await operations[step.StepId].ObserveAsync(
                    step.TargetPostcondition, connection, transaction, cancellationToken).ConfigureAwait(false);
                ValidateObservation(actual, step.TargetPostcondition, identity);
                if (!OfflineMigrationPlanValidation.Equal(actual, recorded.After))
                {
                    throw new InvalidOperationException("offline_apply_recorded_postcondition_changed");
                }
            }
        }

        static async Task AppendAsync(OfflineMigrationApplyJournalVerifier staged, DbTransaction transaction,
            OfflineMigrationApplyJournalEntry entry, CancellationToken token)
        {
            entry = entry with
            {
                ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(entry)
            };
            staged.Accept(entry);
            await OfflineMigrationStateStore.AppendApplyJournalAsync(transaction.Connection!, transaction, entry, token).ConfigureAwait(false);
        }

        OfflineMigrationApplyJournalEntry Control(OfflineMigrationApplyJournalVerifier staged,
            OfflineMigrationApplyJournalState state, int attempt, string? failureCode = null)
            => new(OfflineMigrationApplyJournalVerifier.Format, artifact, plan.ContentDigest, plan.Source.Database,
                request.InvocationId, (staged.Last?.Sequence ?? 0) + 1, attempt,
                null, null, null, state, null, null, null, null, 0, 0, false, null, null,
                staged.Last?.ContentDigest ?? OfflineMigrationApplyJournalVerifier.GenesisDigest,
                string.Empty, failureCode, DateTimeOffset.UtcNow);
    }

    private static void ValidateObservation(OfflineMigrationPredicateObservation observation,
        string predicateReference, OfflineMigrationProviderOperation identity)
    {
        if (observation.PredicateReference != predicateReference || observation.OperationReference != identity.OperationReference
            || observation.OperationSourceDigest != identity.OperationSourceDigest || observation.SemanticDigest != identity.SemanticDigest
            || observation.ContentDigest != OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(observation)
            || observation.ExpectedFacts.IsDefault || observation.ActualFacts.IsDefault
            || !observation.ExpectedFacts.SequenceEqual(observation.ActualFacts)
            || observation.ExpectedFacts.Length > 256
            || observation.ExpectedFacts.Any(fact => string.IsNullOrWhiteSpace(fact.Name)
                || fact.Name.Length > 160 || fact.Value is null || fact.Value.Length > 4096)
            || !observation.ExpectedFacts.Select(fact => fact.Name).SequenceEqual(
                observation.ExpectedFacts.Select(fact => fact.Name).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)))
        {
            throw new InvalidOperationException("offline_apply_owner_predicate_failed");
        }
    }

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

    internal static async Task<OfflineMigrationExecutionResult> ExecuteExpandAsync(
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
            .Where(ContainsDestructiveOperation)
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

    private static bool ContainsDestructiveOperation(ISchemaMigrationDescriptor descriptor)
        => descriptor.Steps.Any(ContainsDestructiveOperation);

    private static bool ContainsDestructiveOperation(SchemaMigrationStep step)
    {
        if (step is DropColumnStep or DropTableStep or DropIndexStep or RenameColumnStep or RenameTableStep)
        {
            return true;
        }
        if (step is not RawSqlStep and not BackfillSqlStep and not AssertSqlStep)
        {
            return false;
        }
        string normalized = $" {Regex.Replace(step.Fingerprint, @"\s+", " ", RegexOptions.CultureInvariant).ToUpperInvariant()} ";
        return s_destructiveSqlTokens.Any(normalized.Contains);
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
