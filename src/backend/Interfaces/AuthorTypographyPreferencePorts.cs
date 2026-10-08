using FsusBlog.Shared.Contracts.AuthorTypography;

namespace FsusBlog.Server.Interfaces;

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
