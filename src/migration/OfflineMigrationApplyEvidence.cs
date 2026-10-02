using System.Data;
using System.Data.Common;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;

using Npgsql;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

// The Host consumes only the original compiled apply route, not a recorded success
// flag, caller SQL, a CLI-selected delegate or a second migration executor.
internal interface IOfflineMigrationApplyProducer
{
    Task<OfflineMigrationApplyResult> ApplyAsync(OfflineMigrationApplyCommandOptions options,
        CancellationToken cancellationToken);
}

internal sealed record OfflineMigrationApplyCapabilities(
    IOfflineMigrationVerificationArtifactReader Artifacts,
    IOfflineMigrationPlanningAuthorityReader Planning,
    IOfflineMigrationCurrentSchemaVerificationAuthority Authority,
    IOfflineMigrationApplyOperationRegistry Operations);

internal sealed class OfflineMigrationOwnedApplyEvidence(
    OfflineMigrationApplyCapabilities owners, TimeProvider timeProvider) : IOfflineMigrationApplyProducer
{
    public async Task<OfflineMigrationApplyResult> ApplyAsync(OfflineMigrationApplyCommandOptions options,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequireOwners(owners);
        if (options.Database.Provider != CurrentSchemaProviderKind.PostgreSql || options.Attempt <= 0
            || options.CleanupTimeoutSeconds is <= 0 or > int.MaxValue / 1000
            || options.TimeoutSeconds is <= 0 or > int.MaxValue / 1000)
        {
            throw new InvalidOperationException("offline_apply_explicit_options_invalid");
        }
        // Actual original bytes are read through the sole anchored file owner. A semantic
        // seal is not the file hash, and decoding a carrier is not write admission.
        byte[] planBytes = (await owners.Artifacts.ReadAsync(options.Plan, cancellationToken).ConfigureAwait(false)).ToArray();
        OfflineMigrationPlan plan = DecodePlan(options, planBytes);
        if (plan.OrderedSteps.IsDefaultOrEmpty || (plan.OrderedSteps.Any(step => step.Destructive) && !options.ConfirmDestructive))
        {
            throw new InvalidOperationException("offline_apply_plan_or_confirmation_invalid");
        }
        OfflineMigrationApplyCheckpoint? checkpoint = null;
        if (options.Checkpoint is { } reference)
        {
            byte[] checkpointBytes = (await owners.Artifacts.ReadAsync(reference, cancellationToken).ConfigureAwait(false)).ToArray();
            checkpoint = DecodeCheckpoint(reference, checkpointBytes, options.InvocationId);
        }
        var request = new OfflineMigrationApplyRequest(options.InvocationId, options.Attempt, options.ConfirmDestructive,
            checkpoint, TimeSpan.FromSeconds(options.CleanupTimeoutSeconds));
        OfflineMigrationPlanningAuthority planning = await owners.Planning.ReadAsync(options.Database.Provider,
            cancellationToken).ConfigureAwait(false);
        OfflineMigrationPlanValidation.ValidateTargetAndTool(planning.Target, planning.Tool);
        cancellationToken.ThrowIfCancellationRequested();
        string connectionString = await OfflineMigrationHost.ReadRequiredConnectionStringAsync(options.EnvironmentFilePath,
            cancellationToken).ConfigureAwait(false);
        var connection = new NpgsqlConnection(connectionString);
        OfflineMigrationApplyResult? outcome = null;
        Exception? primary = null;
        try
        {
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            VerifiedOfflineMigrationPlan carrier;
            // Close the compiled graph and authenticate retained backup/tool facts before
            // entering the executor. The executor MUST repeat admission under its exclusive
            // lock; this read-only carrier is deliberately not a write authorization.
            DbTransaction? snapshot = null;
            Exception? snapshotFailure = null;
            carrier = null!;
            try
            {
                snapshot = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken).ConfigureAwait(false);
                await using (DbCommand readOnly = OfflineMigrationStateStore.NativeCommand(connection, snapshot, "SET TRANSACTION READ ONLY"))
                {
                    _ = await readOnly.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
                }
                CurrentSchemaDatabaseIdentity actualDatabase = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(
                    connection, snapshot, cancellationToken).ConfigureAwait(false);
                if (actualDatabase != options.Database)
                {
                    throw new InvalidOperationException("offline_apply_native_database_changed");
                }
                var preflight = new OfflineMigrationApplyJournalVerifier(plan, options.Plan, options.InvocationId);
                await OfflineMigrationStateStore.ReadApplyJournalAsync(connection, snapshot, plan.ContentDigest,
                    actualDatabase, request, preflight, cancellationToken).ConfigureAwait(false);
                OfflineMigrationCurrentSchemaAuthoritySnapshot authority = await owners.Authority.ReadAsync(plan, connection,
                    snapshot, cancellationToken).ConfigureAwait(false);
                // Resume freshness is measured at the original successfully verified first
                // admission, not at this later invocation or the newest journal entry.
                carrier = BindCarrier(plan, planBytes, options.Plan, planning, authority,
                    preflight.First?.RecordedAt ?? timeProvider.GetUtcNow());
            }
            catch (Exception failure)
            {
                snapshotFailure = failure;
            }
            if (snapshot is not null)
            {
                try
                {
                    await snapshot.DisposeAsync().ConfigureAwait(false);
                }
                catch
                {
                    string category = snapshotFailure is OperationCanceledException ? "cancelled" : snapshotFailure is null ? "none" : "failed";
                    throw new InvalidOperationException("offline_apply_initial_snapshot_cleanup_unverified_primary_" + category);
                }
            }
            if (snapshotFailure is not null)
            {
                ExceptionDispatchInfo.Capture(snapshotFailure).Throw();
            }
            cancellationToken.ThrowIfCancellationRequested();
            var admission = new OfflineMigrationOwnedPlanAdmission(owners, new OfflineMigrationSourceObserver(), timeProvider);
            outcome = await OfflineMigrationExecutor.ApplyAsync(carrier, options.Plan, request, connection, admission,
                owners.Operations, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception failure)
        {
            primary = failure;
        }
        try
        {
            // Await the actual native close; no abandoned timed task or remote-zero claim.
            await connection.DisposeAsync().ConfigureAwait(false);
        }
        catch
        {
            if (outcome is not null)
            {
                return outcome with
                {
                    Status = OfflineMigrationApplyStatus.RecoveryRequired,
                    Codes = outcome.Codes.Add("offline_apply_connection_cleanup_unverified")
                };
            }
            string category = primary is OperationCanceledException ? "cancelled" : primary is null ? "none" : "failed";
            throw new InvalidOperationException("offline_apply_connection_cleanup_unverified_primary_" + category);
        }
        if (primary is not null)
        {
            ExceptionDispatchInfo.Capture(primary).Throw();
        }
        // A terminal failed/cancelled/recovery result still names its real journal anchor.
        // The Host separately controls evidence publication; do not relabel committed
        // database effects as absent merely because the main token changed afterwards.
        return outcome ?? throw new InvalidOperationException("offline_apply_native_outcome_missing");
    }

    internal static OfflineMigrationPlan DecodePlan(OfflineMigrationApplyCommandOptions options, ReadOnlySpan<byte> bytes)
    {
        if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != options.Plan.Sha256)
        {
            throw new InvalidOperationException("offline_apply_original_plan_sha_mismatch");
        }
        OfflineMigrationPlan plan;
        try
        {
            plan = JsonSerializer.Deserialize<OfflineMigrationPlan>(bytes) ?? throw new JsonException();
        }
        catch (JsonException)
        {
            throw new InvalidOperationException("offline_apply_original_plan_json_invalid");
        }
        if (!bytes.SequenceEqual(OfflineMigrationPlanCodec.Serialize(plan)) || plan.Source?.Database != options.Database
            || plan.ContentDigest != OfflineMigrationPlanCodec.ComputeContentDigest(plan))
        {
            throw new InvalidOperationException("offline_apply_original_plan_binding_invalid");
        }
        return plan;
    }

    internal static OfflineMigrationApplyCheckpoint DecodeCheckpoint(CurrentSchemaArtifactReference reference,
        ReadOnlySpan<byte> bytes, string invocation)
    {
        if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != reference.Sha256)
        {
            throw new InvalidOperationException("offline_apply_original_checkpoint_sha_mismatch");
        }
        OfflineMigrationApplyCheckpoint checkpoint;
        try
        {
            checkpoint = JsonSerializer.Deserialize<OfflineMigrationApplyCheckpoint>(bytes) ?? throw new JsonException();
        }
        catch (JsonException)
        {
            throw new InvalidOperationException("offline_apply_original_checkpoint_json_invalid");
        }
        if (!bytes.SequenceEqual(JsonSerializer.SerializeToUtf8Bytes(checkpoint)) || checkpoint.InvocationId != invocation
            || checkpoint.Sequence <= 0 || checkpoint.JournalHead is null
            || checkpoint.JournalHead.Reference != "offline-apply/v1/" + checkpoint.JournalHead.EntryDigest)
        {
            throw new InvalidOperationException("offline_apply_original_checkpoint_binding_invalid");
        }
        OfflineMigrationPlanValidation.RequireDigest(checkpoint.JournalHead.EntryDigest, "offline_apply_original_checkpoint_digest_invalid");
        return checkpoint;
    }

    internal static VerifiedOfflineMigrationPlan BindCarrier(OfflineMigrationPlan plan, ReadOnlySpan<byte> bytes,
        CurrentSchemaArtifactReference reference, OfflineMigrationPlanningAuthority planning,
        OfflineMigrationCurrentSchemaAuthoritySnapshot authority, DateTimeOffset firstAdmissionTime)
    {
        if (planning.Tool != authority.RetainedPlanTool || planning.MaximumBackupAge != authority.MaximumBackupAge
            || !OfflineMigrationPlanValidation.Equal(planning.Dag, authority.Dag))
        {
            throw new InvalidOperationException("offline_apply_independent_authority_changed");
        }
        return OfflineMigrationPlanVerifier.VerifyForCompletedApplyBindings(plan, bytes, reference,
            authority.AuthenticatedBackup, planning.Target, authority.RetainedPlanTool, authority.Registry,
            authority.Dag, firstAdmissionTime, planning.MaximumBackupAge);
    }

    internal static void RequireOwners(OfflineMigrationApplyCapabilities owners)
    {
        ArgumentNullException.ThrowIfNull(owners);
        if (owners.Artifacts is null || owners.Planning is null || owners.Authority is null || owners.Operations is null)
        {
            throw new InvalidOperationException("offline_apply_native_owners_not_configured");
        }
    }
}

