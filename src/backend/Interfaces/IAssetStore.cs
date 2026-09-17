using FsusBlog.Server.Contracts.Assets;

namespace FsusBlog.Server.Interfaces;

public enum AssetDeleteResult
{
    Deleted,
    NotFound,
    Referenced
}

public sealed record AssetDeleteReferenceLocation(
    string SourceKind,
    string SourceKey,
    int? ArticleId,
    int ReferenceCount);

public sealed record AssetDeleteReferenceSummary(
    int SourceCount,
    IReadOnlyList<AssetDeleteReferenceLocation> Locations)
{
    public bool IsTruncated => SourceCount > Locations.Count;
}

public readonly record struct AssetDeleteOutcome(
    AssetDeleteResult Result,
    AssetDeleteReferenceSummary? ReferenceSummary = null);

public interface IAssetStore
{
    Task<AssetDeleteOutcome> DeleteAsync(AssetId assetId, CancellationToken cancellationToken = default);
}
