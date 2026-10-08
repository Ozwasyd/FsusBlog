using FsusBlog.Server.Contracts.Assets;

namespace FsusBlog.Server.Services.ArticleVault.Assets;

internal enum ArticleVaultAssetContentRelation
{
    Incomplete,
    Unchanged,
    LocalChanged,
    ServerChanged,
    ConvergedChange,
    DivergedChange
}

internal enum ArticleVaultAssetObservationSide
{
    Base,
    Local,
    Server
}

internal sealed record ArticleVaultAssetDiagnosticIssue(
    ArticleVaultAssetObservationSide Side,
    string ReasonCode);

/// <summary>
/// Evidence about three records for one AssetId. This is not a plan, permission
/// result, upload receipt or delete obligation. Matching digests cannot merge
/// owners, references or rights, and missing local bytes cannot request deletion.
/// </summary>
internal sealed record ArticleVaultAssetConflictDiagnostic(
    AssetId AssetId,
    string? BaseSha256,
    string? LocalSha256,
    string? ServerSha256,
    ArticleVaultAssetContentRelation ContentRelation,
    IReadOnlyList<ArticleVaultAssetDiagnosticIssue> Issues);

/// <summary>
/// Compares content identity without choosing a winner. Records retain their
/// individual ownership and storage-class facts; permissions and revisions need
/// separate authoritative observations unavailable in the current asset API.
/// </summary>
internal static class ArticleVaultAssetConflictDiagnostics
{
    internal static ArticleVaultAssetConflictDiagnostic Diagnose(
        AssetId assetId,
        AssetRecord? baseRecord,
        AssetRecord? localRecord,
        AssetRecord? serverRecord)
    {
        var issues = new List<ArticleVaultAssetDiagnosticIssue>();
        bool baseValid = CheckRecord(ArticleVaultAssetObservationSide.Base, baseRecord);
        bool localValid = CheckRecord(ArticleVaultAssetObservationSide.Local, localRecord);
        bool serverValid = CheckRecord(ArticleVaultAssetObservationSide.Server, serverRecord);
        ArticleVaultAssetContentRelation relation = ArticleVaultAssetContentRelation.Incomplete;
        if (baseValid && localValid && serverValid)
        {
            bool localChanged = !DigestEquals(baseRecord!, localRecord!);
            bool serverChanged = !DigestEquals(baseRecord!, serverRecord!);
            relation = (localChanged, serverChanged) switch
            {
                (false, false) => ArticleVaultAssetContentRelation.Unchanged,
                (true, false) => ArticleVaultAssetContentRelation.LocalChanged,
                (false, true) => ArticleVaultAssetContentRelation.ServerChanged,
                _ => DigestEquals(localRecord!, serverRecord!)
                    ? ArticleVaultAssetContentRelation.ConvergedChange
                    : ArticleVaultAssetContentRelation.DivergedChange
            };

            CheckDrift(baseRecord!, localRecord!, ArticleVaultAssetObservationSide.Local);
            CheckDrift(baseRecord!, serverRecord!, ArticleVaultAssetObservationSide.Server);
            if (DigestEquals(localRecord!, serverRecord!)
                && !SameMediaMetadata(localRecord!, serverRecord!)
                && !issues.Any(static issue => issue.ReasonCode == "article_vault_asset_media_metadata_drift"))
            {
                issues.Add(new(ArticleVaultAssetObservationSide.Server, "article_vault_asset_media_metadata_drift"));
            }
        }

        return new(
            assetId,
            baseRecord?.Sha256?.ToLowerInvariant(),
            localRecord?.Sha256?.ToLowerInvariant(),
            serverRecord?.Sha256?.ToLowerInvariant(),
            relation,
            issues.AsReadOnly());

        bool CheckRecord(ArticleVaultAssetObservationSide side, AssetRecord? record)
        {
            ArticleVaultAssetValidationResult result = ArticleVaultAssetValidator.ValidateRecord(assetId, record);
            if (!result.IsValid)
            {
                issues.Add(new(side, result.ReasonCode!));
            }
            return result.IsValid;
        }

        void CheckDrift(AssetRecord before, AssetRecord after, ArticleVaultAssetObservationSide side)
        {
            if (before.OwnerAdminPrincipalId != after.OwnerAdminPrincipalId)
            {
                issues.Add(new(side, "article_vault_asset_owner_drift"));
            }
            if (before.StorageClass != after.StorageClass)
            {
                issues.Add(new(side, "article_vault_asset_storage_class_drift"));
            }
            if (DigestEquals(before, after) && !SameMediaMetadata(before, after))
            {
                issues.Add(new(side, "article_vault_asset_media_metadata_drift"));
            }
        }
    }

    private static bool DigestEquals(AssetRecord left, AssetRecord right)
        => string.Equals(left.Sha256, right.Sha256, StringComparison.OrdinalIgnoreCase);

    private static bool SameMediaMetadata(AssetRecord left, AssetRecord right)
        => string.Equals(left.MimeType, right.MimeType, StringComparison.OrdinalIgnoreCase)
            && string.Equals(left.Extension, right.Extension, StringComparison.OrdinalIgnoreCase)
            && left.SizeBytes == right.SizeBytes
            && left.WidthPixels == right.WidthPixels
            && left.HeightPixels == right.HeightPixels;
}
