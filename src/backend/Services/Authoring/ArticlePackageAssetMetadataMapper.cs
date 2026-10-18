using System.Security.Cryptography;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Finite actual-byte metadata projection through canonical Asset contracts, without export rights or retention.</summary>
public static class ArticlePackageAssetMetadataMapper
{
    public const int MaxCandidateAssetBytes = 32 * 1024 * 1024;

    public static ArticlePackageManifestCandidateResult TryMapCandidate(
        ArticlePackageIdentity portableAsset,
        AssetRecord? record,
        ReadOnlySpan<byte> sourceBytes,
        out ArticlePackageManifestAssetMetadataCandidate? candidate)
    {
        candidate = null;
        if (record is null || sourceBytes.Length > MaxCandidateAssetBytes)
        {
            return Invalid("article_package_manifest_asset_input_invalid");
        }
        try
        {
            ContentAssetSchemaValidator.Validate(record);
            if (record.Id.Value == Guid.Empty || !AssetStorageKey.TryParse(record.StorageKey.Value, out _))
            {
                return Invalid("article_package_manifest_asset_input_invalid");
            }
            if (record.StorageClass != "public")
            {
                return Invalid("article_package_manifest_asset_private_export_policy_unavailable");
            }
            if (record.State != ContentAssetState.Active)
            {
                return Invalid("article_package_manifest_asset_retention_unavailable");
            }
            if (record.Extension == ".svg")
            {
                return Invalid("article_package_manifest_asset_media_inspection_unavailable");
            }
            if (record.SizeBytes != sourceBytes.Length || record.Sha256 is null)
            {
                return Invalid("article_package_manifest_asset_byte_binding_mismatch");
            }
            byte[] owned = sourceBytes.ToArray();
            string digest = Convert.ToHexStringLower(SHA256.HashData(owned));
            if (digest != record.Sha256)
            {
                return Invalid("article_package_manifest_asset_byte_binding_mismatch");
            }
            if (!ContentAssetMediaInspector.TryInspect(record.Extension, owned, out var media))
            {
                return Invalid("article_package_manifest_asset_media_inspection_unavailable");
            }
            if (media.MediaType != record.MimeType || media.Width != record.WidthPixels || media.Height != record.HeightPixels)
            {
                return Invalid("article_package_manifest_asset_media_binding_mismatch");
            }
            return ArticlePackageManifestCandidateCodec.TryCreateAssetMetadataCandidate(
                new(portableAsset, record.Id.ToString(), digest, record.MimeType, record.Extension, owned.Length,
                    record.WidthPixels, record.HeightPixels, "assets/" + portableAsset.FileNameToken + record.Extension), out candidate);
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_asset_input_invalid");
        }
    }

    public static ArticlePackageManifestCandidateResult ValidateCandidate(
        ArticlePackageManifestAssetMetadataCandidate? candidate,
        ArticlePackageIdentity portableAsset,
        AssetRecord? record,
        ReadOnlySpan<byte> sourceBytes)
    {
        var result = TryMapCandidate(portableAsset, record, sourceBytes, out var projected);
        if (!result.IsValid)
        {
            return result;
        }
        return candidate is not null && candidate.Metadata == projected!.Metadata && candidate.ComponentDigest == projected.ComponentDigest
            ? new(true, null)
            : Invalid("article_package_manifest_asset_candidate_mismatch");
    }

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);
}
