using System.Text.Json;

using FsusBlog.Contracts.Articles;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class CurrentArticleContractTests
{
    [Fact]
    public void ContentCanonicalHash_PreservesOriginalCompleteGoldenVector()
    {
        // Original canonical-hash-golden-vectors.json, not a migration-specific hash.
        var input = new ArticleCanonicalInput(
            42, 9001, 3, "article:42", "发布说明 Café 中文 😀", null, "/assets/cover.png",
            7, [9, 2, 5], 2, new DateTime(2026, 6, 1, 8, 30, 0, DateTimeKind.Utc), null,
            "# 标题\r\n\r\nCafe\u0301 中文 😀\r\n");

        Assert.Equal(
            "129cb6dac691dccdf53e797da943167ef1e5f3f3972327c221f94e13bcbfab66",
            ArticleCanonicalHashV1.ComputeHashHex(input));
    }

    [Fact]
    public void RightsCanonicalHash_PreservesOriginalCompleteGoldenVector()
    {
        var input = new ArticleRightsCanonicalInput(
            42, 9001, 3, "CC-BY-4.0", "Fe\u0301sus Cafe\u0301", 2026,
            "Line one\r\nLine two Cafe\u0301", "{title} — {holder} ({year}) {license} {url} {proof}",
            "append-attribution", 300, true, true, "https://example.test/articles/cafe",
            "SHA256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789");

        Assert.Equal(
            "sha256:fb79f2fe498ac6e39de1d1a65161a773c83324cd776b2ed7346e7a1c68b8c1ef",
            ArticleRightsCanonicalHashV1.ComputeHashHex(input));
    }

    [Fact]
    public void ContentCanonicalHash_DoesNotCollapseFinalNewline()
    {
        var source = new ArticleCanonicalInput(1, 1, 1, "article:1", "Title", null, null,
            1, [], 2, new DateTime(2026, 5, 17, 10, 0, 0, DateTimeKind.Utc), null, "body");

        Assert.NotEqual(
            ArticleCanonicalHashV1.ComputeHashHex(source),
            ArticleCanonicalHashV1.ComputeHashHex(source with { MarkdownContent = "body\n" }));
    }

    [Fact]
    public void WriterAndWireNormalization_PreserveTheirDifferentNegativeExcerptContracts()
    {
        ArticleRightsRequestCoreModel source = ArticleProductionNormalizers.NormalizeWireArticleRights(null)
            with { MaxExcerptChars = -1 };

        Assert.Throws<ArgumentOutOfRangeException>(
            () => ArticleProductionNormalizers.NormalizeArticleRights(source));
        Assert.Equal(0, ArticleProductionNormalizers.NormalizeWireArticleRights(source).MaxExcerptChars);
    }

    [Fact]
    public void WriterAndWireNormalization_PreserveTheirDifferentWhitespaceContracts()
    {
        ArticleRightsRequestCoreModel source = ArticleProductionNormalizers.NormalizeWireArticleRights(null)
            with { LicenseType = "  CC-BY-4.0  ", CopyrightHolder = "  Owner  " };

        ArticleRightsNormalizedModel writer = ArticleProductionNormalizers.NormalizeArticleRights(source);
        ArticleRightsRequestCoreModel wire = ArticleProductionNormalizers.NormalizeWireArticleRights(source);
        Assert.Equal("CC-BY-4.0", writer.LicenseType);
        Assert.Equal("Owner", writer.CopyrightHolder);
        Assert.Equal(source.LicenseType, wire.LicenseType);
        Assert.Equal(source.CopyrightHolder, wire.CopyrightHolder);
    }

    [Fact]
    public void OmittedRights_ResolveEveryFieldToTheSameExistingDefaults()
    {
        ArticleRightsNormalizedModel writer = ArticleProductionNormalizers.NormalizeArticleRights(null);
        ArticleRightsRequestCoreModel wire = ArticleProductionNormalizers.NormalizeWireArticleRights(null);

        Assert.Equal(JsonSerializer.Serialize(wire), JsonSerializer.Serialize(writer));
        Assert.Equal("all-rights-reserved", writer.LicenseType);
        Assert.Equal("append-attribution", writer.CopyPolicy);
        Assert.Equal(300, writer.MaxExcerptChars);
        Assert.True(writer.Enabled && writer.AllowCodeCopy && writer.ShowPublicBadge && writer.ProofBindingEnabled);
        Assert.Null(writer.CopyrightHolder);
    }
}
