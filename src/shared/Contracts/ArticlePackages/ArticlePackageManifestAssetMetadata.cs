using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Closed portable content metadata; storage, private owner data, rights and retention facts are absent.</summary>
public sealed record ArticlePackageManifestAssetMetadata(
    ArticlePackageIdentity PortableAsset,
    string SourceAssetId,
    string Sha256,
    string MimeType,
    string Extension,
    long SizeBytes,
    int? WidthPixels,
    int? HeightPixels,
    string PackagePath);

/// <summary>Owned finite asset metadata component, not byte custody or export rights.</summary>
public sealed class ArticlePackageManifestAssetMetadataCandidate
{
    internal ArticlePackageManifestAssetMetadataCandidate(ArticlePackageManifestAssetMetadata metadata, string componentDigest)
    {
        Metadata = metadata;
        ComponentDigest = componentDigest;
    }

    public ArticlePackageManifestAssetMetadata Metadata
    {
        get;
    }
    public string ComponentDigest
    {
        get;
    }

    public ArticlePackageManifestCandidateResult RequireAssetAuthority()
        => new(false, "article_package_manifest_asset_rights_retention_authority_unavailable");
}

/// <summary>Pure closed asset-component shape methods of the sole manifest codec; not media-byte validation.</summary>
public static partial class ArticlePackageManifestCandidateCodec
{
    public const int MaxAssetMetadataJsonBytes = 4096;
    public const string AssetMetadataDigestDomain = "fsusblog.article-package.manifest-asset-metadata-candidate.v1";

    public static ArticlePackageManifestCandidateResult TryCreateAssetMetadataCandidate(
        ArticlePackageManifestAssetMetadata? metadata,
        out ArticlePackageManifestAssetMetadataCandidate? candidate)
    {
        candidate = null;
        try
        {
            if (metadata is null || metadata.PortableAsset.Kind != ArticlePackageIdentityKind.Asset
                || !ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Asset, metadata.PortableAsset.Value, out _).IsValid
                || !Guid.TryParseExact(metadata.SourceAssetId, "D", out Guid sourceId) || sourceId == Guid.Empty
                || sourceId.ToString("D") != metadata.SourceAssetId || !IsDigest(metadata.Sha256)
                || !MetadataText(metadata.MimeType, 127, true) || !metadata.MimeType.Contains('/', StringComparison.Ordinal)
                || metadata.Extension is null || metadata.Extension.Length is < 2 or > 16 || metadata.Extension[0] != '.'
                || !metadata.Extension.AsSpan(1).ToString().All(static character => character is >= 'a' and <= 'z' or >= '0' and <= '9')
                || metadata.SizeBytes < 0 || metadata.SizeBytes > ArticlePackageInventory.MaxAssetBytes
                || metadata.WidthPixels.HasValue != metadata.HeightPixels.HasValue
                || metadata.WidthPixels is <= 0 || metadata.HeightPixels is <= 0
                || metadata.MimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase) && metadata.WidthPixels is null
                || metadata.PackagePath != "assets/" + metadata.PortableAsset.FileNameToken + metadata.Extension)
            {
                return Invalid("article_package_manifest_asset_metadata_shape_invalid");
            }
            byte[] payload = SerializeAssetMetadata(metadata, null);
            using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(s_utf8.GetBytes(AssetMetadataDigestDomain + "\0"));
            hash.AppendData(payload);
            candidate = new(metadata, Convert.ToHexStringLower(hash.GetHashAndReset()));
            return new(true, null);
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_asset_metadata_shape_invalid");
        }
    }

    public static byte[] WriteAssetMetadataCandidate(ArticlePackageManifestAssetMetadataCandidate candidate)
    {
        if (candidate is null || !TryCreateAssetMetadataCandidate(candidate.Metadata, out var checkedCandidate).IsValid
            || candidate.ComponentDigest != checkedCandidate!.ComponentDigest)
        {
            throw new ArgumentException("article_package_manifest_asset_metadata_candidate_invalid");
        }
        return SerializeAssetMetadata(candidate.Metadata, candidate.ComponentDigest);
    }

    public static ArticlePackageManifestCandidateResult TryParseAssetMetadataCandidate(
        ReadOnlySpan<byte> json,
        out ArticlePackageManifestAssetMetadataCandidate? candidate)
    {
        candidate = null;
        if (json.Length > MaxAssetMetadataJsonBytes)
        {
            return Invalid("article_package_manifest_asset_metadata_budget_exceeded");
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
            var keys = CheckMetadataObjectKeys(root, "portableAsset", "sourceAssetId", "sha256", "mimeType", "extension",
                "sizeBytes", "widthPixels", "heightPixels", "packagePath", "componentDigest");
            if (!keys.IsValid)
            {
                return keys;
            }
            if (!ReadString(root, "portableAsset", out string? identity)
                || !ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Asset, identity, out var portable).IsValid
                || !ReadString(root, "sourceAssetId", out string? sourceId) || !ReadString(root, "sha256", out string? sha)
                || !ReadString(root, "mimeType", out string? mime) || !ReadString(root, "extension", out string? extension)
                || !ReadLong(root, "sizeBytes", out long size) || !ReadNullableLong(root, "widthPixels", out long? width)
                || !ReadNullableLong(root, "heightPixels", out long? height)
                || width is < int.MinValue or > int.MaxValue || height is < int.MinValue or > int.MaxValue
                || !ReadString(root, "packagePath", out string? path) || !ReadString(root, "componentDigest", out string? digest)
                || !IsDigest(digest))
            {
                return Invalid("article_package_manifest_asset_metadata_shape_invalid");
            }
            var result = TryCreateAssetMetadataCandidate(new(portable, sourceId!, sha!, mime!, extension!, size, (int?)width, (int?)height, path!), out var parsed);
            if (!result.IsValid)
            {
                return result;
            }
            if (parsed!.ComponentDigest != digest)
            {
                return Invalid("article_package_manifest_asset_metadata_digest_mismatch");
            }
            candidate = parsed;
            return new(true, null);
        }
        catch (JsonException)
        {
            return Invalid("article_package_manifest_json_invalid");
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_asset_metadata_shape_invalid");
        }
        catch (InvalidOperationException)
        {
            return Invalid("article_package_manifest_asset_metadata_shape_invalid");
        }
    }

    private static byte[] SerializeAssetMetadata(ArticlePackageManifestAssetMetadata value, string? digest)
    {
        using var stream = new MetadataBudgetStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("portableAsset", value.PortableAsset.Value);
            writer.WriteString("sourceAssetId", value.SourceAssetId);
            writer.WriteString("sha256", value.Sha256);
            writer.WriteString("mimeType", value.MimeType);
            writer.WriteString("extension", value.Extension);
            writer.WriteNumber("sizeBytes", value.SizeBytes);
            WriteNullableLong(writer, "widthPixels", value.WidthPixels);
            WriteNullableLong(writer, "heightPixels", value.HeightPixels);
            writer.WriteString("packagePath", value.PackagePath);
            if (digest is not null)
                writer.WriteString("componentDigest", digest);
            writer.WriteEndObject();
        }
        return stream.ToArray();
    }
}
