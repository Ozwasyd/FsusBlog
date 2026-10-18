using System.Collections.Immutable;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

// Process-owned compiled composition only. CLI/artifact JSON cannot supply owner
// instances, select plugin types, register SQL or fill a missing capability.
internal sealed class OfflineMigrationHostOwnedConfiguration
{
    private readonly IOfflineMigrationPlanningAuthorityReader _planning;
    private readonly OfflineMigrationShellBackupDrillConfiguration _backup;
    private readonly OfflineMigrationCurrentSchemaVerificationCapabilities _verification;
    private readonly IOfflineMigrationOwnedBackupAdmission? _retainedBackupAdmission;

    internal OfflineMigrationHostOwnedConfiguration(IOfflineMigrationPlanningAuthorityReader planning,
        OfflineMigrationShellBackupDrillConfiguration backup,
        OfflineMigrationCurrentSchemaVerificationCapabilities verification, TimeProvider? timeProvider = null,
        IOfflineMigrationOwnedBackupAdmission? retainedBackupAdmission = null)
    {
        ArgumentNullException.ThrowIfNull(planning);
        ArgumentNullException.ThrowIfNull(backup);
        ArgumentNullException.ThrowIfNull(verification);
        // A raw shell-fixture configuration is not a production composition. The
        // original owner must have observed the actual tool bytes and input scope;
        // it repeats those checks at entry and before launching the producer.
        if (backup.OwnedInputs is null)
        {
            throw new InvalidOperationException("offline_backup_owned_tool_configuration_required");
        }
        OfflineMigrationOwnedApplyEvidence.RequireOwners(new(verification.Artifacts, planning, verification.Authority, verification.Operations));
        if (verification.CurrentSchema is null)
        {
            throw new InvalidOperationException("current_verify_native_owners_not_configured");
        }
        _planning = planning;
        _backup = backup;
        _verification = verification;
        _retainedBackupAdmission = retainedBackupAdmission;
        Clock = timeProvider ?? TimeProvider.System;
    }

