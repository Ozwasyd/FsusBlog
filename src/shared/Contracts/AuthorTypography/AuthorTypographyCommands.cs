namespace FsusBlog.Shared.Contracts.AuthorTypography;

/// <summary>Only closed profile replacement and reset are author typography mutations.</summary>
public enum AuthorTypographyMutation : byte
{
    SetProfile = 1,
    Reset = 2
}

/// <summary>
/// Domain input for the sole authenticated preference writer. Reset carries no profile;
/// the server supplies its current design default. This is not a wire codec or a store.
/// </summary>
public sealed record AuthorTypographyCommand(
    long ExpectedRevision,
    AuthorTypographyMutation Mutation,
    AuthorTypographyProfile? Profile);

/// <summary>
/// A validated proposal, not an accepted write. The sole writer must atomically compare
/// ExpectedRevision and preserve the other author preference fields when committing.
/// </summary>
public sealed record AuthorTypographyPreparedMutation(
    AuthorTypographyScope Scope,
    long ExpectedRevision,
    AuthorTypographyProfile Profile);

/// <summary>Finite domain preparation results; Prepared never denotes a committed CAS.</summary>
public enum AuthorTypographyCommandStatus : byte
{
    Prepared = 1,
    InvalidCommand = 2,
    InvalidSnapshot = 3,
    RevisionConflict = 4,
    RevisionExhausted = 5,
    CurrentDesignDefaultUnavailable = 6
}

/// <summary>Refusals carry no proposal; only the sole writer can turn a proposal into a receipt.</summary>
public sealed record AuthorTypographyCommandDecision(
    AuthorTypographyCommandStatus Status,
    AuthorTypographyPreparedMutation? PreparedMutation);
