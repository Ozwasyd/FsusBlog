using FsusBlog.Core.Integrity;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleRightsCanonicalHashTests
{
    [Fact]
    public void BuildPayload_GoldenFixture_NormalizesTextAndHashPrefix()
    {
        ArticleRightsCanonicalInput input = Baseline();
        ArticleRightsCanonicalInput normalized = input with
        {
            CopyrightHolder = "Fésus Café",
            RightsStatement = "Line one\nLine two Café",
            ContentCanonicalHash = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        };

        string hash = ArticleRightsCanonicalHashV1.ComputeHashHex(input);
        string normalizedHash = ArticleRightsCanonicalHashV1.ComputeHashHex(normalized);
        string payload = ArticleRightsCanonicalPayloadV1.BuildPayloadUtf8(input);

        Assert.Equal(1, ArticleRightsCanonicalHashV1.HashVersion);
        Assert.Equal("fsusblog.rights.article-policy.v1", ArticleRightsCanonicalHashV1.DomainSeparator);
        Assert.Equal("sha256:fb79f2fe498ac6e39de1d1a65161a773c83324cd776b2ed7346e7a1c68b8c1ef", hash);
        Assert.Equal(normalizedHash, hash);
        Assert.StartsWith("fsusblog.rights.article-policy.v1\nhashVersion:i:1\n", payload, StringComparison.Ordinal);
        Assert.DoesNotContain("\r", payload, StringComparison.Ordinal);
        Assert.Contains("\nallowCodeCopy:b:1\n", payload, StringComparison.Ordinal);
        Assert.Contains("\ncontentCanonicalHash:h:sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n", payload, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(nameof(ArticleRightsCanonicalInput.ArticleId))]
    [InlineData(nameof(ArticleRightsCanonicalInput.ArticleRevisionId))]
    [InlineData(nameof(ArticleRightsCanonicalInput.RevisionNo))]
    [InlineData(nameof(ArticleRightsCanonicalInput.LicenseType))]
    [InlineData(nameof(ArticleRightsCanonicalInput.CopyrightHolder))]
    [InlineData(nameof(ArticleRightsCanonicalInput.CopyrightYear))]
    [InlineData(nameof(ArticleRightsCanonicalInput.RightsStatement))]
    [InlineData(nameof(ArticleRightsCanonicalInput.AttributionTemplate))]
    [InlineData(nameof(ArticleRightsCanonicalInput.CopyPolicy))]
    [InlineData(nameof(ArticleRightsCanonicalInput.MaxExcerptChars))]
    [InlineData(nameof(ArticleRightsCanonicalInput.AllowCodeCopy))]
    [InlineData(nameof(ArticleRightsCanonicalInput.ShowPublicBadge))]
    [InlineData(nameof(ArticleRightsCanonicalInput.CanonicalUrl))]
    [InlineData(nameof(ArticleRightsCanonicalInput.ContentCanonicalHash))]
    public void ComputeHash_ChangesWhenBoundFieldChanges(string field)
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

        Assert.NotEqual(
            ArticleRightsCanonicalHashV1.ComputeHashHex(baseline),
            ArticleRightsCanonicalHashV1.ComputeHashHex(changed));
    }

    [Fact]
    public void BuildPayload_NullAndEmptyOptionalStringsRemainDistinct()
    {
        ArticleRightsCanonicalInput nullHolder = Baseline() with { CopyrightHolder = null };
        ArticleRightsCanonicalInput emptyHolder = Baseline() with { CopyrightHolder = string.Empty };

        string nullPayload = ArticleRightsCanonicalPayloadV1.BuildPayloadUtf8(nullHolder);
        string emptyPayload = ArticleRightsCanonicalPayloadV1.BuildPayloadUtf8(emptyHolder);

        Assert.NotEqual(
            ArticleRightsCanonicalHashV1.ComputeHashHex(nullHolder),
            ArticleRightsCanonicalHashV1.ComputeHashHex(emptyHolder));
        Assert.Contains("\ncopyrightHolder:n\n", nullPayload, StringComparison.Ordinal);
        Assert.Contains("\ncopyrightHolder:s:\n", emptyPayload, StringComparison.Ordinal);
    }

    [Fact]
    public void AttributionTemplateRenderer_RendersKnownTokensAndLeavesUnknownTokens()
    {
        var values = new ArticleRightsAttributionValues(
            Title: "Rights Title",
            Url: "https://example.test/articles/42",
            Holder: "Fésus",
            Year: "2026",
            License: "CC-BY-4.0",
            Proof: "sha256:abcdef");

        string rendered = ArticleRightsAttributionTemplateRenderer.Render(
            "{title}|{url}|{holder}|{year}|{license}|{proof}|{unknown}|{broken",
            values);

        Assert.Equal(
            "Rights Title|https://example.test/articles/42|Fésus|2026|CC-BY-4.0|sha256:abcdef|{unknown}|{broken",
            rendered);
    }

    [Fact]
    public void AttributionTemplateRenderer_HandlesEmptyAndLongValuesWithoutThrowing()
    {
        string longTitle = new('x', 8192);
        var values = new ArticleRightsAttributionValues(
            Title: longTitle,
            Url: string.Empty,
            Holder: string.Empty,
            Year: string.Empty,
            License: "all-rights-reserved",
            Proof: string.Empty);

        string rendered = ArticleRightsAttributionTemplateRenderer.Render(
            "{title} {holder} {url} {license} {proof}",
            values);

        Assert.StartsWith(longTitle, rendered, StringComparison.Ordinal);
        Assert.Contains("all-rights-reserved", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeType_IsCoreOnlyAndUsesBufferWriterWithoutReflectionOrDynamic()
    {
        Assert.Equal("FsusBlog.Core", typeof(ArticleRightsCanonicalPayloadV1).Assembly.GetName().Name);
        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(ArticleRightsCanonicalPayloadV1));
        Assert.Contains("IBufferWriter", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ArrayBufferWriter", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("FsusBlog.Server", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("SqlSugar", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("HttpContext", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Reflection", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Object Invoke", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("JsonSerializer", runtimeShape, StringComparison.Ordinal);

        Assert.DoesNotContain(
            typeof(ArticleRightsCanonicalPayloadV1).GetMethods(),
            static method => method.ReturnType.IsPointer || method.GetParameters().Any(parameter => parameter.ParameterType.IsPointer));
    }

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
