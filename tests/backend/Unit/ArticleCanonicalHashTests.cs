using FsusBlog.Core.Integrity;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleCanonicalHashTests
{
    [Fact]
    public void BuildPayload_GoldenFixture_NormalizesLineEndingsAndUsesStableVersionedDomain()
    {
        ArticleCanonicalInput input = Baseline() with
        {
            MarkdownContent = "# 标题\r\n\r\nCafe\u0301 中文 😀\r\n"
        };
        ArticleCanonicalInput lfInput = input with
        {
            MarkdownContent = "# 标题\n\nCafé 中文 😀\n"
        };

        string hash = ArticleCanonicalHashV1.ComputeHashHex(input);
        string lfHash = ArticleCanonicalHashV1.ComputeHashHex(lfInput);
        string payload = ArticleCanonicalHashV1.BuildPayloadUtf8(input);

        Assert.Equal(1, ArticleCanonicalHashV1.HashVersion);
        Assert.Equal("fsusblog.integrity.article-canonical.v1", ArticleCanonicalHashV1.DomainSeparator);
        Assert.Equal(lfHash, hash);
        Assert.Equal("129cb6dac691dccdf53e797da943167ef1e5f3f3972327c221f94e13bcbfab66", hash);
        Assert.StartsWith("fsusblog.integrity.article-canonical.v1\nhashVersion:i:1\n", payload, StringComparison.Ordinal);
        Assert.DoesNotContain("\r", payload, StringComparison.Ordinal);
        Assert.Contains("\ntagIds:i:2,5,9\n", payload, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(nameof(ArticleCanonicalInput.Title))]
    [InlineData(nameof(ArticleCanonicalInput.PublicRouteKey))]
    [InlineData(nameof(ArticleCanonicalInput.MarkdownContent))]
    [InlineData(nameof(ArticleCanonicalInput.ArticleRevisionId))]
    [InlineData(nameof(ArticleCanonicalInput.RevisionNo))]
    [InlineData(nameof(ArticleCanonicalInput.TagIds))]
    public void ComputeHash_NegativeFixture_ChangesWhenBoundFieldChanges(string field)
    {
        ArticleCanonicalInput baseline = Baseline();
        ArticleCanonicalInput changed = field switch
        {
            nameof(ArticleCanonicalInput.Title) => baseline with { Title = baseline.Title + " updated" },
            nameof(ArticleCanonicalInput.PublicRouteKey) => baseline with { PublicRouteKey = "article:42-renamed" },
            nameof(ArticleCanonicalInput.MarkdownContent) => baseline with { MarkdownContent = baseline.MarkdownContent + "\nextra" },
            nameof(ArticleCanonicalInput.ArticleRevisionId) => baseline with { ArticleRevisionId = baseline.ArticleRevisionId + 1 },
            nameof(ArticleCanonicalInput.RevisionNo) => baseline with { RevisionNo = baseline.RevisionNo + 1 },
            nameof(ArticleCanonicalInput.TagIds) => baseline with { TagIds = [2, 5, 10] },
            _ => throw new ArgumentOutOfRangeException(nameof(field), field, null)
        };

        Assert.NotEqual(
            ArticleCanonicalHashV1.ComputeHashHex(baseline),
            ArticleCanonicalHashV1.ComputeHashHex(changed));
    }

    [Fact]
    public void ComputeHash_TagIdsAreSetCanonicalized()
    {
        ArticleCanonicalInput first = Baseline() with
        {
            TagIds = [9, 2, 5, 2]
        };
        ArticleCanonicalInput second = Baseline() with
        {
            TagIds = [5, 9, 2]
        };

        string firstPayload = ArticleCanonicalHashV1.BuildPayloadUtf8(first);
        string secondPayload = ArticleCanonicalHashV1.BuildPayloadUtf8(second);

        Assert.Equal(ArticleCanonicalHashV1.ComputeHashHex(first), ArticleCanonicalHashV1.ComputeHashHex(second));
        Assert.Contains("\ntagIds:i:2,5,9\n", firstPayload, StringComparison.Ordinal);
        Assert.Equal(firstPayload, secondPayload);
    }

    [Fact]
    public void ComputeHash_UnicodeNfcCanonicalizationIsStable()
    {
        ArticleCanonicalInput decomposed = Baseline() with
        {
            Title = "Cafe\u0301 中文 😀",
            MarkdownContent = "Cafe\u0301 中文 😀"
        };
        ArticleCanonicalInput composed = Baseline() with
        {
            Title = "Café 中文 😀",
            MarkdownContent = "Café 中文 😀"
        };

        Assert.Equal(
            ArticleCanonicalHashV1.ComputeHashHex(composed),
            ArticleCanonicalHashV1.ComputeHashHex(decomposed));
    }

    [Fact]
    public void BuildPayload_NullAndEmptyStringRemainDistinct()
    {
        ArticleCanonicalInput nullSummary = Baseline() with
        {
            Summary = null
        };
        ArticleCanonicalInput emptySummary = Baseline() with
        {
            Summary = string.Empty
        };

        string nullPayload = ArticleCanonicalHashV1.BuildPayloadUtf8(nullSummary);
        string emptyPayload = ArticleCanonicalHashV1.BuildPayloadUtf8(emptySummary);

        Assert.NotEqual(
            ArticleCanonicalHashV1.ComputeHashHex(nullSummary),
            ArticleCanonicalHashV1.ComputeHashHex(emptySummary));
        Assert.Contains("\nsummary:n\n", nullPayload, StringComparison.Ordinal);
        Assert.Contains("\nsummary:s:\n", emptyPayload, StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeType_IsCoreOnlyAndDoesNotReferenceExternalAnchors()
    {
        Assert.Equal("FsusBlog.Core", typeof(ArticleCanonicalHashV1).Assembly.GetName().Name);
        Assert.DoesNotContain(
            typeof(ArticleCanonicalHashV1).Assembly.GetReferencedAssemblies(),
            static reference => reference.Name?.Contains("FsusBlog.Server", StringComparison.Ordinal) == true ||
                                reference.Name?.Contains("SqlSugar", StringComparison.Ordinal) == true);

        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(ArticleCanonicalHashV1));
        Assert.DoesNotContain("FsusBlog.Server", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("SqlSugar", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("HttpContext", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("Redis", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("IPFS", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Arweave", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Nethereum", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("HttpClient", runtimeShape, StringComparison.Ordinal);
    }

    private static ArticleCanonicalInput Baseline()
        => new(
            ArticleId: 42,
            ArticleRevisionId: 9001,
            RevisionNo: 3,
            PublicRouteKey: "article:42",
            Title: "发布说明 Café 中文 😀",
            Summary: null,
            CoverImageUrl: "/assets/cover.png",
            CategoryId: 7,
            TagIds: [9, 2, 5],
            Status: 2,
            PublishedAt: new DateTime(2026, 6, 1, 8, 30, 0, DateTimeKind.Utc),
            ScheduledPublishAt: null,
            MarkdownContent: "# 标题\n\nCafé 中文 😀\n");
}
