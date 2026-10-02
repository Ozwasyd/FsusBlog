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
}
