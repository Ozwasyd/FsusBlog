using System.Collections;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticlePackageManifestCandidateCodecTests
{
    private const string Token = "01991e72-9a2c-7b60-8f47-b339f58e4a11";

    [Fact]
    public void Candidate_RoundTripsFixedClosedKeysAndIndependentGoldenDigest()
    {
        ArticlePackageManifestCandidate candidate = Create([Article()]);
        byte[] encoded = ArticlePackageManifestCandidateCodec.WriteCandidate(candidate);
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidateCodec.TryParseCandidate(encoded, out var parsed);

        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Equal(candidate.SemanticDigest, parsed!.SemanticDigest);
        Assert.Equal(candidate.Articles[0], parsed.Articles[0]);
        Assert.Equal(encoded, ArticlePackageManifestCandidateCodec.WriteCandidate(parsed));
        using JsonDocument json = JsonDocument.Parse(encoded);
        Assert.Equal(new[] { "schemaVersion", "canonicalHashVersion", "propertySchemaVersion", "articles", "semanticDigest" }, json.RootElement.EnumerateObject().Select(property => property.Name));
        Assert.Equal(1, candidate.SchemaVersion);
        Assert.Equal(1, candidate.CanonicalHashVersion);
        Assert.Equal(1, candidate.PropertySchemaVersion);
        Assert.Equal("d86dfddb574ffb8fe74d3db323b00d6a96394d3c48a2cf50b2835bd83014ce0f", candidate.SemanticDigest);
    }

    [Fact]
    public void Candidate_FreezesInputByBoundedIndexesAndSortsOrdinalPortableIdentities()
    {
        ArticlePackageManifestArticle first = Article();
        ArticlePackageManifestArticle second = NumberedArticle(2);
        ArticlePackageManifestArticle[] mutable = [first, second];
        var list = new IndexOnlyList(mutable);
        ArticlePackageManifestCandidate candidate = Create(list);
        mutable[0] = first with
        {
            Title = "changed caller"
        };
        ArticlePackageManifestCandidate reversed = Create([second, first]);

        Assert.Equal(1, list.CountReads);
        Assert.Equal(2, list.IndexReads);
        Assert.Equal(candidate.SemanticDigest, reversed.SemanticDigest);
        Assert.Equal(ArticlePackageManifestCandidateCodec.WriteCandidate(candidate), ArticlePackageManifestCandidateCodec.WriteCandidate(reversed));
        Assert.DoesNotContain(candidate.Articles, article => article.Title == "changed caller");
        Assert.Throws<NotSupportedException>(() => ((IList<ArticlePackageManifestArticle>)candidate.Articles)[0] = second);
    }

    [Fact]
    public void Candidate_AcceptsOneThousandFrozenArticlesAndRepeatedRoundTrips()
    {
        ArticlePackageManifestArticle[] articles = Enumerable.Range(1, 1000).Select(NumberedArticle).ToArray();
        ArticlePackageManifestCandidate candidate = Create(articles);
        for (int attempt = 0; attempt < 3; attempt++)
        {
            Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(ArticlePackageManifestCandidateCodec.WriteCandidate(candidate), out var parsed).IsValid);
            Assert.Equal(candidate.SemanticDigest, parsed!.SemanticDigest);
            Assert.Equal(1000, parsed.Articles.Count);
        }
    }

    [Fact]
    public void Candidate_RejectsNullEmptyAndOverBudgetSetsBeforeIndexing()
    {
        AssertInvalidCreate(null);
        AssertInvalidCreate([]);
        var tooMany = new IndexOnlyList(new ArticlePackageManifestArticle[1001]);
        AssertInvalidCreate(tooMany);
        Assert.Equal(1, tooMany.CountReads);
        Assert.Equal(0, tooMany.IndexReads);
        AssertInvalidCreate([null!]);
    }

    [Fact]
    public void Candidate_RejectsPortableAndSourceArticleCollisions()
    {
        ArticlePackageManifestArticle first = Article();
        AssertInvalidCreate([first, first with
        {
            Source = first.Source with
            {
                ArticleId = 2
            }
        }]);
        ArticlePackageManifestArticle second = NumberedArticle(2) with
        {
            Source = first.Source
        };
        AssertInvalidCreate([first, second]);
    }

    [Theory]
    [InlineData("schemaVersion")]
    [InlineData("canonicalHashVersion")]
    [InlineData("propertySchemaVersion")]
    public void Parse_RefusesFutureUnknownAndMistypedVersions(string field)
    {
        foreach (string value in new[] { "2", "0", "-1", "null", "\"legacy\"", "{}", "1.0" })
        {
            JsonObject json = Document();
            json[field] = JsonNode.Parse(value);
            AssertInvalidParse(json, "article_package_manifest_version_unsupported");
        }
    }

    [Theory]
    [InlineData("root")]
    [InlineData("article")]
    [InlineData("source")]
    [InlineData("sourceBytes")]
    [InlineData("lifecycle")]
    public void Parse_RejectsUnknownFieldsAtEveryObjectLevel(string level)
    {
        JsonObject json = Document();
        ObjectAt(json, level)["token"] = "private-fixture";

        AssertInvalidParse(json, "article_package_manifest_unknown_field");
    }

    [Theory]
    [InlineData("schemaVersion")]
    [InlineData("title")]
    [InlineData("articleId")]
    [InlineData("hasUtf8Bom")]
    [InlineData("status")]
    public void Parse_RejectsDuplicateFieldsAtEveryObjectLevel(string field)
    {
        string text = Encoding.UTF8.GetString(ArticlePackageManifestCandidateCodec.WriteCandidate(Create([Article()])));
        text = text.Replace($"\"{field}\":", $"\"{field}\":null,\"{field}\":", StringComparison.Ordinal);

        AssertInvalidParse(Encoding.UTF8.GetBytes(text), "article_package_manifest_duplicate_field");
    }

    [Fact]
    public void Parse_RejectsEscapedDuplicateNames()
    {
        string text = Encoding.UTF8.GetString(ArticlePackageManifestCandidateCodec.WriteCandidate(Create([Article()])));
        text = text.Insert(1, "\"\\u0073chemaVersion\":1,");

        AssertInvalidParse(Encoding.UTF8.GetBytes(text), "article_package_manifest_duplicate_field");
    }

    [Theory]
    [InlineData("assets", "article_package_manifest_assets_authority_unavailable")]
    [InlineData("syntaxDependencies", "article_package_manifest_syntax_authority_unavailable")]
    [InlineData("references", "article_package_manifest_reference_authority_unavailable")]
    [InlineData("rights", "article_package_manifest_rights_authority_unavailable")]
    [InlineData("responsibility", "article_package_manifest_responsibility_authority_unavailable")]
    [InlineData("taxonomy", "article_package_manifest_taxonomy_authority_unavailable")]
    [InlineData("privacy", "article_package_manifest_privacy_authority_unavailable")]
    [InlineData("sourceMetadata", "article_package_manifest_source_metadata_authority_unavailable")]
    public void Parse_RejectsDeclaredUnavailableAuthoritiesEvenWhenEmptyOrNull(string field, string reason)
    {
        foreach (string level in new[] { "root", "article", "source", "sourceBytes", "lifecycle" })
        {
            foreach (string value in new[] { "null", "[]", "{}" })
            {
                JsonObject json = Document();
                ObjectAt(json, level)[field] = JsonNode.Parse(value);
                AssertInvalidParse(json, reason);
            }
        }
    }

    [Theory]
    [InlineData("root", "semanticDigest")]
    [InlineData("article", "summary")]
    [InlineData("source", "draftId")]
    [InlineData("source", "draftServerRevision")]
    [InlineData("source", "publicationId")]
    [InlineData("sourceBytes", "byteLength")]
    [InlineData("lifecycle", "publishedAt")]
    [InlineData("lifecycle", "scheduledPublishAt")]
    public void Parse_RequiresAllKeysIncludingNullableFacts(string level, string field)
    {
        JsonObject json = Document();
        ObjectAt(json, level).Remove(field);

        AssertInvalidParse(json, "article_package_manifest_missing_field");
    }

    [Theory]
    [InlineData("article", "source", "null")]
    [InlineData("article", "sourceBytes", "[]")]
    [InlineData("article", "lifecycle", "false")]
    [InlineData("article", "title", "null")]
    [InlineData("article", "summary", "{}")]
    [InlineData("source", "articleId", "\"1\"")]
    [InlineData("source", "articleRevisionId", "99999999999999999999999999")]
    [InlineData("source", "propertyRevision", "1.5")]
    [InlineData("source", "draftId", "false")]
    [InlineData("sourceBytes", "hasUtf8Bom", "\"false\"")]
    [InlineData("sourceBytes", "lfCount", "null")]
    [InlineData("lifecycle", "status", "{}")]
    public void Parse_RejectsWrongFieldTypesAndNumericOverflowWithoutThrowing(string level, string field, string value)
    {
        JsonObject json = Document();
        ObjectAt(json, level)[field] = JsonNode.Parse(value);

        AssertInvalidParse(json, "article_package_manifest_shape_invalid");
    }

    [Theory]
    [InlineData("article", "titleSummaryDigest")]
    [InlineData("article", "propertySnapshotDigest")]
    [InlineData("article", "propertyMappingDigest")]
    [InlineData("source", "canonicalHash")]
    [InlineData("sourceBytes", "sha256")]
    [InlineData("root", "semanticDigest")]
    public void Parse_RejectsNoncanonicalDigestFields(string level, string field)
    {
        foreach (string value in new[] { "", new string('A', 64), new string('g', 64), new string('0', 63) })
        {
            JsonObject json = Document();
            ObjectAt(json, level)[field] = value;
            AssertInvalidParse(json, "article_package_manifest_shape_invalid");
        }
    }

    [Fact]
    public void Parse_RejectsValidLookingSemanticDigestAndFieldTamper()
    {
        JsonObject json = Document();
        json["semanticDigest"] = new string('0', 64);
        AssertInvalidParse(json, "article_package_manifest_semantic_digest_mismatch");
        json = Document();
        ObjectAt(json, "article")["title"] = "tampered";
        AssertInvalidParse(json, "article_package_manifest_semantic_digest_mismatch");
    }

    [Fact]
    public void PropertyRoot_PreservesExplicitNullOwnerAndRejectsMissingOwnerOrComponent()
    {
        var fixture = PropertyRootFixture(owner: null);
        var root = CreatePropertyRoot(fixture.Articles, fixture.Assets, fixture.Inventory, fixture.Properties);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, fixture.Properties);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(bytes, fixture.Assets, fixture.Inventory, fixture.Properties, out var parsed).IsValid);
        Assert.All(parsed!.Properties!, row => Assert.Null(row.Property.Mapping.SourceCoordinates.DefinitionOwnerUserId));
        foreach (string field in new[] { "owner", "missingComponent", "nullComponent" })
        {
            var json = JsonNode.Parse(bytes)!.AsObject();
            var binding = json["properties"]![0]!.AsObject();
            if (field == "owner")
            {
                binding["property"]!["sourceCoordinates"]!.AsObject().Remove("definitionOwnerUserId");
            }
            else if (field == "missingComponent")
            {
                binding.Remove("property");
            }
            else
            {
                binding["property"] = null;
            }
            AssertPropertyRootParseInvalid(JsonSerializer.SerializeToUtf8Bytes(json), fixture.Assets, fixture.Inventory, fixture.Properties);
        }
    }

    [Theory]
    [InlineData("articleId")]
    [InlineData("articleRevisionId")]
    [InlineData("revisionNo")]
    [InlineData("propertyRevision")]
    public void Candidate_RejectsNonpositiveSourceCoordinates(string field)
    {
        JsonObject json = Document();
        ObjectAt(json, "source")[field] = 0;

        AssertInvalidParse(json, "article_package_manifest_shape_invalid");
    }

    [Fact]
    public void Candidate_RejectsInvalidDraftPairAndMixedPublicationCoordinates()
    {
        ArticlePackageManifestArticle original = Article();
        AssertInvalidCreate([original with
        {
            Source = original.Source with { DraftId = 1 }
        }]);
        AssertInvalidCreate([original with
        {
            Source = original.Source with { DraftId = 1, DraftServerRevision = 1, PublicationId = 1 }
        }]);
        AssertInvalidCreate([original with
        {
            Source = original.Source with { DraftId = -1, DraftServerRevision = -1 }
        }]);
        AssertInvalidCreate([original with
        {
            Source = original.Source with { PublicationId = 0 }
        }]);
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate([original with
        {
            Source = original.Source with { DraftId = 1, DraftServerRevision = 2 }
        }], out _).IsValid);
    }

    [Theory]
    [InlineData("byteLength")]
    [InlineData("lfCount")]
    [InlineData("crLfCount")]
    [InlineData("bareCrCount")]
    [InlineData("trailingSpaceCount")]
    [InlineData("trailingTabCount")]
    public void Candidate_RejectsNegativeAndOverBudgetByteMetadataCounts(string field)
    {
        foreach (int number in new[] { -1, ArticlePackageSourceBytes.MaximumByteLength + 1 })
        {
            JsonObject json = Document();
            ObjectAt(json, "sourceBytes")[field] = number;
            AssertInvalidParse(json, "article_package_manifest_shape_invalid");
        }
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(4)]
    [InlineData(256)]
    public void Candidate_RejectsUnknownFinalNewlineBeforeByteEnumConversion(int value)
    {
        JsonObject json = Document();
        ObjectAt(json, "sourceBytes")["finalNewline"] = value;

        AssertInvalidParse(json, "article_package_manifest_shape_invalid");
    }

    [Theory]
    [InlineData(ArticleStatusValues.Scheduled)]
    [InlineData(ArticleStatusValues.Deleted)]
    public void Candidate_PreservesHistoricalLifecycleWithoutWriteTargetValidation(int status)
    {
        ArticlePackageManifestArticle article = Article() with
        {
            Lifecycle = new(status, DateTime.UnixEpoch, DateTime.UnixEpoch)
        };
        ArticlePackageManifestCandidate candidate = Create([article]);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(ArticlePackageManifestCandidateCodec.WriteCandidate(candidate), out var parsed).IsValid);
        Assert.Equal(article.Lifecycle, parsed!.Articles[0].Lifecycle);
    }

    [Theory]
    [InlineData("2026-10-08T03:04:05Z")]
    [InlineData("2026-10-08T03:04:05.123Z")]
    [InlineData("2026-10-08T03:04:05.1234567+00:00")]
    [InlineData("2026-10-08T03:04:05.1234567z")]
    [InlineData("2026-02-30T03:04:05.1234567Z")]
    public void Parse_RejectsNonexactUtcTimestampForms(string timestamp)
    {
        JsonObject json = Document();
        ObjectAt(json, "lifecycle")["publishedAt"] = timestamp;

        AssertInvalidParse(json, "article_package_manifest_shape_invalid");
    }

    [Fact]
    public void Candidate_AcceptsExactUtcTicksAndRejectsLocalOrUndefinedLifecycle()
    {
        ArticlePackageManifestArticle article = Article();
        DateTime utc = new DateTime(2026, 10, 8, 3, 4, 5, DateTimeKind.Utc).AddTicks(1234567);
        ArticlePackageManifestCandidate candidate = Create([article with { Lifecycle = new(2, utc, null) }]);
        byte[] encoded = ArticlePackageManifestCandidateCodec.WriteCandidate(candidate);
        Assert.Contains("2026-10-08T03:04:05.1234567Z", Encoding.UTF8.GetString(encoded));
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(encoded, out var parsed).IsValid);
        Assert.Equal(utc, parsed!.Articles[0].Lifecycle.PublishedAt);
        AssertInvalidCreate([article with { Lifecycle = new(5, null, null) }]);
        AssertInvalidCreate([article with { Lifecycle = new(2, DateTime.SpecifyKind(utc, DateTimeKind.Local), null) }]);
    }

    [Fact]
    public void Candidate_RetainsRawTextAndDistinguishesNullEmptyAndNormalizationVariants()
    {
        string[] titles = ["Title", "Title ", "Title\r\n", "caf\u00e9", "cafe\u0301", "😀", "\\ud800"];
        var digests = new HashSet<string>(StringComparer.Ordinal);
        foreach (string title in titles)
        {
            ArticlePackageManifestCandidate candidate = Create([Article() with { Title = title }]);
            Assert.True(digests.Add(candidate.SemanticDigest));
            Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(ArticlePackageManifestCandidateCodec.WriteCandidate(candidate), out var parsed).IsValid);
            Assert.Equal(title, parsed!.Articles[0].Title);
        }
        Assert.NotEqual(Create([Article()]).SemanticDigest, Create([Article() with { Summary = "" }]).SemanticDigest);
    }

    [Theory]
    [InlineData("\\ud800")]
    [InlineData("\\udc00")]
    [InlineData("\\ud800x")]
    [InlineData("\\ud800\\u0061")]
    public void Parse_RejectsEscapedLoneSurrogates(string escaped)
    {
        string text = Encoding.UTF8.GetString(ArticlePackageManifestCandidateCodec.WriteCandidate(Create([Article()])));
        text = text.Replace("\"Title\"", "\"" + escaped + "\"", StringComparison.Ordinal);

        AssertInvalidParse(Encoding.UTF8.GetBytes(text), "article_package_manifest_utf8_invalid");
    }

    [Fact]
    public void CandidateAndParse_RejectInvalidUnicodeAtAllStringBoundaries()
    {
        ArticlePackageManifestArticle article = Article();
        AssertInvalidCreate([article with { Title = "\ud800" }], "article_package_manifest_utf8_invalid");
        AssertInvalidCreate([article with { Summary = "\udc00" }], "article_package_manifest_utf8_invalid");
        AssertInvalidCreate([article with { Source = article.Source with { SiteScope = "\ud800" } }], "article_package_manifest_utf8_invalid");
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(Create([article]));
        bytes[1] = 0xff;
        AssertInvalidParse(bytes, "article_package_manifest_utf8_invalid");
        string text = Encoding.UTF8.GetString(ArticlePackageManifestCandidateCodec.WriteCandidate(Create([article])));
        text = text.Replace("\"title\":", "\"\\ud800\":", StringComparison.Ordinal);
        AssertInvalidParse(Encoding.UTF8.GetBytes(text), "article_package_manifest_utf8_invalid");
    }

    [Fact]
    public void Candidate_RejectsPerTextAndAggregateTextAndEncodedByteBudgets()
    {
        ArticlePackageManifestArticle article = Article();
        AssertInvalidCreate([article with { Title = new string('t', ArticlePackageTitleSummaryLimits.MaxCanonicalTextCodeUnits + 1) }]);
        AssertInvalidCreate([article with { Summary = new string('s', ArticlePackageTitleSummaryLimits.MaxCanonicalTextCodeUnits + 1) }]);
        AssertInvalidCreate([article with { Source = article.Source with { SiteScope = new string('s', 129) } }]);
        AssertInvalidCreate([article with { Source = article.Source with { SiteScope = " " } }]);

        string maximum = new('x', ArticlePackageTitleSummaryLimits.MaxCanonicalTextCodeUnits);
        ArticlePackageManifestArticle[] aggregate = Enumerable.Range(1, 1000).Select(index => NumberedArticle(index) with { Title = maximum }).ToArray();
        AssertInvalidCreate(aggregate, "article_package_manifest_document_budget_exceeded");
        string control = new('\0', ArticlePackageTitleSummaryLimits.MaxCanonicalTextCodeUnits);
        AssertInvalidCreate(Enumerable.Range(1, 3).Select(index => NumberedArticle(index) with { Title = control }).ToArray(), "article_package_manifest_document_budget_exceeded");
        AssertInvalidParse(new byte[ArticlePackageManifestCandidateCodec.MaxJsonBytes + 1], "article_package_manifest_document_budget_exceeded");
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"schemaVersion\":")]
    [InlineData("/*comment*/{}")]
    [InlineData("{\"a\":0,}")]
    [InlineData("{\"a\":{\"b\":{\"c\":{\"d\":{\"e\":0}}}}}")]
    public void Parse_RejectsMalformedAndNonclosedRootFormsWithoutThrowing(string json)
    {
        AssertInvalidParse(Encoding.UTF8.GetBytes(json));
    }

    [Fact]
    public void Parse_EnforcesBoundedReadDepthBeyondRejectedEmptyAuthorityContainers()
    {
        string json = "{\"a\":" + new string('[', 9) + "0" + new string(']', 9) + "}";
        AssertInvalidParse(Encoding.UTF8.GetBytes(json), "article_package_manifest_json_invalid");
    }

    [Fact]
    public void AssetRoot_RoundTripsRealMappedSharedAssetAndKeepsLegacyDigest()
    {
        var fixture = AssetRootFixture();
        var root = CreateAssetRoot(fixture.Articles, fixture.Assets, fixture.Inventory);
        Assert.Equal(2, root.SchemaVersion);
        Assert.Equal(1, root.CanonicalHashVersion);
        Assert.Equal(1, root.PropertySchemaVersion);
        Assert.NotEqual(Create(fixture.Articles).SemanticDigest, root.SemanticDigest);
        Assert.Equal(IndependentAssetRootDigest(root), root.SemanticDigest);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory);
        using JsonDocument json = JsonDocument.Parse(bytes);
        Assert.Equal(new[] { "schemaVersion", "canonicalHashVersion", "propertySchemaVersion", "articles", "assets", "semanticDigest" },
            json.RootElement.EnumerateObject().Select(property => property.Name));
        Assert.Equal(ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(fixture.Assets),
            Encoding.UTF8.GetBytes(json.RootElement.GetProperty("assets").GetRawText()));
        for (int attempt = 0; attempt < 3; attempt++)
        {
            var result = ArticlePackageManifestCandidateCodec.TryParseCandidate(bytes, fixture.Assets, fixture.Inventory, out var parsed);
            Assert.True(result.IsValid, result.ReasonCode);
            Assert.Equal(root.SemanticDigest, parsed!.SemanticDigest);
            Assert.Equal(root.Articles, parsed.Articles);
            Assert.Single(parsed.Assets!.Assets);
            Assert.Equal(2, parsed.Assets.References.Count);
            Assert.False(parsed.Assets.RequireAssetAuthority().IsValid);
            Assert.Equal(bytes, ArticlePackageManifestCandidateCodec.WriteCandidate(parsed, fixture.Assets, fixture.Inventory));
        }
        foreach (string excluded in new[] { "storageClass", "storageKey", "ownerAdminPrincipalId", "createdAtUtc", "updatedAtUtc", "state" })
        {
            Assert.DoesNotContain(excluded, Encoding.UTF8.GetString(bytes), StringComparison.Ordinal);
        }
    }

    [Fact]
    public void AssetRoot_RequiresExplicitCollectionInventoryAndWireFieldIncludingEmptyCollections()
    {
        var fixture = AssetRootFixture();
        var root = CreateAssetRoot(fixture.Articles, fixture.Assets, fixture.Inventory);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory);
        AssertInvalidParse(bytes, "article_package_manifest_assets_authority_unavailable");
        Assert.Equal("article_package_manifest_assets_authority_unavailable",
            Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(root)).Message);
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateCandidate(fixture.Articles, null, fixture.Inventory, out var missingCollection).IsValid);
        Assert.Null(missingCollection);
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateCandidate(fixture.Articles, fixture.Assets, null, out var missingInventory).IsValid);
        Assert.Null(missingInventory);
        AssertAssetRootParseInvalid(bytes, null, fixture.Inventory, "article_package_manifest_asset_root_input_invalid");
        AssertAssetRootParseInvalid(bytes, fixture.Assets, null, "article_package_manifest_asset_root_input_invalid");
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(root, null, fixture.Inventory));
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, null));
        var json = JsonNode.Parse(bytes)!.AsObject();
        json.Remove("assets");
        AssertAssetRootParseInvalid(JsonSerializer.SerializeToUtf8Bytes(json), fixture.Assets, fixture.Inventory, "article_package_manifest_missing_field");
        foreach (string value in new[] { "null", "[]", "{}" })
        {
            json["assets"] = JsonNode.Parse(value);
            AssertAssetRootParseInvalid(JsonSerializer.SerializeToUtf8Bytes(json), fixture.Assets, fixture.Inventory);
        }
        var noAssetInventory = fixture.Inventory.Where(entry => !entry.Path.StartsWith("assets/", StringComparison.Ordinal)).ToArray();
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate([], [], noAssetInventory, out var empty).IsValid);
        var emptyRoot = CreateAssetRoot(fixture.Articles, empty!, noAssetInventory);
        byte[] emptyBytes = ArticlePackageManifestCandidateCodec.WriteCandidate(emptyRoot, empty, noAssetInventory);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(emptyBytes, empty, noAssetInventory, out var parsed).IsValid);
        Assert.Empty(parsed!.Assets!.Assets);
        AssertInvalidParse(emptyBytes, "article_package_manifest_assets_authority_unavailable");
        AssertAssetRootParseInvalid(ArticlePackageManifestCandidateCodec.WriteCandidate(Create(fixture.Articles)), empty, noAssetInventory,
            "article_package_manifest_missing_field");
    }

    [Theory]
    [InlineData("foreignInventoryArticle")]
    [InlineData("missingRootArticle")]
    [InlineData("foreignReference")]
    [InlineData("articleSize")]
    public void AssetRoot_RequiresExactArticleInventoryMembership(string change)
    {
        var fixture = AssetRootFixture();
        var articles = fixture.Articles.ToList();
        var inventory = fixture.Inventory.ToList();
        var references = fixture.Assets.References.ToList();
        var foreign = NumberedArticle(3);
        if (change is "foreignInventoryArticle" or "foreignReference")
        {
            inventory.Add(Entry("articles/" + foreign.PortableArticle.FileNameToken + ".md", foreign.SourceBytes.ByteLength));
        }
        if (change == "foreignReference")
        {
            references.Add(new(foreign.PortableArticle, fixture.Assets.Assets[0].Metadata.PortableAsset));
        }
        if (change == "missingRootArticle")
        {
            articles.Add(foreign);
        }
        if (change == "articleSize")
        {
            inventory[2] = inventory[2] with
            {
                UncompressedBytes = inventory[2].UncompressedBytes + 1,
                CompressedBytes = inventory[2].CompressedBytes + 1
            };
        }
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate(
            fixture.Assets.Assets.Select(asset => asset.Metadata).ToArray(), references, inventory, out var collection).IsValid);
        var result = ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, collection, inventory, out var root);
        Assert.False(result.IsValid);
        Assert.Null(root);
        Assert.Equal("article_package_manifest_asset_root_membership_mismatch", result.ReasonCode);
    }

    [Theory]
    [InlineData("duplicatePath")]
    [InlineData("foreignAsset")]
    [InlineData("missingAsset")]
    [InlineData("compressedSize")]
    [InlineData("pathTraversal")]
    [InlineData("assetSize")]
    [InlineData("nullRow")]
    public void AssetRoot_RejectsChangedIndependentlySuppliedInventoryAtEveryEntryPoint(string change)
    {
        var fixture = AssetRootFixture();
        var root = CreateAssetRoot(fixture.Articles, fixture.Assets, fixture.Inventory);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory);
        var inventory = fixture.Inventory.ToList();
        if (change == "duplicatePath")
        {
            inventory.Add(inventory[^1]);
        }
        if (change == "foreignAsset")
        {
            inventory.Add(Entry("assets/00000009-0000-4000-8000-000000000001.png", 1));
        }
        if (change == "missingAsset")
        {
            inventory.RemoveAt(inventory.Count - 1);
        }
        if (change == "compressedSize")
        {
            inventory[^1] = inventory[^1] with
            {
                CompressedBytes = inventory[^1].CompressedBytes + 1
            };
        }
        if (change == "pathTraversal")
        {
            inventory[^1] = inventory[^1] with
            {
                Path = "assets/../private.png"
            };
        }
        if (change == "assetSize")
        {
            inventory[^1] = inventory[^1] with
            {
                UncompressedBytes = inventory[^1].UncompressedBytes + 1
            };
        }
        if (change == "nullRow")
        {
            inventory[^1] = null!;
        }
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateCandidate(fixture.Articles, fixture.Assets, inventory, out var candidate).IsValid);
        Assert.Null(candidate);
        AssertAssetRootParseInvalid(bytes, fixture.Assets, inventory);
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, inventory));
    }

    [Theory]
    [InlineData("componentDigest")]
    [InlineData("childDigest")]
    [InlineData("rootDigest")]
    [InlineData("mime")]
    [InlineData("size")]
    [InlineData("path")]
    [InlineData("orphan")]
    [InlineData("duplicateAsset")]
    [InlineData("duplicateReference")]
    [InlineData("foreignReference")]
    [InlineData("article")]
    public void AssetRoot_RejectsComponentRootAndMembershipTampering(string change)
    {
        var fixture = AssetRootFixture();
        var root = CreateAssetRoot(fixture.Articles, fixture.Assets, fixture.Inventory);
        var json = JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory))!.AsObject();
        var collection = json["assets"]!.AsObject();
        var assets = collection["assets"]!.AsArray();
        var references = collection["references"]!.AsArray();
        switch (change)
        {
            case "componentDigest":
                collection["componentDigest"] = new string('0', 64);
                break;
            case "childDigest":
                assets[0]!["componentDigest"] = new string('0', 64);
                break;
            case "rootDigest":
                json["semanticDigest"] = new string('0', 64);
                break;
            case "mime":
                assets[0]!["mimeType"] = "image/jpeg";
                break;
            case "size":
                assets[0]!["sizeBytes"] = 1;
                break;
            case "path":
                assets[0]!["packagePath"] = "assets/../private.png";
                break;
            case "orphan":
                references.Clear();
                break;
            case "duplicateAsset":
                assets.Add(assets[0]!.DeepClone());
                break;
            case "duplicateReference":
                references.Add(references[0]!.DeepClone());
                break;
            case "foreignReference":
                references[0]!["portableArticle"] = NumberedArticle(3).PortableArticle.Value;
                break;
            case "article":
                json["articles"]![0]!["title"] = "changed";
                break;
        }
        AssertAssetRootParseInvalid(JsonSerializer.SerializeToUtf8Bytes(json), fixture.Assets, fixture.Inventory);
    }

    [Fact]
    public void AssetRoot_ParserRejectsForeignInventoryArticlesAndWrongTuplesBeforeDigestComparison()
    {
        var fixture = AssetRootFixture();
        var root = CreateAssetRoot(fixture.Articles, fixture.Assets, fixture.Inventory);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory);
        var json = JsonNode.Parse(bytes)!.AsObject();
        json["articles"]!.AsArray().RemoveAt(1);
        AssertAssetRootParseInvalid(JsonSerializer.SerializeToUtf8Bytes(json), fixture.Assets, fixture.Inventory,
            "article_package_manifest_asset_root_membership_mismatch");
        foreach (int schema in new[] { 0, 1, 3 })
        {
            json = JsonNode.Parse(bytes)!.AsObject();
            json["schemaVersion"] = schema;
            AssertAssetRootParseInvalid(JsonSerializer.SerializeToUtf8Bytes(json), fixture.Assets, fixture.Inventory,
                "article_package_manifest_version_unsupported");
        }
    }

    [Fact]
    public void AssetRoot_RecomputedComponentsChangeRootDigestAndCannotReplaceSuppliedCollection()
    {
        var fixture = AssetRootFixture();
        var original = CreateAssetRoot(fixture.Articles, fixture.Assets, fixture.Inventory);
        var metadata = fixture.Assets.Assets[0].Metadata with
        {
            Sha256 = new string('e', 64)
        };
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate([metadata], fixture.Assets.References, fixture.Inventory, out var replacement).IsValid);
        var changed = CreateAssetRoot(fixture.Articles, replacement!, fixture.Inventory);
        Assert.NotEqual(original.Assets!.ComponentDigest, changed.Assets!.ComponentDigest);
        Assert.NotEqual(original.SemanticDigest, changed.SemanticDigest);
        Assert.Equal(IndependentAssetRootDigest(changed), changed.SemanticDigest);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(changed, replacement, fixture.Inventory);
        AssertAssetRootParseInvalid(bytes, fixture.Assets, fixture.Inventory, "article_package_manifest_asset_root_collection_mismatch");
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(original, replacement, fixture.Inventory));
    }

    [Fact]
    public void AssetRoot_RechecksForgedChildCollectionAndRootDigestsBeforeCreateOrWrite()
    {
        var fixture = AssetRootFixture();
        var root = CreateAssetRoot(fixture.Articles, fixture.Assets, fixture.Inventory);
        var flags = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;
        var asset = fixture.Assets.Assets[0];
        var childConstructor = Assert.Single(typeof(ArticlePackageManifestAssetMetadataCandidate).GetConstructors(flags));
        var forgedChild = (ArticlePackageManifestAssetMetadataCandidate)childConstructor.Invoke([asset.Metadata, new string('0', 64)]);
        var constructor = Assert.Single(typeof(ArticlePackageManifestAssetCollectionCandidate).GetConstructors(flags));
        foreach (var forged in new[]
        {
            (ArticlePackageManifestAssetCollectionCandidate)constructor.Invoke([new[] { forgedChild }, fixture.Assets.References.ToArray(), fixture.Inventory, fixture.Assets.TotalAssetBytes, fixture.Assets.ComponentDigest]),
            (ArticlePackageManifestAssetCollectionCandidate)constructor.Invoke([fixture.Assets.Assets.ToArray(), fixture.Assets.References.ToArray(), fixture.Inventory, fixture.Assets.TotalAssetBytes, new string('0', 64)]),
            (ArticlePackageManifestAssetCollectionCandidate)constructor.Invoke([fixture.Assets.Assets.ToArray(), fixture.Assets.References.ToArray(), fixture.Inventory, fixture.Assets.TotalAssetBytes + 1, fixture.Assets.ComponentDigest])
        })
        {
            Assert.False(ArticlePackageManifestCandidateCodec.TryCreateCandidate(fixture.Articles, forged, fixture.Inventory, out var rejected).IsValid);
            Assert.Null(rejected);
            Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(root, forged, fixture.Inventory));
        }
        var digestField = typeof(ArticlePackageManifestCandidate).GetField("<SemanticDigest>k__BackingField", flags)!;
        digestField.SetValue(root, new string('0', 64));
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory));
    }

    [Fact]
    public void AssetRoot_FreezesBoundedInputsAndCanonicalizesEveryOrder()
    {
        var fixture = AssetRootFixture();
        var inventory = fixture.Inventory.Reverse().ToArray();
        var list = new RootIndexList<ArticlePackageInventoryEntry>(inventory);
        var articles = new IndexOnlyList(fixture.Articles.Reverse().ToArray());
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, fixture.Assets, list, out var root).IsValid);
        Assert.Equal(1, list.CountReads);
        Assert.Equal(inventory.Length, list.IndexReads);
        Assert.Equal(1, articles.CountReads);
        Assert.Equal(fixture.Articles.Length, articles.IndexReads);
        var original = ArticlePackageManifestCandidateCodec.WriteCandidate(root!, fixture.Assets, fixture.Inventory);
        var writeInventory = new RootIndexList<ArticlePackageInventoryEntry>(fixture.Inventory);
        Assert.Equal(original, ArticlePackageManifestCandidateCodec.WriteCandidate(root!, fixture.Assets, writeInventory));
        Assert.Equal(1, writeInventory.CountReads);
        Assert.Equal(fixture.Inventory.Length, writeInventory.IndexReads);
        inventory[0] = null!;
        Assert.Equal(original, ArticlePackageManifestCandidateCodec.WriteCandidate(root!, fixture.Assets, fixture.Inventory));
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate(fixture.Assets.Assets.Select(asset => asset.Metadata).Reverse().ToArray(),
            fixture.Assets.References.Reverse().ToArray(), fixture.Inventory.Reverse().ToArray(), out var reversed).IsValid);
        var second = CreateAssetRoot(fixture.Articles, reversed!, fixture.Inventory);
        Assert.Equal(original, ArticlePackageManifestCandidateCodec.WriteCandidate(second, reversed, fixture.Inventory));
        var json = JsonNode.Parse(original)!.AsObject();
        var rows = json["articles"]!.AsArray();
        var first = rows[0]!.DeepClone();
        rows[0] = rows[1]!.DeepClone();
        rows[1] = first;
        var references = json["assets"]!["references"]!.AsArray();
        first = references[0]!.DeepClone();
        references[0] = references[1]!.DeepClone();
        references[1] = first;
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(JsonSerializer.SerializeToUtf8Bytes(json), fixture.Assets, fixture.Inventory, out var parsed).IsValid);
        Assert.Equal(original, ArticlePackageManifestCandidateCodec.WriteCandidate(parsed!, fixture.Assets, fixture.Inventory));
        var broken = new RootIndexList<ArticlePackageInventoryEntry>(fixture.Inventory, true);
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateCandidate(fixture.Articles, fixture.Assets, broken, out var rejected).IsValid);
        Assert.Null(rejected);
    }

    [Theory]
    [InlineData("duplicateRoot")]
    [InlineData("escapedDuplicate")]
    [InlineData("duplicateChild")]
    [InlineData("utf8")]
    [InlineData("surrogate")]
    [InlineData("depth")]
    [InlineData("documentBudget")]
    public void AssetRoot_RejectsMalformedEncodingDuplicateKeysDepthAndInputBudget(string change)
    {
        var fixture = AssetRootFixture();
        var root = CreateAssetRoot(fixture.Articles, fixture.Assets, fixture.Inventory);
        string text = Encoding.UTF8.GetString(ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory));
        byte[] json = change switch
        {
            "duplicateRoot" => Encoding.UTF8.GetBytes(text.Insert(1, "\"assets\":null,")),
            "escapedDuplicate" => Encoding.UTF8.GetBytes(text.Insert(1, "\"\\u0061ssets\":null,")),
            "duplicateChild" => Encoding.UTF8.GetBytes(text.Replace("\"mimeType\":", "\"mimeType\":null,\"mimeType\":", StringComparison.Ordinal)),
            "utf8" => [0xff, 0x7b, 0x7d],
            "surrogate" => Encoding.UTF8.GetBytes(text.Replace("image/png", "\\ud800", StringComparison.Ordinal)),
            "depth" => Encoding.UTF8.GetBytes(text.Replace("image/png", new string('[', 9), StringComparison.Ordinal).Replace("\"Title\"", new string('[', 9) + "0" + new string(']', 9), StringComparison.Ordinal)),
            _ => new byte[ArticlePackageManifestCandidateCodec.MaxJsonBytes + 1]
        };
        AssertAssetRootParseInvalid(json, fixture.Assets, fixture.Inventory);
    }

    [Theory]
    [InlineData("root")]
    [InlineData("collection")]
    [InlineData("asset")]
    [InlineData("reference")]
    public void AssetRoot_RejectsPrivateAndUnavailableAuthorityFieldsAtEveryNewLevel(string level)
    {
        var fixture = AssetRootFixture();
        var root = CreateAssetRoot(fixture.Articles, fixture.Assets, fixture.Inventory);
        byte[] encoded = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory);
        foreach (string key in new[] { "privacy", "rights", "storageKey", "ownerAdminPrincipalId", "futureField", "inventory" })
        {
            var json = JsonNode.Parse(encoded)!.AsObject();
            JsonObject target = level switch
            {
                "root" => json,
                "collection" => json["assets"]!.AsObject(),
                "asset" => json["assets"]!["assets"]![0]!.AsObject(),
                _ => json["assets"]!["references"]![0]!.AsObject()
            };
            target[key] = null;
            AssertAssetRootParseInvalid(JsonSerializer.SerializeToUtf8Bytes(json), fixture.Assets, fixture.Inventory);
        }
    }

    [Fact]
    public void AssetRoot_DoesNotOpenImportBytesOrZipAssetAuthority()
    {
        var fixture = AssetRootFixture();
        var root = CreateAssetRoot(fixture.Articles, fixture.Assets, fixture.Inventory);
        byte[] manifest = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory);
        byte[] png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZgAAAABJRU5ErkJggg==");
        var content = new[] { new ArticlePackageFileBytes("manifest.json", manifest) }
            .Concat(fixture.Articles.Select(article => new ArticlePackageFileBytes("articles/" + article.PortableArticle.FileNameToken + ".md", "line\r\n"u8.ToArray())))
            .Append(new ArticlePackageFileBytes(fixture.Assets.Assets[0].Metadata.PackagePath, png)).ToArray();
        var package = ArticlePackageImportCandidateByteTests.BuildPackage(content);
        Assert.True(ArticlePackageChecksums.Verify(package.Inventory, package.Files).IsValid);
        var result = ArticlePackageImportCandidateBytes.Validate(package.Inventory, package.Files, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        Assert.Equal("article_package_manifest_assets_authority_unavailable", result.ReasonCode);
        using var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, true))
        {
            foreach (var file in package.Files)
            {
                var entry = archive.CreateEntry(file.Path, CompressionLevel.NoCompression);
                entry.ExternalAttributes = 0;
                entry.LastWriteTime = new DateTimeOffset(2026, 10, 8, 1, 2, 4, TimeSpan.Zero);
                using var output = entry.Open();
                output.Write(file.Bytes.Span);
            }
        }
        result = ArticlePackageImportZipCandidateReader.TryReadCandidate(stream.ToArray(), out var zip);
        Assert.False(result.IsValid);
        Assert.Null(zip);
        Assert.Equal("article_package_manifest_assets_authority_unavailable", result.ReasonCode);
    }

    [Fact]
    public void PropertyRoot_DoesNotOpenImportBytesOrZipAssetAuthority()
    {
        var fixture = PropertyRootFixture();
        var root = CreatePropertyRoot(fixture.Articles, fixture.Assets, fixture.Inventory, fixture.Properties);
        byte[] manifest = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, fixture.Properties);
        byte[] png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZgAAAABJRU5ErkJggg==");
        var content = new[] { new ArticlePackageFileBytes("manifest.json", manifest) }
            .Concat(fixture.Articles.Select(article => new ArticlePackageFileBytes("articles/" + article.PortableArticle.FileNameToken + ".md", "line\r\n"u8.ToArray())))
            .Append(new ArticlePackageFileBytes(fixture.Assets.Assets[0].Metadata.PackagePath, png)).ToArray();
        var package = ArticlePackageImportCandidateByteTests.BuildPackage(content);
        Assert.True(ArticlePackageChecksums.Verify(package.Inventory, package.Files).IsValid);
        var result = ArticlePackageImportCandidateBytes.Validate(package.Inventory, package.Files, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        Assert.Equal("article_package_manifest_assets_authority_unavailable", result.ReasonCode);
        using var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, true))
        {
            foreach (var file in package.Files)
            {
                var entry = archive.CreateEntry(file.Path, CompressionLevel.NoCompression);
                entry.ExternalAttributes = 0;
                entry.LastWriteTime = new DateTimeOffset(2026, 10, 8, 1, 2, 4, TimeSpan.Zero);
                using var output = entry.Open();
                output.Write(file.Bytes.Span);
            }
        }
        result = ArticlePackageImportZipCandidateReader.TryReadCandidate(stream.ToArray(), out var zip);
        Assert.False(result.IsValid);
        Assert.Null(zip);
        Assert.Equal("article_package_manifest_assets_authority_unavailable", result.ReasonCode);
    }

    [Fact]
    public void AssetRoot_EnforcesCombinedSixteenMiBAtExactEncodedBoundary()
    {
        var fixture = AssetRootFixture();
        var articles = Enumerable.Range(1, 1000).Select(NumberedArticle).ToArray();
        var metadata = Enumerable.Range(1, 12000).Select(index =>
        {
            Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Asset,
                $"portable-asset:{index:x8}-0000-4000-8000-000000000001", out var identity).IsValid);
            return fixture.Assets.Assets[0].Metadata with
            {
                PortableAsset = identity,
                SourceAssetId = $"{index:x8}-0000-4000-8000-000000000002",
                PackagePath = "assets/" + identity.FileNameToken + ".png"
            };
        }).ToArray();
        var references = metadata.Select(asset => new ArticlePackageManifestAssetReference(articles[0].PortableArticle, asset.PortableAsset)).ToArray();
        var inventory = new[] { Entry("manifest.json", 1), Entry("checksums.json", 1) }
            .Concat(articles.Select(article => Entry("articles/" + article.PortableArticle.FileNameToken + ".md", article.SourceBytes.ByteLength)))
            .Concat(metadata.Select(asset => Entry(asset.PackagePath, asset.SizeBytes))).ToArray();
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate(metadata, references, inventory, out var assets).IsValid);
        byte[] component = ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(assets!);
        Assert.True(component.Length < ArticlePackageManifestCandidateCodec.MaxJsonBytes);
        var baseline = CreateAssetRoot(articles, assets!, inventory);
        int remaining = ArticlePackageManifestCandidateCodec.MaxJsonBytes
            - ArticlePackageManifestCandidateCodec.WriteCandidate(baseline, assets, inventory).Length;
        Assert.True(remaining > 0);
        for (int index = 0; remaining > 0; index++)
        {
            int added = Math.Min(remaining, ArticlePackageTitleSummaryLimits.MaxCanonicalTextCodeUnits - articles[index].Title.Length - 1);
            articles[index] = articles[index] with
            {
                Title = articles[index].Title + new string('x', added)
            };
            remaining -= added;
        }
        var exact = CreateAssetRoot(articles, assets!, inventory);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(exact, assets, inventory);
        Assert.Equal(ArticlePackageManifestCandidateCodec.MaxJsonBytes, bytes.Length);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(bytes, assets, inventory, out _).IsValid);
        articles[^1] = articles[^1] with
        {
            Title = articles[^1].Title + "x"
        };
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, out _).IsValid);
        var result = ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, assets, inventory, out var over);
        Assert.False(result.IsValid);
        Assert.Null(over);
        Assert.Equal("article_package_manifest_document_budget_exceeded", result.ReasonCode);
    }

    [Fact]
    public void PropertyRoot_RoundTripsActualEightTypeMapperPayloadsAndIndependentSeal()
    {
        var fixture = PropertyRootFixture();
        var root = CreatePropertyRoot(fixture.Articles, fixture.Assets, fixture.Inventory, fixture.Properties);
        Assert.Equal(3, root.SchemaVersion);
        Assert.Equal(IndependentAssetRootDigest(root, withProperties: true), root.SemanticDigest);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, fixture.Properties);
        using JsonDocument document = JsonDocument.Parse(bytes);
        Assert.Equal(new[] { "schemaVersion", "canonicalHashVersion", "propertySchemaVersion", "articles", "assets", "properties", "semanticDigest" },
            document.RootElement.EnumerateObject().Select(property => property.Name));
        foreach (var row in document.RootElement.GetProperty("properties").EnumerateArray())
        {
            var property = row.GetProperty("property");
            Assert.Equal(11, property.GetProperty("properties").GetArrayLength());
            JsonObject payload = JsonNode.Parse(property.GetRawText())!.AsObject();
            string digest = payload["componentDigest"]!.GetValue<string>();
            payload.Remove("componentDigest");
            byte[] preimage = Encoding.UTF8.GetBytes("fsusblog.article-package.manifest-property-candidate.v1\0" + payload.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
            Assert.Equal(digest, Convert.ToHexStringLower(SHA256.HashData(preimage)));
        }
        for (int attempt = 0; attempt < 3; attempt++)
        {
            var result = ArticlePackageManifestCandidateCodec.TryParseCandidate(bytes, fixture.Assets, fixture.Inventory, fixture.Properties, out var parsed);
            Assert.True(result.IsValid, result.ReasonCode);
            Assert.Equal(root.SemanticDigest, parsed!.SemanticDigest);
            Assert.Equal(bytes, ArticlePackageManifestCandidateCodec.WriteCandidate(parsed, fixture.Assets, fixture.Inventory, fixture.Properties));
            foreach (var row in parsed.Properties!)
            {
                var actual = fixture.Properties.Single(value => value.PortableArticle == row.PortableArticle);
                Assert.Equal(ArticlePackageManifestCandidateCodec.WritePropertyCandidate(actual.Property), ArticlePackageManifestCandidateCodec.WritePropertyCandidate(row.Property));
                var values = row.Property.Mapping.Properties;
                Assert.False(Assert.IsType<ArticlePropertyBooleanValue>(Assert.IsType<ArticlePackagePrimitivePropertyProjection>(values[2].Projection).Value).Boolean);
                Assert.Equal(0, Assert.IsType<ArticlePropertyNumberValue>(Assert.IsType<ArticlePackagePrimitivePropertyProjection>(values[1].Projection).Value).Number);
                Assert.Equal(ArticlePropertyValuePresence.Missing, values[8].Presence);
                Assert.Equal(ArticlePropertyValuePresence.Null, values[9].Presence);
                Assert.True(values[10].DefaultApplied);
                Assert.Null(values[8].Projection);
                Assert.Null(values[9].Projection);
                Assert.Equal("", Assert.IsType<ArticlePropertyTextValue>(Assert.IsType<ArticlePackagePrimitivePropertyProjection>(values[0].Projection).Value).Text);
                Assert.Equal("article_package_manifest_property_persisted_definition_authority_unavailable", row.Property.RequirePropertyAuthority().ReasonCode);
            }
            Assert.Equal("article_package_manifest_asset_rights_retention_authority_unavailable", parsed.Assets!.RequireAssetAuthority().ReasonCode);
        }
        Assert.False(ArticlePackageManifestCandidateCodec.TryParseCandidate(bytes, fixture.Assets, fixture.Inventory, out _).IsValid);
        Assert.False(ArticlePackageManifestCandidateCodec.TryParseCandidate(bytes, out _).IsValid);
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory));
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(root));
    }

    [Fact]
    public void PropertyRoot_MissingNullAndEmptyComponentsNeverBecomeEmptySnapshots()
    {
        var fixture = PropertyRootFixture();
        var root = CreatePropertyRoot(fixture.Articles, fixture.Assets, fixture.Inventory, fixture.Properties);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, fixture.Properties);
        foreach (var properties in new IReadOnlyList<ArticlePackageManifestArticleProperty>?[] { null, [], [null!] })
        {
            Assert.False(ArticlePackageManifestCandidateCodec.TryCreateCandidate(fixture.Articles, fixture.Assets, fixture.Inventory, properties, out var missing).IsValid);
            Assert.Null(missing);
            AssertPropertyRootParseInvalid(bytes, fixture.Assets, fixture.Inventory, properties);
            Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, properties));
        }
        foreach (string field in new[] { "missing", "null", "empty" })
        {
            var json = JsonNode.Parse(bytes)!.AsObject();
            if (field == "missing")
            {
                json.Remove("properties");
            }
            else
            {
                json["properties"] = field == "null" ? null : new JsonArray();
            }
            AssertPropertyRootParseInvalid(JsonSerializer.SerializeToUtf8Bytes(json), fixture.Assets, fixture.Inventory, fixture.Properties);
        }
        var empty = PropertyRootFixture(empty: true);
        var emptyRoot = CreatePropertyRoot(empty.Articles, empty.Assets, empty.Inventory, empty.Properties);
        byte[] encoded = ArticlePackageManifestCandidateCodec.WriteCandidate(emptyRoot, empty.Assets, empty.Inventory, empty.Properties);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(encoded, empty.Assets, empty.Inventory, empty.Properties, out var parsed).IsValid);
        Assert.All(parsed!.Properties!, row => Assert.Empty(row.Property.Mapping.Properties));
        Assert.NotEqual(root.SemanticDigest, emptyRoot.SemanticDigest);
    }

    [Theory]
    [InlineData("articleId")]
    [InlineData("siteScope")]
    [InlineData("articleRevisionId")]
    [InlineData("propertyRevision")]
    [InlineData("draftId")]
    [InlineData("draftServerRevision")]
    [InlineData("publicationId")]
    [InlineData("snapshotDigest")]
    [InlineData("mappingDigest")]
    public void PropertyRoot_RejectsEverySourceCoordinateAndDigestMismatch(string field)
    {
        var fixture = PropertyRootFixture();
        var articles = fixture.Articles.ToArray();
        var source = articles[0].Source;
        articles[0] = articles[0] with
        {
            Source = field switch
            {
                "articleId" => source with { ArticleId = 100 },
                "siteScope" => source with { SiteScope = "other-site" },
                "articleRevisionId" => source with { ArticleRevisionId = 100 },
                "propertyRevision" => source with { PropertyRevision = 100 },
                "draftId" => source with { DraftId = 10, DraftServerRevision = 5 },
                "draftServerRevision" => source with { DraftId = 10, DraftServerRevision = 6 },
                "publicationId" => source with { PublicationId = 100 },
                _ => source
            },
            PropertySnapshotDigest = field == "snapshotDigest" ? new string('e', 64) : articles[0].PropertySnapshotDigest,
            PropertyMappingDigest = field == "mappingDigest" ? new string('e', 64) : articles[0].PropertyMappingDigest
        };
        var result = ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, fixture.Assets, fixture.Inventory, fixture.Properties, out var rejected);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_manifest_property_root_source_mismatch", result.ReasonCode);
        Assert.Null(rejected);
    }

    [Theory]
    [InlineData("duplicate")]
    [InlineData("missing")]
    [InlineData("foreign")]
    [InlineData("swapped")]
    [InlineData("null")]
    public void PropertyRoot_RejectsForeignDuplicateOrMisassociatedArticleComponents(string change)
    {
        var fixture = PropertyRootFixture();
        var properties = fixture.Properties.ToArray();
        properties = change switch
        {
            "duplicate" => [properties[0], properties[0]],
            "missing" => [properties[0]],
            "foreign" => [properties[0] with { PortableArticle = NumberedArticle(99).PortableArticle }, properties[1]],
            "swapped" => [properties[0] with { Property = properties[1].Property }, properties[1] with { Property = properties[0].Property }],
            _ => [properties[0] with { Property = null! }, properties[1]]
        };
        var root = CreatePropertyRoot(fixture.Articles, fixture.Assets, fixture.Inventory, fixture.Properties);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, fixture.Properties);
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateCandidate(fixture.Articles, fixture.Assets, fixture.Inventory, properties, out var rejected).IsValid);
        Assert.Null(rejected);
        AssertPropertyRootParseInvalid(bytes, fixture.Assets, fixture.Inventory, properties);
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, properties));
    }

    [Fact]
    public void PropertyRoot_ClosesPortableReferenceEndpointsAndRetainsFullOptionalCoordinates()
    {
        var foreign = PropertyRootFixture(referenceArticle: 99);
        var result = ArticlePackageManifestCandidateCodec.TryCreateCandidate(foreign.Articles, foreign.Assets, foreign.Inventory, foreign.Properties, out var rejected);
        Assert.Equal("article_package_manifest_property_root_reference_mismatch", result.ReasonCode);
        Assert.Null(rejected);
        foreach (bool draft in new[] { false, true })
        {
            var fixture = PropertyRootFixture(draft: draft, publication: !draft);
            var root = CreatePropertyRoot(fixture.Articles, fixture.Assets, fixture.Inventory, fixture.Properties);
            byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, fixture.Properties);
            Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(bytes, fixture.Assets, fixture.Inventory, fixture.Properties, out var parsed).IsValid);
            Assert.All(parsed!.Properties!, row => Assert.Equal(fixture.Properties.Single(value => value.PortableArticle == row.PortableArticle).Property.Mapping.SourceCoordinates,
                row.Property.Mapping.SourceCoordinates));
        }
    }

    [Theory]
    [InlineData("value")]
    [InlineData("owner")]
    [InlineData("default")]
    public void PropertyRoot_ResealedRealMapperReplacementCannotSubstituteExternalComponent(string change)
    {
        var fixture = PropertyRootFixture();
        var replacement = PropertyRootFixture(changedBoolean: change == "value", owner: change == "owner" ? 43 : 42, changedDefault: change == "default");
        var original = CreatePropertyRoot(fixture.Articles, fixture.Assets, fixture.Inventory, fixture.Properties);
        var changed = CreatePropertyRoot(replacement.Articles, replacement.Assets, replacement.Inventory, replacement.Properties);
        Assert.NotEqual(original.SemanticDigest, changed.SemanticDigest);
        Assert.Equal(IndependentAssetRootDigest(changed, withProperties: true), changed.SemanticDigest);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(changed, replacement.Assets, replacement.Inventory, replacement.Properties);
        AssertPropertyRootParseInvalid(bytes, fixture.Assets, fixture.Inventory, fixture.Properties);
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(original, fixture.Assets, fixture.Inventory, replacement.Properties));
    }

    [Theory]
    [InlineData("projection")]
    [InlineData("componentDigest")]
    [InlineData("semanticDigest")]
    [InlineData("mappingDigest")]
    [InlineData("snapshotDigest")]
    [InlineData("owner")]
    [InlineData("unknown")]
    [InlineData("private")]
    [InlineData("missingPresence")]
    [InlineData("nullDefault")]
    [InlineData("duplicate")]
    [InlineData("duplicateArticle")]
    public void PropertyRoot_RejectsPayloadRootAndClosedSchemaTamper(string change)
    {
        var fixture = PropertyRootFixture();
        var root = CreatePropertyRoot(fixture.Articles, fixture.Assets, fixture.Inventory, fixture.Properties);
        var json = JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, fixture.Properties))!.AsObject();
        var component = json["properties"]![0]!["property"]!.AsObject();
        switch (change)
        {
            case "projection":
                component["properties"]![2]!["projection"]!["value"] = true;
                break;
            case "componentDigest":
                component["componentDigest"] = new string('0', 64);
                break;
            case "semanticDigest":
                json["semanticDigest"] = new string('0', 64);
                break;
            case "mappingDigest":
                component["mappingDigest"] = new string('0', 64);
                break;
            case "snapshotDigest":
                component["sourceSnapshotDigest"] = new string('0', 64);
                break;
            case "owner":
                component["sourceCoordinates"]!["definitionOwnerUserId"] = 43;
                break;
            case "unknown":
                component["future"] = null;
                break;
            case "private":
                component["properties"]![0]!["token"] = "private";
                break;
            case "missingPresence":
                component["properties"]![8]!.AsObject().Remove("presence");
                break;
            case "nullDefault":
                component["properties"]![10]!["defaultApplied"] = null;
                break;
            case "duplicate":
                json["properties"]![1] = json["properties"]![0]!.DeepClone();
                break;
            case "duplicateArticle":
                json["articles"]![1] = json["articles"]![0]!.DeepClone();
                break;
        }
        AssertPropertyRootParseInvalid(JsonSerializer.SerializeToUtf8Bytes(json), fixture.Assets, fixture.Inventory, fixture.Properties);
    }

    [Fact]
    public void PropertyRoot_RechecksForgedComponentSealAndOwnedPayloadBeforeEmission()
    {
        var fixture = PropertyRootFixture();
        var root = CreatePropertyRoot(fixture.Articles, fixture.Assets, fixture.Inventory, fixture.Properties);
        var flags = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;
        var constructor = Assert.Single(typeof(ArticlePackageManifestPropertyCandidate).GetConstructors(flags));
        var forged = (ArticlePackageManifestPropertyCandidate)constructor.Invoke([fixture.Properties[0].Property.Mapping, new string('0', 64)]);
        var properties = fixture.Properties.ToArray();
        properties[0] = properties[0] with
        {
            Property = forged
        };
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateCandidate(fixture.Articles, fixture.Assets, fixture.Inventory, properties, out _).IsValid);
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, properties));
        typeof(ArticlePackageManifestCandidate).GetProperty("Properties")!.SetValue(root, Array.AsReadOnly(properties));
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, fixture.Properties));
    }

    [Fact]
    public void PropertyRoot_FreezesBoundedInputAndCanonicalizesComponentOrder()
    {
        var fixture = PropertyRootFixture();
        var input = fixture.Properties.Reverse().ToArray();
        var list = new RootIndexList<ArticlePackageManifestArticleProperty>(input);
        var root = CreatePropertyRoot(fixture.Articles.Reverse().ToArray(), fixture.Assets, fixture.Inventory, list);
        Assert.Equal(1, list.CountReads);
        Assert.Equal(2, list.IndexReads);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, fixture.Properties);
        input[0] = null!;
        Assert.Equal(bytes, ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, fixture.Properties));
        Assert.Throws<NotSupportedException>(() => ((IList<ArticlePackageManifestArticleProperty>)root.Properties!)[0] = fixture.Properties[1]);
        var json = JsonNode.Parse(bytes)!.AsObject();
        json["properties"] = new JsonArray(json["properties"]!.AsArray().Reverse().Select(value => value!.DeepClone()).ToArray());
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(JsonSerializer.SerializeToUtf8Bytes(json), fixture.Assets, fixture.Inventory, fixture.Properties, out var parsed).IsValid);
        Assert.Equal(bytes, ArticlePackageManifestCandidateCodec.WriteCandidate(parsed!, fixture.Assets, fixture.Inventory, fixture.Properties));
    }

    [Theory]
    [InlineData("depth")]
    [InlineData("duplicateKey")]
    [InlineData("utf8")]
    [InlineData("surrogate")]
    [InlineData("version")]
    public void PropertyRoot_RejectsDepthEncodingDuplicateKeysAndWrongTuple(string change)
    {
        var fixture = PropertyRootFixture();
        var root = CreatePropertyRoot(fixture.Articles, fixture.Assets, fixture.Inventory, fixture.Properties);
        string text = Encoding.UTF8.GetString(ArticlePackageManifestCandidateCodec.WriteCandidate(root, fixture.Assets, fixture.Inventory, fixture.Properties));
        byte[] bytes = change switch
        {
            "depth" => Encoding.UTF8.GetBytes(text.Insert(1, "\"extra\":[[[[[[[[[]]]]]]]]],")),
            "duplicateKey" => Encoding.UTF8.GetBytes(text.Replace("\"definitionOwnerUserId\":42", "\"definitionOwnerUserId\":42,\"definitionOwnerUserId\":42", StringComparison.Ordinal)),
            "utf8" => [.. Encoding.UTF8.GetBytes(text), 0xff],
            "surrogate" => Encoding.UTF8.GetBytes(text.Replace("\"site\"", "\"\\ud800\"", StringComparison.Ordinal)),
            _ => Encoding.UTF8.GetBytes(text.Replace("\"schemaVersion\":3", "\"schemaVersion\":2", StringComparison.Ordinal))
        };
        AssertPropertyRootParseInvalid(bytes, fixture.Assets, fixture.Inventory, fixture.Properties);
    }

    [Fact]
    public void PropertyRoot_EnforcesCombinedExactSixteenMiBWithoutChangingDepthOrComponentBudgets()
    {
        var articles = Enumerable.Range(1, 100).Select(NumberedArticle).ToArray();
        var properties = articles.Select(article => MapRootProperty(article, [RootPropertyEntry(1, new ArticlePropertyTextValue(new string('界', 16384)))])).ToArray();
        for (int index = 0; index < articles.Length; index++)
        {
            articles[index] = BindRootProperty(articles[index], properties[index]);
            Assert.True(ArticlePackageManifestCandidateCodec.WritePropertyCandidate(properties[index].Property).Length < ArticlePackageManifestCandidateCodec.MaxJsonBytes);
        }
        var inventory = new[] { Entry("manifest.json", 1), Entry("checksums.json", 1) }
            .Concat(articles.Select(article => Entry("articles/" + article.PortableArticle.FileNameToken + ".md", article.SourceBytes.ByteLength))).ToArray();
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate([], [], inventory, out var assets).IsValid);
        var baseline = CreatePropertyRoot(articles, assets!, inventory, properties);
        int remaining = ArticlePackageManifestCandidateCodec.MaxJsonBytes - ArticlePackageManifestCandidateCodec.WriteCandidate(baseline, assets, inventory, properties).Length;
        Assert.True(remaining > 0);
        for (int index = 0; remaining > 0; index++)
        {
            int added = Math.Min(remaining, ArticlePackageTitleSummaryLimits.MaxCanonicalTextCodeUnits - articles[index].Title.Length - 1);
            articles[index] = articles[index] with
            {
                Title = articles[index].Title + new string('x', added)
            };
            remaining -= added;
        }
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, assets, inventory, out _).IsValid);
        var exact = CreatePropertyRoot(articles, assets!, inventory, properties);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WriteCandidate(exact, assets, inventory, properties);
        Assert.Equal(ArticlePackageManifestCandidateCodec.MaxJsonBytes, bytes.Length);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(bytes, assets, inventory, properties, out _).IsValid);
        AssertPropertyRootParseInvalid([.. bytes, (byte)' '], assets, inventory, properties, "article_package_manifest_document_budget_exceeded");
        articles[^1] = articles[^1] with
        {
            Title = articles[^1].Title + "x"
        };
        var result = ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, assets, inventory, properties, out var over);
        Assert.False(result.IsValid);
        Assert.Null(over);
        Assert.Equal("article_package_manifest_document_budget_exceeded", result.ReasonCode);
        var constructor = Assert.Single(typeof(ArticlePackageManifestCandidate).GetConstructors(System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance));
        var forged = (ArticlePackageManifestCandidate)constructor.Invoke([articles, exact.SemanticDigest]);
        typeof(ArticlePackageManifestCandidate).GetProperty("Assets")!.SetValue(forged, assets);
        typeof(ArticlePackageManifestCandidate).GetProperty("Properties")!.SetValue(forged, exact.Properties);
        Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(forged, assets, inventory, properties));
    }

    private static (ArticlePackageManifestArticle[] Articles, ArticlePackageManifestAssetCollectionCandidate Assets,
        ArticlePackageInventoryEntry[] Inventory, ArticlePackageManifestArticleProperty[] Properties) PropertyRootFixture(
        bool empty = false, int referenceArticle = 2, bool changedBoolean = false, long? owner = 42,
        bool draft = false, bool publication = false, bool changedDefault = false)
    {
        var fixture = AssetRootFixture();
        var articles = fixture.Articles.Select(article => article with
        {
            Source = article.Source with
            {
                DraftId = draft ? 10 : null,
                DraftServerRevision = draft ? 5 : null,
                PublicationId = publication ? 11 : null
            }
        }).ToArray();
        ArticlePropertyValueEntry[] values = empty ? [] : [
            RootPropertyEntry(1, new ArticlePropertyTextValue("")), RootPropertyEntry(2, new ArticlePropertyNumberValue(0)),
            RootPropertyEntry(3, new ArticlePropertyBooleanValue(changedBoolean)), RootPropertyEntry(4, new ArticlePropertyDateValue(new(2026, 10, 18, 0, 0, 0, DateTimeKind.Utc))),
            RootPropertyEntry(5, new ArticlePropertySingleSelectValue(RootPropertyId(101))), RootPropertyEntry(6, new ArticlePropertyMultiSelectValue([RootPropertyId(101), RootPropertyId(102)])),
            RootPropertyEntry(7, new ArticlePropertyArticleReferenceValue([referenceArticle])), RootPropertyEntry(8, new ArticlePropertyUrlValue("https://example.com/exact")),
            RootPropertyEntry(9, null, ArticlePropertyValuePresence.Missing), RootPropertyEntry(10, null, ArticlePropertyValuePresence.Null),
            RootPropertyEntry(11, new ArticlePropertyTextValue("default"), defaultApplied: !changedDefault)
        ];
        var properties = articles.Select(article => MapRootProperty(article, values, owner)).ToArray();
        for (int index = 0; index < articles.Length; index++)
        {
            articles[index] = BindRootProperty(articles[index], properties[index]);
        }
        return (articles, fixture.Assets, fixture.Inventory, properties);
    }

    private static ArticlePackageManifestArticle BindRootProperty(ArticlePackageManifestArticle article, ArticlePackageManifestArticleProperty property)
        => article with
        {
            PropertySnapshotDigest = property.Property.Mapping.SourceSnapshotDigest,
            PropertyMappingDigest = property.Property.Mapping.MappingDigest
        };

    private static ArticlePackageManifestArticleProperty MapRootProperty(ArticlePackageManifestArticle article, ArticlePropertyValueEntry[] values, long? owner = 42)
    {
        var source = article.Source;
        var coordinates = new ArticlePropertySnapshotCoordinates(owner, source.SiteScope, source.ArticleId, source.PropertyRevision,
            source.ArticleRevisionId, source.DraftId, source.DraftServerRevision, source.PublicationId);
        var snapshot = new ArticlePropertyValueSnapshot(1, coordinates, values, ArticlePropertyValueDigest.ComputeSnapshot(coordinates, values));
        var definitions = values.Select((value, index) => new ArticlePackagePropertyDefinitionBinding(value.DefinitionId, value.DefinitionSchemaRevision,
            value.DefinitionDigest, RootPropertyIdentity(ArticlePackageIdentityKind.Definition, index + 1))).ToArray();
        var options = values.SelectMany((value, index) => RootOptionIds(value.Value).Select((option, optionIndex) => new ArticlePackagePropertyOptionBinding(value.DefinitionId, option,
            RootPropertyIdentity(ArticlePackageIdentityKind.Option, index * 1000 + optionIndex + 1)))).ToArray();
        var references = values.SelectMany(value => value.Value is ArticlePropertyArticleReferenceValue reference ? reference.ArticleIds : [])
            .Distinct().Select(id => new ArticlePackagePropertyArticleBinding(id, NumberedArticle(checked((int)id)).PortableArticle,
                new ArticleRelationTargetFacts(new ArticleRelationTargetIdentity(NumberedArticle(checked((int)id)).PortableArticle.Value!, ArticleRelationTargetKind.Article, null, null),
                    "revision:" + id, 1, ArticleRelationRevisionKind.Current, ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed))).ToArray();
        var bindings = new ArticlePackagePropertyMappingBindings(coordinates, snapshot.ContentDigest, definitions, options, references);
        var result = ArticlePackagePropertyMapper.TryMapCandidate(snapshot, bindings, out var mapping);
        Assert.True(result.IsValid, result.ReasonCode);
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreatePropertyCandidate(mapping, out var property).IsValid);
        Assert.True(ArticlePackageManifestPropertyBinder.TryBindCandidate(property, snapshot, bindings, out _).IsValid);
        return new(article.PortableArticle, property!);
    }

    private static ArticlePropertyValueEntry RootPropertyEntry(int index, ArticlePropertyTypedValue? value,
        ArticlePropertyValuePresence presence = ArticlePropertyValuePresence.Present, bool defaultApplied = false)
    {
        var input = new ArticlePropertyValueInput(RootPropertyId(index), 1, new string('a', 64), presence, value);
        return new(input.DefinitionId, input.DefinitionSchemaRevision, input.DefinitionDigest, presence, value,
            ArticlePropertyValueDigest.ComputeValue(input, defaultApplied), defaultApplied);
    }

    private static IEnumerable<Guid> RootOptionIds(ArticlePropertyTypedValue? value)
        => value switch
        {
            ArticlePropertySingleSelectValue single => [single.OptionId],
            ArticlePropertyMultiSelectValue multiple => multiple.OptionIds,
            _ => []
        };

    private static Guid RootPropertyId(int index) => Guid.Parse($"20000000-0000-4000-8000-{index:x12}");

    private static ArticlePackageIdentity RootPropertyIdentity(ArticlePackageIdentityKind kind, int index)
    {
        Assert.True(ArticlePackageIdentity.TryCreate(kind, (kind == ArticlePackageIdentityKind.Definition ? "portable-definition:" : "portable-option:") + RootPropertyId(index).ToString("D"), out var identity).IsValid);
        return identity;
    }

    private static ArticlePackageManifestCandidate CreatePropertyRoot(IReadOnlyList<ArticlePackageManifestArticle> articles,
        ArticlePackageManifestAssetCollectionCandidate assets, IReadOnlyList<ArticlePackageInventoryEntry> inventory,
        IReadOnlyList<ArticlePackageManifestArticleProperty> properties)
    {
        var result = ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, assets, inventory, properties, out var root);
        Assert.True(result.IsValid, result.ReasonCode);
        return root!;
    }

    private static void AssertPropertyRootParseInvalid(byte[] bytes, ArticlePackageManifestAssetCollectionCandidate? assets,
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory, IReadOnlyList<ArticlePackageManifestArticleProperty>? properties, string? reason = null)
    {
        var result = ArticlePackageManifestCandidateCodec.TryParseCandidate(bytes, assets, inventory, properties, out var parsed);
        Assert.False(result.IsValid);
        Assert.Null(parsed);
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
    }

    private static (ArticlePackageManifestArticle[] Articles, ArticlePackageManifestAssetCollectionCandidate Assets, ArticlePackageInventoryEntry[] Inventory) AssetRootFixture()
    {
        ArticlePackageManifestArticle[] articles = [NumberedArticle(1), NumberedArticle(2)];
        byte[] bytes = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZgAAAABJRU5ErkJggg==");
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Asset, "portable-asset:00000004-0000-4000-8000-000000000001", out var asset).IsValid);
        var record = new AssetRecord(AssetId.Parse("00000005-0000-4000-8000-000000000001"), "public", AssetStorageKey.Parse("content/public/example.png"),
            "image/png", ".png", bytes.Length, Convert.ToHexStringLower(SHA256.HashData(bytes)), 1, 1, 9,
            ContentAssetState.Active, new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero), new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero));
        ArticlePackageInventoryEntry[] inventory = [Entry("manifest.json", 1), Entry("checksums.json", 1),
            Entry("articles/" + articles[0].PortableArticle.FileNameToken + ".md", articles[0].SourceBytes.ByteLength),
            Entry("articles/" + articles[1].PortableArticle.FileNameToken + ".md", articles[1].SourceBytes.ByteLength),
            Entry("assets/" + asset.FileNameToken + ".png", bytes.Length)];
        var references = articles.Select(article => new ArticlePackageManifestAssetReference(article.PortableArticle, asset)).ToArray();
        var result = ArticlePackageAssetCollectionMapper.TryMapCandidate([new(asset, record, bytes)], references, inventory, out var mapped);
        Assert.True(result.IsValid, result.ReasonCode);
        return (articles, mapped!, inventory);
    }

    private static ArticlePackageInventoryEntry Entry(string path, long bytes)
        => new(path, ArticlePackageEntryKind.RegularFile, bytes, bytes);

    private static ArticlePackageManifestCandidate CreateAssetRoot(IReadOnlyList<ArticlePackageManifestArticle> articles,
        ArticlePackageManifestAssetCollectionCandidate assets, IReadOnlyList<ArticlePackageInventoryEntry> inventory)
    {
        var result = ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, assets, inventory, out var root);
        Assert.True(result.IsValid, result.ReasonCode);
        return root!;
    }

    private static void AssertAssetRootParseInvalid(byte[] bytes, ArticlePackageManifestAssetCollectionCandidate? assets,
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory, string? reason = null)
    {
        var result = ArticlePackageManifestCandidateCodec.TryParseCandidate(bytes, assets, inventory, out var parsed);
        Assert.False(result.IsValid);
        Assert.Null(parsed);
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
    }

    // Independent little-endian v2 preimage writer; no codec digest or serializer is called.
    private static string IndependentAssetRootDigest(ArticlePackageManifestCandidate root, bool withProperties = false)
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, new UTF8Encoding(false, true), true);
        void Text(string text)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            writer.Write(bytes.Length);
            writer.Write(bytes);
        }
        void NullableText(string? text)
        {
            writer.Write(text is null ? 0 : 1);
            if (text is not null)
            {
                Text(text);
            }
        }
        void NullableLong(long? value)
        {
            writer.Write(value.HasValue ? 1 : 0);
            if (value.HasValue)
            {
                writer.Write(value.Value);
            }
        }
        Text(withProperties ? "fsusblog.article-package.manifest-candidate.v3" : "fsusblog.article-package.manifest-candidate.v2");
        writer.Write(withProperties ? 3 : 2);
        writer.Write(1);
        writer.Write(1);
        writer.Write(root.Articles.Count);
        foreach (var article in root.Articles.OrderBy(article => article.PortableArticle.Value, StringComparer.Ordinal))
        {
            Text(article.PortableArticle.Value!);
            writer.Write(article.Source.ArticleId);
            writer.Write(article.Source.ArticleRevisionId);
            writer.Write(article.Source.RevisionNo);
            Text(article.Source.CanonicalHash);
            Text(article.Source.SiteScope);
            writer.Write(article.Source.PropertyRevision);
            NullableLong(article.Source.DraftId);
            NullableLong(article.Source.DraftServerRevision);
            NullableLong(article.Source.PublicationId);
            Text(article.Title);
            NullableText(article.Summary);
            Text(article.TitleSummaryDigest);
            Text(article.PropertySnapshotDigest);
            Text(article.PropertyMappingDigest);
            var bytes = article.SourceBytes;
            writer.Write(bytes.ByteLength);
            Text(bytes.Sha256);
            writer.Write(bytes.HasUtf8Bom ? 1 : 0);
            writer.Write(bytes.LfCount);
            writer.Write(bytes.CrLfCount);
            writer.Write(bytes.BareCrCount);
            writer.Write((int)bytes.FinalNewline);
            writer.Write(bytes.TrailingSpaceCount);
            writer.Write(bytes.TrailingTabCount);
            writer.Write(article.Lifecycle.Status);
            NullableText(article.Lifecycle.PublishedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", System.Globalization.CultureInfo.InvariantCulture));
            NullableText(article.Lifecycle.ScheduledPublishAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", System.Globalization.CultureInfo.InvariantCulture));
        }
        Text(root.Assets!.ComponentDigest);
        if (withProperties)
        {
            writer.Write(root.Properties!.Count);
            foreach (var row in root.Properties)
            {
                Text(row.PortableArticle.Value!);
                Text(row.Property.ComponentDigest);
            }
        }
        writer.Flush();
        return Convert.ToHexStringLower(SHA256.HashData(stream.ToArray()));
    }

    private sealed class RootIndexList<T>(T[] values, bool failIndex = false) : IReadOnlyList<T>
    {
        public int CountReads
        {
            get;
            private set;
        }
        public int IndexReads
        {
            get;
            private set;
        }
        public int Count => ++CountReads == 1 ? values.Length : int.MaxValue;
        public T this[int index]
        {
            get
            {
                IndexReads++;
                return failIndex ? throw new IndexOutOfRangeException() : values[index];
            }
        }
        public IEnumerator<T> GetEnumerator() => throw new InvalidOperationException("enumeration_forbidden");
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }


    private static ArticlePackageManifestArticle Article()
    {
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article, "article:" + Token, out var identity).IsValid);
        Assert.True(ArticlePackageSourceBytes.Inspect("line\r\n"u8, out var bytes).IsValid);
        return new(identity, new(1, 11, 2, new string('a', 64), "site", 4, null, null, null),
            "Title", null, new string('b', 64), new string('c', 64), new string('d', 64), bytes!, new(0, null, null));
    }

    private static ArticlePackageManifestArticle NumberedArticle(int index)
    {
        ArticlePackageManifestArticle article = Article();
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article,
            $"article:{index:x8}-0000-4000-8000-000000000001", out var identity).IsValid);
        return article with
        {
            PortableArticle = identity,
            Source = article.Source with
            {
                ArticleId = index
            }
        };
    }

    private static ArticlePackageManifestCandidate Create(IReadOnlyList<ArticlePackageManifestArticle> articles)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return candidate!;
    }

    private static JsonObject Document()
        => JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteCandidate(Create([Article()])))!.AsObject();

    private static JsonObject ObjectAt(JsonObject root, string level)
        => level switch
        {
            "root" => root,
            "article" => root["articles"]![0]!.AsObject(),
            _ => root["articles"]![0]![level]!.AsObject()
        };

    private static void AssertInvalidCreate(IReadOnlyList<ArticlePackageManifestArticle>? articles, string? reason = null)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        Assert.NotNull(result.ReasonCode);
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
    }

    private static void AssertInvalidParse(JsonObject document, string reason)
        => AssertInvalidParse(JsonSerializer.SerializeToUtf8Bytes(document), reason);

    private static void AssertInvalidParse(byte[] bytes, string? reason = null)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidateCodec.TryParseCandidate(bytes, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        Assert.NotNull(result.ReasonCode);
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
    }

    private sealed class IndexOnlyList(ArticlePackageManifestArticle[] values) : IReadOnlyList<ArticlePackageManifestArticle>
    {
        public int CountReads
        {
            get;
            private set;
        }
        public int IndexReads
        {
            get;
            private set;
        }
        public int Count
        {
            get
            {
                CountReads++;
                return values.Length;
            }
        }
        public ArticlePackageManifestArticle this[int index]
        {
            get
            {
                IndexReads++;
                return values[index];
            }
        }
        public IEnumerator<ArticlePackageManifestArticle> GetEnumerator() => throw new InvalidOperationException("enumeration_forbidden");
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
