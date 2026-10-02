using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

internal sealed record OfflineMigrationPlanningSnapshot(
    OfflineMigrationSourceObservation Source,
    OfflineMigrationBackupObservation Backup,
    CurrentSchemaTargetIdentity Target,
    CurrentSchemaVerifierIdentity Tool,
    OfflineMigrationSourceRegistry Registry,
    OfflineMigrationDag Dag,
    DateTimeOffset AdmissionTime,
    TimeSpan MaximumBackupAge);

/// <summary>
/// The host-owned read-only evidence boundary, never a command-line plugin or JSON approval.
/// Implementations must use the original authenticated backup owner, independently observe the
/// restored database, and load approved registry/DAG and current target/tool identities from owners.
/// </summary>
internal interface IOfflineMigrationPlanningEvidence
{
    Task<OfflineMigrationPlanningSnapshot> ReadAsync(
        OfflineMigrationPlanCommandOptions options,
        CancellationToken cancellationToken);
}

// This port belongs to the original backup owner: an invocation must authenticate the
// encrypted package and its inner manifest, read all six canonical artifacts, and verify
// run the original restore-drill producer to actual terminal, and consume that invocation's
// new private report/raw artifacts and native restore observation before target disposal.
// Neither pure inspection nor an external unsigned manifest/status report is this result.
internal interface IOfflineMigrationOwnedBackupAdmission
{
    Task<OfflineMigrationBackupObservation> ReadAndVerifyAsync(
        OfflineMigrationPlanCommandOptions options, CancellationToken cancellationToken);
}

internal sealed record OfflineMigrationPlanningAuthority(
    CurrentSchemaTargetIdentity Target,
    CurrentSchemaVerifierIdentity Tool,
    OfflineMigrationDag Dag,
    TimeSpan MaximumBackupAge);

// Only the actual compiled target/operation owner supplies this closure. No CLI option,
// nullable subset projection, or deserialized plan can implement target/operation admission.
internal interface IOfflineMigrationPlanningAuthorityReader
{
    Task<OfflineMigrationPlanningAuthority> ReadAsync(
        CurrentSchemaProviderKind provider, CancellationToken cancellationToken);
}

