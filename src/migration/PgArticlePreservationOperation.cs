using System.Collections.Immutable;
using System.Data.Common;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

// These are explicit original-input locators and finite limits, not an admission grant.
// InvocationId remains the Host's opaque identifier; MediaRunId is the media owner's GUID.
internal sealed record PgArticlePreservationMediaConfiguration(
    Guid MediaRunId, string SourceAssetRoot, Uri TrustedSiteOrigin, string PublicPathPrefix,
    string TargetParent, string TargetDirectoryName, ArticlePreservationLimits ProjectionLimits,
    ArticleMediaLimits MediaLimits, ArticlePreservationWriteLimits WriteLimits, TimeSpan SourceReadBudget);

internal sealed record PgArticlePreservationRecoveryConfiguration(
    OwnedRetainedMigrationTool Tool, string AbsoluteOutputPath, long MaximumInputBytes);

// The factory independently reads original artifacts, captures actual historical rows and
// inventories native media. No caller DTO, payload seal or stage flag creates this operation.
// Only PostgreSQL is implemented here. Other provider/DAG entries remain unregistered.
internal sealed class PgArticlePreservationOperation : OfflineMigrationArticleMediaOperation
{
    internal const string StepReference = "legacy-20260517-to-current";
    internal const string SourcePredicate = "article-preservation-original-source.v1";
    internal const string TargetPredicate = "article-preservation-current-graph-and-media.v1";
    private readonly OwnedCurrentSchemaTarget _owned;
    private readonly CurrentSchemaArtifactReference _sourceReference;
    private readonly CurrentSchemaArtifactReference _currentReference;
    private ArticlePreservationSourceExport _source = null!;
    private ArticlePreservationCurrentExport _current = null!;
    private ArticlePreservationWritePlan _plan = null!;
    private OfflineMigrationSourceObservation _observation = null!;
    private bool _nativeCaptured;
    private bool _publishedRead;
    private OfflineMigrationApplyJournalVerifier? _verifiedProgress;
    private readonly PgArticlePreservationMediaConfiguration _configuration;
    private string _targetRootIdentity = null!;
    private readonly CurrentSchemaArtifactReference _assembly;
    private OfflineMigrationMediaJournalEvidence? _binding;
    private ArticleMediaPublication? _publication;
    private PgLegacyNonArticlePreparation? _nonArticle;
    private PgArticlePreservationRecoveryConfiguration? _recoveryConfiguration;
    private VerifiedOfflineMigrationPlan? _verifiedPlan;
    private CurrentSchemaArtifactReference? _verifiedPlanArtifact;
    private IOfflineMigrationApplyOperationRegistry? _verifiedRegistry;
    private OfflineMigrationApplyCheckpoint? _verifiedCheckpoint;

    private PgArticlePreservationOperation(OwnedCurrentSchemaTarget owned, CurrentSchemaArtifactReference source,
        CurrentSchemaArtifactReference current, PgArticlePreservationMediaConfiguration configuration,
        CurrentSchemaArtifactReference assembly, CurrentSchemaVerifierIdentity tool)
    {
        _owned = owned;
        _sourceReference = source;
        _currentReference = current;
        _configuration = configuration;
        _assembly = assembly;
        RetainedTool = tool;
        string semantic = ArticlePreservationSemanticReceipt.Digest("pg-article-preservation-operation-v1", new
        {
            Source = SourcePredicate,
            Target = TargetPredicate,
            CurrentTarget = owned.Target,
            SourceArtifact = source,
            CurrentArtifact = current,
            configuration.MediaRunId,
            configuration.SourceAssetRoot,
            configuration.TargetParent,
            configuration.TrustedSiteOrigin,
            configuration.PublicPathPrefix,
            configuration.TargetDirectoryName
        });
        Identity = new(CurrentSchemaProviderKind.PostgreSql, "compiled-pg:" + StepReference,
            assembly.Sha256, semantic, OfflineMigrationExecutionMode.Transaction);
        Step = new(StepReference, SourcePredicate, TargetPredicate, [],
            "whole-legacy-graph-media-transaction.v1", true,
            new("article-preservation-transaction-resume.v1", 0, "no-partial-transaction-watermark", TargetPredicate), [Identity]);
    }

    internal override OfflineMigrationProviderOperation Identity
    {
        get;
    }
    internal OfflineMigrationStep Step
    {
        get;
    }
    internal CurrentSchemaVerifierIdentity RetainedTool
    {
        get;
    }

    // Mandatory for this whole-legacy operation: a caller-owned finite artifact
    // locator and the actual original retained-tool capability, not a tool DTO.
    internal async Task BindRecoveryOwnerAsync(PgArticlePreservationRecoveryConfiguration configuration, CancellationToken token)
    {
        RequireRecoveryConfiguration(configuration);
        if (await configuration.Tool.RevalidateAsync(token).ConfigureAwait(false) != RetainedTool)
            throw new InvalidOperationException("article_preservation_operation_recovery_tool_changed");
        if (_recoveryConfiguration is not null && _recoveryConfiguration != configuration)
            throw new InvalidOperationException("article_preservation_operation_recovery_configuration_changed");
        _recoveryConfiguration = configuration;
    }

