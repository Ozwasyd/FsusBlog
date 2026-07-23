using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Core.Integrity;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleRightsCanonicalHashTests
{
    private static readonly JsonSerializerOptions s_jsonOptions = new() { PropertyNameCaseInsensitive = true };

    public static TheoryData<string> BoundFields
        => new()
        {
            nameof(ArticleRightsCanonicalInput.ArticleId),
            nameof(ArticleRightsCanonicalInput.ArticleRevisionId),
            nameof(ArticleRightsCanonicalInput.RevisionNo),
            nameof(ArticleRightsCanonicalInput.LicenseType),
            nameof(ArticleRightsCanonicalInput.CopyrightHolder),
            nameof(ArticleRightsCanonicalInput.CopyrightYear),
            nameof(ArticleRightsCanonicalInput.RightsStatement),
            nameof(ArticleRightsCanonicalInput.AttributionTemplate),
            nameof(ArticleRightsCanonicalInput.CopyPolicy),
            nameof(ArticleRightsCanonicalInput.MaxExcerptChars),
            nameof(ArticleRightsCanonicalInput.AllowCodeCopy),
            nameof(ArticleRightsCanonicalInput.ShowPublicBadge),
            nameof(ArticleRightsCanonicalInput.CanonicalUrl),
            nameof(ArticleRightsCanonicalInput.ContentCanonicalHash)
        };

    public static TheoryData<string> CanonicalEquivalenceCases
        => new()
        {
            "crlf-lf",
            "unicode-nfc",
            "content-hash-prefix-and-case"
        };

    [Fact]
    [Trait("Category", "GoldenContract")]
    public void GoldenVector_ArticleRightsV1MatchesCompletePayloadAndHash()
    {
        JsonObject vector = ReadGoldenVector("article-rights-v1-unicode-newline-hash-prefix");
        ArticleRightsCanonicalInput input = vector["input"]!.Deserialize<ArticleRightsCanonicalInput>(s_jsonOptions)!;

        Assert.Equal(ArticleRightsCanonicalHashV1.HashVersion, vector["version"]!.GetValue<int>());
        Assert.Equal(ArticleRightsCanonicalHashV1.DomainSeparator, vector["domain"]!.GetValue<string>());
        Assert.Equal(
            Convert.FromBase64String(vector["payloadBase64"]!.GetValue<string>()),
            ArticleRightsCanonicalPayloadV1.BuildPayloadBytes(input));
        Assert.Equal(vector["hash"]!.GetValue<string>(), ArticleRightsCanonicalHashV1.ComputeHashHex(input));
    }

    [Theory]
    [MemberData(nameof(CanonicalEquivalenceCases))]
    public void ComputeHash_CanonicalEquivalentInputsRemainEqual(string invariant)
    {
        (ArticleRightsCanonicalInput first, ArticleRightsCanonicalInput second) = invariant switch
        {
            "crlf-lf" => (
                Baseline() with
                {
                    RightsStatement = "first\r\nsecond\rthird"
                },
                Baseline() with
                {
                    RightsStatement = "first\nsecond\nthird"
                }),
            "unicode-nfc" => (
                Baseline() with
                {
                    CopyrightHolder = "Fe\u0301sus Cafe\u0301"
                },
                Baseline() with
                {
                    CopyrightHolder = "Fésus Café"
                }),
            "content-hash-prefix-and-case" => (
                Baseline() with
                {
                    ContentCanonicalHash = "SHA256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789"
                },
                Baseline() with
                {
                    ContentCanonicalHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
                }),
            _ => throw new ArgumentOutOfRangeException(nameof(invariant), invariant, null)
        };

        Assert.True(
            ArticleRightsCanonicalPayloadV1.BuildPayloadBytes(first).AsSpan().SequenceEqual(ArticleRightsCanonicalPayloadV1.BuildPayloadBytes(second)),
            $"canonical payload differed for invariant '{invariant}'");
        Assert.Equal(ArticleRightsCanonicalHashV1.ComputeHashHex(first), ArticleRightsCanonicalHashV1.ComputeHashHex(second));
    }

    [Theory]
    [MemberData(nameof(BoundFields))]
    public void ComputeHash_EachBoundFieldMutationChangesHash(string field)
    {
        ArticleRightsCanonicalInput baseline = Baseline();
        ArticleRightsCanonicalInput changed = field switch
        {
            nameof(ArticleRightsCanonicalInput.ArticleId) => baseline with { ArticleId = baseline.ArticleId + 1 },
            nameof(ArticleRightsCanonicalInput.ArticleRevisionId) => baseline with { ArticleRevisionId = baseline.ArticleRevisionId + 1 },
            nameof(ArticleRightsCanonicalInput.RevisionNo) => baseline with { RevisionNo = baseline.RevisionNo + 1 },
            nameof(ArticleRightsCanonicalInput.LicenseType) => baseline with { LicenseType = "all-rights-reserved" },
            nameof(ArticleRightsCanonicalInput.CopyrightHolder) => baseline with { CopyrightHolder = "Other Holder" },
            nameof(ArticleRightsCanonicalInput.CopyrightYear) => baseline with { CopyrightYear = baseline.CopyrightYear + 1 },
            nameof(ArticleRightsCanonicalInput.RightsStatement) => baseline with { RightsStatement = baseline.RightsStatement + "\nextra" },
            nameof(ArticleRightsCanonicalInput.AttributionTemplate) => baseline with { AttributionTemplate = "{title} {url}" },
            nameof(ArticleRightsCanonicalInput.CopyPolicy) => baseline with { CopyPolicy = "disabled" },
            nameof(ArticleRightsCanonicalInput.MaxExcerptChars) => baseline with { MaxExcerptChars = baseline.MaxExcerptChars + 1 },
            nameof(ArticleRightsCanonicalInput.AllowCodeCopy) => baseline with { AllowCodeCopy = !baseline.AllowCodeCopy },
            nameof(ArticleRightsCanonicalInput.ShowPublicBadge) => baseline with { ShowPublicBadge = !baseline.ShowPublicBadge },
            nameof(ArticleRightsCanonicalInput.CanonicalUrl) => baseline with { CanonicalUrl = "https://example.test/articles/changed" },
            nameof(ArticleRightsCanonicalInput.ContentCanonicalHash) => baseline with { ContentCanonicalHash = "sha256:1111111111111111111111111111111111111111111111111111111111111111" },
            _ => throw new ArgumentOutOfRangeException(nameof(field), field, null)
        };

        Assert.True(
            !StringComparer.Ordinal.Equals(
                ArticleRightsCanonicalHashV1.ComputeHashHex(baseline),
                ArticleRightsCanonicalHashV1.ComputeHashHex(changed)),
            $"bound field '{field}' did not change the rights canonical hash");
    }

    [Theory]
    [InlineData(nameof(ArticleRightsCanonicalInput.CopyrightHolder))]
    [InlineData(nameof(ArticleRightsCanonicalInput.RightsStatement))]
    [InlineData(nameof(ArticleRightsCanonicalInput.AttributionTemplate))]
    [InlineData(nameof(ArticleRightsCanonicalInput.CanonicalUrl))]
    public void ComputeHash_NullAndEmptyOptionalStringsRemainDistinct(string field)
    {
        ArticleRightsCanonicalInput nullValue = field switch
        {
            nameof(ArticleRightsCanonicalInput.CopyrightHolder) => Baseline() with { CopyrightHolder = null },
            nameof(ArticleRightsCanonicalInput.RightsStatement) => Baseline() with { RightsStatement = null },
            nameof(ArticleRightsCanonicalInput.AttributionTemplate) => Baseline() with { AttributionTemplate = null },
            nameof(ArticleRightsCanonicalInput.CanonicalUrl) => Baseline() with { CanonicalUrl = null },
            _ => throw new ArgumentOutOfRangeException(nameof(field), field, null)
        };
        ArticleRightsCanonicalInput emptyValue = field switch
        {
            nameof(ArticleRightsCanonicalInput.CopyrightHolder) => Baseline() with { CopyrightHolder = string.Empty },
            nameof(ArticleRightsCanonicalInput.RightsStatement) => Baseline() with { RightsStatement = string.Empty },
            nameof(ArticleRightsCanonicalInput.AttributionTemplate) => Baseline() with { AttributionTemplate = string.Empty },
            nameof(ArticleRightsCanonicalInput.CanonicalUrl) => Baseline() with { CanonicalUrl = string.Empty },
            _ => throw new ArgumentOutOfRangeException(nameof(field), field, null)
        };

        Assert.True(
            !StringComparer.Ordinal.Equals(
                ArticleRightsCanonicalHashV1.ComputeHashHex(nullValue),
                ArticleRightsCanonicalHashV1.ComputeHashHex(emptyValue)),
            $"optional field '{field}' collapsed null and empty values");
    }

    [Fact]
    public void CanonicalContract_UsesVersionedDomainDistinctFromArticleContent()
    {
        Assert.Equal(1, ArticleRightsCanonicalHashV1.HashVersion);
        Assert.Equal("fsusblog.rights.article-policy.v1", ArticleRightsCanonicalHashV1.DomainSeparator);
        Assert.NotEqual(ArticleCanonicalHashV1.DomainSeparator, ArticleRightsCanonicalHashV1.DomainSeparator);
    }

    [Theory]
    [InlineData(nameof(ArticleRightsCanonicalInput.ArticleId))]
    [InlineData(nameof(ArticleRightsCanonicalInput.ArticleRevisionId))]
    [InlineData(nameof(ArticleRightsCanonicalInput.RevisionNo))]
    public void BuildPayload_RejectsZeroForPositiveIdentifiers(string field)
    {
        ArticleRightsCanonicalInput input = field switch
        {
            nameof(ArticleRightsCanonicalInput.ArticleId) => Baseline() with { ArticleId = 0 },
            nameof(ArticleRightsCanonicalInput.ArticleRevisionId) => Baseline() with { ArticleRevisionId = 0 },
            nameof(ArticleRightsCanonicalInput.RevisionNo) => Baseline() with { RevisionNo = 0 },
            _ => throw new ArgumentOutOfRangeException(nameof(field), field, null)
        };

        ArgumentOutOfRangeException exception = Assert.Throws<ArgumentOutOfRangeException>(
            () => ArticleRightsCanonicalPayloadV1.BuildPayloadBytes(input));

        Assert.Equal(field, exception.ParamName);
    }

    [Fact]
    public void BuildPayload_RejectsNegativeMaxExcerptChars()
    {
        ArgumentOutOfRangeException exception = Assert.Throws<ArgumentOutOfRangeException>(
            () => ArticleRightsCanonicalPayloadV1.BuildPayloadBytes(Baseline() with { MaxExcerptChars = -1 }));

        Assert.Equal(nameof(ArticleRightsCanonicalInput.MaxExcerptChars), exception.ParamName);
    }

    [Theory]
    [InlineData("first\rsecond", "first\nsecond")]
    [InlineData("first\r\nsecond", "first\nsecond")]
    [InlineData("\rleading", "\nleading")]
    [InlineData("trailing\r", "trailing\n")]
    public void ComputeHash_NormalizesEveryCarriageReturnForm(string source, string canonical)
    {
        string sourceHash = ArticleRightsCanonicalHashV1.ComputeHashHex(
            Baseline() with { RightsStatement = source });
        string canonicalHash = ArticleRightsCanonicalHashV1.ComputeHashHex(
            Baseline() with { RightsStatement = canonical });

        Assert.Equal(canonicalHash, sourceHash);
    }

    [Theory]
    [InlineData("known-and-unknown-tokens")]
    [InlineData("empty-and-long-values")]
    public void AttributionTemplateRenderer_PreservesSupportedBoundaryBehavior(string invariant)
    {
        if (StringComparer.Ordinal.Equals(invariant, "known-and-unknown-tokens"))
        {
            var values = new ArticleRightsAttributionValues(
                Title: "Rights Title",
                Url: "https://example.test/articles/42",
                Holder: "Fésus",
                Year: "2026",
                License: "CC-BY-4.0",
                Proof: "sha256:abcdef");

            Assert.Equal(
                "Rights Title|https://example.test/articles/42|Fésus|2026|CC-BY-4.0|sha256:abcdef|{unknown}|{broken",
                ArticleRightsAttributionTemplateRenderer.Render(
                    "{title}|{url}|{holder}|{year}|{license}|{proof}|{unknown}|{broken",
                    values));
            return;
        }

        string longTitle = new('x', 8192);
        var boundaryValues = new ArticleRightsAttributionValues(
            Title: longTitle,
            Url: string.Empty,
            Holder: string.Empty,
            Year: string.Empty,
            License: "all-rights-reserved",
            Proof: string.Empty);
        string rendered = ArticleRightsAttributionTemplateRenderer.Render(
            "{title} {holder} {url} {license} {proof}",
            boundaryValues);

        Assert.StartsWith(longTitle, rendered, StringComparison.Ordinal);
        Assert.Contains("all-rights-reserved", rendered, StringComparison.Ordinal);
    }

    private static JsonObject ReadGoldenVector(string id)
        => BackendTestPaths.ReadJsonFromRoot("tests", "backend", "Fixtures", "canonical-hash-golden-vectors.json")["vectors"]!
            .AsArray()
            .Select(static node => node!.AsObject())
            .Single(vector => StringComparer.Ordinal.Equals(id, vector["id"]!.GetValue<string>()));

    private static ArticleRightsCanonicalInput Baseline()
        => new(
            ArticleId: 42,
            ArticleRevisionId: 9001,
            RevisionNo: 3,
            LicenseType: "CC-BY-4.0",
            CopyrightHolder: "Fe\u0301sus Cafe\u0301",
            CopyrightYear: 2026,
            RightsStatement: "Line one\r\nLine two Cafe\u0301",
            AttributionTemplate: "{title} — {holder} ({year}) {license} {url} {proof}",
            CopyPolicy: "append-attribution",
            MaxExcerptChars: 300,
            AllowCodeCopy: true,
            ShowPublicBadge: true,
            CanonicalUrl: "https://example.test/articles/cafe",
            ContentCanonicalHash: "SHA256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789");
}