internal sealed class OfflineMigrationOwnedPlanningEvidence(
    IOfflineMigrationSourceObserver sourceObserver,
    IOfflineMigrationOwnedBackupAdmission backupAdmission,
    IOfflineMigrationPlanningAuthorityReader authorityReader,
    OfflineMigrationSourceRegistry registry,
    Func<string, CancellationToken, Task<string>> readConnectionString,
    TimeProvider timeProvider) : IOfflineMigrationPlanningEvidence
{
    public async Task<OfflineMigrationPlanningSnapshot> ReadAsync(
        OfflineMigrationPlanCommandOptions options, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        // Resolve real capability first, before credential/backup/native work. An entity-only
        // current projection cannot provide the complete target or executable DAG closure.
        OfflineMigrationPlanningAuthority authority = await authorityReader.ReadAsync(
            options.ExpectedDatabase.Provider, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        OfflineMigrationPlanValidation.ValidateTargetAndTool(authority.Target, authority.Tool);
        if (authority.MaximumBackupAge <= TimeSpan.Zero)
        {
            throw new InvalidOperationException("offline_backup_age_policy_invalid");
        }

        OfflineMigrationBackupObservation backup = await backupAdmission.ReadAndVerifyAsync(options, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        // Do not replace an inspector mismatch with the expected path/hash. Each reference is
        // the original owner's actual authenticated input, not a caller-supplied success flag.
        RequireObservedPath(backup.Package, options.BackupPackagePath);
        RequireObservedPath(backup.Manifest, options.BackupManifestPath);
        RequireObservedPath(backup.RestoreDrill, options.RestoreDrillPath);
        if (backup.BackupOwner != "tools/operations/backup-site.sh" || backup.BackupOwnerVersion != "3")
        {
            throw new InvalidOperationException("offline_backup_authenticated_owner_required");
        }

        string sourceConnection = await readConnectionString(options.EnvironmentFilePath, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        OfflineMigrationSourceObservation source = await sourceObserver.ObserveAsync(
            options.ExpectedDatabase.Provider, sourceConnection, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (source.Database != options.ExpectedDatabase)
        {
            throw new InvalidOperationException("schema_offline_plan_database_identity_mismatch");
        }
        _ = registry.Match(source);

        // RestoredSource is the original owned drill invocation's actual native observation,
        // not caller JSON. Its task-owned target is retired only after that producer terminal;
        // opening a new connection to an already disposed endpoint would invent an extra gate.
        DateTimeOffset admissionTime = timeProvider.GetUtcNow();
        OfflineMigrationPlanValidation.ValidateBackup(source, backup, admissionTime, authority.MaximumBackupAge);
        // Re-read actual owner closure after the potentially lengthy source/restore observations;
        // reject drift, never silently regenerate a different DAG or target for this attempt.
        OfflineMigrationPlanningAuthority terminalAuthority = await authorityReader.ReadAsync(
            options.ExpectedDatabase.Provider, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!OfflineMigrationPlanValidation.Equal(authority, terminalAuthority))
        {
            throw new InvalidOperationException("offline_plan_authority_changed_during_observation");
        }

        return new(source, backup, authority.Target, authority.Tool, registry, authority.Dag,
            admissionTime, authority.MaximumBackupAge);
    }

    private static void RequireObservedPath(CurrentSchemaArtifactReference observed, string expectedPath)
    {
        OfflineMigrationPlanValidation.RequireDigest(observed.Sha256, "offline_backup_artifact_digest_invalid");
        if (!Path.IsPathFullyQualified(observed.Reference)
            || observed.Reference != Path.GetFullPath(expectedPath))
        {
            throw new InvalidOperationException("offline_backup_authenticated_input_reference_mismatch");
        }
    }
}

internal static class OfflineMigrationPlanEvidence
{
    internal static IOfflineMigrationSnapshotSourceObserver CreateOwnedSourceObserver()
        => new OfflineMigrationSourceObserver();

    internal static IOfflineMigrationPlanningEvidence CreateOwnedReader()
    {
        // Registered source profiles are not complete current target/operation authority.
        // The original shell invocation is available through ComposeOwnedReader, but
        // needs owned tool/resource configuration and complete compiled authority here.
        // Caller JSON, digests or a successful drill flag cannot fill them.
        throw new InvalidOperationException("schema_offline_plan_evidence_owner_not_configured");
    }

    // The composition owner supplies actual compiled target/operation capability and
    // original operation configuration. This is not a CLI extension or a deserialized
    // plan factory; authority is still read/re-read independently by the real consumer.
    internal static IOfflineMigrationPlanningEvidence ComposeOwnedReader(
        IOfflineMigrationPlanningAuthorityReader authority,
        OfflineMigrationShellBackupDrillConfiguration backupConfiguration,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(authority);
        ArgumentNullException.ThrowIfNull(backupConfiguration);
        return ComposeOwnedReader(authority,
            new OfflineMigrationBackupAdmission(new OfflineMigrationShellBackupDrillProducer(backupConfiguration)), timeProvider);
    }

    // The original retention owner may wrap its successful invocation to preserve
    // the opaque capability for later commands in the same configured process.
    // It still uses the original producer; this port cannot import a report/plan.
    internal static IOfflineMigrationPlanningEvidence ComposeOwnedReader(
        IOfflineMigrationPlanningAuthorityReader authority, IOfflineMigrationOwnedBackupAdmission backupAdmission,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(authority);
        ArgumentNullException.ThrowIfNull(backupAdmission);
        return new OfflineMigrationOwnedPlanningEvidence(CreateOwnedSourceObserver(), backupAdmission,
            authority, OfflineMigrationSourceFingerprints.CreateRegistry(),
            OfflineMigrationHost.ReadRequiredConnectionStringAsync, timeProvider ?? TimeProvider.System);
    }

    internal static async Task<VerifiedOfflineMigrationPlan> ReadAndVerifyAsync(
        OfflineMigrationPlanCommandOptions options,
        IOfflineMigrationPlanningEvidence evidence,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        OfflineMigrationPlanningSnapshot snapshot = await evidence.ReadAsync(options, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (snapshot.Source.Database != options.ExpectedDatabase)
        {
            throw new InvalidOperationException("schema_offline_plan_database_identity_mismatch");
        }

        OfflineMigrationPlan plan = OfflineMigrationPlanBuilder.Create(snapshot.Source, snapshot.Backup,
            snapshot.Target, snapshot.Tool, snapshot.Registry, snapshot.Dag, snapshot.AdmissionTime, snapshot.MaximumBackupAge);
        return OfflineMigrationPlanVerifier.Verify(plan, snapshot.Source, snapshot.Backup, snapshot.Target,
            snapshot.Tool, snapshot.Registry, snapshot.Dag, snapshot.AdmissionTime, snapshot.MaximumBackupAge);
    }
}
