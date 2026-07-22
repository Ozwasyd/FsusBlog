using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Core.Integrity;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleCanonicalHashTests
{
    private static readonly JsonSerializerOptions s_jsonOptions = new() { PropertyNameCaseInsensitive = true };

    public static TheoryData<string> BoundFields
        => new()
        {
            nameof(ArticleCanonicalInput.ArticleId),
            nameof(ArticleCanonicalInput.ArticleRevisionId),
            nameof(ArticleCanonicalInput.RevisionNo),
            nameof(ArticleCanonicalInput.PublicRouteKey),
            nameof(ArticleCanonicalInput.Title),
            nameof(ArticleCanonicalInput.Summary),
            nameof(ArticleCanonicalInput.CoverImageUrl),
            nameof(ArticleCanonicalInput.CategoryId),
            nameof(ArticleCanonicalInput.TagIds),
            nameof(ArticleCanonicalInput.Status),
            nameof(ArticleCanonicalInput.PublishedAt),
            nameof(ArticleCanonicalInput.ScheduledPublishAt),
            nameof(ArticleCanonicalInput.MarkdownContent)
        };

    public static TheoryData<string> CanonicalEquivalenceCases
        => new()
        {
            "crlf-lf",
            "unicode-nfc",
            "tag-set-order-and-duplicates"
        };

    [Fact]
    [Trait("Category", "GoldenContract")]
    public void GoldenVector_ArticleContentV1MatchesCompletePayloadAndHash()
    {
        JsonObject vector = ReadGoldenVector("article-content-v1-unicode-newline");
        ArticleCanonicalInput input = vector["input"]!.Deserialize<ArticleCanonicalInput>(s_jsonOptions)!;

        Assert.Equal(ArticleCanonicalHashV1.HashVersion, vector["version"]!.GetValue<int>());
        Assert.Equal(ArticleCanonicalHashV1.DomainSeparator, vector["domain"]!.GetValue<string>());
        Assert.Equal(
            Convert.FromBase64String(vector["payloadBase64"]!.GetValue<string>()),
            ArticleCanonicalHashV1.BuildPayloadBytes(input));
        Assert.Equal(vector["hash"]!.GetValue<string>(), ArticleCanonicalHashV1.ComputeHashHex(input));
    }

    [Theory]
    [MemberData(nameof(CanonicalEquivalenceCases))]
    public void ComputeHash_CanonicalEquivalentInputsRemainEqual(string invariant)
    {
        (ArticleCanonicalInput first, ArticleCanonicalInput second) = invariant switch
        {
            "crlf-lf" => (
                Baseline() with
                {
                    MarkdownContent = "first\r\nsecond\rthird"
                },
                Baseline() with
                {
                    MarkdownContent = "first\nsecond\nthird"
                }),
            "unicode-nfc" => (
                Baseline() with
                {
                    Title = "Cafe\u0301 中文 😀",
                    MarkdownContent = "Cafe\u0301 中文 😀"
                },
                Baseline() with
                {
                    Title = "Café 中文 😀",
                    MarkdownContent = "Café 中文 😀"
                }),
            "tag-set-order-and-duplicates" => (
                Baseline() with
                {
                    TagIds = [9, 2, 5, 2]
                },
                Baseline() with
                {
                    TagIds = [5, 9, 2]
                }),
            _ => throw new ArgumentOutOfRangeException(nameof(invariant), invariant, null)
        };

        Assert.True(
            ArticleCanonicalHashV1.BuildPayloadBytes(first).AsSpan().SequenceEqual(ArticleCanonicalHashV1.BuildPayloadBytes(second)),
            $"canonical payload differed for invariant '{invariant}'");
        Assert.Equal(ArticleCanonicalHashV1.ComputeHashHex(first), ArticleCanonicalHashV1.ComputeHashHex(second));
    }

    [Theory]
    [MemberData(nameof(BoundFields))]
    public void ComputeHash_EachBoundFieldMutationChangesHash(string field)
    {
        ArticleCanonicalInput baseline = Baseline();
        ArticleCanonicalInput changed = field switch
        {
            nameof(ArticleCanonicalInput.ArticleId) => baseline with { ArticleId = baseline.ArticleId + 1 },
            nameof(ArticleCanonicalInput.ArticleRevisionId) => baseline with { ArticleRevisionId = baseline.ArticleRevisionId + 1 },
            nameof(ArticleCanonicalInput.RevisionNo) => baseline with { RevisionNo = baseline.RevisionNo + 1 },
            nameof(ArticleCanonicalInput.PublicRouteKey) => baseline with { PublicRouteKey = "article:42-renamed" },
            nameof(ArticleCanonicalInput.Title) => baseline with { Title = baseline.Title + " updated" },
            nameof(ArticleCanonicalInput.Summary) => baseline with { Summary = "summary" },
            nameof(ArticleCanonicalInput.CoverImageUrl) => baseline with { CoverImageUrl = "/assets/changed.png" },
            nameof(ArticleCanonicalInput.CategoryId) => baseline with { CategoryId = baseline.CategoryId + 1 },
            nameof(ArticleCanonicalInput.TagIds) => baseline with { TagIds = [2, 5, 10] },
            nameof(ArticleCanonicalInput.Status) => baseline with { Status = baseline.Status + 1 },
            nameof(ArticleCanonicalInput.PublishedAt) => baseline with { PublishedAt = baseline.PublishedAt!.Value.AddSeconds(1) },
            nameof(ArticleCanonicalInput.ScheduledPublishAt) => baseline with { ScheduledPublishAt = baseline.PublishedAt!.Value.AddHours(1) },
            nameof(ArticleCanonicalInput.MarkdownContent) => baseline with { MarkdownContent = baseline.MarkdownContent + "\nextra" },
            _ => throw new ArgumentOutOfRangeException(nameof(field), field, null)
        };

        Assert.True(
            !StringComparer.Ordinal.Equals(
                ArticleCanonicalHashV1.ComputeHashHex(baseline),
                ArticleCanonicalHashV1.ComputeHashHex(changed)),
            $"bound field '{field}' did not change the article canonical hash");
    }

    [Theory]
    [InlineData(nameof(ArticleCanonicalInput.Summary))]
    [InlineData(nameof(ArticleCanonicalInput.CoverImageUrl))]
    [InlineData(nameof(ArticleCanonicalInput.PublicRouteKey))]
    public void ComputeHash_NullAndEmptyOptionalStringsRemainDistinct(string field)
    {
        ArticleCanonicalInput nullValue = field switch
        {
            nameof(ArticleCanonicalInput.Summary) => Baseline() with { Summary = null },
            nameof(ArticleCanonicalInput.CoverImageUrl) => Baseline() with { CoverImageUrl = null },
            nameof(ArticleCanonicalInput.PublicRouteKey) => Baseline() with { PublicRouteKey = null },
            _ => throw new ArgumentOutOfRangeException(nameof(field), field, null)
        };
        ArticleCanonicalInput emptyValue = field switch
        {
            nameof(ArticleCanonicalInput.Summary) => Baseline() with { Summary = string.Empty },
            nameof(ArticleCanonicalInput.CoverImageUrl) => Baseline() with { CoverImageUrl = string.Empty },
            nameof(ArticleCanonicalInput.PublicRouteKey) => Baseline() with { PublicRouteKey = string.Empty },
            _ => throw new ArgumentOutOfRangeException(nameof(field), field, null)
        };

        Assert.True(
            !StringComparer.Ordinal.Equals(
                ArticleCanonicalHashV1.ComputeHashHex(nullValue),
                ArticleCanonicalHashV1.ComputeHashHex(emptyValue)),
            $"optional field '{field}' collapsed null and empty values");
    }

    [Fact]
    public void CanonicalContract_UsesVersionedDomainDistinctFromRights()
    {
        Assert.Equal(1, ArticleCanonicalHashV1.HashVersion);
        Assert.Equal("fsusblog.integrity.article-canonical.v1", ArticleCanonicalHashV1.DomainSeparator);
        Assert.NotEqual(ArticleRightsCanonicalHashV1.DomainSeparator, ArticleCanonicalHashV1.DomainSeparator);
    }

    private static JsonObject ReadGoldenVector(string id)
        => BackendTestPaths.ReadJsonFromRoot("tests", "backend", "Fixtures", "canonical-hash-golden-vectors.json")["vectors"]!
            .AsArray()
            .Select(static node => node!.AsObject())
            .Single(vector => StringComparer.Ordinal.Equals(id, vector["id"]!.GetValue<string>()));

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
