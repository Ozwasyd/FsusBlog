using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>One original record and its supplied byte view, bound to an explicit portable identity.</summary>
public sealed record ArticlePackageAssetCollectionSource(
    ArticlePackageIdentity PortableAsset,
    AssetRecord Record,
    ReadOnlyMemory<byte> SourceBytes);

/// <summary>
/// Freezes a finite complete collection and delegates each byte/media check to the original asset mapper.
/// Supplied records and bytes are candidates, not authorized ledger reads or retention observations.
/// </summary>
public static class ArticlePackageAssetCollectionMapper
{
    public const long MaxCandidateCollectionBytes = 256L * 1024 * 1024;

    /// <summary>Maps owned bytes only after all input lists and aggregate byte budgets have been checked.</summary>
    public static ArticlePackageManifestCandidateResult TryMapCandidate(
        IReadOnlyList<ArticlePackageAssetCollectionSource>? sources,
        IReadOnlyList<ArticlePackageManifestAssetReference>? references,
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory,
        out ArticlePackageManifestAssetCollectionCandidate? candidate)
    {
        candidate = null;
        try
        {
            if (!FreezeCollection(sources, ArticlePackageInventory.MaxAssets, out ArticlePackageAssetCollectionSource[] heldSources)
                || !FreezeCollection(references, ArticlePackageManifestCandidateCodec.MaxAssetCollectionReferences, out ArticlePackageManifestAssetReference[] heldReferences)
                || !FreezeCollection(inventory, ArticlePackageInventory.MaxEntries, out ArticlePackageInventoryEntry[] heldInventory))
            {
                return Invalid("article_package_manifest_asset_collection_input_invalid");
            }
            ArticlePackageValidationResult inventoryResult = ArticlePackageInventory.Validate(heldInventory);
            if (!inventoryResult.IsValid)
            {
                return Invalid(inventoryResult.ReasonCode!);
            }
            long totalBytes = 0;
            var portableIds = new HashSet<ArticlePackageIdentity>();
            var sourceIds = new HashSet<AssetId>();
            foreach (ArticlePackageAssetCollectionSource source in heldSources)
            {
                if (source.Record is null || source.SourceBytes.Length > ArticlePackageAssetMetadataMapper.MaxCandidateAssetBytes
                    || source.SourceBytes.Length > MaxCandidateCollectionBytes - totalBytes)
                {
                    return Invalid("article_package_manifest_asset_collection_byte_budget_exceeded");
                }
                if (!portableIds.Add(source.PortableAsset) || !sourceIds.Add(source.Record.Id))
                {
                    return Invalid("article_package_manifest_asset_collection_duplicate");
                }
                totalBytes += source.SourceBytes.Length;
            }
            // Copy every byte view before projecting any entry; failed projections expose no prefix.
            for (int index = 0; index < heldSources.Length; index++)
            {
                heldSources[index] = heldSources[index] with
                {
                    SourceBytes = heldSources[index].SourceBytes.ToArray()
                };
            }
            var metadata = new ArticlePackageManifestAssetMetadata[heldSources.Length];
            for (int index = 0; index < heldSources.Length; index++)
            {
                ArticlePackageAssetCollectionSource source = heldSources[index];
                ArticlePackageManifestCandidateResult result = ArticlePackageAssetMetadataMapper.TryMapCandidate(
                    source.PortableAsset, source.Record, source.SourceBytes.Span, out var mapped);
                if (!result.IsValid)
                {
                    return result;
                }
                metadata[index] = mapped!.Metadata;
            }
            return ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate(metadata, heldReferences, heldInventory, out candidate);
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_asset_collection_input_invalid");
        }
        catch (IndexOutOfRangeException)
        {
            return Invalid("article_package_manifest_asset_collection_input_invalid");
        }
    }

    /// <summary>Recomputes the complete projection from supplied records/bytes; matching hashes never grant authority.</summary>
    public static ArticlePackageManifestCandidateResult ValidateCandidate(
        ArticlePackageManifestAssetCollectionCandidate? candidate,
        IReadOnlyList<ArticlePackageAssetCollectionSource>? sources,
        IReadOnlyList<ArticlePackageManifestAssetReference>? references,
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory)
    {
        ArticlePackageManifestCandidateResult result = TryMapCandidate(sources, references, inventory, out var mapped);
        if (!result.IsValid)
        {
            return result;
        }
        try
        {
            if (candidate is null || candidate.ComponentDigest != mapped!.ComponentDigest
                || !ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(candidate)
                    .AsSpan().SequenceEqual(ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(mapped)))
            {
                return Invalid("article_package_manifest_asset_collection_candidate_mismatch");
            }
            return new(true, null);
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_asset_collection_candidate_mismatch");
        }
    }

    private static bool FreezeCollection<T>(IReadOnlyList<T>? values, int maximum, out T[] held) where T : class
    {
        held = [];
        if (values is null)
        {
            return false;
        }
        int count = values.Count;
        if (count < 0 || count > maximum)
        {
            return false;
        }
        var copy = new T[count];
        for (int index = 0; index < count; index++)
        {
            T value = values[index];
            if (value is null)
            {
                return false;
            }
            copy[index] = value;
        }
        held = copy;
        return true;
    }

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);
}
