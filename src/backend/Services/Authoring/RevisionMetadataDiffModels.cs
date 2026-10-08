using System.Collections.Immutable;

namespace FsusBlog.Server.Services.Authoring;

public enum RevisionMetadataDiffStatus
{
    Complete,
    PartialMissingAuthority,
    Unavailable,
    Stale,
    Invalid,
    BudgetExceeded,
    Cancelled,
    Tampered
}

public enum RevisionMetadataDiffCoverage
{
    None,
    Complete,
    PartialMissingAuthority
}

public enum RevisionMetadataDiffValueKind
{
    NotObserved,
    NotApplicable,
    Null,
    String,
    Integer,
    Boolean,
    UtcTicks,
    DateDayNumber,
    UnorderedIntegerSet
}

public enum RevisionMetadataDiffChangeKind
{
    Unchanged,
    Added,
    Removed,
    Replaced,
    SetChanged,
    MissingAuthority,
    NotApplicable
}

/// <summary>Typed derived value. Null, absent authority and empty strings are distinct.</summary>
public sealed record RevisionMetadataDiffValue(
    RevisionMetadataDiffValueKind Kind,
    string? Text = null,
    long? Number = null,
    bool? Boolean = null,
    ImmutableArray<int> Ids = default)
{
    public ImmutableArray<int> Ids { get; init; } = Ids.IsDefault ? [] : Ids;
}

public sealed record RevisionMetadataDiffField(
    string FieldId,
    string BeforePackageDigest,
    string AfterPackageDigest,
    string Authority,
    string Normalization,
    string DisplayFormat,
    bool Sensitive,
    RevisionMetadataDiffValue Before,
    RevisionMetadataDiffValue After,
    RevisionMetadataDiffChangeKind Change,
    ImmutableArray<int> AddedIds,
    ImmutableArray<int> RemovedIds);

/// <summary>Deterministic semantic receipt; elapsed worker time is kept outside its digest.</summary>
public sealed record RevisionMetadataDiffReceipt(
    string EngineVersion,
    string ProjectionVersion,
    string RegistryDigest,
    RevisionMetadataDiffStatus Status,
    RevisionMetadataDiffCoverage Coverage,
    string Reason,
    string? PlanDigest,
    string? BasePackageDigest,
    string? ComparePackageDigest,
    int? FieldCount,
    ImmutableArray<string> MissingAuthorities,
    string ContentDigest);

public sealed record RevisionMetadataDiffTiming(long ElapsedTicks, long Frequency);

public sealed record RevisionMetadataDiffResult(
    RevisionMetadataDiffReceipt Receipt,
    ImmutableArray<RevisionMetadataDiffField> Fields,
    RevisionMetadataDiffTiming Timing)
{
    public bool IsSuccess => Receipt.Status == RevisionMetadataDiffStatus.Complete;
    public bool IsReviewable => Receipt.Status is RevisionMetadataDiffStatus.Complete
        or RevisionMetadataDiffStatus.PartialMissingAuthority;
}
