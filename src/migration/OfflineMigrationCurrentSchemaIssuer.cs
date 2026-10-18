using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.SchemaMigration;

using Npgsql;

namespace FsusBlog.Migration;

internal sealed record OfflineMigrationCurrentSchemaVerifyRequest(
    CurrentSchemaArtifactReference Plan,
    CurrentSchemaArtifactReference Apply,
    ImmutableArray<CurrentSchemaArtifactReference> Checkpoints,
    CurrentSchemaDatabaseIdentity Database,
    string InvocationId);

internal sealed record OfflineMigrationCurrentSchemaIssuedArtifact(
    CurrentSchemaArtifactReference Reference,
    CurrentSchemaReceipt Receipt,
    ReadOnlyMemory<byte> Bytes);

internal static class OfflineMigrationCurrentSchemaIssuer
{
    internal const string NativeIdentityCleanupFailuresKey = "FsusBlog.Migration.CurrentIdentityCleanupFailures";

    private static readonly JsonSerializerOptions s_artifactJson = new()
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    // The normal host route cannot substitute arbitrary callbacks for missing owners.
    internal static Task<CurrentSchemaReceipt> IssueAsync(
        OfflineMigrationCurrentSchemaVerifyRequest request, NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateRequest(request);
        return IssueAsync(request, connection, OfflineMigrationCurrentSchemaVerificationOwners.CreateOwned(),
            cancellationToken);
    }

    internal static async Task<OfflineMigrationCurrentSchemaIssuedArtifact> IssueArtifactAsync(
        OfflineMigrationCurrentSchemaVerifyRequest request, NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        CurrentSchemaReceipt receipt = await IssueAsync(request, connection, cancellationToken).ConfigureAwait(false);
        byte[] bytes = CurrentSchemaReceiptCodec.Serialize(receipt);
        string sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
        return new(new($"current-schema/v1/{sha256}", sha256), receipt, bytes);
    }

    // Re-run the native verifier, not just the receipt codec, for an independent
    // explicit artifact consumer. The registered verifier/tool identity is part
    // of the recomputed receipt, rather than copied from the supplied JSON.
    internal static async Task VerifyExistingAsync(
        CurrentSchemaArtifactReference receiptArtifact,
        OfflineMigrationCurrentSchemaVerifyRequest request, NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateRequest(request);
        RequireReference(receiptArtifact);
        OfflineMigrationCurrentSchemaVerificationCapabilities owners = OfflineMigrationCurrentSchemaVerificationOwners.CreateOwned();
        ReadOnlyMemory<byte> bytes = await ReadArtifactAsync(receiptArtifact, owners.Artifacts, cancellationToken)
            .ConfigureAwait(false);
        CurrentSchemaReceipt reported = CurrentSchemaReceiptCodec.Deserialize(bytes);
        CurrentSchemaReceipt observed = await IssueAsync(request, connection, owners, cancellationToken).ConfigureAwait(false);
        ValidateObservedReceipt(reported, observed);
    }

    internal static void ValidateObservedReceipt(CurrentSchemaReceipt reported, CurrentSchemaReceipt independentlyObserved)
    {
        CurrentSchemaReceiptCodec.ValidateIntegrity(reported);
        CurrentSchemaReceiptCodec.ValidateIntegrity(independentlyObserved);
        if (reported.Status != CurrentSchemaReceiptStatus.VerifiedCurrent
            || independentlyObserved.Status != CurrentSchemaReceiptStatus.VerifiedCurrent
            || reported.ContentDigest != independentlyObserved.ContentDigest)
        {
            throw new InvalidOperationException("current_verify_receipt_differs_from_native_reverification");
        }
    }

