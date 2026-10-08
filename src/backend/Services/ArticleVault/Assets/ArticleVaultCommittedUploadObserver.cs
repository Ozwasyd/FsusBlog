using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

namespace FsusBlog.Server.Services.ArticleVault.Assets;

/// <summary>
/// Obtains the existing upload authority's byte and ledger observation, then
/// checks its asset identity and metadata against the supplied dependency.
/// This is not a Vault receipt: rights, plan/operation/revision bindings,
/// reuse, materialization and recovery still require their canonical owners.
/// </summary>
internal sealed class ArticleVaultCommittedUploadObserver(IFileService files)
{
    internal async Task<Result<UploadAssetObservation>> ObserveAsync(
        UploadSessionAccess access,
        VaultAssetDependency? expected,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (expected is null || expected.AssetIdentity == Guid.Empty
            || !ArticleEmbedContractDigest.IsSha256(expected.ContentSha256))
        {
            return Result<UploadAssetObservation>.Failure(ErrorCode.Validation, "article_vault_upload_dependency_invalid");
        }

        Result<UploadAssetObservation> result = await files.ObserveCommittedUploadAsync(
            access, expected.ContentSha256, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (result.IsFailure)
        {
            return result;
        }
        UploadAssetObservation? observation = result.Value;
        ArticleVaultAssetValidationResult record = ArticleVaultAssetValidator.ValidateRecord(
            AssetId.FromGuid(expected.AssetIdentity), observation?.Asset);
        if (!record.IsValid)
        {
            return Result<UploadAssetObservation>.Failure(ErrorCode.Conflict, record.ReasonCode!);
        }
        AssetRecord asset = observation!.Asset;
        if (asset.Sha256 != expected.ContentSha256 || asset.MimeType != expected.MimeType
            || asset.Extension != expected.Extension || asset.SizeBytes != expected.SizeBytes
            || asset.WidthPixels != expected.WidthPixels || asset.HeightPixels != expected.HeightPixels
            || asset.OwnerAdminPrincipalId != expected.OwnerAdminPrincipalId)
        {
            return Result<UploadAssetObservation>.Failure(ErrorCode.Conflict, "article_vault_upload_asset_metadata_drift");
        }
        if (!ArticleEmbedContractDigest.IsSha256(observation.AssetVersionSha256)
            || !ArticleEmbedContractDigest.IsSha256(observation.ReferenceLedgerSha256)
            || observation.References is null)
        {
            return Result<UploadAssetObservation>.Failure(ErrorCode.Conflict, "article_vault_upload_observation_incomplete");
        }
        return result;
    }
}
