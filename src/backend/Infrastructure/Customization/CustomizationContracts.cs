namespace FsusBlog.Server.Infrastructure.Customization;

/// <summary>
/// A user's customization identity. Each user may own multiple profiles.
/// </summary>
public sealed class CustomizationProfile
{
    public long Id
    {
        get; set;
    }

    public int UserId
    {
        get; set;
    }

    public string Name { get; set; } = string.Empty;

    public DateTime CreatedAtUtc
    {
        get; set;
    }

    public DateTime UpdatedAtUtc
    {
        get; set;
    }
}

/// <summary>
/// Immutable snapshot of a profile's customization payload at a specific version.
/// </summary>
public sealed class CustomizationVersion
{
    public long Id
    {
        get; set;
    }

    public long ProfileId
    {
        get; set;
    }

    public int Version
    {
        get; set;
    }

    /// <summary>
    /// Typed hash-bound customization payload stored as JSON.
    /// </summary>
    public string Payload { get; set; } = string.Empty;

    public DateTime CreatedAtUtc
    {
        get; set;
    }
}

/// <summary>
/// Mutable working copy of a profile's customization state, protected by ETag optimistic concurrency.
/// </summary>
public sealed class CustomizationDraft
{
    public long Id
    {
        get; set;
    }

    public long ProfileId
    {
        get; set;
    }

    /// <summary>
    /// The version this draft was branched from, if any.
    /// </summary>
    public long? VersionId
    {
        get; set;
    }

    /// <summary>
    /// Mutable customization payload stored as JSON.
    /// </summary>
    public string Payload { get; set; } = string.Empty;

    /// <summary>
    /// Opaque concurrency token. Clients must supply this value via If-Match when updating.
    /// </summary>
    public string Etag { get; set; } = string.Empty;

    public DateTime UpdatedAtUtc
    {
        get; set;
    }
}

/// <summary>
/// Immutable diff capturing the changes between two versions of a profile.
/// </summary>
public sealed class CustomizationChangeSet
{
    public long Id
    {
        get; set;
    }

    public long ProfileId
    {
        get; set;
    }

    public long FromVersionId
    {
        get; set;
    }

    public long ToVersionId
    {
        get; set;
    }

    /// <summary>
    /// Structured diff payload stored as JSONB.
    /// </summary>
    public string Changes { get; set; } = string.Empty;

    public DateTime CreatedAtUtc
    {
        get; set;
    }
}

/// <summary>
/// Request body for creating a new customization profile.
/// </summary>
public sealed class CreateCustomizationProfileRequest
{
    public string Name { get; set; } = string.Empty;
}

/// <summary>
/// Request body for upserting a customization draft.
/// </summary>
public sealed class UpsertCustomizationDraftRequest
{
    /// <summary>
    /// The version id this draft is based on. May be null to create a blank draft.
    /// </summary>
    public long? VersionId
    {
        get; set;
    }

    /// <summary>
    /// The customization payload as a JSON string.
    /// </summary>
    public string Payload { get; set; } = string.Empty;
}

/// <summary>
/// Numeric identifiers emitted for profile-scoped resources.
/// </summary>
public static class CustomizationProfilePortIds
{
    public const string ProfileId = "profile.id";
    public const string VersionId = "version.id";
    public const string DraftId = "draft.id";
    public const string ChangeSetId = "changeset.id";
}
