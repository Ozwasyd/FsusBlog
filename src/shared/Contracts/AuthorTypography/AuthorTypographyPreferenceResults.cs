namespace FsusBlog.Shared.Contracts.AuthorTypography;

/// <summary>Finite read outcomes from the sole server preference authority.</summary>
public enum AuthorTypographyPreferenceReadOutcome : byte
{
    Stored = 1,
    CurrentDesignDefault = 2,
    Forbidden = 3,
    CurrentDesignDefaultUnavailable = 4,
    Unavailable = 5
}

/// <summary>
/// Stored/default observations carry their authenticated scope and actual shared revision.
/// Refusals carry no snapshot. A missing row uses revision zero, never a client default.
/// </summary>
public sealed record AuthorTypographyPreferenceReadResult(
    AuthorTypographyPreferenceReadOutcome Outcome,
    AuthorTypographySnapshot? Snapshot);

/// <summary>Only Committed/Replayed denote a persisted request result from the sole writer.</summary>
public enum AuthorTypographyPreferenceWriteOutcome : byte
{
    Committed = 1,
    Replayed = 2,
    RevisionConflict = 3,
    RequestIdentityConflict = 4,
    InvalidRequest = 5,
    Forbidden = 6,
    CurrentDesignDefaultUnavailable = 7,
    Unavailable = 8
}

/// <summary>
/// Success carries its original persisted request record. On replay, CurrentSnapshot is
/// the original committed snapshot, not the latest row; read again before another CAS.
/// A revision conflict may carry a separately observed scoped snapshot or null. Other
/// refusals carry neither payload. Shape/content validation does not authenticate storage.
/// </summary>
public sealed record AuthorTypographyPreferenceWriteResult(
    AuthorTypographyPreferenceWriteOutcome Outcome,
    AuthorTypographyRecordedRequest? Record,
    AuthorTypographySnapshot? CurrentSnapshot);
