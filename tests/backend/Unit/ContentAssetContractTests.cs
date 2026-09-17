using System.Reflection;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Services;

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

        Assert.Equal("https://cdn.example.test/uploads/images/hero.png", url.ToString());
        Assert.True(codec.TryGetStorageKey(url, baseUri, out AssetStorageKey storageKey));
        Assert.Equal(record.StorageKey, storageKey);
    }

    [Theory]
    [InlineData("/content-assets/images/hero.png")]
    [InlineData("ftp://cdn.example.test/uploads/images/hero.png")]
    [InlineData("javascript:alert(1)")]
    [InlineData("https://cdn.example.test/uploads/images/hero.png?x=1")]
    [InlineData("https://cdn.example.test/uploads/images/hero.png#fragment")]
    [InlineData("https://user@cdn.example.test/uploads/images/hero.png")]
    [InlineData("https://evil.example.test/uploads/images/hero.png")]
    [InlineData("https://cdn.example.test/content-assets/images/hero.png")]
    [InlineData("https://cdn.example.test/uploads/a/../secret.png")]
    [InlineData("https://cdn.example.test/uploads/a/%2e%2e/secret.png")]
    [InlineData("https://cdn.example.test/uploads/a\\b.png")]
    [InlineData("https://cdn.example.test/uploads/a%5cb.png")]
    [InlineData("https://cdn.example.test/uploads/a\0b.png")]
    [InlineData("https://cdn.example.test/uploads/")]
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
    public void PublicAssetUrlCodec_StringBoundaryRejectsAbsoluteUrlsRegardlessOfHost()
    {
        var codec = new PublicAssetUrlCodec();

        Assert.False(codec.TryGetStorageKey(
            "https://evil.example.test/uploads/images/hero.png",
            out _));
        Assert.False(codec.TryGetStorageKey(
            "https://cdn.example.test/uploads/images/hero.png",
            out _));
        Assert.True(codec.TryGetStorageKey("/uploads/images/hero.png", out AssetStorageKey storageKey));
        Assert.Equal("images/hero.png", storageKey.Value);
    }

    [Fact]
    public void FileService_CommittedAssetFlowCarriesTypedIdentityAndOneUrlCodec()
    {
        FieldInfo codec = Assert.Single(
            typeof(FileService).GetFields(BindingFlags.Instance | BindingFlags.NonPublic),
            static field => field.FieldType == typeof(PublicAssetUrlCodec));
        Assert.Equal("_publicAssetUrlCodec", codec.Name);

        foreach (string methodName in new[]
        {
            "CommitVerifiedUploadAsync",
            "RegisterCommittedAssetAsync"
        })
        {
            MethodInfo method = Assert.Single(
                typeof(FileService).GetMethods(BindingFlags.Instance | BindingFlags.NonPublic),
                method => method.Name == methodName);
            ParameterInfo[] parameters = method.GetParameters();
            Assert.Contains(parameters, static parameter => parameter.ParameterType == typeof(AssetId));
            Assert.Contains(parameters, static parameter => parameter.ParameterType == typeof(AssetStorageKey));
            Assert.DoesNotContain(
                parameters,
                static parameter => parameter.Name?.Contains("url", StringComparison.OrdinalIgnoreCase) == true);
        }
    }

    [Fact]
    public void ContentAssetMediaInspector_ReadsEveryRuntimeUploadFormatFromCompleteBytes()
    {
        foreach ((string extension, byte[] bytes, string mediaType, int width, int height) in new[]
        {
            (".png", CreatePng(17, 19), "image/png", 17, 19),
            (".gif", CreateGif(23, 29), "image/gif", 23, 29),
            (".jpg", CreateJpegWithLateSof(31, 37), "image/jpeg", 31, 37),
            (".webp", CreateVp8xWebp(41, 43), "image/webp", 41, 43),
            (".ico", CreateIco(47, 53), "image/x-icon", 47, 53)
        })
        {
            Assert.True(ContentAssetMediaInspector.TryInspect(extension, bytes, out ContentAssetMediaMetadata metadata));
            Assert.Equal(mediaType, metadata.MediaType);
            Assert.Equal(width, metadata.Width);
            Assert.Equal(height, metadata.Height);
        }
    }

    [Fact]
    public void ContentAssetMediaInspector_RejectsImageWithoutReliableDimensions()
    {
        Assert.False(ContentAssetMediaInspector.TryInspect(".png", [137, 80, 78, 71, 13, 10, 26, 10], out _));
        Assert.False(ContentAssetMediaInspector.TryInspect(".ico", [0, 0, 1, 0, 1, 0], out _));
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
        Exception? error = Record.Exception(() => ContentAssetSchemaValidator.ValidateReferences(references));

        Assert.Null(error);
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
        Exception? error = Record.Exception(() =>
        {
            foreach (string sourceKind in new[] { ContentAssetSourceKinds.Article, ContentAssetSourceKinds.Draft, ContentAssetSourceKinds.Revision })
            {
                ContentAssetSchemaValidator.Validate(ValidReference() with
                {
                    SourceKind = sourceKind
                });
            }
        });

        Assert.Null(error);
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
        Exception? error = Record.Exception(() =>
        {
            ContentAssetSchemaValidator.Validate(ValidRecord());
            ContentAssetSchemaValidator.Validate(ValidRecord() with
            {
                MimeType = "application/pdf",
                Extension = ".pdf",
                Sha256 = null,
                WidthPixels = null,
                HeightPixels = null
            });
        });

        Assert.Null(error);
    }

    [Fact]
    public void EntityValidation_RejectsEmptyAssetIdStateAndReferenceFields()
    {
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            new ContentAsset { AssetId = Guid.Empty }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            new ContentAsset { AssetId = Guid.Parse(CanonicalUuid), StorageKey = "images/hero.png", State = "archived" }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            new ContentAssetReference { AssetId = Guid.Parse(CanonicalUuid), SourceKind = "video", SourceKey = "article/1" }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            new ContentAssetReference { AssetId = Guid.Parse(CanonicalUuid), SourceKind = ContentAssetSourceKinds.Article, SourceKey = "" }));
        Assert.Throws<ArgumentException>(() => ContentAssetSchemaValidator.Validate(
            new ContentAssetCleanupQueueItem { AssetId = Guid.Parse(CanonicalUuid), AttemptCount = -1 }));
    }

    [Fact]
    public void EntityValidation_AcceptsValidEntities()
    {
        Exception? error = Record.Exception(() =>
        {
            ContentAssetSchemaValidator.Validate(new ContentAsset
            {
                AssetId = Guid.Parse(CanonicalUuid),
                StorageClass = "public",
                StorageKey = "images/hero.png",
                MimeType = "image/png",
                Extension = ".png",
                SizeBytes = 10,
                WidthPixels = 1,
                HeightPixels = 1,
                State = ContentAssetStates.Active
            });
            ContentAssetSchemaValidator.Validate(new ContentAssetReference
            {
                AssetId = Guid.Parse(CanonicalUuid),
                SourceKind = ContentAssetSourceKinds.Article,
                SourceKey = "article/1",
                ReferenceCount = 1
            });
            ContentAssetSchemaValidator.Validate(new ContentAssetCleanupQueueItem
            {
                AssetId = Guid.Parse(CanonicalUuid),
                NotBeforeUtc = DateTime.UtcNow.AddMinutes(5),
                AttemptCount = 0
            });
        });

        Assert.Null(error);
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
        Exception? error = Record.Exception(ContentAssetSchemaValidator.ValidateSchema);

        Assert.Null(error);
        Assert.Equal(typeof(Guid), typeof(ContentAsset).GetProperty(nameof(ContentAsset.AssetId))!.PropertyType);
        SugarColumn contentAssetId = typeof(ContentAsset).GetProperty(nameof(ContentAsset.AssetId))!
            .GetCustomAttribute<SugarColumn>(inherit: false)!;
        Assert.Equal("id", contentAssetId.ColumnName);
        Assert.Equal("uuid", contentAssetId.ColumnDataType);
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
            "public",
            AssetStorageKey.Parse("images/hero.png"),
            "image/png",
            ".png",
            4096,
            "3f3b2e7a1d2e4f8a9c5b6a7b8c9d0e1f3f3b2e7a1d2e4f8a9c5b6a7b8c9d0e1f",
            800,
            600,
            null,
            ContentAssetState.Active,
            s_utcNow,
            s_utcNow);

    private static byte[] CreatePng(int width, int height)
    {
        var bytes = new byte[24];
        new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }.CopyTo(bytes, 0);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(16, 4), width);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(20, 4), height);
        return bytes;
    }

    private static byte[] CreateGif(ushort width, ushort height)
    {
        var bytes = new byte[10];
        "GIF89a"u8.CopyTo(bytes);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(6, 2), width);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(8, 2), height);
        return bytes;
    }

    private static byte[] CreateJpegWithLateSof(ushort width, ushort height)
    {
        var bytes = new byte[534];
        bytes[0] = 0xff;
        bytes[1] = 0xd8;
        bytes[2] = 0xff;
        bytes[3] = 0xe0;
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(bytes.AsSpan(4, 2), 520);
        bytes[524] = 0xff;
        bytes[525] = 0xc0;
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(bytes.AsSpan(526, 2), 7);
        bytes[528] = 8;
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(bytes.AsSpan(529, 2), height);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(bytes.AsSpan(531, 2), width);
        return bytes;
    }

    private static byte[] CreateVp8xWebp(int width, int height)
    {
        var bytes = new byte[30];
        "RIFF"u8.CopyTo(bytes);
        "WEBP"u8.CopyTo(bytes.AsSpan(8));
        "VP8X"u8.CopyTo(bytes.AsSpan(12));
        int encodedWidth = width - 1;
        int encodedHeight = height - 1;
        bytes[24] = (byte)encodedWidth;
        bytes[25] = (byte)(encodedWidth >> 8);
        bytes[26] = (byte)(encodedWidth >> 16);
        bytes[27] = (byte)encodedHeight;
        bytes[28] = (byte)(encodedHeight >> 8);
        bytes[29] = (byte)(encodedHeight >> 16);
        return bytes;
    }

    private static byte[] CreateIco(byte width, byte height)
    {
        var bytes = new byte[23];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(2, 2), 1);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(4, 2), 1);
        bytes[6] = width;
        bytes[7] = height;
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(14, 4), 1);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(18, 4), 22);
        bytes[22] = 1;
        return bytes;
    }

    private static AssetReference ValidReference()
        => new(
            AssetId.Parse(CanonicalUuid),
            ContentAssetSourceKinds.Article,
            "article/1",
            1,
            1,
            "hero",
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
