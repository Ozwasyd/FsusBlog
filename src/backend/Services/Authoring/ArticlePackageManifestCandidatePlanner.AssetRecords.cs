using System.Security.Cryptography;

using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Services.Authoring;

public static partial class ArticlePackageManifestCandidatePlanner
{
    /// <summary>
    /// Binds the complete supplied closure to an expected backend-owned plan, including every
    /// original AssetRecord field and owned byte. Private storage/owner/timestamp facts remain
    /// backend-only; a portable manifest alone cannot supply their expected snapshot.
    /// This comparison grants no ledger, permission, export or retention authority.
    /// </summary>
    public static ArticlePackageManifestCandidateResult TryBindCandidatePlanToSnapshot(
        ArticlePackageManifestCandidatePlan expected,
        IReadOnlyList<ArticlePackageManifestCandidateInput>? inputs,
        IReadOnlyList<ArticlePackageAssetCollectionSource>? sources,
        IReadOnlyList<ArticlePackageManifestAssetReference>? references,
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory,
        out ArticlePackageManifestCandidatePlan? plan,
        CancellationToken cancellationToken = default)
    {
        plan = null;
        cancellationToken.ThrowIfCancellationRequested();
        if (expected?.Assets is null)
        {
            return Invalid("article_package_manifest_asset_record_snapshot_unavailable");
        }
        ArticlePackageManifestCandidateResult result = TryBindCandidatePlan(expected.Manifest,
            inputs, sources, references, inventory, out var projected, cancellationToken);
        if (!result.IsValid)
        {
            return result;
        }
        if (projected!.Assets is null || expected.Assets.Count != projected.Assets.Count)
        {
            return Invalid("article_package_manifest_asset_record_snapshot_mismatch");
        }
        for (int index = 0; index < expected.Assets.Count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticlePackageManifestPlannedAsset frozen = expected.Assets[index];
            ArticlePackageManifestPlannedAsset actual = projected.Assets[index];
            string rawHash = Convert.ToHexStringLower(SHA256.HashData(frozen.Source.SourceBytes.Span));
            if (frozen.Record != actual.Record || frozen.Metadata.Metadata != actual.Metadata.Metadata
                || frozen.RawByteSha256 != rawHash || actual.RawByteSha256 != rawHash
                || !frozen.Source.SourceBytes.Span.SequenceEqual(actual.Source.SourceBytes.Span))
            {
                return Invalid("article_package_manifest_asset_record_snapshot_mismatch");
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        plan = projected;
        return new(true, null);
    }
}