// Whole-plan admission only. The original source/identity, operation predicates and
// journal owner remain the single implementations of their respective observations.
internal sealed class OfflineMigrationOwnedPlanAdmission(OfflineMigrationApplyCapabilities owners,
    OfflineMigrationSourceObserver sourceObserver, TimeProvider timeProvider) : IOfflineMigrationPlanAdmission
{
    public async Task RevalidateAsync(VerifiedOfflineMigrationPlan verified, CurrentSchemaArtifactReference artifact,
        OfflineMigrationApplyJournalVerifier progress, DbConnection connection, DbTransaction transaction,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        OfflineMigrationOwnedApplyEvidence.RequireOwners(owners);
        OfflineMigrationPlan plan = verified.Plan;
        byte[] original = (await owners.Artifacts.ReadAsync(artifact, cancellationToken).ConfigureAwait(false)).ToArray();
        if (!original.AsSpan().SequenceEqual(OfflineMigrationPlanCodec.Serialize(plan))
            || Convert.ToHexStringLower(SHA256.HashData(original)) != artifact.Sha256)
        {
            throw new InvalidOperationException("offline_apply_plan_changed_under_lock");
        }
        CurrentSchemaDatabaseIdentity actualDatabase = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        if (actualDatabase != plan.Source.Database)
        {
            throw new InvalidOperationException("offline_apply_native_database_changed");
        }
        OfflineMigrationPlanningAuthority planning = await owners.Planning.ReadAsync(actualDatabase.Provider,
            cancellationToken).ConfigureAwait(false);
        OfflineMigrationCurrentSchemaAuthoritySnapshot authority = await owners.Authority.ReadAsync(plan, connection,
            transaction, cancellationToken).ConfigureAwait(false);
        DateTimeOffset admissionTime;
        if (progress.Last is null)
        {
            if (progress.First is not null)
            {
                throw new InvalidOperationException("offline_apply_first_journal_binding_invalid");
            }
            admissionTime = timeProvider.GetUtcNow();
            OfflineMigrationSourceObservation source = await sourceObserver.ObserveAsync(actualDatabase.Provider, connection,
                transaction, cancellationToken).ConfigureAwait(false);
            _ = OfflineMigrationOwnedApplyEvidence.BindCarrier(plan, original, artifact, planning, authority, admissionTime);
            _ = OfflineMigrationPlanVerifier.Verify(plan, source, authority.AuthenticatedBackup, planning.Target,
                authority.RetainedPlanTool, authority.Registry, authority.Dag, admissionTime, planning.MaximumBackupAge);
        }
        else
        {
            // First is retained only by the original streaming verifier after successful
            // Accept. It is not a caller date, last-entry timestamp or plan assertion.
            OfflineMigrationApplyJournalEntry first = progress.First
                ?? throw new InvalidOperationException("offline_apply_first_journal_binding_invalid");
            if (first.State != OfflineMigrationApplyJournalState.AttemptStarted || first.Sequence != 1)
            {
                throw new InvalidOperationException("offline_apply_first_journal_binding_invalid");
            }
            admissionTime = first.RecordedAt;
            _ = OfflineMigrationOwnedApplyEvidence.BindCarrier(plan, original, artifact, planning, authority, admissionTime);
            if (progress.PendingUnit is { } unit)
            {
                OfflineMigrationStep step = plan.OrderedSteps.Single(value => value.StepId == unit.StepId);
                OfflineMigrationProviderOperation identity = step.Operations.Single(value => value.Provider == actualDatabase.Provider);
                OfflineMigrationApplyOperation operation = owners.Operations.Resolve(step, identity);
                if (operation.Identity != identity)
                {
                    throw new InvalidOperationException("offline_apply_progress_operation_changed");
                }
                string predicate = unit.UnitComplete ? step.TargetPostcondition : step.ResumePolicy.ReplayPostcondition;
                OfflineMigrationPredicateObservation actual = await operation.ObserveAsync(predicate, connection, transaction,
                    cancellationToken).ConfigureAwait(false);
                if (!OfflineMigrationPlanValidation.Equal(actual, unit.After))
                {
                    throw new InvalidOperationException("offline_apply_pending_postcondition_changed");
                }
            }
            // The executor additionally re-observes every committed step and each next
            // source/replay predicate on this same session before business writes.
        }
        cancellationToken.ThrowIfCancellationRequested();
    }
}

internal static class OfflineMigrationApplyEvidence
{
    internal static IOfflineMigrationApplyProducer ComposeOwned(OfflineMigrationApplyCapabilities owners,
        TimeProvider? timeProvider = null)
    {
        OfflineMigrationOwnedApplyEvidence.RequireOwners(owners);
        return new OfflineMigrationOwnedApplyEvidence(owners, timeProvider ?? TimeProvider.System);
    }

    internal static IOfflineMigrationApplyProducer CreateOwned()
    {
        // Concrete operation/target and authenticated retained-backup configuration is
        // supplied only by compiled owner composition, never CLI plugin/type names.
        throw new InvalidOperationException("offline_apply_native_owners_not_configured");
    }
}