    // Phase one retains a real compiled descriptor without SQL or a source/media admission.
    // Resolve remains synchronous. The original Core's fresh RR boundary performs phase two.
    internal static async Task<PgArticlePreservationOperation> CreateAsync(
        CurrentSchemaArtifactReference sourceArtifact, CurrentSchemaArtifactReference currentArtifact,
        OwnedCurrentSchemaTarget owned, CurrentSchemaVerifierIdentity actualRetainedTool,
        PgArticlePreservationMediaConfiguration configuration, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(owned);
        ArgumentNullException.ThrowIfNull(actualRetainedTool);
        RequireConfiguration(configuration);
        if (actualRetainedTool.SourceRevision != owned.Execution.SourceRevision)
            throw new InvalidOperationException("article_preservation_operation_tool_source");
        OfflineMigrationPlanValidation.RequireDigest(actualRetainedTool.WorktreeDigest, "article_preservation_operation_tool_worktree");
        OfflineMigrationPlanValidation.RequireDigest(actualRetainedTool.ToolchainDigest, "article_preservation_operation_toolchain");
        OfflineMigrationPlanValidation.RequireDigest(actualRetainedTool.ConfigurationDigest, "article_preservation_operation_tool_configuration");
        await owned.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        if (sourceArtifact is null || currentArtifact is null
            || !ArticlePreservationSemanticReceipt.IsDigest(sourceArtifact.Sha256)
            || !ArticlePreservationSemanticReceipt.IsDigest(currentArtifact.Sha256))
            throw new InvalidOperationException("article_preservation_operation_artifact_reference_invalid");
        string assemblyPath = Path.GetFullPath(typeof(PgArticlePreservationOperation).Assembly.Location);
        using var assemblyHandle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(assemblyPath, cancellationToken);
        var assemblyIdentity = OfflineMigrationCurrentSchemaArtifactReader.CaptureOriginalRegularFileIdentity(
            assemblyPath, assemblyHandle, cancellationToken);
        var assemblyStream = new FileStream(assemblyHandle, FileAccess.Read, 4096);
        string assemblyDigest = await PreserveFirstAsync(assemblyStream,
            async () =>
            {
                string digest = Convert.ToHexStringLower(await SHA256.HashDataAsync(assemblyStream, cancellationToken).ConfigureAwait(false));
                OfflineMigrationCurrentSchemaArtifactReader.ValidateOriginalRegularFileUnchanged(
                    assemblyPath, assemblyHandle, assemblyIdentity, cancellationToken);
                return digest;
            })
            .ConfigureAwait(false);
        return new(owned, sourceArtifact, currentArtifact, configuration, new(assemblyPath, assemblyDigest), actualRetainedTool);
    }

    private async Task MaterializePublishedAsync(CancellationToken cancellationToken)
    {
        if (_publishedRead)
            return;
        OwnedCurrentSchemaTarget owned = _owned;
        PgArticlePreservationMediaConfiguration configuration = _configuration;
        CurrentSchemaArtifactReference sourceArtifact = _sourceReference;
        CurrentSchemaArtifactReference currentArtifact = _currentReference;
        await owned.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        ImmutableArray<byte> sourceBytes = await ReadArtifactAsync(sourceArtifact,
            configuration.WriteLimits.MaximumArtifactBytes, cancellationToken).ConfigureAwait(false);
        ArticlePreservationSourceData data = Deserialize<ArticlePreservationSourceData>(sourceBytes);
        _ = await ReadArtifactAsync(data.OriginArtifact, configuration.WriteLimits.MaximumArtifactBytes,
            cancellationToken).ConfigureAwait(false);
        var source = new ArticlePreservationSourceExport(sourceArtifact, sourceBytes, data);
        ImmutableArray<byte> currentBytes = await ReadArtifactAsync(currentArtifact,
            configuration.WriteLimits.MaximumArtifactBytes, cancellationToken).ConfigureAwait(false);
        CurrentEnvelope envelope = Deserialize<CurrentEnvelope>(currentBytes);
        var current = new ArticlePreservationCurrentExport(currentArtifact, currentBytes,
            envelope.Categories, envelope.Tags, envelope.Articles, envelope.DefaultPolicy);
        ArticleMediaInventory media = await InventoryAsync(source, configuration, cancellationToken).ConfigureAwait(false);
        ArticlePreservationWritePlan plan = ArticlePreservationProjection.Project(source, current, media,
            configuration.ProjectionLimits, configuration.MediaLimits, cancellationToken);
        ArticlePreservationStorageWriter.RequireRows(
            ArticlePreservationStorageProgram.Compile(plan, owned, cancellationToken).Rows, configuration.WriteLimits);
        await RequirePublishedInputsAsync(source, current, configuration.WriteLimits.MaximumArtifactBytes,
            cancellationToken).ConfigureAwait(false);
        using var sourceRoot = ArticleMediaDirectory.Open(configuration.SourceAssetRoot, writable: false);
        using var target = ArticleMediaDirectory.Open(configuration.TargetParent, writable: true);
        if (sourceRoot.Identity != media.SourceRootIdentity || sourceRoot.Overlaps(target))
            throw new InvalidOperationException("article_preservation_operation_media_roots");
        // No partially verified capture escapes if any original input fails.
        _source = source;
        _current = current;
        _plan = plan;
        _targetRootIdentity = target.Identity;
        _publishedRead = true;
    }