    internal static async Task<OfflineMigrationHostOwnedConfiguration> CreateAsync(
        IOfflineMigrationPlanningAuthorityReader planning, OfflineMigrationShellBackupDrillOwnedInputs backupInputs,
        OfflineMigrationCurrentSchemaVerificationCapabilities verification, CancellationToken cancellationToken,
        TimeProvider? timeProvider = null, IOfflineMigrationOwnedBackupAdmission? retainedBackupAdmission = null)
    {
        ArgumentNullException.ThrowIfNull(planning);
        ArgumentNullException.ThrowIfNull(backupInputs);
        ArgumentNullException.ThrowIfNull(verification);
        cancellationToken.ThrowIfCancellationRequested();
        OfflineMigrationOwnedApplyEvidence.RequireOwners(new(verification.Artifacts, planning,
            verification.Authority, verification.Operations));
        if (verification.CurrentSchema is null)
        {
            throw new InvalidOperationException("current_verify_native_owners_not_configured");
        }
        OfflineMigrationShellBackupDrillConfiguration backup = await backupInputs.CreateConfigurationAsync(
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return new(planning, backup, verification, timeProvider, retainedBackupAdmission);
    }

    internal static async Task<OfflineMigrationHostOwnedConfiguration> CreateRetainedAsync(
        IOfflineMigrationPlanningAuthorityReader planning,
        OfflineMigrationShellBackupDrillOwnedInputs backupInputs,
        IOfflineMigrationVerificationArtifactReader artifacts,
        IOfflineMigrationCurrentSchemaObserver currentSchema,
        IOfflineMigrationApplyOperationRegistry operations,
        CancellationToken cancellationToken,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(planning);
        ArgumentNullException.ThrowIfNull(backupInputs);
        ArgumentNullException.ThrowIfNull(artifacts);
        ArgumentNullException.ThrowIfNull(currentSchema);
        ArgumentNullException.ThrowIfNull(operations);
        cancellationToken.ThrowIfCancellationRequested();
        // Resolve the original process-owned tool/input bytes before constructing the
        // retained authority. That authority captures exactly one actual backup invocation;
        // the very same instance then serves planning and locked apply/verify reads.
        OfflineMigrationShellBackupDrillConfiguration backup = await backupInputs.CreateConfigurationAsync(
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        var retained = new OfflineMigrationRetainedEvidenceAuthority(planning, backup);
        var verification = new OfflineMigrationCurrentSchemaVerificationCapabilities(
            artifacts, currentSchema, retained, operations);
        return new(planning, backup, verification, timeProvider, retained);
    }

    internal static Task<OfflineMigrationHostOwnedConfiguration> CreateOriginalAsync(
        OwnedCurrentSchemaTarget target,
        OwnedRetainedMigrationTool tool,
        OfflineMigrationDag dag,
        IOfflineMigrationApplyOperationRegistry operations,
        TimeSpan maximumBackupAge,
        OfflineMigrationShellBackupDrillOwnedInputs backupInputs,
        IOfflineMigrationCurrentSchemaObserver currentSchema,
        CancellationToken cancellationToken,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(tool);
        ArgumentNullException.ThrowIfNull(dag);
        ArgumentNullException.ThrowIfNull(operations);
        ArgumentNullException.ThrowIfNull(backupInputs);
        ArgumentNullException.ThrowIfNull(currentSchema);
        cancellationToken.ThrowIfCancellationRequested();
        // An actual unsupported compiled provider fails before shell configuration
        // or credential/native work. No caller plan can supply its missing identity.
        OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(dag, operations, cancellationToken);
        var planning = new OfflineMigrationOwnedPlanningAuthorityReader(
            target, tool, operations, dag, maximumBackupAge);
        return CreateRetainedAsync(planning, backupInputs,
            OfflineMigrationCurrentSchemaVerificationOwners.CreateOwnedArtifactReader(),
            currentSchema, operations, cancellationToken, timeProvider);
    }

    internal static Task<OfflineMigrationHostOwnedConfiguration> CreateOriginalPostgreSqlAsync(
        OwnedCurrentSchemaTarget target, OwnedRetainedMigrationTool tool, OfflineMigrationDag dag,
        IOfflineMigrationApplyOperationRegistry operations, TimeSpan maximumBackupAge,
        OfflineMigrationShellBackupDrillOwnedInputs backupInputs, CancellationToken cancellationToken,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(target);
        return CreateOriginalAsync(target, tool, dag, operations, maximumBackupAge, backupInputs,
            new PgCurrentSchemaOwnedTargetObserver(target), cancellationToken, timeProvider);
    }

    internal static async Task<OfflineMigrationHostOwnedConfiguration> CreateOriginalFromRetainedToolAsync(
        OwnedRetainedMigrationTool tool, OfflineMigrationDag dag,
        IOfflineMigrationApplyOperationRegistry operations, TimeSpan maximumBackupAge,
        OfflineMigrationShellBackupDrillOwnedInputs backupInputs, CancellationToken cancellationToken,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(tool);
        ArgumentNullException.ThrowIfNull(backupInputs);
        cancellationToken.ThrowIfCancellationRequested();
        OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(dag, operations, cancellationToken);
        // The retained capability derives the original Server domain, source and
        // output from its own observations. No CLI assembly/hash/path can supply it.
        OwnedCurrentSchemaTarget target = await tool.InvokeCurrentSchemaOriginalOwnerAsync(
            cancellationToken).ConfigureAwait(false);
        return await CreateOriginalPostgreSqlAsync(target, tool, dag, operations,
            maximumBackupAge, backupInputs, cancellationToken, timeProvider).ConfigureAwait(false);
    }

    internal static async Task<OfflineMigrationHostOwnedConfiguration> CreateOriginalArticlePreservationAsync(
        OfflineMigrationPlanCommandOptions options, ArticlePreservationProducerInputs inputs,
        OwnedCurrentSchemaTarget target, OwnedRetainedMigrationTool tool,
        PgArticlePreservationMediaConfiguration media, PgArticlePreservationRecoveryConfiguration recovery,
        ImmutableArray<OfflineMigrationApplyOperation> otherProviderOwners, TimeSpan maximumBackupAge,
        OfflineMigrationShellBackupDrillOwnedInputs backupInputs, CancellationToken cancellationToken,
        TimeProvider? timeProvider = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        // The whole-route requirement is checked before any retained-file, credential,
        // native or publication work. A PG descriptor cannot stand in for the other owners.
        ArticlePreservationProducer.RequireProviderOwners(otherProviderOwners);
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(tool);
        ArgumentNullException.ThrowIfNull(backupInputs);
        RequireArticlePlanningScope(options, inputs, backupInputs.InputScope, cancellationToken);
        ArticlePreservationProducer.RequireInputs(inputs);
        PgArticlePreservationOperation.RequireConfiguration(media);
        PgArticlePreservationOperation.RequireRecoveryConfiguration(recovery);
        if (!ReferenceEquals(recovery.Tool, tool))
        {
            throw new InvalidOperationException("article_preservation_producer_original_tool_changed");
        }
        if (maximumBackupAge <= TimeSpan.Zero)
        {
            throw new InvalidOperationException("offline_backup_age_policy_invalid");
        }
        OfflineMigrationOperationDeadline deadline = options.OperationDeadline
            ?? throw new InvalidOperationException("offline_article_original_plan_deadline_required");
        _ = deadline.RemainingWholeSeconds(cancellationToken);
        _ = await backupInputs.CreateConfigurationAsync(cancellationToken).ConfigureAwait(false);
        CurrentSchemaVerifierIdentity actualTool = await tool.RevalidateAsync(cancellationToken).ConfigureAwait(false);
        await target.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        _ = deadline.RemainingWholeSeconds(cancellationToken);
        string connectionString = await OfflineMigrationHost.ReadRequiredConnectionStringAsync(
            options.EnvironmentFilePath, cancellationToken).ConfigureAwait(false);
        OfflineMigrationArticlePreservationRoute? matched = null;
        _ = await OfflineMigrationPostgreSqlNativeSession.ObserveAsync(connectionString, async (connection, transaction, token) =>
        {
            OfflineMigrationSourceObservation source = await new OfflineMigrationSourceObserver().ObserveAsync(
                CurrentSchemaProviderKind.PostgreSql, connection, transaction, token).ConfigureAwait(false);
            if (source.Database != options.ExpectedDatabase)
            {
                throw new InvalidOperationException("schema_offline_plan_database_identity_mismatch");
            }
            _ = OfflineMigrationSourceFingerprints.CreateRegistry().Match(source);
            OfflineMigrationArticlePreservationRoute route = await ArticlePreservationProducer.CreateMatchedRouteAsync(
                inputs, target, tool, media, recovery, otherProviderOwners, connection, transaction, token).ConfigureAwait(false);
            OfflineMigrationSourceRouteSelection selection = route.MatchSource(source, token);
            if (!ReferenceEquals(selection.Dag, route.Dag))
            {
                throw new InvalidOperationException("article_preservation_producer_route_changed");
            }
            matched = route;
            return source;
        }, cancellationToken).ConfigureAwait(false);
        // No capability is published to the Host until the unique native session owner
        // has awaited its cleanup. Disposal returned is not physical remote-release proof.
        _ = deadline.RemainingWholeSeconds(cancellationToken);
        if (matched is null || await tool.RevalidateAsync(cancellationToken).ConfigureAwait(false) != actualTool)
        {
            throw new InvalidOperationException("article_preservation_producer_original_tool_changed");
        }
        await target.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        return await CreateOriginalPostgreSqlAsync(target, tool, matched.Dag, matched,
            maximumBackupAge, backupInputs, cancellationToken, timeProvider).ConfigureAwait(false);
    }

    internal static void RequireArticlePlanningScope(OfflineMigrationPlanCommandOptions options,
        ArticlePreservationProducerInputs inputs, OfflineMigrationShellBackupDrillInputScope scope, CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(inputs);
        ArgumentNullException.ThrowIfNull(scope);
        token.ThrowIfCancellationRequested();
        if (options.ExpectedDatabase is null || options.ExpectedDatabase != scope.ExpectedDatabase
            || options.ExpectedDatabase.Provider != CurrentSchemaProviderKind.PostgreSql
            || options.EnvironmentFilePath != scope.EnvironmentFilePath
            || options.RestoreEnvironmentFilePath != scope.RestoreEnvironmentFilePath
            || options.BackupPackagePath != scope.BackupPackagePath
            || options.PlanOutputPath != scope.PlanOutputPath)
        {
            throw new InvalidOperationException("offline_backup_tool_configuration_invocation_scope_changed");
        }
        // The caller selects the original run's output locators; do not invent a new run,
        // copy current facts into historical inputs or accept a mutable latest alias.
        ArticlePreservationProducer.RequireInputs(inputs);
        if (!Path.IsPathFullyQualified(scope.OutputParent) || Path.GetFullPath(scope.OutputParent) != scope.OutputParent
            || inputs.OutputDirectory == scope.OutputParent
            || !inputs.OutputDirectory.StartsWith(Path.TrimEndingDirectorySeparator(scope.OutputParent)
                + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("offline_article_original_output_scope_changed");
        }
    }

    internal TimeProvider Clock
    {
        get;
    }
    internal OfflineMigrationShellBackupDrillConfiguration ShellBackupConfiguration => _backup;
    internal IOfflineMigrationPlanningEvidence CreatePlanningEvidence()
        => _retainedBackupAdmission is null
            ? OfflineMigrationPlanEvidence.ComposeOwnedReader(_planning, _backup, Clock,
                _verification.Operations as IOfflineMigrationMatchedSourceRoute)
            : OfflineMigrationPlanEvidence.ComposeOwnedReader(_planning, _retainedBackupAdmission, Clock,
                _verification.Operations as IOfflineMigrationMatchedSourceRoute);
    internal IOfflineMigrationApplyProducer CreateApplyProducer()
        => OfflineMigrationApplyEvidence.ComposeOwned(new(_verification.Artifacts, _planning,
            _verification.Authority, _verification.Operations), Clock);
    internal IOfflineMigrationVerifiedReceiptProducer CreateVerifyProducer()
        => OfflineMigrationVerifyEvidence.ComposeOwned(_verification);
}
