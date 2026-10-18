using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Tests.Unit;

public sealed class ArticlePackageAssetMetadataMapperTests
{
    [Fact]
    public void Mapping_UsesActualRecordByteDigestAndCanonicalMediaHeaderWithoutPrivateFieldsOrAuthority()
    {
        byte[] bytes = Bytes();
        AssetRecord record = Record(bytes);
        var result = ArticlePackageAssetMetadataMapper.TryMapCandidate(Identity(), record, bytes, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Equal(record.Id.ToString(), candidate!.Metadata.SourceAssetId);
        Assert.Equal(record.Sha256, candidate.Metadata.Sha256);
        Assert.Equal(1, candidate.Metadata.WidthPixels);
        Assert.Equal(1, candidate.Metadata.HeightPixels);
        Assert.Equal("assets/00000002-0000-4000-8000-000000000001.png", candidate.Metadata.PackagePath);
        Assert.NotEqual(record.Id.ToString(), candidate.Metadata.PortableAsset.FileNameToken);
        byte[] encoded = ArticlePackageManifestCandidateCodec.WriteAssetMetadataCandidate(candidate);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseAssetMetadataCandidate(encoded, out var parsed).IsValid);
        Assert.Equal(candidate.Metadata, parsed!.Metadata);
        Assert.Equal(candidate.ComponentDigest, parsed.ComponentDigest);
        Assert.True(ArticlePackageAssetMetadataMapper.ValidateCandidate(parsed, Identity(), record, bytes).IsValid);
        Assert.False(parsed.RequireAssetAuthority().IsValid);
        Assert.Equal("article_package_manifest_asset_rights_retention_authority_unavailable", parsed.RequireAssetAuthority().ReasonCode);
        string json = Encoding.UTF8.GetString(encoded);
        foreach (string excluded in new[] { "storageClass", "storageKey", "ownerAdminPrincipalId", "createdAtUtc", "updatedAtUtc", "state" })
        {
            Assert.DoesNotContain(excluded, json, StringComparison.Ordinal);
        }
        Assert.DoesNotContain(record.StorageKey.Value, json, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("size")]
    [InlineData("hash")]
    [InlineData("missingHash")]
    [InlineData("mime")]
    [InlineData("dimensions")]
    [InlineData("extension")]
    [InlineData("identity")]
    [InlineData("storage")]
    [InlineData("state")]
    [InlineData("owner")]
    [InlineData("time")]
    public void Mapping_RefusesByteMediaOrCanonicalRecordDrift(string field)
    {
        byte[] bytes = Bytes();
        AssetRecord record = Record(bytes);
        record = field switch
        {
            "size" => record with { SizeBytes = bytes.Length + 1 },
            "hash" => record with { Sha256 = new string('a', 64) },
            "missingHash" => record with { Sha256 = null },
            "mime" => record with { MimeType = "image/gif" },
            "dimensions" => record with { WidthPixels = 2 },
            "extension" => record with { Extension = ".gif" },
            "identity" => record with { Id = default },
            "storage" => record with { StorageKey = default },
            "state" => record with { State = (ContentAssetState)255 },
            "owner" => record with { OwnerAdminPrincipalId = 0 },
            _ => record with { UpdatedAtUtc = record.CreatedAtUtc.AddDays(-1) }
        };
        RejectMap(record, bytes);
    }

    [Fact]
    public void MissingRightsPrivateStorageAndDeletionNeverBecomeExportPermission()
    {
        byte[] bytes = Bytes();
        AssetRecord record = Record(bytes);
        RejectMap(record with
        {
            StorageClass = "private"
        }, bytes, "article_package_manifest_asset_private_export_policy_unavailable");
        RejectMap(record with
        {
            State = ContentAssetState.PendingDelete
        }, bytes, "article_package_manifest_asset_retention_unavailable");
        RejectMap(null, bytes);
        Assert.True(ArticlePackageAssetMetadataMapper.TryMapCandidate(Identity(), record, bytes, out var candidate).IsValid);
        Assert.False(candidate!.RequireAssetAuthority().IsValid);
    }

    [Fact]
    public void Mapper_RejectsUnsupportedMediaRatherThanInventingAnInspectionFallback()
    {
        byte[] bytes = "%PDF-1.7\n"u8.ToArray();
        AssetRecord record = Record(bytes) with
        {
            MimeType = "application/pdf",
            Extension = ".pdf",
            WidthPixels = null,
            HeightPixels = null
        };
        RejectMap(record, bytes, "article_package_manifest_asset_media_inspection_unavailable");
        bytes = "<svg width=\"1\" height=\"1\"></svg>"u8.ToArray();
        record = Record(bytes) with
        {
            MimeType = "image/svg+xml",
            Extension = ".svg"
        };
        RejectMap(record, bytes, "article_package_manifest_asset_media_inspection_unavailable");
        bytes = [0, 1, 2, 3];
        RejectMap(Record(bytes), bytes, "article_package_manifest_asset_media_inspection_unavailable");
    }

    [Fact]
    public void CopiedDigestAndChangedActualBytesCannotRebindAnOldCandidate()
    {
        byte[] bytes = Bytes();
        AssetRecord record = Record(bytes);
        Assert.True(ArticlePackageAssetMetadataMapper.TryMapCandidate(Identity(), record, bytes, out var candidate).IsValid);
        bytes[^1] ^= 1;
        Assert.False(ArticlePackageAssetMetadataMapper.ValidateCandidate(candidate, Identity(), record, bytes).IsValid);
        AssetRecord changedRecord = Record(bytes);
        var result = ArticlePackageAssetMetadataMapper.ValidateCandidate(candidate, Identity(), changedRecord, bytes);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_manifest_asset_candidate_mismatch", result.ReasonCode);
        Assert.False(ArticlePackageAssetMetadataMapper.ValidateCandidate(null, Identity(), changedRecord, bytes).IsValid);
        byte[] encoded = ArticlePackageManifestCandidateCodec.WriteAssetMetadataCandidate(candidate!);
        encoded[0] = 0;
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseAssetMetadataCandidate(ArticlePackageManifestCandidateCodec.WriteAssetMetadataCandidate(candidate!), out _).IsValid);
    }