    private async Task MaterializeOriginalAsync(DbConnection connection, DbTransaction transaction, CancellationToken token)
    {
        await MaterializePublishedAsync(token).ConfigureAwait(false);
        if (_nativeCaptured)
            return;
        OfflineMigrationSourceObserver.RequirePostgreSqlStageSession(connection, transaction);
        ArticlePreservationSourceReadResult actual = await ArticlePreservationSourceReader.ReadApplyAsync(
            connection, transaction, new OfflineMigrationSourceObserver(), _source.Data.OriginArtifact,
            _source.Data.DocumentBase, _configuration.ProjectionLimits, _configuration.SourceReadBudget, token).ConfigureAwait(false);
        ArticlePreservationSourceExport source = ArticlePreservationPolicyExporter.PrepareSource(actual, _source.Artifact.Reference, token);
        if (source.Artifact != _source.Artifact || !source.Bytes.AsSpan().SequenceEqual(_source.Bytes.AsSpan()))
            throw new InvalidOperationException("article_preservation_operation_native_source_export_changed");
        _observation = actual.Observation;
        _nativeCaptured = true;
    }

    // Called by the original admission owner after streaming/Accept of the full journal
    // bound to the original closed registry. This does not turn a plan DTO into source facts.
    internal async Task BindVerifiedProgressAsync(VerifiedOfflineMigrationPlan verified,
        CurrentSchemaArtifactReference artifact, OfflineMigrationApplyJournalVerifier progress,
        IOfflineMigrationApplyOperationRegistry originalRegistry, CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(originalRegistry);
        ImmutableArray<byte> original = await ReadArtifactAsync(artifact, _configuration.WriteLimits.MaximumArtifactBytes, token).ConfigureAwait(false);
        if (!original.AsSpan().SequenceEqual(OfflineMigrationPlanCodec.Serialize(verified.Plan))
            || verified.Plan.ContentDigest != OfflineMigrationPlanCodec.ComputeContentDigest(verified.Plan)
            || verified.Plan.Tool != RetainedTool)
            throw new InvalidOperationException("article_preservation_operation_plan_binding");
        RequireStep(verified.Plan.OrderedSteps.Single(step => step.StepId == StepReference), Identity);
        if (!progress.RequiresMedia(StepReference))
            throw new InvalidOperationException("article_preservation_operation_progress_owner_not_bound");
        OfflineMigrationStep actualStep = verified.Plan.OrderedSteps.Single(step => step.StepId == StepReference);
        if (!ReferenceEquals(originalRegistry.Resolve(actualStep, Identity), this))
            throw new InvalidOperationException("article_preservation_operation_progress_original_owner_changed");
        if (progress.First is { } first && (first.Plan != artifact || first.PlanContentDigest != verified.Plan.ContentDigest
            || first.Database != verified.Plan.Source.Database || progress.Last?.Plan != artifact))
            throw new InvalidOperationException("article_preservation_operation_progress_binding_changed");
        _verifiedProgress = progress.Fork();
        _verifiedPlan = verified;
        _verifiedPlanArtifact = artifact;
        _verifiedRegistry = originalRegistry;
        _verifiedCheckpoint = progress.Last is { } last
            ? new(OfflineMigrationApplyJournalVerifier.Reference(last), last.InvocationId, last.Sequence) : null;
    }

    internal static bool RequiresCommittedTarget(OfflineMigrationApplyJournalVerifier progress,
        string stepId, OfflineMigrationProviderOperation identity)
    {
        OfflineMigrationApplyJournalEntry? unit = progress.PendingUnit?.StepId == stepId ? progress.PendingUnit
            : progress.StepProofs.SingleOrDefault(entry => entry.StepId == stepId);
        if (unit is null)
            return false;
        if (!progress.RequiresMedia(stepId) || progress.First is null || unit.OperationReference != identity.OperationReference
            || unit.Mode != identity.Mode || !unit.UnitComplete || unit.Media?.GenerationIdentity is null
            || unit.After?.PredicateReference != TargetPredicate || unit.After.OperationSourceDigest != identity.OperationSourceDigest
            || unit.After.SemanticDigest != identity.SemanticDigest)
            throw new InvalidOperationException("article_preservation_operation_committed_progress_invalid");
        return true;
    }

    internal override async Task<OfflineMigrationMediaJournalEvidence> GetMediaBindingAsync(
        VerifiedOfflineMigrationPlan verified, CurrentSchemaArtifactReference artifact, string invocationId,
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        RequireInvocation(invocationId);
        PgArticlePreservationRecoveryConfiguration recovery = _recoveryConfiguration
            ?? throw new InvalidOperationException("article_preservation_operation_recovery_producer_missing");
        if (await recovery.Tool.RevalidateAsync(cancellationToken).ConfigureAwait(false) != RetainedTool)
            throw new InvalidOperationException("article_preservation_operation_recovery_tool_changed");
        await MaterializeOriginalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await RevalidateInputsAsync(cancellationToken).ConfigureAwait(false);
        // Hash the full original plan file, not its semantic ContentDigest or reserialized DTO.
        ImmutableArray<byte> bytes = await ReadArtifactAsync(artifact, _configuration.WriteLimits.MaximumArtifactBytes,
            cancellationToken).ConfigureAwait(false);
        if (!bytes.AsSpan().SequenceEqual(OfflineMigrationPlanCodec.Serialize(verified.Plan))
            || verified.Plan.ContentDigest != OfflineMigrationPlanCodec.ComputeContentDigest(verified.Plan)
            || verified.Plan.Tool != RetainedTool)
            throw new InvalidOperationException("article_preservation_operation_plan_binding");
        PgLegacyCurrentSchemaPreparation.RequireUnchangedSource(_observation, verified.Plan.Source);
        RequireStep(verified.Plan.OrderedSteps.Single(step => step.StepId == StepReference), Identity);
        await RequireOriginalSourceAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        var binding = new ArticleMediaBinding(_configuration.MediaRunId, artifact.Sha256,
            verified.Plan.ContentDigest, _observation.ContentDigest, _plan.Media.ManifestDigest,
            _plan.Media.SourceRootIdentity, _targetRootIdentity, _configuration.TargetDirectoryName);
        var evidence = new OfflineMigrationMediaJournalEvidence(invocationId, binding, null);
        if (_binding is not null && _binding != evidence)
            throw new InvalidOperationException("article_preservation_operation_media_binding_changed");
        _binding = evidence;
        _verifiedPlan = verified;
        _verifiedPlanArtifact = artifact;
        return evidence;
    }

