using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

/// <summary>An exact, named observation owned by a versioned read-only extractor.</summary>
public sealed record OfflineMigrationFact(string Name, string Value);

/// <summary>
/// Complete schema, history, and business-shape observations. Extractor identity binds the
/// observation vocabulary; an empty list is not permission to omit an unobserved category.
/// </summary>
public sealed record OfflineMigrationSourceObservation(
    CurrentSchemaDatabaseIdentity Database,
    string ExtractorId,
    string ExtractorVersion,
    ImmutableArray<OfflineMigrationFact> Schema,
    ImmutableArray<OfflineMigrationFact> History,
    ImmutableArray<OfflineMigrationFact> BusinessShape,
    string ContentDigest);

/// <summary>The original backup owner's verified package and restore drill plus its restored database observation.</summary>
public sealed record OfflineMigrationBackupObservation(
    CurrentSchemaArtifactReference Package,
    CurrentSchemaArtifactReference Manifest,
    CurrentSchemaArtifactReference RestoreDrill,
    string BackupOwner,
    string BackupOwnerVersion,
    DateTimeOffset CapturedAt,
    DateTimeOffset RestoreVerifiedAt,
    string CaptureSnapshotId,
    string DatabaseDumpSha256,
    string RestoredDatabaseDumpSha256,
    OfflineMigrationSourceObservation SourceAtCapture,
    OfflineMigrationSourceObservation RestoredSource,
    ImmutableArray<OfflineMigrationFact> ArtifactDigests);

/// <summary>
/// A completed native snapshot capture, produced only after the original dump owner's
/// terminal handshake and the observer's independent hash of the pre-bound dump bytes.
/// An initial source/snapshot announcement without a dump digest is not this evidence.
/// </summary>
public sealed record OfflineMigrationBackupCaptureEvidence(
    OfflineMigrationSourceObservation Source,
    string SnapshotId,
    DateTimeOffset CapturedAt,
    string ObserverId,
    string ObserverVersion,
    string DatabaseDumpSha256,
    int TimeoutSeconds);

/// <summary>How a step's provider operation preserves failure and replay boundaries.</summary>
public enum OfflineMigrationExecutionMode
{
    Transaction,
    CheckpointedBatch
}

/// <summary>Frozen checkpoint and watermark bounds; zero batch size is reserved for a transactional step.</summary>
public sealed record OfflineMigrationResumePolicy(
    string Version,
    long MaximumBatchRows,
    string WatermarkDefinition,
    string ReplayPostcondition);

/// <summary>One dialect implementation of the same semantic step, bound to its compiled operation owner.</summary>
public sealed record OfflineMigrationProviderOperation(
    CurrentSchemaProviderKind Provider,
    string OperationReference,
    string OperationSourceDigest,
    string SemanticDigest,
    OfflineMigrationExecutionMode Mode);

/// <summary>Immutable semantic DAG node. Provider implementations may not redefine dependencies or business mapping.</summary>
public sealed record OfflineMigrationStep(
    string StepId,
    string SourcePrecondition,
    string TargetPostcondition,
    ImmutableArray<string> Dependencies,
    string IdempotencyDefinition,
    bool Destructive,
    OfflineMigrationResumePolicy ResumePolicy,
    ImmutableArray<OfflineMigrationProviderOperation> Operations);

/// <summary>
/// Content-addressed plan payload. Deserialization does not confer authorization: apply must
/// independently re-observe source or exact journal progress and revalidate every owner binding.
/// </summary>
public sealed record OfflineMigrationPlan(
    string Format,
    OfflineMigrationSourceObservation Source,
    string SourceFingerprintId,
    string SourceFingerprintVersion,
    string SourceRegistryDigest,
    CurrentSchemaTargetIdentity Target,
    string DagId,
    string DagVersion,
    string DagDigest,
    ImmutableArray<OfflineMigrationStep> OrderedSteps,
    OfflineMigrationBackupObservation Backup,
    CurrentSchemaVerifierIdentity Tool,
    string ContentDigest);

/// <summary>
/// Reads a complete source snapshot in one provider-owned read-only boundary. Implementations
/// must reject unsupported providers, unobserved categories, and concurrent observation drift.
/// </summary>
public interface IOfflineMigrationSourceObserver
{
    Task<OfflineMigrationSourceObservation> ObserveAsync(
        CurrentSchemaProviderKind provider,
        string connectionString,
        CancellationToken cancellationToken);
}

/// <summary>
/// The source observer owns one PostgreSQL repeatable-read, read-only session until the
/// original backup owner completes its dump of the actual exported snapshot. It does not
/// run a dump, choose a backup, or confer restore/admission authority.
/// </summary>
public interface IOfflineMigrationSnapshotSourceObserver : IOfflineMigrationSourceObserver
{
    /// <summary>
    /// Hold the native snapshot while the callback waits for the dump owner's actual terminal
    /// boundary, then independently hash that callback's pre-bound dump path before disposing
    /// the transaction. Callback errors, EOF, or cancellation must not produce capture evidence.
    /// CapturedAt is the UTC timestamp observed when that native snapshot is established,
    /// before the source scan, and must be identical in callback and terminal evidence.
    /// </summary>
    Task<(OfflineMigrationSourceObservation Source, string SnapshotId, DateTimeOffset CapturedAt, string DumpSha256)> CapturePostgreSqlSnapshotAsync(
        string connectionString,
        Func<OfflineMigrationSourceObservation, string, DateTimeOffset, CancellationToken, Task<string>> awaitCompletedDumpPath,
        CancellationToken cancellationToken);
}

/// <summary>
/// Pure plan byte identity owned by the migration assembly. A matching digest is integrity only, never registry, backup, or execution authorization.
/// </summary>
public static class OfflineMigrationPlanCodec
{
    /// <summary>Serialize the versioned payload with fixed declaration order and no invocation metadata.</summary>
    public static byte[] Serialize(OfflineMigrationPlan plan) => JsonSerializer.SerializeToUtf8Bytes(plan);

    /// <summary>Recompute the payload identity with its self-referential digest field empty.</summary>
    public static string ComputeContentDigest(OfflineMigrationPlan plan)
        => Convert.ToHexStringLower(SHA256.HashData(Serialize(plan with
        {
            ContentDigest = string.Empty
        })));
}
