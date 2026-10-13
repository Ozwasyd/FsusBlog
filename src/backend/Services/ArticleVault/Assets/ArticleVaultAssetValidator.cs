using System.Security.Cryptography;

using FsusBlog.Server.Contracts.Assets;

namespace FsusBlog.Server.Services.ArticleVault.Assets;

internal readonly record struct ArticleVaultAssetValidationResult(
    bool IsValid,
    string? ReasonCode,
    string? ObservedSha256 = null)
{
    internal static ArticleVaultAssetValidationResult Reject(string reasonCode)
        => new(false, reasonCode);
}

/// <summary>
/// Checks supplied bytes against a canonical asset record. The caller must obtain
/// bytes through the stable snapshot authority and the record through the asset
/// authority; this check establishes neither path safety nor read/write rights.
/// Media recognition uses the existing inspector, not a full media decoder.
/// </summary>
internal static class ArticleVaultAssetValidator
{
    internal static ArticleVaultAssetValidationResult ValidateBytes(
        AssetId expectedAssetId,
        AssetRecord? record,
        ReadOnlySpan<byte> bytes)
    {
        ArticleVaultAssetValidationResult metadata = ValidateRecord(expectedAssetId, record);
        if (!metadata.IsValid)
        {
            return metadata;
        }

        if (bytes.IsEmpty || bytes.Length != record!.SizeBytes)
        {
            return ArticleVaultAssetValidationResult.Reject("article_vault_asset_size_mismatch");
        }

        byte[] observedHash = SHA256.HashData(bytes);
        string observedSha256 = Convert.ToHexStringLower(observedHash);
        if (!CryptographicOperations.FixedTimeEquals(observedHash, Convert.FromHexString(record.Sha256!)))
        {
            return new(false, "article_vault_asset_digest_mismatch", observedSha256);
        }

        ContentAssetMediaMetadata media;
        try
        {
            if (!ContentAssetMediaInspector.TryInspect(record.Extension, bytes, out media))
            {
                return new(false, "article_vault_asset_media_invalid_or_unsupported", observedSha256);
            }
        }
        catch (Exception exception) when (exception is FormatException or OverflowException)
        {
            return new(false, "article_vault_asset_media_invalid_or_unsupported", observedSha256);
        }

        if (!string.Equals(record.MimeType, media.MediaType, StringComparison.OrdinalIgnoreCase)
            || record.WidthPixels != media.Width
            || record.HeightPixels != media.Height)
        {
            return new(false, "article_vault_asset_media_metadata_mismatch", observedSha256);
        }

        return new(true, null, observedSha256);
    }

    internal static ArticleVaultAssetValidationResult ValidateRecord(AssetId expectedAssetId, AssetRecord? record)
    {
        if (expectedAssetId.Value == Guid.Empty)
        {
            return ArticleVaultAssetValidationResult.Reject("article_vault_asset_identity_invalid");
        }
        if (record is null)
        {
            return ArticleVaultAssetValidationResult.Reject("article_vault_asset_missing");
        }
        if (record.Id != expectedAssetId)
        {
            return ArticleVaultAssetValidationResult.Reject("article_vault_asset_identity_mismatch");
        }
        if (!AssetStorageKey.TryParse(record.StorageKey.Value, out _))
        {
            return ArticleVaultAssetValidationResult.Reject("article_vault_asset_metadata_invalid");
        }

        try
        {
            ContentAssetSchemaValidator.Validate(record);
        }
        catch (ArgumentException)
        {
            return ArticleVaultAssetValidationResult.Reject("article_vault_asset_metadata_invalid");
        }

        if (record.Sha256 is null)
        {
            return ArticleVaultAssetValidationResult.Reject("article_vault_asset_digest_missing");
        }
        if (record.State != ContentAssetState.Active)
        {
            return ArticleVaultAssetValidationResult.Reject("article_vault_asset_inactive");
        }
        if (record.SizeBytes == 0)
        {
            return ArticleVaultAssetValidationResult.Reject("article_vault_asset_size_invalid");
        }

        return new(true, null);
    }
}