    internal override async Task<OfflineMigrationApplyUnit> ExecuteMediaAsync(
        OfflineMigrationStep step, OfflineMigrationApplyJournalEntry? previousUnit,
        DbConnection connection, DbTransaction transaction, IArticleMediaPreservationJournal journal,
        CancellationToken cancellationToken)
    {
        RequireStep(step, Identity);
        if (previousUnit is not null || _binding is null)
            throw new InvalidOperationException("article_preservation_operation_prepared_binding_required");
        PgArticlePreservationRecoveryConfiguration recovery = _recoveryConfiguration
            ?? throw new InvalidOperationException("article_preservation_operation_recovery_producer_missing");
        VerifiedOfflineMigrationPlan verified = _verifiedPlan
            ?? throw new InvalidOperationException("article_preservation_operation_verified_plan_missing");
        CurrentSchemaArtifactReference planArtifact = _verifiedPlanArtifact
            ?? throw new InvalidOperationException("article_preservation_operation_verified_plan_missing");
        if (await recovery.Tool.RevalidateAsync(cancellationToken).ConfigureAwait(false) != RetainedTool)
            throw new InvalidOperationException("article_preservation_operation_recovery_tool_changed");
        await RevalidateInputsAsync(cancellationToken).ConfigureAwait(false);
        await RequireOriginalSourceAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        // Require the actual durable preparation before any structural or graph effect.
        if (await journal.RequirePreparedAsync(_binding.Binding, cancellationToken).ConfigureAwait(false)
            != ArticleMediaJournalState.Prepared)
            throw new InvalidOperationException("article_preservation_operation_durable_prepared_required");
        PgLegacyCurrentSchemaPreparation legacy = await PgLegacyCurrentSchemaPreparation.StageAsync(
            _owned, _observation, connection, transaction, cancellationToken).ConfigureAwait(false);
        PgLegacyNonArticlePreparation nonArticle = await PgLegacyNonArticlePreparation.MigrateAsync(
            legacy, connection, transaction, cancellationToken).ConfigureAwait(false);
        _nonArticle = nonArticle;
        ArticlePreservationStorageStage graph = await ArticlePreservationStorageWriter.StagePostgreSqlAsync(
            _plan, _source, _current, _owned, connection, transaction, _observation.Database,
            _configuration.ProjectionLimits, _configuration.MediaLimits, _configuration.WriteLimits,
            cancellationToken).ConfigureAwait(false);
        if (graph.PlanDigest != _plan.ContentDigest)
            throw new InvalidOperationException("article_preservation_operation_graph_binding");
        ArticleMediaPublication publication = await ArticleMediaPreservation.StageAndPublishAsync(
            _plan.Media, _configuration.SourceAssetRoot, _configuration.TargetParent,
            _configuration.TargetDirectoryName, _binding.Binding, _configuration.MediaLimits,
            journal, cancellationToken).ConfigureAwait(false);
        _publication = publication;
        PgArticlePreservationStage article = await PgArticlePreservationStage.CreateAsync(
            this, legacy, connection, transaction, publication, cancellationToken).ConfigureAwait(false);
        // The original nonarticle owner re-observes this opaque capability and every other
        // original domain before removing its temporary namespace. No caller boolean suffices.
        await nonArticle.CompleteAsync(article, connection, transaction, cancellationToken).ConfigureAwait(false);
        await nonArticle.RevalidateCurrentAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await article.RevalidateAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        // Publication alone is not durable provenance. Core's original transaction
        // will seal this actual reference in After and commit it with graph/media.
        _ = await nonArticle.PublishRecoveryAsync(article, recovery.Tool, verified, planArtifact,
            _source.Artifact, _current.Artifact, _binding.InvocationId, _configuration.MediaRunId,
            recovery.AbsoluteOutputPath, recovery.MaximumInputBytes, connection, transaction, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return new(null, null, null, graph.VerifiedRows, graph.VerifiedRows, true);
    }

    internal override async Task<OfflineMigrationPredicateObservation> ObserveAsync(
        string predicateReference, DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        ImmutableArray<OfflineMigrationFact> facts;
        if (predicateReference == SourcePredicate)
        {
            await MaterializeOriginalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
            await RevalidateInputsAsync(cancellationToken).ConfigureAwait(false);
            await RequireOriginalSourceAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
            facts = [new("source.content_digest", _observation.ContentDigest), new("source.export_sha256", _source.Artifact.Sha256)];
        }
        else if (predicateReference == TargetPredicate)
        {
            // Do not recapture a deleted legacy domain on committed-unit recovery.
            // A newly materialized process still needs the original verified full-journal
            // and retained nonarticle proof capability; a predicate name/plan JSON is not it.
            if (!_nativeCaptured && (_verifiedProgress is null || !RequiresCommittedTarget(_verifiedProgress, StepReference, Identity)))
                throw new InvalidOperationException("article_preservation_operation_verified_progress_capability_missing");
            await MaterializePublishedAsync(cancellationToken).ConfigureAwait(false);
            if (_nonArticle is null)
            {
                PgArticlePreservationRecoveryConfiguration recovery = _recoveryConfiguration
                    ?? throw new InvalidOperationException("article_preservation_operation_recovery_producer_missing");
                _nonArticle = await PgLegacyNonArticlePreparation.ReadCommittedAsync(_owned, recovery.Tool,
                    _verifiedPlan ?? throw new InvalidOperationException("article_preservation_operation_verified_plan_missing"),
                    _verifiedPlanArtifact ?? throw new InvalidOperationException("article_preservation_operation_verified_plan_missing"),
                    _verifiedCheckpoint ?? throw new InvalidOperationException("article_preservation_operation_verified_checkpoint_missing"),
                    _verifiedRegistry ?? throw new InvalidOperationException("article_preservation_operation_verified_registry_missing"),
                    _source.Artifact, _current.Artifact, _configuration.MediaRunId, recovery.MaximumInputBytes,
                    connection, transaction, cancellationToken).ConfigureAwait(false);
            }
            await _nonArticle.RevalidateCurrentAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
            await RevalidateTargetAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
            CurrentSchemaArtifactReference proof = _nonArticle.RecoveryArtifact;
            facts = [new("article.projection_digest", _plan.ContentDigest), new("media.manifest_digest", _plan.Media.ManifestDigest),
                new(PgLegacyNonArticlePreparation.RecoveryReferenceFact, proof.Reference),
                new(PgLegacyNonArticlePreparation.RecoveryDigestFact, proof.Sha256)];
        }
        else
            throw new InvalidOperationException("article_preservation_operation_unknown_predicate");
        // Facts are emitted only after complete native readback. A failure throws before an
        // observation exists; expected values are never substituted for unobserved rows.
        var observation = new OfflineMigrationPredicateObservation(predicateReference, Identity.OperationReference,
            Identity.OperationSourceDigest, Identity.SemanticDigest, facts, facts, string.Empty);
        return observation with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(observation)
        };
    }

