using System.Collections.Immutable;
using System.Data.Common;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Contracts.SchemaMigration;

namespace FsusBlog.Migration;

// These are producer outputs, not public receipt constructors or apply grants.
internal sealed record PgLegacyNonArticleTableProof(
    string Owner, string Table, string ColumnBindingDigest, long Rows, string DataDigest);
internal sealed record PgLegacyNonArticleRecoveryData(
    string Format, CurrentSchemaArtifactReference Plan, string PlanContentDigest,
    CurrentSchemaArtifactReference SourceArtifact, CurrentSchemaArtifactReference CurrentArtifact,
    OfflineMigrationSourceObservation Source, CurrentSchemaIdentity Target,
    string OwnedInputDigest, CurrentSchemaVerifierIdentity Tool, string InvocationId, Guid MediaRunId,
    string IsolatedSchema, long UserMinimumNext, ImmutableArray<PgLegacyNonArticleTableProof> Tables);

internal sealed partial class PgLegacyNonArticlePreparation
{
    internal const string RecoveryFormat = "fsusblog.pg-legacy-nonarticle-recovery.v1";
    internal const string RecoveryReferenceFact = "nonarticle.artifact.reference";
    internal const string RecoveryDigestFact = "nonarticle.artifact.sha256";
    private CurrentSchemaArtifactReference? _recoveryArtifact;
    private PgLegacyNonArticleRecoveryData? _recoveryData;
    private OwnedRetainedMigrationTool? _recoveryTool;
    private long _recoveryMaximumInputBytes;
    private static readonly JsonSerializerOptions s_recoveryJson = new()
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        PropertyNameCaseInsensitive = false
    };

    internal CurrentSchemaArtifactReference RecoveryArtifact => _recoveryArtifact
        ?? throw new InvalidOperationException("legacy_nonarticle_recovery_not_published");

    // Only the original privately created native capability can publish expected
    // facts after full same-TX source/readback and successful native cleanup. The
    // original journal must subsequently commit this exact reference and byte SHA.
    internal async Task<CurrentSchemaArtifactReference> PublishRecoveryAsync(
        PgArticlePreservationOperation.PgArticlePreservationStage actualArticleStage,
        OwnedRetainedMigrationTool actualTool, VerifiedOfflineMigrationPlan verified,
        CurrentSchemaArtifactReference planArtifact, CurrentSchemaArtifactReference sourceArtifact,
        CurrentSchemaArtifactReference currentArtifact, string invocationId, Guid mediaRunId,
        string absoluteOutputPath, long maximumInputBytes, DbConnection connection, DbTransaction transaction,
        CancellationToken cancellationToken)
    {
        _ = Stage.RequireOriginalSession(connection, transaction);
        if (!ReferenceEquals(actualArticleStage.OriginalStage, _stage) || actualArticleStage.SourceArtifact != sourceArtifact
            || actualArticleStage.CurrentArtifact != currentArtifact || actualArticleStage.Database != _source.Database)
            throw new InvalidOperationException("legacy_nonarticle_recovery_original_article_stage_changed");
        if (!_removed || _userMinimumNext is null || _recoveryArtifact is not null)
            throw new InvalidOperationException("legacy_nonarticle_recovery_publication_phase_invalid");
        PgArticlePreservationOperation.RequireInvocation(invocationId);
        if (mediaRunId == Guid.Empty)
            throw new InvalidOperationException("legacy_nonarticle_recovery_run_missing");
        CurrentSchemaVerifierIdentity tool = await actualTool.RevalidateAsync(cancellationToken).ConfigureAwait(false);
        await RequireOriginalInputsAsync(_owned, verified, planArtifact, sourceArtifact, currentArtifact,
            tool, maximumInputBytes, cancellationToken).ConfigureAwait(false);
        await actualArticleStage.RevalidateAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        PgLegacyCurrentSchemaPreparation.RequireUnchangedSource(_source, verified.Plan.Source);
        await RevalidateCurrentAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        var tables = _programs.OrderBy(static program => program.Owner, StringComparer.Ordinal)
            .Select(program => new PgLegacyNonArticleTableProof(program.Owner, program.Table.Name,
                ColumnBindingDigest(program), _currentCounts[program.Owner], _currentDigests[program.Owner])).ToImmutableArray();
        var data = new PgLegacyNonArticleRecoveryData(RecoveryFormat, planArtifact, verified.Plan.ContentDigest,
            sourceArtifact, currentArtifact, _source, _owned.Target,
            CurrentSchemaOwnedTargetProjection.ComputeInputDigest(_owned.ReadBoundInput()), tool,
            invocationId, mediaRunId, _schemaName, _userMinimumNext.Value, tables);
        RequireCompleteRecoveryData(data, _programs);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(data, s_recoveryJson);
        if (bytes.Length > CurrentSchemaReceiptCodec.MaximumEncodedBytes)
            throw new InvalidOperationException("legacy_nonarticle_recovery_artifact_budget");
        CurrentSchemaArtifactReference published = await OfflineMigrationArtifactPublisher.PublishAsync(
            absoluteOutputPath, bytes, cancellationToken).ConfigureAwait(false);
        ReadOnlyMemory<byte> reread = await new OfflineMigrationCurrentSchemaArtifactReader().ReadAsync(published, cancellationToken).ConfigureAwait(false);
        if (!reread.Span.SequenceEqual(bytes))
            throw new InvalidOperationException("legacy_nonarticle_recovery_published_bytes_changed");
        await RevalidateCurrentAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        if (await actualTool.RevalidateAsync(cancellationToken).ConfigureAwait(false) != tool)
            throw new InvalidOperationException("legacy_nonarticle_recovery_producer_changed");
        _recoveryData = data;
        _recoveryTool = actualTool;
        _recoveryMaximumInputBytes = maximumInputBytes;
        _recoveryArtifact = published;
        return published;
    }

    // Locators are inputs, never authority. Re-read the exact native full journal
    // with its original closed compiled registry and checkpoint. Only the actual
    // committed unit's After facts can select a recovery artifact; an orphan
    // publication, Plan/CLI hash, or caller-created verifier is insufficient.
    internal static async Task<PgLegacyNonArticlePreparation> ReadCommittedAsync(
        OwnedCurrentSchemaTarget owned, OwnedRetainedMigrationTool actualTool,
        VerifiedOfflineMigrationPlan verified, CurrentSchemaArtifactReference planArtifact,
        OfflineMigrationApplyCheckpoint checkpoint, IOfflineMigrationApplyOperationRegistry originalRegistry,
        CurrentSchemaArtifactReference sourceArtifact, CurrentSchemaArtifactReference currentArtifact,
        Guid mediaRunId, long maximumInputBytes, DbConnection connection, DbTransaction transaction,
        CancellationToken cancellationToken)
    {
        OfflineMigrationSourceObserver.RequirePostgreSqlStageSession(connection, transaction);
        CurrentSchemaVerifierIdentity tool = await actualTool.RevalidateAsync(cancellationToken).ConfigureAwait(false);
        await RequireOriginalInputsAsync(owned, verified, planArtifact, sourceArtifact, currentArtifact,
            tool, maximumInputBytes, cancellationToken).ConfigureAwait(false);
        CurrentSchemaDatabaseIdentity database = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        if (database != verified.Plan.Source.Database)
            throw new InvalidOperationException("legacy_nonarticle_recovery_database_changed");
        var progress = new OfflineMigrationApplyJournalVerifier(verified.Plan, planArtifact, checkpoint.InvocationId);
        progress.BindOperationOwners(originalRegistry);
        await OfflineMigrationStateStore.ReadApplyJournalAsync(connection, transaction, verified.Plan.ContentDigest,
            database, new(checkpoint.InvocationId, 1, false, checkpoint), progress, cancellationToken).ConfigureAwait(false);
        OfflineMigrationStep step = verified.Plan.OrderedSteps.Single(value => value.StepId == PgArticlePreservationOperation.StepReference);
        OfflineMigrationProviderOperation identity = step.Operations.Single(value => value.Provider == CurrentSchemaProviderKind.PostgreSql);
        if (originalRegistry.Resolve(step, identity) is not PgArticlePreservationOperation actualOwner)
            throw new InvalidOperationException("legacy_nonarticle_recovery_original_operation_missing");
        actualOwner.RequireStep(step, identity);
        actualOwner.RequireRecoveryInputBinding(sourceArtifact, currentArtifact, mediaRunId, tool);
        if (!PgArticlePreservationOperation.RequiresCommittedTarget(progress, step.StepId, identity))
            throw new InvalidOperationException("legacy_nonarticle_recovery_committed_unit_missing");
        OfflineMigrationApplyJournalEntry unit = (progress.PendingUnit?.StepId == step.StepId ? progress.PendingUnit
            : progress.StepProofs.Single(value => value.StepId == step.StepId))
            ?? throw new InvalidOperationException("legacy_nonarticle_recovery_committed_unit_missing");
        CurrentSchemaArtifactReference artifact = ArtifactFromCommittedObservation(unit.After!);
        ReadOnlyMemory<byte> bytes = await new OfflineMigrationCurrentSchemaArtifactReader().ReadAsync(artifact, cancellationToken).ConfigureAwait(false);
        PgLegacyNonArticleRecoveryData data = JsonSerializer.Deserialize<PgLegacyNonArticleRecoveryData>(bytes.Span, s_recoveryJson)
            ?? throw new InvalidOperationException("legacy_nonarticle_recovery_artifact_invalid");
        if (!bytes.Span.SequenceEqual(JsonSerializer.SerializeToUtf8Bytes(data, s_recoveryJson)))
            throw new InvalidOperationException("legacy_nonarticle_recovery_artifact_noncanonical");
        IReadOnlyList<LegacyTableProgram> programs = Compile(owned.ReadBoundInput(), Quote(data.IsolatedSchema));
        RequireCompleteRecoveryData(data, programs);
        RequireRecoveryBinding(data, owned, verified, planArtifact, sourceArtifact, currentArtifact, tool,
            checkpoint.InvocationId, mediaRunId);
        if (unit.Media?.Binding.RunId != mediaRunId)
            throw new InvalidOperationException("legacy_nonarticle_recovery_media_run_changed");
        var recovered = new PgLegacyNonArticlePreparation(null, owned, data.Source, data.IsolatedSchema, programs)
        {
            _removed = true,
            _userMinimumNext = data.UserMinimumNext,
            _recoveryArtifact = artifact,
            _recoveryData = data,
            _recoveryTool = actualTool,
            _recoveryMaximumInputBytes = maximumInputBytes
        };
        foreach (PgLegacyNonArticleTableProof table in data.Tables)
        {
            recovered._currentCounts.Add(table.Owner, table.Rows);
            recovered._currentDigests.Add(table.Owner, table.DataDigest);
        }
        // A payload seal cannot bypass actual full target/catalog/native data.
        await recovered.RevalidateCurrentAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        if (await actualTool.RevalidateAsync(cancellationToken).ConfigureAwait(false) != tool)
            throw new InvalidOperationException("legacy_nonarticle_recovery_producer_changed");
        return recovered;
    }

    internal static CurrentSchemaArtifactReference ArtifactFromCommittedObservation(OfflineMigrationPredicateObservation observation)
    {
        ImmutableArray<OfflineMigrationFact> actual = OfflineMigrationPlanValidation.NormalizeFacts(observation.ActualFacts);
        if (!OfflineMigrationPlanValidation.Equal(actual, OfflineMigrationPlanValidation.NormalizeFacts(observation.ExpectedFacts)))
            throw new InvalidOperationException("legacy_nonarticle_recovery_observation_mismatch");
        string reference = actual.Single(value => value.Name == RecoveryReferenceFact).Value;
        string digest = actual.Single(value => value.Name == RecoveryDigestFact).Value;
        OfflineMigrationPlanValidation.RequireDigest(digest, "legacy_nonarticle_recovery_artifact_digest_invalid");
        if (!Path.IsPathFullyQualified(reference) || Path.GetFullPath(reference) != reference || reference.Any(char.IsControl))
            throw new InvalidOperationException("legacy_nonarticle_recovery_artifact_reference_invalid");
        return new(reference, digest);
    }

    internal static void RequireCompleteRecoveryData(PgLegacyNonArticleRecoveryData data, IReadOnlyList<LegacyTableProgram> programs)
    {
        if (data.Format != RecoveryFormat || data.Tables.IsDefault || data.Tables.Length != programs.Count
            || data.Tables.Any(static table => table is null) || data.IsolatedSchema is null
            || programs.Count != 11 || data.MediaRunId == Guid.Empty || data.UserMinimumNext < 1
            || data.IsolatedSchema.Length != "__fsus_legacy_stage_".Length + 32
            || !data.IsolatedSchema.StartsWith("__fsus_legacy_stage_", StringComparison.Ordinal)
            || data.IsolatedSchema["__fsus_legacy_stage_".Length..].Any(static value => value is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
            throw new InvalidOperationException("legacy_nonarticle_recovery_closure_incomplete");
        PgLegacyNonArticleTableProof[] proofs = data.Tables.OrderBy(static value => value.Owner, StringComparer.Ordinal).ToArray();
        LegacyTableProgram[] expected = programs.OrderBy(static value => value.Owner, StringComparer.Ordinal).ToArray();
        for (int index = 0; index < proofs.Length; index++)
        {
            PgLegacyNonArticleTableProof proof = proofs[index];
            if (proof.Owner != expected[index].Owner || proof.Table != expected[index].Table.Name
                || proof.ColumnBindingDigest != ColumnBindingDigest(expected[index]) || proof.Rows < 0)
                throw new InvalidOperationException("legacy_nonarticle_recovery_table_binding_changed");
            OfflineMigrationPlanValidation.RequireDigest(proof.DataDigest, "legacy_nonarticle_recovery_data_digest_invalid");
        }
    }

    internal static string ColumnBindingDigest(LegacyTableProgram program)
        => OfflineMigrationPlanValidation.Digest(new
        {
            program.Owner,
            Table = program.Table.Name,
            Columns = program.Table.Columns.Values.OrderBy(static value => value.Name, StringComparer.Ordinal).ToArray()
        });

    private static void RequireRecoveryBinding(PgLegacyNonArticleRecoveryData data, OwnedCurrentSchemaTarget owned,
        VerifiedOfflineMigrationPlan verified, CurrentSchemaArtifactReference planArtifact,
        CurrentSchemaArtifactReference sourceArtifact, CurrentSchemaArtifactReference currentArtifact,
        CurrentSchemaVerifierIdentity tool, string invocationId, Guid mediaRunId)
    {
        PgLegacyCurrentSchemaPreparation.RequireUnchangedSource(verified.Plan.Source, data.Source);
        if (data.Plan != planArtifact || data.PlanContentDigest != verified.Plan.ContentDigest || data.SourceArtifact != sourceArtifact
            || data.CurrentArtifact != currentArtifact || data.Target != owned.Target || data.Tool != tool
            || data.InvocationId != invocationId || data.MediaRunId != mediaRunId
            || data.OwnedInputDigest != CurrentSchemaOwnedTargetProjection.ComputeInputDigest(owned.ReadBoundInput()))
            throw new InvalidOperationException("legacy_nonarticle_recovery_original_binding_changed");
    }

    // Also used on every later native target revalidation, not just at initial
    // restoration. Neither an edited proof file nor changed retained inputs can
    // keep an already constructed capability valid.
    private async Task RevalidateRecoveryPublicationAsync(CancellationToken cancellationToken)
    {
        if (_recoveryArtifact is null)
            return; // Original same-TX native capability, before publication.
        if (_recoveryData is null || _recoveryTool is null || _recoveryMaximumInputBytes <= 0)
            throw new InvalidOperationException("legacy_nonarticle_recovery_retention_missing");
        ReadOnlyMemory<byte> bytes = await new OfflineMigrationCurrentSchemaArtifactReader().ReadAsync(_recoveryArtifact, cancellationToken).ConfigureAwait(false);
        if (!bytes.Span.SequenceEqual(JsonSerializer.SerializeToUtf8Bytes(_recoveryData, s_recoveryJson))
            || await _recoveryTool.RevalidateAsync(cancellationToken).ConfigureAwait(false) != _recoveryData.Tool
            || _recoveryData.OwnedInputDigest != CurrentSchemaOwnedTargetProjection.ComputeInputDigest(_owned.ReadBoundInput()))
            throw new InvalidOperationException("legacy_nonarticle_recovery_retained_producer_changed");
        await new OfflineMigrationCurrentSchemaArtifactReader().ReadAsync(_recoveryData.Plan, cancellationToken).ConfigureAwait(false);
        await RequireOriginalArtifactAsync(_recoveryData.SourceArtifact, _recoveryMaximumInputBytes, cancellationToken).ConfigureAwait(false);
        await RequireOriginalArtifactAsync(_recoveryData.CurrentArtifact, _recoveryMaximumInputBytes, cancellationToken).ConfigureAwait(false);
    }

    private static async Task RequireOriginalInputsAsync(OwnedCurrentSchemaTarget owned, VerifiedOfflineMigrationPlan verified,
        CurrentSchemaArtifactReference planArtifact, CurrentSchemaArtifactReference sourceArtifact,
        CurrentSchemaArtifactReference currentArtifact, CurrentSchemaVerifierIdentity tool,
        long maximumInputBytes, CancellationToken cancellationToken)
    {
        CurrentSchemaIdentity target = owned.Target;
        CurrentSchemaTargetIdentity recordedTarget = verified.Plan.Target;
        if (maximumInputBytes <= 0 || tool != verified.Plan.Tool || tool.SourceRevision != owned.Execution.SourceRevision
            || recordedTarget.ModelVersion != target.ModelVersion || recordedTarget.ExtractorVersion != target.ExtractorVersion
            || recordedTarget.GeneratorVersion != target.GeneratorVersion || recordedTarget.SourceDigest != target.SourceDigest
            || recordedTarget.ContentDigest != target.ContentDigest
            || OfflineMigrationSourceFingerprints.CreateRegistry().Match(verified.Plan.Source).Id != OfflineMigrationSourceFingerprints.LegacyId)
            throw new InvalidOperationException("legacy_nonarticle_recovery_original_tool_changed");
        await owned.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        ReadOnlyMemory<byte> plan = await new OfflineMigrationCurrentSchemaArtifactReader().ReadAsync(planArtifact, cancellationToken).ConfigureAwait(false);
        if (!plan.Span.SequenceEqual(OfflineMigrationPlanCodec.Serialize(verified.Plan))
            || verified.Plan.ContentDigest != OfflineMigrationPlanCodec.ComputeContentDigest(verified.Plan))
            throw new InvalidOperationException("legacy_nonarticle_recovery_original_plan_changed");
        await RequireOriginalArtifactAsync(sourceArtifact, maximumInputBytes, cancellationToken).ConfigureAwait(false);
        await RequireOriginalArtifactAsync(currentArtifact, maximumInputBytes, cancellationToken).ConfigureAwait(false);
    }

    private static async Task RequireOriginalArtifactAsync(CurrentSchemaArtifactReference reference,
        long maximumInputBytes, CancellationToken cancellationToken)
    {
        OfflineMigrationPlanValidation.RequireDigest(reference.Sha256, "legacy_nonarticle_recovery_original_digest_invalid");
        using var handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(reference.Reference, cancellationToken);
        var initial = OfflineMigrationCurrentSchemaArtifactReader.CaptureOriginalRegularFileIdentity(reference.Reference, handle, cancellationToken);
        var stream = new FileStream(handle, FileAccess.Read, 4096);
        string digest = await WithResourceAsync(stream, async input =>
        {
            if (input.Length is <= 0 || input.Length > maximumInputBytes)
                throw new InvalidOperationException("legacy_nonarticle_recovery_original_artifact_budget");
            using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            byte[] buffer = new byte[64 * 1024];
            long bytes = 0;
            int count;
            while ((count = await input.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false)) != 0)
            {
                bytes = checked(bytes + count);
                if (bytes > maximumInputBytes)
                    throw new InvalidOperationException("legacy_nonarticle_recovery_original_artifact_budget");
                hash.AppendData(buffer.AsSpan(0, count));
            }
            OfflineMigrationCurrentSchemaArtifactReader.ValidateOriginalRegularFileUnchanged(reference.Reference, handle, initial, cancellationToken);
            return Convert.ToHexStringLower(hash.GetHashAndReset());
        }).ConfigureAwait(false);
        if (digest != reference.Sha256)
            throw new InvalidOperationException("legacy_nonarticle_recovery_original_artifact_changed");
    }
}