    [Theory]
    [InlineData("sourceAssetId")]
    [InlineData("sha256")]
    [InlineData("mimeType")]
    [InlineData("sizeBytes")]
    [InlineData("widthPixels")]
    [InlineData("heightPixels")]
    public void ClosedComponentDigest_CoversEachContentMetadataField(string field)
    {
        JsonObject document = Document();
        document[field] = field switch
        {
            "sourceAssetId" => JsonValue.Create("00000003-0000-4000-8000-000000000001"),
            "sha256" => JsonValue.Create(new string('a', 64)),
            "mimeType" => JsonValue.Create("image/gif"),
            "sizeBytes" => JsonValue.Create(123),
            _ => JsonValue.Create(2)
        };
        Reject(document, "article_package_manifest_asset_metadata_digest_mismatch");
    }

    [Theory]
    [InlineData("token")]
    [InlineData("session")]
    [InlineData("storageKey")]
    [InlineData("ownerAdminPrincipalId")]
    [InlineData("auditPayload")]
    [InlineData("rights")]
    [InlineData("unknown")]
    public void Decoder_RejectsUnknownPrivateOrAuthorityFields(string name)
    {
        JsonObject document = Document();
        document[name] = "fixture";
        Reject(document);
    }

    [Fact]
    public void Decoder_RejectsMissingDuplicateWrongTypePathAliasIdentityAndBudgets()
    {
        JsonObject document = Document();
        document.Remove("sourceAssetId");
        Reject(document, "article_package_manifest_missing_field");
        document = Document();
        document["sizeBytes"] = "1";
        Reject(document);
        document = Document();
        document["sourceAssetId"] = "https://example.org/1";
        Reject(document);
        document = Document();
        document["sourceAssetId"] = Guid.Empty.ToString("D");
        Reject(document);
        document = Document();
        document["packagePath"] = "assets/../private.png";
        Reject(document);
        document = Document();
        document["extension"] = ".PNG";
        Reject(document);
        document = Document();
        document["widthPixels"] = null;
        Reject(document);
        document = Document();
        string json = document.ToJsonString().Insert(1, "\"sizeBytes\":1,");
        RejectBytes(Encoding.UTF8.GetBytes(json), "article_package_manifest_duplicate_field");
        RejectBytes(new byte[ArticlePackageManifestCandidateCodec.MaxAssetMetadataJsonBytes + 1], "article_package_manifest_asset_metadata_budget_exceeded");
        RejectMap(Record(Bytes()), new byte[ArticlePackageAssetMetadataMapper.MaxCandidateAssetBytes + 1]);
    }

    [Fact]
    public void FinitePackageEnvelope_StillRefusesAssetsAndFullAssetAdmission()
    {
        JsonObject asset = Document();
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article, "article:00000001-0000-4000-8000-000000000001", out var article).IsValid);
        Assert.True(ArticlePackageSourceBytes.Inspect("line\n"u8, out var bytes).IsValid);
        var row = new ArticlePackageManifestArticle(article, new(1, 11, 2, new string('a', 64), "site", 1, null, null, null),
            "Title", null, new string('b', 64), new string('c', 64), new string('d', 64), bytes!, new(0, null, null));
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate([row], out var manifest).IsValid);
        JsonObject document = JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteCandidate(manifest!))!.AsObject();
        document["assets"] = new JsonArray(asset);
        Assert.False(ArticlePackageManifestCandidateCodec.TryParseCandidate(Encoding.UTF8.GetBytes(document.ToJsonString()), out _).IsValid);
    }

    private static byte[] Bytes()
        => Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZgAAAABJRU5ErkJggg==");

    private static AssetRecord Record(byte[] bytes)
        => new(AssetId.Parse("00000001-0000-4000-8000-000000000001"), "public", AssetStorageKey.Parse("content/public/example.png"),
            "image/png", ".png", bytes.Length, Convert.ToHexStringLower(SHA256.HashData(bytes)), 1, 1, 9,
            ContentAssetState.Active, new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero), new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero));

    private static ArticlePackageIdentity Identity()
    {
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Asset, "portable-asset:00000002-0000-4000-8000-000000000001", out var identity).IsValid);
        return identity;
    }

    private static JsonObject Document()
    {
        byte[] bytes = Bytes();
        Assert.True(ArticlePackageAssetMetadataMapper.TryMapCandidate(Identity(), Record(bytes), bytes, out var candidate).IsValid);
        return JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteAssetMetadataCandidate(candidate!))!.AsObject();
    }

    private static void RejectMap(AssetRecord? record, byte[] bytes, string? reason = null)
    {
        var result = ArticlePackageAssetMetadataMapper.TryMapCandidate(Identity(), record, bytes, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        if (reason is not null)
            Assert.Equal(reason, result.ReasonCode);
    }

    private static void Reject(JsonObject document, string? reason = null)
        => RejectBytes(Encoding.UTF8.GetBytes(document.ToJsonString()), reason);

    private static void RejectBytes(byte[] bytes, string? reason = null)
    {
        var result = ArticlePackageManifestCandidateCodec.TryParseAssetMetadataCandidate(bytes, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        if (reason is not null)
            Assert.Equal(reason, result.ReasonCode);
    }
}