    private async Task RequireOriginalSourceAsync(DbConnection connection, DbTransaction transaction, CancellationToken token)
    {
        OfflineMigrationSourceObservation actual = await new OfflineMigrationSourceObserver()
            .ObserveLegacyAfterValidatedJournalAsync(connection, transaction, token).ConfigureAwait(false);
        PgLegacyCurrentSchemaPreparation.RequireUnchangedSource(_observation, actual);
    }

    internal async Task RevalidateTargetAsync(DbConnection connection, DbTransaction transaction, CancellationToken token)
    {
        OfflineMigrationSourceObserver.RequirePostgreSqlStageSession(connection, transaction);
        await RevalidateInputsAsync(token).ConfigureAwait(false);
        CurrentSchemaDatabaseIdentity actualDatabase = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(
            connection, transaction, token).ConfigureAwait(false);
        CurrentSchemaDatabaseIdentity expectedDatabase = _nativeCaptured ? _observation.Database
            : _verifiedProgress?.First?.Database ?? throw new InvalidOperationException("article_preservation_operation_verified_progress_capability_missing");
        if (actualDatabase != expectedDatabase)
            throw new InvalidOperationException("article_preservation_operation_target_database_changed");
        _ = await new PgCurrentSchemaOwnedTargetObserver(_owned).ObserveAsync(
            connection, transaction, actualDatabase, token).ConfigureAwait(false);
        ArticlePreservationStorageProgram program = ArticlePreservationStorageProgram.Compile(_plan, _owned, token);
        ArticlePreservationStorageWriter.RequireRows(program.Rows, _configuration.WriteLimits);
        // Read-only original full-row oracle. Do not call StageRows or sequence-restarting Stage.
        await ArticlePreservationStorageWriter.VerifyRowsAsync(
            program.Rows.GroupBy(static row => row.Table, StringComparer.Ordinal), connection, transaction,
            _configuration.WriteLimits, token).ConfigureAwait(false);
        using var parent = ArticleMediaDirectory.Open(_configuration.TargetParent, writable: false);
        if (parent.Identity != _targetRootIdentity)
            throw new InvalidOperationException("article_preservation_operation_target_root_changed");
        using ArticleMediaDirectory generation = parent.TryOpenDirectory(_configuration.TargetDirectoryName)
            ?? throw new InvalidOperationException("article_preservation_operation_generation_missing");
        string expectedGeneration = _publication?.GenerationIdentity
            ?? RequireCommittedMedia().GenerationIdentity
            ?? throw new InvalidOperationException("article_preservation_operation_committed_generation_missing");
        RequireGenerationIdentity(generation.Identity, expectedGeneration);
        await generation.VerifyAsync(_plan.Media.Files, _configuration.MediaLimits.FileBytes,
            _configuration.MediaLimits.MetadataBytes, token).ConfigureAwait(false);
        // Identity is cached on the anchored FD. Re-open the original pathname after
        // full verification so an equal-byte replacement cannot seal an older inode.
        using var terminalParent = ArticleMediaDirectory.Open(_configuration.TargetParent, writable: false);
        if (terminalParent.Identity != _targetRootIdentity)
            throw new InvalidOperationException("article_preservation_operation_target_root_changed");
        using ArticleMediaDirectory terminalGeneration = terminalParent.TryOpenDirectory(_configuration.TargetDirectoryName)
            ?? throw new InvalidOperationException("article_preservation_operation_generation_missing");
        RequireGenerationIdentity(terminalGeneration.Identity, expectedGeneration);
    }

