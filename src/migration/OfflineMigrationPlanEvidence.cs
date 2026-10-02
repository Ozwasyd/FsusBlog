using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

internal sealed record OfflineMigrationPlanningSnapshot(
    OfflineMigrationSourceObservation Source,
    OfflineMigrationBackupObservation Backup,
    OfflineMigrationTargetIdentity Target,
    OfflineMigrationToolIdentity Tool,
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

internal static class OfflineMigrationPlanEvidence
{
    internal static IOfflineMigrationPlanningEvidence CreateOwnedReader()
    {
        // The existing site backup/drill does not bind source instance or fingerprint, and
        // the current-only schema observer cannot register a historical baseline. Neither
        // a caller-provided digest nor a successful drill flag may fill those capabilities.
        throw new InvalidOperationException("schema_offline_plan_evidence_owner_not_configured");
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
