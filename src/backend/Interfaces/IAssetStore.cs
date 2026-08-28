using FsusBlog.Server.Contracts.Assets;

namespace FsusBlog.Server.Interfaces;

public enum AssetDeleteResult
{
    Deleted,
    NotFound,
    Referenced
}

public interface IAssetStore
{
    Task<AssetDeleteResult> DeleteAsync(AssetId assetId, CancellationToken cancellationToken = default);
}
