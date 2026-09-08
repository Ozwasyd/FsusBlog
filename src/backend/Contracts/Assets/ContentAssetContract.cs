namespace FsusBlog.Server.Contracts.Assets;

public enum ContentAssetState
{
    Active = 0,
    PendingDelete = 1
}

public static class ContentAssetSourceKinds
{
    public const string Article = "article";
    public const string Draft = "draft";
    public const string Revision = "revision";

    public static bool IsValid(string? value)
        => value is Article or Draft or Revision;
}

public static class ContentAssetStates
{
    public const string Active = "active";
    public const string PendingDelete = "pending_delete";

    public static bool IsValid(string? value)
        => value is Active or PendingDelete;
}

/// <summary>Durable cleanup states that prohibit restoring references after byte deletion begins.</summary>
public static class ContentAssetCleanupMarkers
{
    public const string DeletePending = "content_asset_delete_pending";
}

/// <summary>
/// Content asset domain record. Identity flows exclusively through
/// <see cref="AssetId"/> and <see cref="AssetStorageKey"/>; public URLs are a
/// presentation boundary handled only by <see cref="PublicAssetUrlCodec"/>.
/// </summary>
public sealed record AssetRecord(
    AssetId Id,
    string StorageClass,
    AssetStorageKey StorageKey,
    string MimeType,
    string Extension,
    long SizeBytes,
    string? Sha256,
    int? WidthPixels,
    int? HeightPixels,
    long? OwnerAdminPrincipalId,
    ContentAssetState State,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc);

/// <summary>
/// Asset-to-source reference. The composite identity is exactly
/// (asset_id, source_kind, source_key) and never a URL.
/// </summary>
public sealed record AssetReference(
    AssetId AssetId,
    string SourceKind,
    string SourceKey,
    int? ArticleId,
    int ReferenceCount,
    string? AltText,
    DateTimeOffset UpdatedAtUtc)
{
    public string CompositeKey
        => $"{AssetId}:{SourceKind}:{SourceKey}";
}
