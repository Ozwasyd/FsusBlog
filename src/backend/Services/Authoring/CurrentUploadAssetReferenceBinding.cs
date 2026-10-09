using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Shared exact source-edge binding of original upload observations. Native byte, metadata,
/// session and ledger acquisition remain in FileService; this check issues no reuse grant.
/// </summary>
internal static class CurrentUploadAssetReferenceBinding
{
    internal static AssetReference? FindReference(
        UploadAssetObservation upload,
        UploadSessionAccess session,
        AssetId assetId,
        string sha256,
        string sourceKind,
        string sourceKey,
        int? articleId)
    {
        if (upload.Schema != "fsusblog.upload-asset-observation.v1" || upload.UploadId != session.UploadId
            || upload.Asset.Id != assetId || upload.Asset.OwnerAdminPrincipalId != session.OwnerAdminPrincipalId
            || upload.Asset.State != ContentAssetState.Active || upload.Asset.Sha256 != sha256
            || !Digest(upload.AssetVersionSha256) || !Digest(upload.ReferenceLedgerSha256)
            || sourceKind is not (ContentAssetSourceKinds.Article or ContentAssetSourceKinds.Draft or ContentAssetSourceKinds.Revision)
            || string.IsNullOrWhiteSpace(sourceKey))
        {
            return null;
        }
        AssetReference[] edges = [.. upload.References.Where(value => value.AssetId == assetId
            && value.SourceKind == sourceKind && value.SourceKey == sourceKey)];
        return edges.Length == 1 && edges[0].ArticleId == articleId && edges[0].ReferenceCount > 0
            ? edges[0] : null;
    }

    internal static UploadAssetObservation Freeze(UploadAssetObservation upload)
        => upload with
        {
            References = Array.AsReadOnly(upload.References.ToArray())
        };

    private static bool Digest(string? value) => value is { Length: 64 }
        && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
}
