using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>One distinct article-to-asset edge; several articles may reference the same collection entry.</summary>
public sealed record ArticlePackageManifestAssetReference(
    ArticlePackageIdentity PortableArticle,
    ArticlePackageIdentity PortableAsset);

/// <summary>
/// Frozen complete asset metadata and reference set checked against a complete inventory.
/// The digest covers canonical asset components and reference edges, not compressed archive bytes.
/// This candidate supplies neither byte custody nor export, reuse or retention permission.
/// </summary>
public sealed class ArticlePackageManifestAssetCollectionCandidate
{
    internal ArticlePackageManifestAssetCollectionCandidate(
        ArticlePackageManifestAssetMetadataCandidate[] assets,
        ArticlePackageManifestAssetReference[] references,
        ArticlePackageInventoryEntry[] inventory,
        long totalAssetBytes,
        string componentDigest)
    {
        Assets = Array.AsReadOnly(assets);
        References = Array.AsReadOnly(references);
        Inventory = Array.AsReadOnly(inventory);
        TotalAssetBytes = totalAssetBytes;
        ComponentDigest = componentDigest;
    }

    public IReadOnlyList<ArticlePackageManifestAssetMetadataCandidate> Assets
    {
        get;
    }
    public IReadOnlyList<ArticlePackageManifestAssetReference> References
    {
        get;
    }
    public IReadOnlyList<ArticlePackageInventoryEntry> Inventory
    {
        get;
    }
    public long TotalAssetBytes
    {
        get;
    }
    public string ComponentDigest
    {
        get;
    }

    /// <summary>Self-consistency never admits an asset operation or establishes current rights.</summary>
    public ArticlePackageManifestCandidateResult RequireAssetAuthority()
        => new(false, "article_package_manifest_asset_rights_retention_authority_unavailable");
}

/// <summary>Complete finite asset component of the sole codec, reusing the original individual asset format.</summary>
public static partial class ArticlePackageManifestCandidateCodec
{
    public const int MaxAssetCollectionJsonBytes = MaxJsonBytes;
    public const int MaxAssetCollectionReferences = 100000;
    public const string AssetCollectionDigestDomain = "fsusblog.article-package.manifest-asset-collection-candidate.v1";

