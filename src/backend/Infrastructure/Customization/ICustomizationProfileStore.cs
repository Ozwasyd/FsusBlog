namespace FsusBlog.Server.Infrastructure.Customization;

/// <summary>
/// Persistence contract for customization profile lifecycle and versioned state.
/// </summary>
public interface ICustomizationProfileStore
{
    /// <summary>
    /// List all profiles owned by a user.
    /// </summary>
    Task<IReadOnlyList<CustomizationProfile>> ListProfilesAsync(
        int userId,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Find a single profile by id.
    /// </summary>
    Task<CustomizationProfile?> GetProfileAsync(
        long profileId,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Create a new profile for a user. Returns the created profile.
    /// </summary>
    Task<CustomizationProfile> CreateProfileAsync(
        int userId,
        string name,
        DateTime createdAtUtc,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// List version snapshots for a profile, newest first.
    /// </summary>
    Task<IReadOnlyList<CustomizationVersion>> ListVersionsAsync(
        long profileId,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Create an immutable snapshot of the current draft as a new version.
    /// Returns the created version.
    /// </summary>
    Task<CustomizationVersion> CreateVersionAsync(
        long profileId,
        string payload,
        DateTime createdAtUtc,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Get a specific version by id.
    /// </summary>
    Task<CustomizationVersion?> GetVersionAsync(
        long versionId,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Get the current draft for a profile, or null if none exists.
    /// </summary>
    Task<CustomizationDraft?> GetDraftAsync(
        long profileId,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Upsert the draft for a profile. The <paramref name="expectedEtag"/> must match
    /// the current draft's etag. Returns null if the etag mismatched (conflict).
    /// To create a new draft when none exists, pass <c>null</c> for <paramref name="expectedEtag"/>.
    /// Returns the updated or created draft.
    /// </summary>
    Task<CustomizationDraft?> UpsertDraftAsync(
        long profileId,
        long? versionId,
        string payload,
        string newEtag,
        string? expectedEtag,
        DateTime updatedAtUtc,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// List change sets for a profile, newest first.
    /// </summary>
    Task<IReadOnlyList<CustomizationChangeSet>> ListChangeSetsAsync(
        long profileId,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Create a change set recording the diff between two versions.
    /// Returns the created change set.
    /// </summary>
    Task<CustomizationChangeSet> CreateChangeSetAsync(
        long profileId,
        long fromVersionId,
        long toVersionId,
        string changes,
        DateTime createdAtUtc,
        CancellationToken cancellationToken = default);
}
