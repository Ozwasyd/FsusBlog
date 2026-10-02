using System.Data.Common;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

// Only compiled operation owners implement these ports. They are not a caller SQL/delegate
// registry, and no production operation is fabricated for the currently unowned DAG entries.
internal interface IOfflineMigrationApplyOperationRegistry
{
    OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation operation);
}

internal abstract class OfflineMigrationApplyOperation
{
    internal abstract OfflineMigrationProviderOperation Identity { get; }
    internal abstract Task<OfflineMigrationPredicateObservation> ObserveAsync(
        string predicateReference, DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken);
    internal abstract Task<OfflineMigrationApplyUnit> ExecuteAsync(
        OfflineMigrationStep step, OfflineMigrationApplyJournalEntry? previousUnit,
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken);
}

internal sealed record OfflineMigrationApplyUnit(
    string? WatermarkBefore, string? WatermarkAfter, string? HighWatermark,
    long RowsProcessed, long ExpectedRows, bool Complete);

internal interface IOfflineMigrationPlanAdmission
{
    // Re-observe database identity, target/tool/DAG/backup authorities and original source or
    // exact verified progress on THIS locked connection and snapshot. Independently hash the
    // original canonical plan file bytes against artifact.Sha256, separately from its payload
    // ContentDigest; reconstructed payloads do not prove an artifact was read. A carrier is not a grant.
    Task RevalidateAsync(
        VerifiedOfflineMigrationPlan plan, CurrentSchemaArtifactReference artifact,
        OfflineMigrationApplyJournalVerifier progress, DbConnection connection,
        DbTransaction transaction, CancellationToken cancellationToken);
}

internal sealed class MissingOfflineMigrationApplyOperationRegistry : IOfflineMigrationApplyOperationRegistry
{
    // Bootstrap/current and legacy-to-current need actual operation owners before CLI apply
    // can be wired. An empty registry never makes an empty or partially supported plan succeed.
    public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation operation)
        => throw new InvalidOperationException("offline_apply_operation_owner_missing");
}
