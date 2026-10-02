using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Contracts.Migration;

/// <summary>The explicit database dialect; no connection-string or release inference selects it.</summary>
public enum OfflineMigrationProvider
{
    PostgreSql,
    MySql,
    Sqlite
}

/// <summary>Identity observed from the selected database, not a release, slot, or display name.</summary>
public sealed record OfflineMigrationDatabaseIdentity(
    OfflineMigrationProvider Provider,
    string InstanceId,
    string DatabaseId);

/// <summary>An exact, named observation owned by a versioned read-only extractor.</summary>
public sealed record OfflineMigrationFact(string Name, string Value);

/// <summary>
/// Complete schema, history, and business-shape observations. Extractor identity binds the
/// observation vocabulary; an empty list is not permission to omit an unobserved category.
/// </summary>
public sealed record OfflineMigrationSourceObservation(
    OfflineMigrationDatabaseIdentity Database,
    string ExtractorId,
    string ExtractorVersion,
    ImmutableArray<OfflineMigrationFact> Schema,
    ImmutableArray<OfflineMigrationFact> History,
    ImmutableArray<OfflineMigrationFact> BusinessShape);

/// <summary>Exact immutable artifact reference and digest; a path or latest selector alone is insufficient.</summary>
public sealed record OfflineMigrationArtifactReference(string Reference, string Sha256);

/// <summary>The original backup owner's verified package and restore drill plus its restored database observation.</summary>
public sealed record OfflineMigrationBackupObservation(
    OfflineMigrationArtifactReference Package,
    OfflineMigrationArtifactReference Manifest,
    OfflineMigrationArtifactReference RestoreDrill,
    string BackupOwner,
    string BackupOwnerVersion,
    DateTimeOffset CapturedAt,
    DateTimeOffset RestoreVerifiedAt,
    OfflineMigrationSourceObservation SourceAtCapture,
    OfflineMigrationSourceObservation RestoredSource,
    ImmutableArray<OfflineMigrationFact> ArtifactDigests);

/// <summary>Source, worktree, executable closure, and configuration identity observed by their existing owners.</summary>
public sealed record OfflineMigrationToolIdentity(
    string SourceRevision,
    string WorktreeDigest,
    string ToolchainDigest,
    string ConfigurationDigest);

/// <summary>Owner-computed current target identity, independent of migration descriptors and source baselines.</summary>
public sealed record OfflineMigrationTargetIdentity(
    string ModelVersion,
    string ExtractorVersion,
    string GeneratorVersion,
    string SourceDigest,
    string ContentDigest);

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
    OfflineMigrationProvider Provider,
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
    OfflineMigrationTargetIdentity Target,
    string DagId,
    string DagVersion,
    string DagDigest,
    ImmutableArray<OfflineMigrationStep> OrderedSteps,
    OfflineMigrationBackupObservation Backup,
    OfflineMigrationToolIdentity Tool,
    string ContentDigest);

/// <summary>
/// Reads a complete source snapshot in one provider-owned read-only boundary. Implementations
/// must reject unsupported providers, unobserved categories, and concurrent observation drift.
/// </summary>
public interface IOfflineMigrationSourceObserver
{
    Task<OfflineMigrationSourceObservation> ObserveAsync(
        OfflineMigrationProvider provider,
        string connectionString,
        CancellationToken cancellationToken);
}

/// <summary>
/// Pure plan byte identity used by independent receipt consumers without loading migration
/// operations. A matching digest is integrity only, never registry, backup, or execution authorization.
/// </summary>
public static class OfflineMigrationPlanCodec
{
    /// <summary>Serialize the versioned payload with fixed declaration order and no invocation metadata.</summary>
    public static byte[] Serialize(OfflineMigrationPlan plan) => JsonSerializer.SerializeToUtf8Bytes(plan);

    /// <summary>Recompute the payload identity with its self-referential digest field empty.</summary>
    public static string ComputeContentDigest(OfflineMigrationPlan plan)
        => Convert.ToHexStringLower(SHA256.HashData(Serialize(plan with { ContentDigest = string.Empty })));
}