    private OfflineMigrationMediaJournalEvidence RequireCommittedMedia()
    {
        if (_verifiedProgress is null || !RequiresCommittedTarget(_verifiedProgress, StepReference, Identity))
            throw new InvalidOperationException("article_preservation_operation_verified_progress_capability_missing");
        OfflineMigrationApplyJournalEntry? pending = _verifiedProgress.PendingUnit;
        OfflineMigrationApplyJournalEntry unit = pending?.StepId == StepReference
            ? pending : _verifiedProgress.StepProofs.Single(entry => entry.StepId == StepReference);
        OfflineMigrationMediaJournalEvidence media = unit.Media
            ?? throw new InvalidOperationException("article_preservation_operation_committed_generation_missing");
        if (media.Binding.RunId != _configuration.MediaRunId
            || media.Binding.SourceContentDigest != _source.Data.FullSourceContentDigest
            || media.Binding.ManifestDigest != _plan.Media.ManifestDigest
            || media.Binding.SourceRootIdentity != _plan.Media.SourceRootIdentity
            || media.Binding.TargetRootIdentity != _targetRootIdentity
            || media.Binding.TargetDirectoryName != _configuration.TargetDirectoryName)
            throw new InvalidOperationException("article_preservation_operation_committed_media_binding_changed");
        return media;
    }

    internal static void RequireGenerationIdentity(string actual, string expected)
    {
        if (string.IsNullOrWhiteSpace(actual) || string.IsNullOrWhiteSpace(expected)
            || !string.Equals(actual, expected, StringComparison.Ordinal))
            throw new InvalidOperationException("article_preservation_operation_generation_identity_changed");
    }

