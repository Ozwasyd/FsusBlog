using System.Collections.Immutable;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

/// <summary>Execution outcome only; completion does not certify the current database schema.</summary>
public enum OfflineMigrationApplyStatus
{
    Completed,
    NoOpVerified,
    Failed,
    Cancelled,
    RecoveryRequired
}

/// <summary>A durable event in one exact plan and invocation's append-only journal.</summary>
public enum OfflineMigrationApplyJournalState
{
    AttemptStarted,
    TransactionCommitted,
    BatchCommitted,
    StepVerified,
    AttemptFailed,
    AttemptCancelled,
    RecoveryRequired,
    ApplyCompleted
}

/// <summary>
/// A named operation-owner predicate and its observed fact vector. Expected facts must be
/// independently obtained from that owner; neither this record nor its digest proves truth.
/// Fact names and redacted values reuse the plan owner's closed observation vocabulary.
/// </summary>
public sealed record OfflineMigrationPredicateObservation(
    string PredicateReference,
    string OperationReference,
    string OperationSourceDigest,
    string SemanticDigest,
    ImmutableArray<OfflineMigrationFact> ExpectedFacts,
    ImmutableArray<OfflineMigrationFact> ActualFacts,
    string ContentDigest);

/// <summary>
/// Exact resume anchor. The journal head is an immutable entry reference, never a latest
/// selector; the invocation and sequence must agree with its verified parent chain.
/// </summary>
public sealed record OfflineMigrationApplyCheckpoint(
    CurrentSchemaArtifactReference JournalHead,
    string InvocationId,
    long Sequence);

/// <summary>Apply admission options; operations and their order come only from the sealed plan.</summary>
public sealed record OfflineMigrationApplyRequest(
    string InvocationId,
    int Attempt,
    bool ConfirmDestructive,
    OfflineMigrationApplyCheckpoint? Checkpoint = null);

/// <summary>
/// Immutable evidence of an attempt, committed unit, or terminal boundary. Commit events must
/// be persisted in the same database transaction as their effects. Watermarks and counts are
/// operation-owned bounded facts, not migration SQL or private content. FailureCode is a fixed
/// category, never a database exception, connection string, or caller-supplied message.
/// </summary>
public sealed record OfflineMigrationApplyJournalEntry(
    string Format,
    CurrentSchemaArtifactReference Plan,
    string PlanContentDigest,
    CurrentSchemaDatabaseIdentity Database,
    string InvocationId,
    long Sequence,
    int Attempt,
    string? StepId,
    string? OperationReference,
    OfflineMigrationExecutionMode? Mode,
    OfflineMigrationApplyJournalState State,
    string? IdempotencyKey,
    string? WatermarkBefore,
    string? WatermarkAfter,
    string? HighWatermark,
    long RowsProcessed,
    long ExpectedRows,
    bool UnitComplete,
    OfflineMigrationPredicateObservation? Before,
    OfflineMigrationPredicateObservation? After,
    string PreviousDigest,
    string ContentDigest,
    string? FailureCode,
    DateTimeOffset RecordedAt);

/// <summary>
/// Bounded apply evidence for independent re-reading. StepProofs contains at most one final
/// observation per plan step; the full journal is streamed from the exact checkpoint instead
/// of retaining every batch in memory. The terminal and journal must be checked
/// against the original plan, operation owners, and live database; no success flag or copied
/// observation is a final current-schema receipt or authorization to start the Server.
/// </summary>
public sealed record OfflineMigrationApplyResult(
    OfflineMigrationApplyStatus Status,
    CurrentSchemaArtifactReference Plan,
    string PlanContentDigest,
    CurrentSchemaDatabaseIdentity Database,
    OfflineMigrationApplyCheckpoint? Checkpoint,
    ImmutableArray<OfflineMigrationApplyJournalEntry> StepProofs,
    ImmutableArray<string> Codes);
