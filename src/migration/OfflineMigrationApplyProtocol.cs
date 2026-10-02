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

// A compiled article/media owner cannot select the old no-media Execute route.
// It supplies actual retained source/media capabilities; Core alone persists the
// preparation and commits the caller transaction and the one journal.
internal abstract class OfflineMigrationArticleMediaOperation : OfflineMigrationApplyOperation
{
    internal abstract Task<OfflineMigrationMediaJournalEvidence> GetMediaBindingAsync(
        VerifiedOfflineMigrationPlan plan, CurrentSchemaArtifactReference artifact, string invocationId,
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken);

    internal abstract Task<OfflineMigrationApplyUnit> ExecuteMediaAsync(
        OfflineMigrationStep step, OfflineMigrationApplyJournalEntry? previousUnit,
        DbConnection connection, DbTransaction transaction, IArticleMediaPreservationJournal journal,
        CancellationToken cancellationToken);

    internal sealed override Task<OfflineMigrationApplyUnit> ExecuteAsync(
        OfflineMigrationStep step, OfflineMigrationApplyJournalEntry? previousUnit,
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
        => throw new InvalidOperationException("offline_apply_media_journal_required");
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
