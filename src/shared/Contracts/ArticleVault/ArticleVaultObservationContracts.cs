namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Closes the filesystem event vocabulary without selecting an article identity or winner.</summary>
public enum VaultNormalizedEventClass
{
    Created,
    ContentChanged,
    MetadataSidecarChanged,
    Renamed,
    Moved,
    Removed,
    Reappeared,
    CaseCollision,
    UnicodeCollision,
    IncompleteWrite,
    PermissionBlocked,
    RescanRequired
}

/// <summary>Defines portable observation roles mapped explicitly from validated native facts.</summary>
public enum VaultRawObservationClass
{
    Created,
    Modified,
    AttributesChanged,
    ClosedAfterWrite,
    MovedFrom,
    MovedTo,
    Deleted,
    Restarted,
    Overflow,
    PermissionBlocked,
    RootLost,
    WatchInvalidated,
    Unknown
}

/// <summary>Binds pure observation data to a manifest, agent, root and native watch instance.</summary>
public sealed record VaultObservationBinding(VaultPathStructuralScope Scope, string WatchInstanceIdentity);

/// <summary>
/// Retains sequence coverage and the original native fact digest. Cookie is a move diagnostic,
/// never portable identity; timestamps intentionally have no role in normalization.
/// </summary>
public sealed record VaultRawObservation(
    long Sequence,
    VaultRawObservationClass Class,
    string? RelativePath,
    uint? MoveCookie,
    bool RescanRequired,
    bool WatermarkValid,
    string? ReasonCode,
    string NativeFactSha256);

/// <summary>Records a source projection, including missing, unreadable and incomplete observations.</summary>
public sealed record VaultFilesystemObservation(
    string RelativePath,
    bool Present,
    VaultSnapshotAssessment? Assessment);

/// <summary>Content-addresses an event candidate and the exact raw sequences that explain it.</summary>
public sealed record VaultNormalizedEvent(
    VaultNormalizedEventClass Class,
    string? RelativePath,
    string? OldRelativePath,
    string? PortableArticleIdentityCandidate,
    IReadOnlyList<long> RawSequences,
    string? SnapshotAssessmentSha256,
    string? ReasonCode);

/// <summary>Records one observed sequence and every conflicting original fact digest.</summary>
public sealed record VaultRawSequenceCoverage(long Sequence, IReadOnlyList<string> NativeFactSha256s);

/// <summary>Represents pure observation progress; validity never grants native or planner admission.</summary>
public sealed record VaultObservationWatermark(
    string WatchInstanceIdentity,
    long LastSequence,
    string FilesystemSnapshotSha256,
    string? PreviousBatchSha256);

/// <summary>Closes rescan obligation state while retaining failure and ownership history.</summary>
public enum VaultRescanState
{
    Required,
    Running,
    Failed,
    AwaitingNativeVerification
}

/// <summary>
/// Binds a mandatory rescan to its exact owner, root scope and interrupted watermark. Structural
/// completion cannot release synchronization admission or manufacture a native terminal receipt.
/// </summary>
public sealed record VaultRescanObligation(
    string Schema,
    int SchemaVersion,
    VaultObservationBinding Binding,
    string OwnerIdentity,
    string ScopeRelativePath,
    IReadOnlyList<string> ReasonCodes,
    VaultObservationWatermark WatermarkBefore,
    VaultRescanState State,
    int Attempt,
    string? ResultSnapshotSha256,
    string? NativeTerminalReceiptSha256,
    string ContentSha256)
{
    public bool BlocksSynchronization => true;
}

/// <summary>
/// Seals bounded, deterministic filesystem candidates and mandatory rescan obligations. This batch
/// performs no synchronization and requires native snapshot/rescan verification before admission.
/// </summary>
public sealed record VaultObservationBatch(
    string Schema,
    int SchemaVersion,
    VaultObservationBinding Binding,
    IReadOnlyList<VaultRawSequenceCoverage> RawCoverage,
    long? FirstRawSequence,
    long? LastRawSequence,
    string FilesystemSnapshotSha256,
    IReadOnlyList<string> SnapshotAssessmentSha256s,
    IReadOnlyList<VaultNormalizedEvent> Events,
    IReadOnlyList<VaultRescanObligation> RescanObligations,
    VaultObservationWatermark WatermarkBefore,
    VaultObservationWatermark WatermarkAfter,
    string ContentSha256)
{
    public bool RequiresNativeAdmission => true;

    public bool CanAdmitSynchronization => false;
}
