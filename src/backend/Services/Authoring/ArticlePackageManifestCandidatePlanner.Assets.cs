using System.Security.Cryptography;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Owned asset bytes and supplied ledger record; neither grants current export permission.</summary>
public sealed class ArticlePackageManifestPlannedAsset
{
    private readonly byte[] _sourceBytes;

    internal ArticlePackageManifestPlannedAsset(
        ArticlePackageAssetCollectionSource source,
        ArticlePackageManifestAssetMetadataCandidate metadata,
        string rawByteSha256)
    {
        Record = source.Record with
        {
        };
        Metadata = metadata;
        RawByteSha256 = rawByteSha256;
        _sourceBytes = source.SourceBytes.ToArray();
    }

    public AssetRecord Record
    {
        get;
    }
    public ArticlePackageManifestAssetMetadataCandidate Metadata
    {
        get;
    }
    public string RawByteSha256
    {
        get;
    }

    /// <summary>Returns a detached copy; caller mutations cannot alter the frozen plan.</summary>
    public byte[] CopySourceBytes() => (byte[])_sourceBytes.Clone();

    internal ArticlePackageAssetCollectionSource Source => new(Metadata.Metadata.PortableAsset, Record, _sourceBytes);
}

public static partial class ArticlePackageManifestCandidatePlanner
{
    /// <summary>
    /// Projects the complete supplied closure through the original mappers and asset-root codec.
    /// Missing inputs are refused, including when the caller intends an explicitly empty asset set.
    /// Records are caller assertions pending an authorized reader; no permission label creates one.
    /// </summary>
    public static ArticlePackageManifestCandidateResult TryCreateCandidatePlan(
        IReadOnlyList<ArticlePackageManifestCandidateInput>? inputs,
        IReadOnlyList<ArticlePackageAssetCollectionSource>? sources,
        IReadOnlyList<ArticlePackageManifestAssetReference>? references,
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory,
        out ArticlePackageManifestCandidatePlan? plan,
        CancellationToken cancellationToken = default)
    {
        plan = null;
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            if (!FreezeAssetInputs(sources, ArticlePackageInventory.MaxAssets, cancellationToken, out var heldSources)
                || !FreezeAssetInputs(references, ArticlePackageManifestCandidateCodec.MaxAssetCollectionReferences, cancellationToken, out var heldReferences)
                || !FreezeAssetInputs(inventory, ArticlePackageInventory.MaxEntries, cancellationToken, out var heldInventory))
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
                cancellationToken.ThrowIfCancellationRequested();
                if (source.Record is null || source.SourceBytes.Length > ArticlePackageAssetMetadataMapper.MaxCandidateAssetBytes
                    || source.SourceBytes.Length > ArticlePackageAssetCollectionMapper.MaxCandidateCollectionBytes - totalBytes)
                {
                    return Invalid("article_package_manifest_asset_collection_byte_budget_exceeded");
                }
                if (!portableIds.Add(source.PortableAsset) || !sourceIds.Add(source.Record.Id))
                {
                    return Invalid("article_package_manifest_asset_collection_duplicate");
                }
                totalBytes += source.SourceBytes.Length;
            }
            // Bound every list and all bytes before copying or projecting any asset.
            for (int index = 0; index < heldSources.Length; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                heldSources[index] = heldSources[index] with
                {
                    Record = heldSources[index].Record with
                    {
                    },
                    SourceBytes = heldSources[index].SourceBytes.ToArray()
                };
            }
            ArticlePackageManifestCandidateResult articleResult = TryCreateCandidatePlan(inputs, out var articlePlan);
            if (!articleResult.IsValid)
            {
                return articleResult;
            }
            cancellationToken.ThrowIfCancellationRequested();
            ArticlePackageManifestCandidateResult mapped = ArticlePackageAssetCollectionMapper.TryMapCandidate(
                heldSources, heldReferences, heldInventory, out var collection);
            if (!mapped.IsValid)
            {
                return mapped;
            }
            var metadata = collection!.Assets.ToDictionary(static asset => asset.Metadata.PortableAsset);
            var assets = new ArticlePackageManifestPlannedAsset[heldSources.Length];
            for (int index = 0; index < heldSources.Length; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ArticlePackageAssetCollectionSource source = heldSources[index];
                ArticlePackageManifestAssetMetadataCandidate component = metadata[source.PortableAsset];
                string rawHash = Convert.ToHexStringLower(SHA256.HashData(source.SourceBytes.Span));
                if (rawHash != source.Record.Sha256 || rawHash != component.Metadata.Sha256
                    || source.SourceBytes.Length != component.Metadata.SizeBytes)
                {
                    return Invalid("article_package_manifest_asset_byte_binding_mismatch");
                }
                assets[index] = new(source, component, rawHash);
            }
            ArticlePackageManifestCandidateResult root = ArticlePackageManifestCandidateCodec.TryCreateCandidate(
                articlePlan!.Manifest.Articles, collection, heldInventory, out var manifest);
            if (!root.IsValid)
            {
                return root;
            }
            Array.Sort(assets, static (left, right) => string.CompareOrdinal(
                left.Metadata.Metadata.PortableAsset.Value, right.Metadata.Metadata.PortableAsset.Value));
            cancellationToken.ThrowIfCancellationRequested();
            plan = new(manifest!, articlePlan.Articles.ToArray(), assets);
            return new(true, null);
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

    /// <summary>
    /// Reprojects actual article and asset bytes, then checks the supplied root and every component
    /// and archive fact against that closure. A copied component digest cannot establish binding.
    /// </summary>
    public static ArticlePackageManifestCandidateResult TryBindCandidatePlan(
        ArticlePackageManifestCandidate? manifest,
        IReadOnlyList<ArticlePackageManifestCandidateInput>? inputs,
        IReadOnlyList<ArticlePackageAssetCollectionSource>? sources,
        IReadOnlyList<ArticlePackageManifestAssetReference>? references,
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory,
        out ArticlePackageManifestCandidatePlan? plan,
        CancellationToken cancellationToken = default)
    {
        plan = null;
        cancellationToken.ThrowIfCancellationRequested();
        if (manifest?.Assets is null)
        {
            return Invalid("article_package_manifest_asset_root_input_invalid");
        }
        ArticlePackageManifestCandidateResult projected = TryCreateCandidatePlan(
            inputs, sources, references, inventory, out var expected, cancellationToken);
        if (!projected.IsValid)
        {
            return projected;
        }
        cancellationToken.ThrowIfCancellationRequested();
        ArticlePackageManifestCandidateResult assets = ArticlePackageAssetCollectionMapper.ValidateCandidate(
            manifest.Assets, expected!.Assets!.Select(static asset => asset.Source).ToArray(),
            expected.Manifest.Assets!.References, expected.Inventory);
        if (!assets.IsValid)
        {
            return assets;
        }
        try
        {
            byte[] supplied = ArticlePackageManifestCandidateCodec.WriteCandidate(manifest, manifest.Assets, expected.Inventory);
            byte[] actual = ArticlePackageManifestCandidateCodec.WriteCandidate(expected.Manifest, expected.Manifest.Assets, expected.Inventory);
            if (!supplied.AsSpan().SequenceEqual(actual))
            {
                return Invalid("article_package_manifest_source_mismatch");
            }
            cancellationToken.ThrowIfCancellationRequested();
            plan = expected;
            return new(true, null);
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_candidate_mismatch");
        }
    }

    private static bool FreezeAssetInputs<T>(IReadOnlyList<T>? values, int maximum,
        CancellationToken cancellationToken, out T[] held) where T : class
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
            cancellationToken.ThrowIfCancellationRequested();
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
}
