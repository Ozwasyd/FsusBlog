using FsusBlog.Server.Contracts.Assets;

namespace FsusBlog.Server.Interfaces;

/// <summary>
/// A current server observation obtained with the original upload session grant.
/// This proves session ownership, bytes and canonical ledger facts; it does not
/// grant article rights or seal a caller's Vault plan, operation or revision.
/// </summary>
public sealed record UploadAssetObservation(
    string Schema,
    string UploadId,
    AssetRecord Asset,
    string PublicUrl,
    IReadOnlyList<AssetReference> References,
    string AssetVersionSha256,
    string ReferenceLedgerSha256);