    internal static async Task<CurrentSchemaReceipt> IssueAsync(
        OfflineMigrationCurrentSchemaVerifyRequest request, NpgsqlConnection connection,
        OfflineMigrationCurrentSchemaVerificationCapabilities owners, CancellationToken cancellationToken)
    {
        ValidateRequest(request);
        ArgumentNullException.ThrowIfNull(owners);
        if (owners.Artifacts is null || owners.Authority is null || owners.CurrentSchema is null || owners.Operations is null)
        {
            throw new InvalidOperationException("current_verify_native_owners_not_configured");
        }
        cancellationToken.ThrowIfCancellationRequested();
        ReadOnlyMemory<byte> planBytes = await ReadArtifactAsync(request.Plan, owners.Artifacts, cancellationToken)
            .ConfigureAwait(false);
        OfflineMigrationPlan plan = DecodeArtifact<OfflineMigrationPlan>(planBytes);
        ReadOnlyMemory<byte> applyBytes = await ReadArtifactAsync(request.Apply, owners.Artifacts, cancellationToken)
            .ConfigureAwait(false);
        OfflineMigrationApplyResult apply = DecodeArtifact<OfflineMigrationApplyResult>(applyBytes);
        var checkpoints = ImmutableArray.CreateBuilder<OfflineMigrationApplyCheckpoint>(request.Checkpoints.Length);
        foreach (CurrentSchemaArtifactReference reference in request.Checkpoints)
        {
            checkpoints.Add(DecodeArtifact<OfflineMigrationApplyCheckpoint>(
                await ReadArtifactAsync(reference, owners.Artifacts, cancellationToken).ConfigureAwait(false)));
        }
        ImmutableArray<OfflineMigrationApplyCheckpoint> exactCheckpoints = checkpoints.MoveToImmutable();
        ValidateReportedApply(request, plan, apply, exactCheckpoints);
        if (connection.State != ConnectionState.Open)
        {
            throw new InvalidOperationException("current_verify_native_connection_not_open");
        }

        DbTransaction transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken)
            .ConfigureAwait(false);
        CurrentSchemaReceipt? receipt = null;
        Exception? failure = null;
        try
        {
            await using (DbCommand readOnly = OfflineMigrationStateStore.NativeCommand(
                connection, transaction, "SET TRANSACTION READ ONLY"))
            {
                await readOnly.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            }
            CurrentSchemaDatabaseIdentity database = await ReadNativeIdentityAsync(connection, transaction, cancellationToken)
                .ConfigureAwait(false);
            if (database != request.Database || database != plan.Source.Database)
            {
                throw new InvalidOperationException("current_verify_native_database_changed");
            }

            OfflineMigrationApplyJournalVerifier journal = CreateBoundJournalVerifier(
                plan, request.Plan, request.InvocationId, owners.Operations);
            await OfflineMigrationStateStore.ReadApplyJournalAsync(connection, transaction, plan.ContentDigest,
                database, new(request.InvocationId, 1, false, apply.Checkpoint), journal, cancellationToken)
                .ConfigureAwait(false);
            ValidateNativeProofs(plan, apply, journal);
            foreach (OfflineMigrationApplyCheckpoint checkpoint in exactCheckpoints)
            {
                OfflineMigrationApplyJournalEntry anchor = await ReadNativeEntryAsync(
                    plan, request, checkpoint.Sequence, connection, transaction, cancellationToken).ConfigureAwait(false);
                if (anchor.InvocationId != checkpoint.InvocationId
                    || OfflineMigrationApplyJournalVerifier.Reference(anchor) != checkpoint.JournalHead)
                {
                    throw new InvalidOperationException("current_verify_checkpoint_native_anchor_changed");
                }
            }
            OfflineMigrationApplyJournalEntry first = await ReadNativeEntryAsync(
                plan, request, 1, connection, transaction, cancellationToken).ConfigureAwait(false);
            ValidateFirstAdmission(plan, request, first);

            CurrentSchemaAdmissionObservation current = await owners.CurrentSchema.ObserveAsync(
                connection, transaction, database, cancellationToken).ConfigureAwait(false);
            ValidateCurrentObservation(current, database, plan.Target);
            OfflineMigrationCurrentSchemaAuthoritySnapshot authority = await owners.Authority.ReadAsync(
                plan, connection, transaction, cancellationToken).ConfigureAwait(false);
            if (authority.CurrentVerifier.SourceRevision == new string('0', 40))
            {
                throw new InvalidOperationException("current_verify_producer_source_unobserved");
            }
            VerifiedOfflineMigrationPlan admitted = OfflineMigrationPlanVerifier.VerifyForCompletedApplyBindings(plan, planBytes.Span, request.Plan,
                authority.AuthenticatedBackup, current.Target, authority.RetainedPlanTool, authority.Registry,
                authority.Dag, first.RecordedAt, authority.MaximumBackupAge);
            await OfflineMigrationApplyEvidence.BindAcceptedOperationProgressAsync(admitted, request.Plan, journal,
                owners.Operations, cancellationToken).ConfigureAwait(false);

            ImmutableArray<OfflineMigrationApplyJournalEntry> nativeProofs = journal.StepProofs;
            var postconditions = ImmutableArray.CreateBuilder<CurrentSchemaStepPostcondition>(plan.OrderedSteps.Length);
            for (int index = 0; index < plan.OrderedSteps.Length; index++)
            {
                OfflineMigrationStep step = plan.OrderedSteps[index];
                OfflineMigrationProviderOperation identity = step.Operations.Single(value => value.Provider == database.Provider);
                if (!Enum.IsDefined(identity.Mode))
                {
                    throw new InvalidOperationException("current_verify_operation_mode_unknown");
                }
                OfflineMigrationApplyOperation operation = owners.Operations.Resolve(step, identity);
                if (operation.Identity != identity)
                {
                    throw new InvalidOperationException("current_verify_operation_owner_changed");
                }
                OfflineMigrationPredicateObservation actual = await operation.ObserveAsync(
                    step.TargetPostcondition, connection, transaction, cancellationToken).ConfigureAwait(false);
                ValidatePostcondition(step.TargetPostcondition, identity, actual, nativeProofs[index].After);
                if (identity.Mode == OfflineMigrationExecutionMode.CheckpointedBatch)
                {
                    OfflineMigrationPredicateObservation replay = await operation.ObserveAsync(
                        step.ResumePolicy.ReplayPostcondition, connection, transaction, cancellationToken).ConfigureAwait(false);
                    ValidatePostcondition(step.ResumePolicy.ReplayPostcondition, identity, replay, null);
                }
                postconditions.Add(new(step.StepId, step.TargetPostcondition,
                    OfflineMigrationPlanValidation.Digest(actual.ExpectedFacts),
                    OfflineMigrationPlanValidation.Digest(actual.ActualFacts), actual.ContentDigest));
            }
            receipt = new(CurrentSchemaReceiptCodec.Format, CurrentSchemaReceiptStatus.VerifiedCurrent,
                current.Target, plan.SourceFingerprintId, plan.SourceFingerprintVersion, plan.SourceRegistryDigest,
                plan.Source.ContentDigest, request.Plan, request.Apply, request.Checkpoints, database,
                current.ActualSchemaDigest, postconditions.MoveToImmutable(), authority.AuthenticatedBackup.Package,
                authority.AuthenticatedBackup.Manifest, authority.AuthenticatedBackup.RestoreDrill,
                authority.RecoveryReferences, authority.CurrentVerifier, [], string.Empty);
            receipt = receipt with
            {
                ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(receipt)
            };
            _ = CurrentSchemaReceiptCodec.Serialize(receipt);
            cancellationToken.ThrowIfCancellationRequested();
            // No commit or migration write: closing this read-only snapshot precedes
            // returning anything eligible for artifact publication.
        }
        catch (Exception exception)
        {
            failure = exception;
        }
        try
        {
            await transaction.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception)
        {
            if (failure is null)
            {
                failure = new InvalidOperationException("current_verify_read_only_cleanup_failed");
            }
            else
            {
                failure.Data["current_verify_read_only_cleanup_failed"] = true;
            }
        }
        if (failure is not null)
        {
            ExceptionDispatchInfo.Capture(failure).Throw();
        }
        cancellationToken.ThrowIfCancellationRequested();
        return receipt ?? throw new InvalidOperationException("current_verify_receipt_not_observed");
    }

    internal static void ValidateCurrentObservation(CurrentSchemaAdmissionObservation current,
        CurrentSchemaDatabaseIdentity nativeDatabase, CurrentSchemaTargetIdentity intendedTarget)
    {
        ArgumentNullException.ThrowIfNull(current);
        CurrentSchemaReceiptCodec.ValidateTarget(current.Target);
        CurrentSchemaReceiptCodec.ValidateDatabase(current.Database);
        CurrentSchemaReceiptCodec.RequireDigest(current.ActualSchemaDigest);
        if (current.Database != nativeDatabase || current.Target != intendedTarget)
        {
            throw new InvalidOperationException("current_verify_actual_target_or_database_changed");
        }
    }

    internal static void ValidateRequest(OfflineMigrationCurrentSchemaVerifyRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireReference(request.Plan);
        RequireReference(request.Apply);
        CurrentSchemaReceiptCodec.ValidateDatabase(request.Database);
        if (request.Database.Provider != CurrentSchemaProviderKind.PostgreSql
            || request.Checkpoints.IsDefaultOrEmpty || string.IsNullOrWhiteSpace(request.InvocationId)
            || request.InvocationId.Length > 160 || request.InvocationId != request.InvocationId.Trim()
            || request.InvocationId.Any(char.IsControl))
        {
            throw new InvalidOperationException("current_verify_explicit_native_identity_required");
        }
        var references = new HashSet<string>(StringComparer.Ordinal);
        foreach (CurrentSchemaArtifactReference checkpoint in request.Checkpoints)
        {
            RequireReference(checkpoint);
            if (!references.Add(checkpoint.Reference))
            {
                throw new InvalidOperationException("current_verify_checkpoint_reference_duplicate");
            }
        }
    }

    internal static void ValidateReportedApply(OfflineMigrationCurrentSchemaVerifyRequest request,
        OfflineMigrationPlan plan, OfflineMigrationApplyResult apply,
        ImmutableArray<OfflineMigrationApplyCheckpoint> checkpoints)
    {
        if (plan.Source.Database != request.Database || apply.Database != request.Database
            || apply.Plan != request.Plan || apply.PlanContentDigest != plan.ContentDigest
            || plan.ContentDigest != OfflineMigrationPlanCodec.ComputeContentDigest(plan)
            || request.Plan.Sha256 != OfflineMigrationApplyJournalVerifier.ComputePlanArtifactDigest(plan)
            || apply.Status is not (OfflineMigrationApplyStatus.Completed or OfflineMigrationApplyStatus.NoOpVerified)
            || apply.Codes.IsDefault || !apply.Codes.IsEmpty || apply.Checkpoint is null
            || checkpoints.IsDefaultOrEmpty || checkpoints.Length != request.Checkpoints.Length
            || checkpoints[^1] != apply.Checkpoint || apply.Checkpoint.InvocationId != request.InvocationId
            || plan.OrderedSteps.IsDefaultOrEmpty || apply.StepProofs.IsDefault
            || apply.StepProofs.Length != plan.OrderedSteps.Length)
        {
            throw new InvalidOperationException("current_verify_reported_apply_incomplete_or_changed");
        }
        long previous = 0;
        foreach (OfflineMigrationApplyCheckpoint checkpoint in checkpoints)
        {
            if (checkpoint.Sequence <= previous || checkpoint.InvocationId != request.InvocationId)
            {
                throw new InvalidOperationException("current_verify_checkpoint_order_or_invocation_changed");
            }
            previous = checkpoint.Sequence;
        }
    }

    internal static void ValidateNativeProofs(OfflineMigrationPlan plan, OfflineMigrationApplyResult apply,
        OfflineMigrationApplyJournalVerifier journal)
    {
        ImmutableArray<OfflineMigrationApplyJournalEntry> nativeProofs = journal.StepProofs;
        if (!journal.Completed || journal.Last is null || nativeProofs.Length != plan.OrderedSteps.Length
            || apply.StepProofs.Length != nativeProofs.Length)
        {
            throw new InvalidOperationException("current_verify_native_journal_incomplete");
        }
        for (int index = 0; index < nativeProofs.Length; index++)
        {
            OfflineMigrationApplyJournalEntry reported = apply.StepProofs[index];
            OfflineMigrationApplyJournalEntry native = nativeProofs[index];
            if (reported.ContentDigest != OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(reported)
                || native.ContentDigest != reported.ContentDigest)
            {
                throw new InvalidOperationException("current_verify_reported_proof_differs_from_native");
            }
        }
    }

    internal static void ValidatePostcondition(string predicate, OfflineMigrationProviderOperation owner,
        OfflineMigrationPredicateObservation actual, OfflineMigrationPredicateObservation? recorded)
    {
        if (actual is null || actual.PredicateReference != predicate || actual.OperationReference != owner.OperationReference
            || actual.OperationSourceDigest != owner.OperationSourceDigest || actual.SemanticDigest != owner.SemanticDigest
            || actual.ContentDigest != OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(actual)
            || !FactsValid(actual.ExpectedFacts) || !FactsValid(actual.ActualFacts)
            || !actual.ExpectedFacts.SequenceEqual(actual.ActualFacts)
            || (recorded is not null && actual.ContentDigest != recorded.ContentDigest))
        {
            throw new InvalidOperationException("current_verify_actual_postcondition_changed");
        }
    }

    internal static T DecodeArtifact<T>(ReadOnlyMemory<byte> bytes) where T : class
    {
        using JsonDocument document = JsonDocument.Parse(bytes);
        RejectDuplicateMembers(document.RootElement);
        if (typeof(T) == typeof(OfflineMigrationApplyResult)
            && !document.RootElement.TryGetProperty(nameof(OfflineMigrationApplyResult.Status), out _))
        {
            throw new InvalidOperationException("current_verify_apply_status_missing");
        }
        T value = JsonSerializer.Deserialize<T>(bytes.Span, s_artifactJson)
            ?? throw new InvalidOperationException("current_verify_artifact_null");
        return value;
    }

    private static void RejectDuplicateMembers(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    throw new InvalidOperationException("current_verify_artifact_duplicate_member");
                }
                RejectDuplicateMembers(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement value in element.EnumerateArray())
            {
                RejectDuplicateMembers(value);
            }
        }
    }

    internal static void ValidateArtifactBytes(CurrentSchemaArtifactReference reference, ReadOnlyMemory<byte> bytes)
    {
        RequireReference(reference);
        if (bytes.IsEmpty || reference.Sha256 != Convert.ToHexStringLower(SHA256.HashData(bytes.Span)))
        {
            throw new InvalidOperationException("current_verify_original_artifact_hash_changed");
        }
    }

    private static async Task<ReadOnlyMemory<byte>> ReadArtifactAsync(CurrentSchemaArtifactReference reference,
        IOfflineMigrationVerificationArtifactReader reader, CancellationToken cancellationToken)
    {
        ReadOnlyMemory<byte> bytes = await reader.ReadAsync(reference, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        // The reader may reuse its own buffer. Bind a task-owned snapshot before any
        // later artifact read can overwrite the bytes used for original plan admission.
        byte[] snapshot = bytes.ToArray();
        ValidateArtifactBytes(reference, snapshot);
        return snapshot;
    }

    internal static OfflineMigrationApplyJournalVerifier CreateBoundJournalVerifier(
        OfflineMigrationPlan plan, CurrentSchemaArtifactReference artifact, string invocationId,
        IOfflineMigrationApplyOperationRegistry operations)
    {
        ArgumentNullException.ThrowIfNull(operations);
        var journal = new OfflineMigrationApplyJournalVerifier(plan, artifact, invocationId);
        // The same actual owners used for postconditions declare media requirements
        // before any native entry is streamed. Neither journal JSON nor a flag can
        // replace this binding; VerifyExistingAsync re-enters this exact path.
        journal.BindOperationOwners(operations);
        return journal;
    }

    internal static void ValidateFirstAdmission(OfflineMigrationPlan plan,
        OfflineMigrationCurrentSchemaVerifyRequest request, OfflineMigrationApplyJournalEntry first)
    {
        var verifier = new OfflineMigrationApplyJournalVerifier(plan, request.Plan, request.InvocationId);
        verifier.Accept(first);
        if (first.State != OfflineMigrationApplyJournalState.AttemptStarted || first.RecordedAt == default)
        {
            throw new InvalidOperationException("current_verify_first_admission_missing");
        }
    }

    internal static async Task<CurrentSchemaDatabaseIdentity> ReadNativeIdentityAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        var cleanupFailures = ImmutableArray.CreateBuilder<string>(2);
        DbCommand command = OfflineMigrationStateStore.NativeCommand(connection, transaction, """
            SELECT control.system_identifier::text, database_identity.oid::text, current_database()::text
            FROM pg_catalog.pg_control_system() AS control
            CROSS JOIN pg_catalog.pg_database AS database_identity
            WHERE database_identity.datname = current_database()
            """);
        DbDataReader? reader = null;
        CurrentSchemaDatabaseIdentity? result = null;
        Exception? failure = null;
        try
        {
            reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException("current_verify_native_identity_unobserved");
            }
            result = new CurrentSchemaDatabaseIdentity(CurrentSchemaProviderKind.PostgreSql,
                reader.GetString(0), $"{reader.GetString(1)}/{reader.GetString(2)}");
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException("current_verify_native_identity_ambiguous");
            }
            CurrentSchemaReceiptCodec.ValidateDatabase(result);
        }
        catch (Exception primary)
        {
            failure = primary;
        }
        // ReadyForQuery may still be pending after the final false ReadAsync.
        // Await both owned disposals without replacing an identity/body refusal.
        if (reader is not null)
        {
            try
            {
                await reader.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception cleanup)
            {
                failure ??= cleanup;
                cleanupFailures.Add("current_verify_native_identity_reader_cleanup_failed");
            }
        }
        try
        {
            await command.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception cleanup)
        {
            failure ??= cleanup;
            cleanupFailures.Add("current_verify_native_identity_command_cleanup_failed");
        }
        if (failure is not null)
        {
            if (cleanupFailures.Count > 0)
            {
                // Fixed codes only: no secondary exception, message, SQL or row data.
                failure.Data[NativeIdentityCleanupFailuresKey] = cleanupFailures.ToImmutable();
            }
            ExceptionDispatchInfo.Capture(failure).Throw();
        }
        return result!;
    }

    private static async Task<OfflineMigrationApplyJournalEntry> ReadNativeEntryAsync(
        OfflineMigrationPlan plan, OfflineMigrationCurrentSchemaVerifyRequest request, long sequence,
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        await using DbCommand command = OfflineMigrationStateStore.NativeCommand(connection, transaction, """
            SELECT entry_digest, parent_digest,
                CASE WHEN octet_length(entry_payload) <= 1048576 THEN entry_payload ELSE NULL END
            FROM public.__fsus_schema_offline_apply_journal
            WHERE plan_digest = @plan AND database_digest = @database
                AND invocation_id = @invocation AND sequence = @sequence
            """);
        OfflineMigrationStateStore.Parameter(command, "@plan", plan.ContentDigest);
        OfflineMigrationStateStore.Parameter(command, "@database", OfflineMigrationPlanValidation.Digest(request.Database));
        OfflineMigrationStateStore.Parameter(command, "@invocation", request.InvocationId);
        OfflineMigrationStateStore.Parameter(command, "@sequence", sequence);
        await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false) || reader.IsDBNull(2))
        {
            throw new InvalidOperationException("current_verify_native_anchor_missing_or_oversized");
        }
        OfflineMigrationApplyJournalEntry entry = JsonSerializer.Deserialize<OfflineMigrationApplyJournalEntry>(
            reader.GetString(2), s_artifactJson) ?? throw new InvalidOperationException("current_verify_native_anchor_null");
        if (entry.Plan != request.Plan || entry.PlanContentDigest != plan.ContentDigest || entry.Database != request.Database
            || entry.InvocationId != request.InvocationId || entry.Sequence != sequence
            || entry.ContentDigest != reader.GetString(0) || entry.PreviousDigest != reader.GetString(1)
            || entry.ContentDigest != OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(entry)
            || await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("current_verify_native_anchor_changed");
        }
        return entry;
    }

    private static void RequireReference(CurrentSchemaArtifactReference reference)
    {
        ArgumentNullException.ThrowIfNull(reference);
        OfflineMigrationPlanValidation.RequireText(reference.Reference, "current_verify_artifact_reference_missing");
        CurrentSchemaReceiptCodec.RequireDigest(reference.Sha256);
        if (reference.Reference.Split('/', '\\').Any(value => value.Equals("latest", StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException("current_verify_latest_reference_forbidden");
        }
    }

    private static bool FactsValid(ImmutableArray<OfflineMigrationFact> facts)
        => !facts.IsDefaultOrEmpty && facts.Length <= 256
            && facts.All(value => value is not null && !string.IsNullOrWhiteSpace(value.Name)
                && value.Name.Length <= 160 && value.Value is not null && value.Value.Length <= 4096)
            && facts.Select(value => value.Name).SequenceEqual(
                facts.Select(value => value.Name).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal));

}
