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

    internal TimeProvider Clock { get; }
    internal OfflineMigrationShellBackupDrillConfiguration ShellBackupConfiguration => _backup;
    internal IOfflineMigrationPlanningEvidence CreatePlanningEvidence()
        => _retainedBackupAdmission is null
            ? OfflineMigrationPlanEvidence.ComposeOwnedReader(_planning, _backup, Clock)
            : OfflineMigrationPlanEvidence.ComposeOwnedReader(_planning, _retainedBackupAdmission, Clock);
    internal IOfflineMigrationApplyProducer CreateApplyProducer()
        => OfflineMigrationApplyEvidence.ComposeOwned(new(_verification.Artifacts, _planning,
            _verification.Authority, _verification.Operations), Clock);
    internal IOfflineMigrationVerifiedReceiptProducer CreateVerifyProducer()
        => OfflineMigrationVerifyEvidence.ComposeOwned(_verification);
    internal OfflineMigrationOwnedVerifyEvidence CreateExistingReceiptVerifier()
        => OfflineMigrationVerifyEvidence.ComposeOwnedExisting(_verification);
}
