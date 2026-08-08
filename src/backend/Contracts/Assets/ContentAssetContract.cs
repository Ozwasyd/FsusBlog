namespace FsusBlog.Server.Contracts.Assets;

public enum ContentAssetState
{
    Pending = 0,
    Ready = 1,
    Failed = 2
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
    public const string Pending = "pending";
    public const string Ready = "ready";
    public const string Failed = "failed";

    public static bool IsValid(string? value)
        => value is Pending or Ready or Failed;
}

/// <summary>
/// Content asset domain record. Identity flows exclusively through
/// <see cref="AssetId"/> and <see cref="AssetStorageKey"/>; public URLs are a
/// presentation boundary handled only by <see cref="PublicAssetUrlCodec"/>.
/// </summary>
public sealed record AssetRecord(
    AssetId Id,
    AssetStorageKey StorageKey,
    string MimeType,
    long SizeBytes,
    string? Sha256,
    int? WidthPixels,
    int? HeightPixels,
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
    int ReferenceCount,
    DateTimeOffset UpdatedAtUtc)
{
    public string CompositeKey
        => $"{AssetId}:{SourceKind}:{SourceKey}";
}
