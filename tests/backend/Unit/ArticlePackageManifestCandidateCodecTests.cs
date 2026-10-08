using System.Collections;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Contracts.Articles;
using FsusBlog.Shared.Contracts.ArticlePackages;

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
