using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Validates finite v2 import candidates against actual owned media bytes, without manufacturing
/// ledger records or invoking the export mapper. Metadata remains untrusted source assertions:
/// success supplies no storage, source, rights, retention, archive or execution authority.
/// </summary>
public static class ArticlePackageImportAssetCandidateValidator
{
    /// <summary>
    /// Checks the sole byte/root/checksum path before calling the existing content media inspector.
    /// The complete candidate is withheld on any failure or cancellation; no business writes occur.
    /// </summary>
    public static ArticlePackageManifestCandidateResult Validate(
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory,
        IReadOnlyList<ArticlePackageFileBytes>? files,
        ArticlePackageManifestAssetCollectionCandidate? assets,
        out ArticlePackageValidatedImportCandidate? candidate,
        CancellationToken cancellationToken = default)
    {
        candidate = null;
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidateBytes.Validate(
            inventory, files, assets, out var bytesCandidate, cancellationToken);
        if (!result.IsValid)
        {
            return result;
        }
        result = ValidateMedia(bytesCandidate!, cancellationToken);
        if (result.IsValid)
        {
            candidate = bytesCandidate;
        }
        return result;
    }

    /// <summary>
    /// Consumes actual CRC-checked decompression and archive-derived independent inventory through
    /// the original ZIP reader. The same media checks apply to stored and deflated asset entries.
    /// </summary>
    public static ArticlePackageManifestCandidateResult TryReadCandidate(
        ReadOnlySpan<byte> archiveBytes,
        ArticlePackageManifestAssetCollectionCandidate? assets,
        out ArticlePackageImportZipCandidate? candidate,
        CancellationToken cancellationToken = default)
    {
        candidate = null;
        ArticlePackageManifestCandidateResult result = ArticlePackageImportZipCandidateReader.TryReadCandidate(
            archiveBytes, assets, out var zipCandidate, cancellationToken);
        if (!result.IsValid)
        {
            return result;
        }
        result = ValidateMedia(zipCandidate!.Candidate, cancellationToken);
        if (result.IsValid)
        {
            candidate = zipCandidate;
        }
        return result;
    }

    private static ArticlePackageManifestCandidateResult ValidateMedia(
        ArticlePackageValidatedImportCandidate candidate,
        CancellationToken cancellationToken)
    {
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (ArticlePackageManifestAssetMetadataCandidate asset in candidate.Manifest.Assets!.Assets)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ArticlePackageManifestAssetMetadata metadata = asset.Metadata;
                // Keep the original finite media profile and budget. SVG inspection does not
                // establish sanitization; unsupported media has no fallback or fabricated facts.
                if (metadata.SizeBytes > ArticlePackageAssetMetadataMapper.MaxCandidateAssetBytes)
                {
                    return Invalid("article_package_import_asset_media_budget_exceeded");
                }
                if (metadata.Extension == ".svg")
                {
                    return Invalid("article_package_manifest_asset_media_inspection_unavailable");
                }
                byte[] bytes = candidate.CopyFileBytes(metadata.PackagePath);
                if (!ContentAssetMediaInspector.TryInspect(metadata.Extension, bytes, out var media))
                {
                    return Invalid("article_package_manifest_asset_media_inspection_unavailable");
                }
                cancellationToken.ThrowIfCancellationRequested();
                if (media.MediaType != metadata.MimeType
                    || media.Width != metadata.WidthPixels || media.Height != metadata.HeightPixels)
                {
                    return Invalid("article_package_manifest_asset_media_binding_mismatch");
                }
            }
            cancellationToken.ThrowIfCancellationRequested();
            return new(true, null);
        }
        catch (OperationCanceledException)
        {
            return Invalid("article_package_import_cancelled");
        }
    }

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);
}
