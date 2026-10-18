using System.Collections.Immutable;
using System.Text.Json.Serialization;

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
    ApplyCompleted,
    /// <summary>Original Core durably retained an exact article/media binding before publication or graph effects.</summary>
    MediaPrepared,
    /// <summary>Verified physical publication CAS, committed atomically with its graph unit on the original transaction.</summary>
    MediaPublished
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
    OfflineMigrationJournalAnchor JournalHead,
    string InvocationId,
    long Sequence);

/// <summary>
/// A content-addressed journal entry's semantic seal, excluding its self-digest field.
/// This is not an artifact-byte SHA. An exported checkpoint artifact must separately bind
/// the SHA of all actual file bytes using the current artifact reference contract.
/// </summary>
public sealed record OfflineMigrationJournalAnchor(string Reference, string EntryDigest);

/// <summary>
/// Apply admission options; operations and their order come only from the sealed plan.
/// CleanupBudget must be explicitly positive and supported by the runtime timer before
/// any write. Cleanup receives its own token/deadline after main-request cancellation;
/// a budget does not prove the native session or transaction has actually terminated.
/// </summary>
public sealed record OfflineMigrationApplyRequest(
    string InvocationId,
    int Attempt,
    bool ConfirmDestructive,
    OfflineMigrationApplyCheckpoint? Checkpoint = null,
    TimeSpan? CleanupBudget = null);

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
    DateTimeOffset RecordedAt)
{
    // Migration-owned raw media binding; never crosses the current Shared receipt boundary.
    // Null is omitted so every original non-media v1 payload and digest remains unchanged.
    [JsonInclude]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    internal OfflineMigrationMediaJournalEvidence? Media
    {
        get; init;
    }
}

internal sealed record OfflineMigrationMediaJournalEvidence(
    string InvocationId, ArticleMediaBinding Binding, string? GenerationIdentity);

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