    /// <summary>
    /// Freezes bounded input before validation. Every metadata entry and reference must occur exactly
    /// once; sharing uses distinct reference edges rather than repeated metadata or source aliases.
    /// Actual byte/media binding remains with the original backend asset mapper.
    /// </summary>
    public static ArticlePackageManifestCandidateResult TryCreateAssetCollectionCandidate(
        IReadOnlyList<ArticlePackageManifestAssetMetadata>? assets,
        IReadOnlyList<ArticlePackageManifestAssetReference>? references,
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory,
        out ArticlePackageManifestAssetCollectionCandidate? candidate)
    {
        candidate = null;
        if (!TryCopyMetadataRows(assets, ArticlePackageInventory.MaxAssets, out ArticlePackageManifestAssetMetadata[] heldAssets)
            || !TryCopyMetadataRows(references, MaxAssetCollectionReferences, out ArticlePackageManifestAssetReference[] heldReferences)
            || !TryCopyMetadataRows(inventory, ArticlePackageInventory.MaxEntries, out ArticlePackageInventoryEntry[] heldInventory))
        {
            return Invalid("article_package_manifest_asset_collection_input_invalid");
        }
        ArticlePackageValidationResult inventoryResult = ArticlePackageInventory.Validate(heldInventory);
        if (!inventoryResult.IsValid)
        {
            return Invalid(inventoryResult.ReasonCode!);
        }
        try
        {
            var inventoryPaths = heldInventory.ToDictionary(static entry => entry.Path, StringComparer.Ordinal);
            var portableIds = new HashSet<ArticlePackageIdentity>();
            var sourceIds = new HashSet<string>(StringComparer.Ordinal);
            var assetPaths = new HashSet<string>(StringComparer.Ordinal);
            var content = new Dictionary<string, ArticlePackageManifestAssetMetadata>(StringComparer.Ordinal);
            var checkedAssets = new ArticlePackageManifestAssetMetadataCandidate[heldAssets.Length];
            long totalAssetBytes = 0;
            for (int index = 0; index < heldAssets.Length; index++)
            {
                ArticlePackageManifestAssetMetadata asset = heldAssets[index];
                ArticlePackageManifestCandidateResult result = TryCreateAssetMetadataCandidate(asset, out var checkedAsset);
                if (!result.IsValid)
                {
                    return result;
                }
                if (!portableIds.Add(asset.PortableAsset) || !sourceIds.Add(asset.SourceAssetId) || !assetPaths.Add(asset.PackagePath))
                {
                    return Invalid("article_package_manifest_asset_collection_duplicate");
                }
                if (!inventoryPaths.TryGetValue(asset.PackagePath, out var entry) || entry.UncompressedBytes != asset.SizeBytes)
                {
                    return Invalid("article_package_manifest_asset_collection_inventory_mismatch");
                }
                if (content.TryGetValue(asset.Sha256, out var sameBytes)
                    && (sameBytes.SizeBytes != asset.SizeBytes || sameBytes.MimeType != asset.MimeType
                        || sameBytes.WidthPixels != asset.WidthPixels || sameBytes.HeightPixels != asset.HeightPixels))
                {
                    return Invalid("article_package_manifest_asset_collection_content_mismatch");
                }
                content.TryAdd(asset.Sha256, asset);
                if (asset.SizeBytes > ArticlePackageInventory.MaxTotalBytes - totalAssetBytes)
                {
                    return Invalid("article_package_manifest_asset_collection_budget_exceeded");
                }
                totalAssetBytes += asset.SizeBytes;
                checkedAssets[index] = checkedAsset!;
            }
            if (heldInventory.Any(entry => entry.Path.StartsWith("assets/", StringComparison.Ordinal) && !assetPaths.Contains(entry.Path)))
            {
                return Invalid("article_package_manifest_asset_collection_inventory_mismatch");
            }
            var edges = new HashSet<ArticlePackageManifestAssetReference>();
            var referenced = new HashSet<ArticlePackageIdentity>();
            foreach (ArticlePackageManifestAssetReference reference in heldReferences)
            {
                if (reference.PortableArticle.Kind != ArticlePackageIdentityKind.Article
                    || !ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article, reference.PortableArticle.Value, out _).IsValid
                    || !portableIds.Contains(reference.PortableAsset)
                    || !inventoryPaths.ContainsKey("articles/" + reference.PortableArticle.FileNameToken + ".md"))
                {
                    return Invalid("article_package_manifest_asset_collection_reference_mismatch");
                }
                if (!edges.Add(reference))
                {
                    return Invalid("article_package_manifest_asset_collection_duplicate_reference");
                }
                referenced.Add(reference.PortableAsset);
            }
            if (referenced.Count != checkedAssets.Length)
            {
                return Invalid("article_package_manifest_asset_collection_orphan");
            }
            Array.Sort(checkedAssets, static (left, right) => string.CompareOrdinal(left.Metadata.PortableAsset.Value, right.Metadata.PortableAsset.Value));
            Array.Sort(heldReferences, static (left, right) =>
            {
                int article = string.CompareOrdinal(left.PortableArticle.Value, right.PortableArticle.Value);
                return article != 0 ? article : string.CompareOrdinal(left.PortableAsset.Value, right.PortableAsset.Value);
            });
            Array.Sort(heldInventory, static (left, right) => string.CompareOrdinal(left.Path, right.Path));
            _ = SerializeAssetCollection(checkedAssets, heldReferences, new string('0', 64));
            byte[] payload = SerializeAssetCollection(checkedAssets, heldReferences, null);
            using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(s_utf8.GetBytes(AssetCollectionDigestDomain + "\0"));
            hash.AppendData(payload);
            candidate = new(checkedAssets, heldReferences, heldInventory, totalAssetBytes, Convert.ToHexStringLower(hash.GetHashAndReset()));
            return new(true, null);
        }
        catch (EncoderFallbackException)
        {
            return Invalid("article_package_manifest_utf8_invalid");
        }
        catch (DocumentBudgetException)
        {
            return Invalid("article_package_manifest_asset_collection_budget_exceeded");
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_asset_collection_input_invalid");
        }
    }

    /// <summary>Parses original individual asset components, then rechecks the complete set against the supplied inventory.</summary>
    public static ArticlePackageManifestCandidateResult TryParseAssetCollectionCandidate(
        ReadOnlySpan<byte> json,
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory,
        out ArticlePackageManifestAssetCollectionCandidate? candidate)
    {
        candidate = null;
        if (json.Length > MaxAssetCollectionJsonBytes)
        {
            return Invalid("article_package_manifest_asset_collection_budget_exceeded");
        }
        try
        {
            _ = s_utf8.GetCharCount(json);
            if (!HasValidEscapedUnicode(json))
            {
                return Invalid("article_package_manifest_utf8_invalid");
            }
            using JsonDocument document = JsonDocument.Parse(json.ToArray(), new JsonDocumentOptions { MaxDepth = MaxReadDepth });
            JsonElement root = document.RootElement;
            ArticlePackageManifestCandidateResult keys = CheckMetadataObjectKeys(root, "assets", "references", "componentDigest");
            if (!keys.IsValid)
            {
                return keys;
            }
            if (!ReadString(root, "componentDigest", out string? digest) || !IsDigest(digest))
            {
                return Invalid("article_package_manifest_asset_collection_shape_invalid");
            }
            JsonElement assetRows = root.GetProperty("assets");
            JsonElement referenceRows = root.GetProperty("references");
            if (assetRows.ValueKind != JsonValueKind.Array || assetRows.GetArrayLength() > ArticlePackageInventory.MaxAssets
                || referenceRows.ValueKind != JsonValueKind.Array || referenceRows.GetArrayLength() > MaxAssetCollectionReferences)
            {
                return Invalid("article_package_manifest_asset_collection_input_invalid");
            }
            var assets = new ArticlePackageManifestAssetMetadata[assetRows.GetArrayLength()];
            int index = 0;
            foreach (JsonElement row in assetRows.EnumerateArray())
            {
                string raw = row.GetRawText();
                if (s_utf8.GetByteCount(raw) > MaxAssetMetadataJsonBytes)
                {
                    return Invalid("article_package_manifest_asset_metadata_budget_exceeded");
                }
                ArticlePackageManifestCandidateResult result = TryParseAssetMetadataCandidate(s_utf8.GetBytes(raw), out var parsed);
                if (!result.IsValid)
                {
                    return result;
                }
                assets[index++] = parsed!.Metadata;
            }
            var references = new ArticlePackageManifestAssetReference[referenceRows.GetArrayLength()];
            index = 0;
            foreach (JsonElement row in referenceRows.EnumerateArray())
            {
                keys = CheckMetadataObjectKeys(row, "portableArticle", "portableAsset");
                if (!keys.IsValid)
                {
                    return keys;
                }
                if (!ReadString(row, "portableArticle", out string? article)
                    || !ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article, article, out var portableArticle).IsValid
                    || !ReadString(row, "portableAsset", out string? asset)
                    || !ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Asset, asset, out var portableAsset).IsValid)
                {
                    return Invalid("article_package_manifest_asset_collection_reference_mismatch");
                }
                references[index++] = new(portableArticle, portableAsset);
            }
            ArticlePackageManifestCandidateResult created = TryCreateAssetCollectionCandidate(assets, references, inventory, out var owned);
            if (!created.IsValid)
            {
                return created;
            }
            if (owned!.ComponentDigest != digest)
            {
                return Invalid("article_package_manifest_asset_collection_digest_mismatch");
            }
            candidate = owned;
            return new(true, null);
        }
        catch (DecoderFallbackException)
        {
            return Invalid("article_package_manifest_utf8_invalid");
        }
        catch (JsonException)
        {
            return Invalid("article_package_manifest_json_invalid");
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_asset_collection_shape_invalid");
        }
        catch (InvalidOperationException)
        {
            return Invalid("article_package_manifest_asset_collection_shape_invalid");
        }
    }

    /// <summary>Recreates the complete collection and recomputes its digest before writing canonical bytes.</summary>
    public static byte[] WriteAssetCollectionCandidate(ArticlePackageManifestAssetCollectionCandidate candidate)
    {
        if (candidate is null
            || !TryCreateAssetCollectionCandidate(candidate.Assets.Select(static asset =>
            {
                _ = WriteAssetMetadataCandidate(asset);
                return asset.Metadata;
            }).ToArray(),
                candidate.References, candidate.Inventory, out var checkedCandidate).IsValid
            || checkedCandidate!.ComponentDigest != candidate.ComponentDigest
            || checkedCandidate.TotalAssetBytes != candidate.TotalAssetBytes)
        {
            throw new ArgumentException("article_package_manifest_asset_collection_candidate_invalid", nameof(candidate));
        }
        return SerializeAssetCollection(checkedCandidate.Assets, checkedCandidate.References, checkedCandidate.ComponentDigest);
    }

    private static byte[] SerializeAssetCollection(
        IReadOnlyList<ArticlePackageManifestAssetMetadataCandidate> assets,
        IReadOnlyList<ArticlePackageManifestAssetReference> references,
        string? digest)
    {
        using var stream = new MetadataBudgetStream(MaxAssetCollectionJsonBytes);
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteStartArray("assets");
            foreach (ArticlePackageManifestAssetMetadataCandidate asset in assets)
            {
                writer.WriteRawValue(WriteAssetMetadataCandidate(asset));
                writer.Flush();
            }
            writer.WriteEndArray();
            writer.WriteStartArray("references");
            foreach (ArticlePackageManifestAssetReference reference in references)
            {
                writer.WriteStartObject();
                writer.WriteString("portableArticle", reference.PortableArticle.Value);
                writer.WriteString("portableAsset", reference.PortableAsset.Value);
                writer.WriteEndObject();
                writer.Flush();
            }
            writer.WriteEndArray();
            if (digest is not null)
            {
                writer.WriteString("componentDigest", digest);
            }
            writer.WriteEndObject();
        }
        return stream.ToArray();
    }
}
