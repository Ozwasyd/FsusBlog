using FsusBlog.Shared.Contracts.AuthorTypography;

namespace FsusBlog.Server.Interfaces;

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

/// <summary>
/// Sole server policy for a profile verified against the active public design baseline.
/// An unavailable policy returns null; consumers must not invent a client/default catalog.
/// </summary>
public interface IAuthorTypographyCurrentDesignDefaultPolicy
{
    /// <summary>Returns the verified current design profile, or null while its source contract is unavailable.</summary>
    AuthorTypographyProfile? GetCurrentDesignDefault();
}

/// <summary>Reads author typography through the same scoped service as writing-aid preferences.</summary>
public interface IAuthorTypographyPreferenceReader
{
    /// <summary>
    /// The endpoint supplies server-authenticated account/site scope. The implementation
    /// validates access and resolves missing/corrupt/future data through its sole design policy.
    /// </summary>
    Task<AuthorTypographyPreferenceReadResult> GetTypographyAsync(
        AuthorTypographyScope authenticatedScope,
        CancellationToken cancellationToken = default);
}

/// <summary>Only Committed/Replayed denote an authoritative persisted request result.</summary>
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
/// A successful writer result carries its original persisted request record. A CAS refusal
/// may expose a scoped current snapshot but never a newly constructed success record.
/// Consumers must validate record content; the domain digest alone does not authenticate storage.
/// </summary>
public sealed record AuthorTypographyPreferenceWriteResult(
    AuthorTypographyPreferenceWriteOutcome Outcome,
    AuthorTypographyRecordedRequest? Record,
    AuthorTypographySnapshot? CurrentSnapshot);

/// <summary>
/// Mutates only typography fields through the single shared author preference transaction.
/// Implementation and DI must reuse the existing scoped UserLocalePreferenceService instance.
/// </summary>
public interface IAuthorTypographyPreferenceCommand
{
    /// <summary>
    /// Persisted matching requests replay before fresh expected-revision CAS. Set/reset
    /// preserve locale and writing aids; reset derives its profile only from the server policy.
    /// </summary>
    Task<AuthorTypographyPreferenceWriteResult> UpdateTypographyAsync(
        AuthorTypographyScope authenticatedScope,
        string deviceScope,
        AuthorTypographyMutationRequest request,
        CancellationToken cancellationToken = default);
}
