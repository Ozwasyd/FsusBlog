using System.Reflection;

using FsusBlog.Server.Contracts.Assets;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ContentAssetContractTests
{
    private const string CanonicalUuid = "3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f";

    private static readonly DateTimeOffset s_utcNow = new(2026, 8, 9, 12, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData("")]
    [InlineData("not-a-uuid")]
    [InlineData("/assets/3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f")]
    [InlineData("https://example.test/content-assets/3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f")]
    [InlineData("3f3b2e7a1d2e4f8a9c5b6a7b8c9d0e1f")]
    [InlineData("{3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f}")]
    [InlineData("3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1")]
    public void AssetId_RejectsInvalidUuid(string candidate)
    {
        Assert.False(AssetId.TryParse(candidate, out _));
        Assert.Throws<ArgumentException>(() => AssetId.Parse(candidate));
    }

    [Fact]
    public void AssetId_RoundTripsCanonicalUuid()
    {
        AssetId assetId = AssetId.Parse(CanonicalUuid);
        Assert.Equal(CanonicalUuid, assetId.ToString());
        Assert.True(AssetId.TryParse(assetId.ToString(), out AssetId parsed));
        Assert.Equal(assetId, parsed);
    }

    [Theory]
    [InlineData("")]
    [InlineData("/etc/passwd")]
    [InlineData("C:\\windows\\system32")]
    [InlineData("C:/secret")]
    [InlineData("../secret")]
    [InlineData("a/../../secret")]
    [InlineData("./secret")]
    [InlineData("a\\b.png")]
    [InlineData("a\0b.png")]
    [InlineData("a//b.png")]
    [InlineData("/a/b.png")]
    [InlineData("a/%2e%2e/b")]
    [InlineData("a b.png")]
    [InlineData("a#b.png")]
    [InlineData("a?b.png")]
    public void AssetStorageKey_RejectsRootAbsoluteTraversalBackslashNulOrUnsafeChars(string candidate)
    {
        Assert.False(AssetStorageKey.TryParse(candidate, out _));
        Assert.Throws<ArgumentException>(() => AssetStorageKey.Parse(candidate));
    }

    [Fact]
    public void AssetStorageKey_RoundTripsNormalizedRelativeKey()
    {
        AssetStorageKey storageKey = AssetStorageKey.Parse("images/hero.png");
        Assert.Equal("images/hero.png", storageKey.Value);
        Assert.True(AssetStorageKey.TryParse("images/hero.png", out AssetStorageKey parsed));
        Assert.Equal(storageKey, parsed);
    }

    [Fact]
    public void PublicAssetUrlCodec_RoundTripsRecordToStorageKey()
    {
        var codec = new PublicAssetUrlCodec();
        AssetRecord record = ValidRecord();
        Uri baseUri = new("https://cdn.example.test");

        Uri url = codec.ToPublicUrl(record, baseUri);

        Assert.Equal("https://cdn.example.test/content-assets/images/hero.png", url.ToString());
        Assert.True(codec.TryGetStorageKey(url, baseUri, out AssetStorageKey storageKey));
        Assert.Equal(record.StorageKey, storageKey);
    }

    [Theory]
    [InlineData("/content-assets/images/hero.png")]
    [InlineData("ftp://cdn.example.test/content-assets/images/hero.png")]
    [InlineData("javascript:alert(1)")]
    [InlineData("https://cdn.example.test/content-assets/images/hero.png?x=1")]
    [InlineData("https://cdn.example.test/content-assets/images/hero.png#fragment")]
    [InlineData("https://user@cdn.example.test/content-assets/images/hero.png")]
    [InlineData("https://evil.example.test/content-assets/images/hero.png")]
    [InlineData("https://cdn.example.test/uploads/images/hero.png")]
    [InlineData("https://cdn.example.test/content-assets/../secret")]
    [InlineData("https://cdn.example.test/content-assets/%2e%2e/secret")]
    [InlineData("https://cdn.example.test/content-assets/")]
    public void PublicAssetUrlCodec_RejectsNonLocalAndMalformedUrls(string candidate)
    {
        var codec = new PublicAssetUrlCodec();
        Uri url = new(candidate, UriKind.RelativeOrAbsolute);
        Assert.False(codec.TryGetStorageKey(url, new Uri("https://cdn.example.test"), out _));
    }

    [Fact]
    public void PublicAssetUrlCodec_RejectsNonHttpBase()
    {
        var codec = new PublicAssetUrlCodec();
        Assert.Throws<ArgumentException>(() => codec.ToPublicUrl(ValidRecord(), new Uri("file:///tmp/assets")));
    }

    [Fact]
    public void ContentAssetReference_RejectsDuplicateCompositeKey()
    {
        AssetReference[] references = [ValidReference(), ValidReference()];
        Assert.Throws<InvalidOperationException>(() => ContentAssetSchemaValidator.ValidateReferences(references));
    }

    [Fact]
    public void ContentAssetReference_AcceptsDistinctCompositeKeys()
    {
        AssetReference[] references =
        [
            ValidReference() with { SourceKey = "article/1" },
            ValidReference() with { SourceKey = "article/2" },
            ValidReference() with { SourceKind = ContentAssetSourceKinds.Draft }
        ];
        ContentAssetSchemaValidator.ValidateReferences(references);
    }

    [Theory]
    [InlineData("")]
    [InlineData("video")]
    [InlineData("page")]
    [InlineData("Article")]
    public void ContentAssetReference_RejectsInvalidSourceKind(string sourceKind)
    {
        AssetReference reference = ValidReference() with
        {
            SourceKind = sourceKind
        };
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(reference));
    }

    [Fact]
    public void ContentAssetReference_AcceptsAllClosedSourceKinds()
    {
        foreach (string sourceKind in new[] { ContentAssetSourceKinds.Article, ContentAssetSourceKinds.Draft, ContentAssetSourceKinds.Revision })
        {
            ContentAssetSchemaValidator.Validate(ValidReference() with
            {
                SourceKind = sourceKind
            });
        }
    }

    [Fact]
    public void AssetRecord_RejectsUnknownStateAndInvalidMediaMetadata()
    {
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            ValidRecord() with
            {
                State = (ContentAssetState)99
            }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            ValidRecord() with
            {
                MimeType = "image"
            }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            ValidRecord() with
            {
                MimeType = new string('x', 128)
            }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            ValidRecord() with
            {
                SizeBytes = -1
            }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            ValidRecord() with
            {
                Sha256 = "abcd"
            }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            ValidRecord() with
            {
                WidthPixels = null
            }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            ValidRecord() with
            {
                UpdatedAtUtc = s_utcNow.AddHours(-1)
            }));
    }

    [Fact]
    public void AssetRecord_AcceptsValidMediaMetadata()
    {
        ContentAssetSchemaValidator.Validate(ValidRecord());
        ContentAssetSchemaValidator.Validate(ValidRecord() with
        {
            Sha256 = null,
            WidthPixels = null,
            HeightPixels = null
        });
    }

    [Fact]
    public void EntityValidation_RejectsInvalidAssetIdStateAndReferenceFields()
    {
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            new ContentAsset { AssetId = "/assets/not-a-uuid" }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            new ContentAsset { AssetId = CanonicalUuid, StorageKey = "images/hero.png", State = "archived" }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            new ContentAssetReference { AssetId = CanonicalUuid, SourceKind = "video", SourceKey = "article/1" }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            new ContentAssetReference { AssetId = CanonicalUuid, SourceKind = ContentAssetSourceKinds.Article, SourceKey = "" }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            new ContentAssetCleanupQueueItem { AssetId = CanonicalUuid, AttemptCount = -1 }));
    }

    [Fact]
    public void EntityValidation_AcceptsValidEntities()
    {
        ContentAssetSchemaValidator.Validate(new ContentAsset
        {
            AssetId = CanonicalUuid,
            StorageKey = "images/hero.png",
            MimeType = "image/png",
            SizeBytes = 10,
            State = ContentAssetStates.Ready
        });
        ContentAssetSchemaValidator.Validate(new ContentAssetReference
        {
            AssetId = CanonicalUuid,
            SourceKind = ContentAssetSourceKinds.Article,
            SourceKey = "article/1",
            ReferenceCount = 1
        });
        ContentAssetSchemaValidator.Validate(new ContentAssetCleanupQueueItem
        {
            AssetId = CanonicalUuid,
            NotBeforeUtc = DateTime.UtcNow.AddMinutes(5),
            AttemptCount = 0
        });
    }

    [Fact]
    public void AssetIdentity_IsNeverInterchangeableWithUrlOrPath()
    {
        Assert.False(AssetId.TryParse("/assets/" + CanonicalUuid, out _));
        Assert.False(AssetId.TryParse("https://example.test/content-assets/" + CanonicalUuid, out _));
        Assert.False(AssetStorageKey.TryParse("https://example.test/content-assets/images/hero.png", out _));

        Assert.Null(typeof(AssetId).GetProperty("Url"));
        Assert.Null(typeof(AssetId).GetProperty("Path"));
        Assert.Null(typeof(AssetStorageKey).GetProperty("Url"));
        Assert.Null(typeof(AssetStorageKey).GetProperty("Path"));
        Assert.Null(typeof(AssetReference).GetProperty("NormalizedUrl"));
    }

    [Fact]
    public void ContentAssetSchema_MatchesCanonicalTableAndKeyContract()
    {
        ContentAssetSchemaValidator.ValidateSchema();
    }

    [Fact]
    public void ContentAssetReference_PrimaryKeyIsCompositeAssetSourceKey()
    {
        string[] primaryKeyColumns = GetPrimaryKeyColumns(typeof(ContentAssetReference));
        Assert.Equal(3, primaryKeyColumns.Length);
        Assert.True(primaryKeyColumns.ToHashSet(StringComparer.Ordinal)
            .SetEquals(["asset_id", "source_kind", "source_key"]));
    }

    [Fact]
    public void ContentAssetCleanupQueue_PrimaryKeyIsAssetIdOnly()
    {
        string[] primaryKeyColumns = GetPrimaryKeyColumns(typeof(ContentAssetCleanupQueueItem));
        Assert.Equal(["asset_id"], primaryKeyColumns);
    }

    [Fact]
    public void ContentAsset_StorageKeyHasUniqueIndexAndNoUrlColumn()
    {
        Assert.Contains(
            typeof(ContentAsset).GetCustomAttributes<SugarIndexAttribute>(),
            static index => index.IsUnique
                && index.IndexFields.ContainsKey(nameof(ContentAsset.StorageKey)));
        Assert.DoesNotContain(
            GetColumnNames(typeof(ContentAsset)),
            static column => column.Contains("url", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void SchemaValidator_RejectsMissingPrimaryKey()
    {
        Assert.Throws<InvalidOperationException>(() => ContentAssetSchemaValidator.ValidateEntitySchema(
            typeof(MissingPrimaryKeyModel),
            "missing_pk",
            ["asset_id"],
            ["asset_id"],
            rejectUrlIdentity: false,
            uniqueProperties: []));
    }

    [Fact]
    public void SchemaValidator_RejectsMissingRequiredColumn()
    {
        Assert.Throws<InvalidOperationException>(() => ContentAssetSchemaValidator.ValidateEntitySchema(
            typeof(MissingColumnModel),
            "missing_column",
            ["asset_id"],
            ["asset_id", "storage_key"],
            rejectUrlIdentity: false,
            uniqueProperties: []));
    }

    [Fact]
    public void SchemaValidator_RejectsExtraIdentityColumn()
    {
        Assert.Throws<InvalidOperationException>(() => ContentAssetSchemaValidator.ValidateEntitySchema(
            typeof(ExtraIdentityModel),
            "extra_identity",
            ["asset_id"],
            ["asset_id"],
            rejectUrlIdentity: false,
            uniqueProperties: []));
    }

    [Fact]
    public void SchemaValidator_RejectsUrlPrimaryKeyResurrection()
    {
        Assert.Throws<InvalidOperationException>(() => ContentAssetSchemaValidator.ValidateEntitySchema(
            typeof(UrlIdentityModel),
            "url_identity",
            ["normalized_url"],
            ["normalized_url"],
            rejectUrlIdentity: true,
            uniqueProperties: []));
    }

    private static AssetRecord ValidRecord()
        => new(
            AssetId.Parse(CanonicalUuid),
            AssetStorageKey.Parse("images/hero.png"),
            "image/png",
            4096,
            "3f3b2e7a1d2e4f8a9c5b6a7b8c9d0e1f3f3b2e7a1d2e4f8a9c5b6a7b8c9d0e1f",
            800,
            600,
            ContentAssetState.Ready,
            s_utcNow,
            s_utcNow);

    private static AssetReference ValidReference()
        => new(
            AssetId.Parse(CanonicalUuid),
            ContentAssetSourceKinds.Article,
            "article/1",
            1,
            s_utcNow);

    private static string[] GetPrimaryKeyColumns(Type entityType)
        => entityType
            .GetProperties()
            .Select(static property => (property, attribute: property.GetCustomAttribute<SugarColumn>(inherit: false)))
            .Where(static column => column.attribute?.IsPrimaryKey == true)
            .Select(static column => column.attribute!.ColumnName)
            .OrderBy(static column => column, StringComparer.Ordinal)
            .ToArray();

    private static string[] GetColumnNames(Type entityType)
        => entityType
            .GetProperties()
            .Select(static property => property.GetCustomAttribute<SugarColumn>(inherit: false))
            .Where(static attribute => attribute is not null)
            .Select(static attribute => attribute!.ColumnName)
            .ToArray();

    [SugarTable("missing_pk")]
    private sealed class MissingPrimaryKeyModel
    {
        [SugarColumn(ColumnName = "asset_id", Length = 36)]
        public string AssetId { get; set; } = string.Empty;
    }

    [SugarTable("missing_column")]
    private sealed class MissingColumnModel
    {
        [SugarColumn(IsPrimaryKey = true, ColumnName = "asset_id", Length = 36)]
        public string AssetId { get; set; } = string.Empty;
    }

    [SugarTable("extra_identity")]
    private sealed class ExtraIdentityModel
    {
        [SugarColumn(IsPrimaryKey = true, ColumnName = "asset_id", Length = 36)]
        public string AssetId { get; set; } = string.Empty;

        [SugarColumn(IsPrimaryKey = true, ColumnName = "url_alias", Length = 512)]
        public string UrlAlias { get; set; } = string.Empty;
    }

    [SugarTable("url_identity")]
    private sealed class UrlIdentityModel
    {
        [SugarColumn(IsPrimaryKey = true, ColumnName = "normalized_url", Length = 512)]
        public string NormalizedUrl { get; set; } = string.Empty;
    }
}
