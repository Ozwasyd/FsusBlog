using System.Collections.Immutable;
using System.Data;
using System.Data.Common;

using Npgsql;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

// One process-owned composition of existing readers, not another backup writer,
// planner or issuer. A new process cannot reconstruct this owner from plan JSON.
internal sealed class OfflineMigrationRetainedEvidenceAuthority
    : IOfflineMigrationOwnedBackupAdmission, IOfflineMigrationCurrentSchemaVerificationAuthority
{
    private readonly OfflineMigrationBackupAdmission _backup;
    private readonly IOfflineMigrationPlanningAuthorityReader _planning;
    private OfflineMigrationRetainedOwnedBackup? _retainedBackup;
    private OfflineMigrationPlanningAuthority? _retainedPlanning;
    private int _captureStarted;

    internal OfflineMigrationRetainedEvidenceAuthority(
        IOfflineMigrationPlanningAuthorityReader planning,
        OfflineMigrationShellBackupDrillConfiguration backupConfiguration)
    {
        ArgumentNullException.ThrowIfNull(planning);
        ArgumentNullException.ThrowIfNull(backupConfiguration);
        if (backupConfiguration.OwnedInputs is null)
        {
            throw new InvalidOperationException("offline_backup_owned_tool_configuration_required");
        }
        _planning = planning;
        _backup = new(new OfflineMigrationShellBackupDrillProducer(backupConfiguration));
    }

    public async Task<OfflineMigrationBackupObservation> ReadAndVerifyAsync(
        OfflineMigrationPlanCommandOptions options, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(options);
        cancellationToken.ThrowIfCancellationRequested();
        if (Interlocked.CompareExchange(ref _captureStarted, 1, 0) != 0)
        {
            throw new InvalidOperationException("offline_retained_backup_capture_already_started");
        }
        OfflineMigrationPlanningAuthority before = await _planning.ReadAsync(
            options.ExpectedDatabase.Provider, cancellationToken).ConfigureAwait(false);
        OfflineMigrationPlanValidation.ValidateTargetAndTool(before.Target, before.Tool);
        if (before.MaximumBackupAge <= TimeSpan.Zero)
        {
            throw new InvalidOperationException("offline_backup_age_policy_invalid");
        }
        OfflineMigrationRetainedOwnedBackup backup = await _backup.ReadAndRetainAsync(options,
            cancellationToken).ConfigureAwait(false);
        OfflineMigrationPlanningAuthority after = await _planning.ReadAsync(
            options.ExpectedDatabase.Provider, cancellationToken).ConfigureAwait(false);
        if (!OfflineMigrationPlanValidation.Equal(before, after))
        {
            throw new InvalidOperationException("offline_plan_authority_changed_during_observation");
        }
        // Publish the invocation-owned pair only after all original readers return.
        // An exception leaves no importable or partially successful capability.
        _retainedPlanning = before;
        Volatile.Write(ref _retainedBackup, backup);
        return backup.Observation;
    }

    public async Task<OfflineMigrationCurrentSchemaAuthoritySnapshot> ReadAsync(
        OfflineMigrationPlan plan, DbConnection connection, DbTransaction transaction,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(transaction);
        cancellationToken.ThrowIfCancellationRequested();
        OfflineMigrationRetainedOwnedBackup backupOwner = Volatile.Read(ref _retainedBackup)
            ?? throw new InvalidOperationException("offline_actual_plan_time_backup_invocation_required");
        OfflineMigrationPlanningAuthority retained = _retainedPlanning
            ?? throw new InvalidOperationException("offline_actual_plan_time_tool_snapshot_required");
        if (connection is not NpgsqlConnection || connection.State != ConnectionState.Open
            || !ReferenceEquals(transaction.Connection, connection))
        {
            throw new InvalidOperationException("offline_retained_authority_same_native_session_required");
        }
        // The original issuer observes identity on the caller's locked/RO snapshot;
        // no second connection, inferred identity or plan.Source reconstruction.
        CurrentSchemaDatabaseIdentity actualDatabase = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        OfflineMigrationBackupObservation backup = await backupOwner.RevalidateAsync(cancellationToken).ConfigureAwait(false);
        if (actualDatabase != backup.SourceAtCapture.Database)
        {
            throw new InvalidOperationException("offline_retained_backup_native_database_changed");
        }
        OfflineMigrationPlanningAuthority current = await _planning.ReadAsync(actualDatabase.Provider,
            cancellationToken).ConfigureAwait(false);
        if (!OfflineMigrationPlanValidation.Equal(retained, current))
        {
            throw new InvalidOperationException("offline_retained_plan_authority_changed");
        }
        // The apply owner compares its same-session pre-write source and original
        // first admission time; the issuer compares completed native postconditions.
        // This reader does not pretend the migrated DB still has its old shape.
        ImmutableArray<CurrentSchemaArtifactReference> recovery = [backup.Package, backup.Manifest, backup.RestoreDrill];
        cancellationToken.ThrowIfCancellationRequested();
        return new(backup, retained.Tool, current.Tool, OfflineMigrationSourceFingerprints.CreateRegistry(),
            retained.Dag, retained.MaximumBackupAge, recovery);
    }
    public async Task<OfflineMigrationCurrentSchemaAuthoritySnapshot> ReadAsync(
        OfflineMigrationPlan plan, OfflineMigrationMySqlNativeSession.OwnedReadContext context,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(context);
        using CancellationTokenSource scope = context.CreateReadScope(cancellationToken);
        CancellationToken token = scope.Token;
        OfflineMigrationRetainedOwnedBackup backupOwner = Volatile.Read(ref _retainedBackup)
            ?? throw new InvalidOperationException("offline_actual_plan_time_backup_invocation_required");
        OfflineMigrationPlanningAuthority retained = _retainedPlanning
            ?? throw new InvalidOperationException("offline_actual_plan_time_tool_snapshot_required");

        // Both samples use the creator's original live connection and transaction.
        // Native identity/settings are observed by the existing source reader;
        // the context independently proves the read-only transaction epoch.
        await context.RequireBoundaryAsync(token).ConfigureAwait(false);
        OfflineMigrationSourceObserver.MySqlNativeIdentityMaterial initial =
            await OfflineMigrationSourceObserver.ReadMySqlNativeIdentityMaterialAsync(
                context.OriginalConnection, context.OriginalTransaction, token).ConfigureAwait(false);
        await context.RequireBoundaryAsync(token).ConfigureAwait(false);
        OfflineMigrationBackupObservation backup = await backupOwner.RevalidateAsync(token).ConfigureAwait(false);
        OfflineMigrationPlanningAuthority current = await _planning.ReadAsync(initial.Database.Provider, token)
            .ConfigureAwait(false);
        ValidateRetainedBindings(initial.Database, backup.SourceAtCapture.Database, retained, current);
        OfflineMigrationSourceObserver.MySqlNativeIdentityMaterial terminal =
            await OfflineMigrationSourceObserver.ReadMySqlNativeIdentityMaterialAsync(
                context.OriginalConnection, context.OriginalTransaction, token).ConfigureAwait(false);
        RequireMySqlIdentityUnchanged(initial, terminal);
        await context.RequireBoundaryAsync(token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();

        // Only the earlier successful original capture published this pair. The
        // plan argument, raw pair and these measured values cannot recreate it.
        ImmutableArray<CurrentSchemaArtifactReference> recovery = [backup.Package, backup.Manifest, backup.RestoreDrill];
        return new(backup, retained.Tool, current.Tool, OfflineMigrationSourceFingerprints.CreateRegistry(),
            retained.Dag, retained.MaximumBackupAge, recovery);
    }

    // Pure comparison controls do not mint either retained backup or native context.
    internal static void ValidateRetainedBindings(CurrentSchemaDatabaseIdentity actualDatabase,
        CurrentSchemaDatabaseIdentity capturedDatabase, OfflineMigrationPlanningAuthority retained,
        OfflineMigrationPlanningAuthority current)
    {
        ArgumentNullException.ThrowIfNull(actualDatabase);
        ArgumentNullException.ThrowIfNull(capturedDatabase);
        ArgumentNullException.ThrowIfNull(retained);
        ArgumentNullException.ThrowIfNull(current);
        if (actualDatabase != capturedDatabase)
        {
            throw new InvalidOperationException("offline_retained_backup_native_database_changed");
        }
        if (!OfflineMigrationPlanValidation.Equal(retained, current))
        {
            throw new InvalidOperationException("offline_retained_plan_authority_changed");
        }
    }

    internal static void RequireMySqlIdentityUnchanged(
        OfflineMigrationSourceObserver.MySqlNativeIdentityMaterial initial,
        OfflineMigrationSourceObserver.MySqlNativeIdentityMaterial terminal)
    {
        ArgumentNullException.ThrowIfNull(initial);
        ArgumentNullException.ThrowIfNull(terminal);
        if (initial != terminal)
        {
            throw new InvalidOperationException("offline_retained_backup_native_database_changed");
        }
    }
}
