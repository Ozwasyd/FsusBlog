using System.Collections.Immutable;
using System.Data.Common;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.SchemaMigration;

namespace FsusBlog.Migration;

// These are compiled-owner ports, not CLI plugins, SQL delegates or JSON approvals.
internal interface IOfflineMigrationCurrentSchemaObserver
{
    // Use the original current authority and exact provider projection on this native
    // read-only snapshot; reject every unknown, missing or extra physical object.
    // observedDatabase comes from the issuer's native identity read on this exact
    // session, not request/plan fields or an observer-owned second capture.
    // A provider's source fingerprint/catalog-only reader cannot fill this port:
    // every complete current physical/effect projection must be independently checked.
    Task<CurrentSchemaAdmissionObservation> ObserveAsync(
        DbConnection connection, DbTransaction transaction,
        CurrentSchemaDatabaseIdentity observedDatabase, CancellationToken cancellationToken);
}

internal sealed record OfflineMigrationCurrentSchemaAuthoritySnapshot(
    OfflineMigrationBackupObservation AuthenticatedBackup,
    CurrentSchemaVerifierIdentity RetainedPlanTool,
    CurrentSchemaVerifierIdentity CurrentVerifier,
    OfflineMigrationSourceRegistry Registry,
    OfflineMigrationDag Dag,
    TimeSpan MaximumBackupAge,
    ImmutableArray<CurrentSchemaArtifactReference> RecoveryReferences);

internal interface IOfflineMigrationCurrentSchemaVerificationAuthority
{
    // Authenticate the original capture/restore artifacts and approved registry/DAG
    // and tool provenance independently. Never fill observations from plan.Backup/Tool.
    Task<OfflineMigrationCurrentSchemaAuthoritySnapshot> ReadAsync(
        OfflineMigrationPlan plan, DbConnection connection, DbTransaction transaction,
        CancellationToken cancellationToken);
}

internal interface IOfflineMigrationVerificationArtifactReader
{
    // Independently read the original explicit artifact's complete bytes; never select
    // latest or serialize a supplied record as a substitute for an existing artifact.
    Task<ReadOnlyMemory<byte>> ReadAsync(
        CurrentSchemaArtifactReference artifact, CancellationToken cancellationToken);
}

internal sealed record OfflineMigrationCurrentSchemaVerificationCapabilities(
    IOfflineMigrationVerificationArtifactReader Artifacts,
    IOfflineMigrationCurrentSchemaObserver CurrentSchema,
    IOfflineMigrationCurrentSchemaVerificationAuthority Authority,
    IOfflineMigrationApplyOperationRegistry Operations);

internal static class OfflineMigrationCurrentSchemaVerificationOwners
{
    internal static IOfflineMigrationVerificationArtifactReader CreateOwnedArtifactReader()
        => new OfflineMigrationCurrentSchemaArtifactReader();

    internal static OfflineMigrationCurrentSchemaVerificationCapabilities CreateOwned()
    {
        // Native current-schema and operation observers plus an authenticated backup
        // owner are not yet registered. A recorded proof or successful drill flag
        // cannot fill these capabilities, even when all supplied hashes agree.
        throw new InvalidOperationException("current_verify_native_owners_not_configured");
    }
}