    private async Task RevalidateInputsAsync(CancellationToken token)
    {
        await _owned.RevalidateRetainedArtifactAsync(token).ConfigureAwait(false);
        await RequirePublishedInputsAsync(_source, _current, _configuration.WriteLimits.MaximumArtifactBytes, token).ConfigureAwait(false);
        using var handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(_assembly.Reference, token);
        var initial = OfflineMigrationCurrentSchemaArtifactReader.CaptureOriginalRegularFileIdentity(_assembly.Reference, handle, token);
        var stream = new FileStream(handle, FileAccess.Read, 4096);
        _ = await PreserveFirstAsync(stream,
            async () =>
            {
                string digest = Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, token).ConfigureAwait(false));
                if (digest != _assembly.Sha256)
                    throw new InvalidOperationException("article_preservation_operation_compiled_owner_changed");
                OfflineMigrationCurrentSchemaArtifactReader.ValidateOriginalRegularFileUnchanged(_assembly.Reference, handle, initial, token);
                return digest;
            }).ConfigureAwait(false);
        ArticleMediaInventory actual = await InventoryAsync(_source, _configuration, token).ConfigureAwait(false);
        if (!ArticlePreservationSemanticReceipt.Serialize(actual).AsSpan().SequenceEqual(ArticlePreservationSemanticReceipt.Serialize(_plan.Media)))
            throw new InvalidOperationException("article_preservation_operation_source_media_changed");
        using var parent = ArticleMediaDirectory.Open(_configuration.TargetParent, writable: true);
        if (parent.Identity != _targetRootIdentity)
            throw new InvalidOperationException("article_preservation_operation_target_root_changed");
    }

    internal void RequireStep(OfflineMigrationStep step, OfflineMigrationProviderOperation identity)
    {
        if (identity != Identity || step.StepId != Step.StepId || step.SourcePrecondition != Step.SourcePrecondition
            || step.TargetPostcondition != Step.TargetPostcondition || !step.Dependencies.SequenceEqual(Step.Dependencies)
            || step.IdempotencyDefinition != Step.IdempotencyDefinition || step.Destructive != Step.Destructive
            || step.ResumePolicy != Step.ResumePolicy || step.Operations.Count(operation => operation.Provider == Identity.Provider) != 1
            || step.Operations.Single(operation => operation.Provider == Identity.Provider) != Identity)
            throw new InvalidOperationException("article_preservation_operation_step_binding_changed");
    }

    // The recovery owner calls this only on the descriptor resolved from the same
    // actual closed registry. Matching immutable inputs is not native admission.
    internal void RequireRecoveryInputBinding(CurrentSchemaArtifactReference sourceArtifact,
        CurrentSchemaArtifactReference currentArtifact, Guid mediaRunId, CurrentSchemaVerifierIdentity actualTool)
    {
        if (sourceArtifact != _sourceReference || currentArtifact != _currentReference
            || mediaRunId != _configuration.MediaRunId || actualTool != RetainedTool)
            throw new InvalidOperationException("article_preservation_operation_recovery_inputs_changed");
    }

    internal static void RequireInvocation(string invocation)
    {
        if (string.IsNullOrWhiteSpace(invocation) || invocation.Length > 160 || invocation.Any(char.IsControl)
            || !string.Equals(invocation, invocation.Trim(), StringComparison.Ordinal))
            throw new InvalidOperationException("article_preservation_operation_invocation_invalid");
    }

    internal static void RequireConfiguration(PgArticlePreservationMediaConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArticlePreservationStorageWriter.RequireLimits(configuration.WriteLimits);
        if (configuration.MediaRunId == Guid.Empty || configuration.ProjectionLimits is null || configuration.MediaLimits is null
            || configuration.SourceReadBudget <= TimeSpan.Zero || configuration.SourceReadBudget.TotalMilliseconds > uint.MaxValue - 1
            || configuration.TrustedSiteOrigin is null || !configuration.TrustedSiteOrigin.IsAbsoluteUri
            || configuration.TrustedSiteOrigin.Scheme is not ("http" or "https") || configuration.TrustedSiteOrigin.UserInfo.Length != 0
            || !Path.IsPathFullyQualified(configuration.SourceAssetRoot) || !Path.IsPathFullyQualified(configuration.TargetParent))
            throw new InvalidOperationException("article_preservation_operation_configuration_required");
        ArticleMediaDirectory.ValidateSegment(configuration.TargetDirectoryName);
        configuration.MediaLimits.Validate();
        if (configuration.ProjectionLimits.MaximumArticles <= 0 || configuration.ProjectionLimits.MaximumTaxonomyRows <= 0
            || configuration.ProjectionLimits.MaximumMetadataBytes <= 0)
            throw new InvalidOperationException("article_preservation_operation_configuration_required");
    }

    internal static void RequireRecoveryConfiguration(PgArticlePreservationRecoveryConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        if (configuration.Tool is null)
            throw new InvalidOperationException("article_preservation_operation_recovery_configuration_required");
        RequireRecoveryOutput(configuration.AbsoluteOutputPath, configuration.MaximumInputBytes);
    }

    internal static void RequireRecoveryOutput(string path, long maximumInputBytes)
    {
        if (maximumInputBytes is <= 0 or > int.MaxValue || string.IsNullOrWhiteSpace(path)
            || !Path.IsPathFullyQualified(path) || Path.GetFullPath(path) != path
            || Path.GetPathRoot(path) == path || path.Any(char.IsControl)
            || path.Split('/', '\\').Any(value => value.Equals("latest", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("article_preservation_operation_recovery_configuration_required");
    }

    private static Task<ArticleMediaInventory> InventoryAsync(ArticlePreservationSourceExport source,
        PgArticlePreservationMediaConfiguration configuration, CancellationToken token)
        => ArticleMediaPreservation.InventoryAsync(Documents(source, token), configuration.SourceAssetRoot,
            configuration.TrustedSiteOrigin, configuration.PublicPathPrefix, configuration.MediaLimits, token);

    private static async IAsyncEnumerable<ArticleMediaSource> Documents(ArticlePreservationSourceExport source,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken token)
    {
        foreach (LegacyArticlePreservationRow row in source.Data.Articles.OrderBy(static row => row.Id))
        {
            token.ThrowIfCancellationRequested();
            yield return new(row.Id, null, row.Markdown ?? throw new InvalidOperationException("article_preservation_operation_markdown_missing"), source.Data.DocumentBase);
        }
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async Task RequirePublishedInputsAsync(ArticlePreservationSourceExport source,
        ArticlePreservationCurrentExport current, long maximumBytes, CancellationToken token)
    {
        async Task Require(CurrentSchemaArtifactReference reference, ImmutableArray<byte> expected)
        {
            ImmutableArray<byte> actual = await ReadArtifactAsync(reference, maximumBytes, token).ConfigureAwait(false);
            if (!actual.AsSpan().SequenceEqual(expected.AsSpan()))
                throw new InvalidOperationException("article_preservation_operation_published_bytes_changed");
        }
        await Require(source.Artifact, source.Bytes).ConfigureAwait(false);
        await Require(current.Artifact, current.Bytes).ConfigureAwait(false);
        if (current.DefaultPolicy is null)
            throw new InvalidOperationException("article_preservation_operation_default_policy_required");
        await Require(current.DefaultPolicy.Artifact, current.DefaultPolicy.Bytes).ConfigureAwait(false);
        foreach (ArticlePreservationCurrentPackage package in current.Articles)
            await Require(package.Artifact, package.Bytes).ConfigureAwait(false);
    }

    private static T Deserialize<T>(ImmutableArray<byte> bytes)
    {
        T value = JsonSerializer.Deserialize<T>(bytes.AsSpan(), new JsonSerializerOptions
        {
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
        }) ?? throw new InvalidOperationException("article_preservation_operation_artifact_payload_missing");
        if (!bytes.AsSpan().SequenceEqual(ArticlePreservationSemanticReceipt.Serialize(value)))
            throw new InvalidOperationException("article_preservation_operation_artifact_noncanonical");
        return value;
    }

    internal static async Task<ImmutableArray<byte>> ReadArtifactAsync(CurrentSchemaArtifactReference reference,
        long maximumBytes, CancellationToken token)
    {
        if (reference is null || !ArticlePreservationSemanticReceipt.IsDigest(reference.Sha256) || maximumBytes <= 0)
            throw new InvalidOperationException("article_preservation_operation_artifact_reference_invalid");
        using var handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(reference.Reference, token);
        var initial = OfflineMigrationCurrentSchemaArtifactReader.CaptureOriginalRegularFileIdentity(reference.Reference, handle, token);
        var stream = new FileStream(handle, FileAccess.Read, 4096);
        return await PreserveFirstAsync(stream, async () =>
        {
            if (stream.Length <= 0 || stream.Length > maximumBytes || stream.Length > int.MaxValue)
                throw new InvalidOperationException("article_preservation_operation_artifact_byte_budget");
            byte[] bytes = new byte[checked((int)stream.Length)];
            await stream.ReadExactlyAsync(bytes.AsMemory(), token).ConfigureAwait(false);
            if (stream.ReadByte() != -1 || ArticlePreservationSemanticReceipt.HashBytes(bytes) != reference.Sha256)
                throw new InvalidOperationException("article_preservation_operation_original_artifact_changed");
            OfflineMigrationCurrentSchemaArtifactReader.ValidateOriginalRegularFileUnchanged(reference.Reference, handle, initial, token);
            return bytes.ToImmutableArray();
        }).ConfigureAwait(false);
    }

    internal static async Task<T> PreserveFirstAsync<T>(IAsyncDisposable resource, Func<Task<T>> body)
    {
        Exception? first = null;
        T result = default!;
        try
        {
            result = await body().ConfigureAwait(false);
        }
        catch (Exception failure) { first = failure; }
        try
        {
            await resource.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception cleanup)
        {
            first ??= cleanup;
            first.Data["FsusBlog.ArticlePreservation.OperationCleanupFailure"] = "article_preservation_operation_resource_disposal_failed";
        }
        if (first is not null)
            ExceptionDispatchInfo.Capture(first).Throw();
        return result;
    }

    private sealed record CurrentEnvelope(ImmutableArray<ArticlePreservationTaxonomyMap> Categories,
        ImmutableArray<ArticlePreservationTaxonomyMap> Tags, ImmutableArray<ArticlePreservationCurrentPackage> Articles,
        ArticlePreservationDefaultPolicyExport? DefaultPolicy);

    // A private constructor reached only after real graph/media effects, not a status DTO.
    internal sealed class PgArticlePreservationStage
    {
        private readonly PgArticlePreservationOperation _operation;
        private readonly DbConnection _connection;
        private readonly DbTransaction _transaction;
        private readonly ArticleMediaPublication _publication;
        private PgArticlePreservationStage(PgArticlePreservationOperation operation,
            PgLegacyCurrentSchemaPreparation originalStage, DbConnection connection, DbTransaction transaction,
            ArticleMediaPublication publication)
        {
            _operation = operation;
            OriginalStage = originalStage;
            _connection = connection;
            _transaction = transaction;
            _publication = publication;
        }
        internal PgLegacyCurrentSchemaPreparation OriginalStage
        {
            get;
        }
        internal CurrentSchemaDatabaseIdentity Database => _operation._observation.Database;
        internal CurrentSchemaArtifactReference SourceArtifact => _operation._source.Artifact;
        internal CurrentSchemaArtifactReference CurrentArtifact => _operation._current.Artifact;
        internal static async Task<PgArticlePreservationStage> CreateAsync(PgArticlePreservationOperation operation,
            PgLegacyCurrentSchemaPreparation originalStage, DbConnection connection, DbTransaction transaction,
            ArticleMediaPublication publication, CancellationToken token)
        {
            _ = originalStage.RequireOriginalSession(connection, transaction);
            var stage = new PgArticlePreservationStage(operation, originalStage, connection, transaction, publication);
            await stage.RevalidateAsync(connection, transaction, token).ConfigureAwait(false);
            return stage;
        }
        internal async Task RevalidateAsync(DbConnection connection, DbTransaction transaction, CancellationToken token)
        {
            if (!ReferenceEquals(connection, _connection) || !ReferenceEquals(transaction, _transaction))
                throw new InvalidOperationException("article_preservation_operation_stage_session_changed");
            await _operation.RevalidateTargetAsync(connection, transaction, token).ConfigureAwait(false);
            using var parent = ArticleMediaDirectory.Open(_operation._configuration.TargetParent, writable: false);
            using ArticleMediaDirectory generation = parent.TryOpenDirectory(_operation._configuration.TargetDirectoryName)
                ?? throw new InvalidOperationException("article_preservation_operation_generation_missing");
            if (_publication.Binding != _operation._binding?.Binding || generation.Identity != _publication.GenerationIdentity)
                throw new InvalidOperationException("article_preservation_operation_publication_identity_changed");
        }
    }
}

// Composition must retain every other actual DAG owner. This registry can resolve only
// its exact compiled PostgreSQL node; it never accepts unknown/other-provider steps.
internal sealed class PgArticlePreservationOperationRegistry(PgArticlePreservationOperation operation) : IOfflineMigrationApplyOperationRegistry
{
    public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation identity)
    {
        operation.RequireStep(step, identity);
        return operation;
    }
}
