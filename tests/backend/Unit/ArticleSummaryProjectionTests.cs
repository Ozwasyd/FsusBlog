using System.Globalization;
using System.Text.Json;

using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleSummaryProjectionTests
{
    [Fact]
    public void MarkdownFixtures_ProduceStablePlainTextWithoutBreakingGraphemes()
    {
        string json = BackendTestPaths.ReadAllTextFromRoot(
            "tests/backend/Fixtures/article-summary-projection.json");
        using JsonDocument document = JsonDocument.Parse(json);

        Assert.Equal(
            "fsusblog.article-summary-projection.v1",
            document.RootElement.GetProperty("schema").GetString());
        foreach (JsonElement fixture in document.RootElement.GetProperty("cases").EnumerateArray())
        {
            string name = fixture.GetProperty("name").GetString()!;
            int maxGraphemes = fixture.GetProperty("maxGraphemes").GetInt32();
            string markdown = fixture.GetProperty("markdown").GetString()!;
            string expected = fixture.GetProperty("expected").GetString()!;

            string actual = ArticleSummaryProjection.ToPlainText(markdown, maxGraphemes);

            Assert.Equal(expected, actual);
            Assert.InRange(StringInfo.ParseCombiningCharacters(actual).Length, 0, maxGraphemes);
            Assert.Equal(actual, ImageHelper.StripMarkdown(markdown, maxGraphemes));
        }
    }

    [Fact]
    public void Resolve_PreservesManualSummaryAndDoesNotAssignAutomaticVersion()
    {
        ArticleSummaryProjectionResult result = ArticleSummaryProjection.Resolve(
            "  手工摘要保留原意  ",
            "# 不应覆盖手工摘要");

        Assert.Equal("手工摘要保留原意", result.Text);
        Assert.False(result.IsGenerated);
        Assert.Null(result.GenerationVersion);
        Assert.Equal("article updated", ArticleSummaryProjection.AttachGenerationVersion("article updated", result));
    }

    [Fact]
    public void Resolve_GeneratedSummaryCarriesAuditableRevisionVersion()
    {
        ArticleSummaryProjectionResult result = ArticleSummaryProjection.Resolve(
            null,
            "# 标题\n\n正文");

        Assert.Equal("标题 正文", result.Text);
        Assert.True(result.IsGenerated);
        Assert.Equal(ArticleSummaryProjection.CurrentGenerationVersion, result.GenerationVersion);

        string revisionDescription = ArticleSummaryProjection.AttachGenerationVersion(
            "initial publish",
            result);
        Assert.Equal("initial publish [summary:auto:plain-text-v1]", revisionDescription);
        Assert.True(ArticleSummaryProjection.WasAutomaticallyGenerated(revisionDescription));
    }

    [Fact]
    public void Resolve_GeneratedSummaryHonorsStorageLengthWithoutSplittingLongEmojiClusters()
    {
        string family = "👨‍👩‍👧‍👦";
        string markdown = string.Concat(Enumerable.Repeat(family, 200));

        ArticleSummaryProjectionResult result = ArticleSummaryProjection.Resolve(null, markdown);

        Assert.InRange(result.Text.Length, 1, ArticleSummaryProjection.StoredSummaryMaxUtf16Length);
        Assert.InRange(
            StringInfo.ParseCombiningCharacters(result.Text).Length,
            1,
            ArticleSummaryProjection.DefaultMaxGraphemes);
        Assert.False(result.Text.EndsWith('\u200d'));
        Assert.EndsWith("…", result.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleSummaryConsumers_UseTheSingleProjectionPipeline()
    {
        string articleService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/ArticleService.cs");
        string articleCache = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/ArticleService.CacheAndInvalidation.cs");
        string search = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/SearchIndexService.RuntimePersistence.cs");
        string authoring = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Authoring/AuthoringDraftLifecycleService.cs");
        string imageHelper = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Helpers/ImageHelper.cs");

        Assert.Contains("ArticleSummaryProjection.Resolve(summary, content)", articleService, StringComparison.Ordinal);
        Assert.Contains("ArticleSummaryProjection.AttachGenerationVersion", articleService, StringComparison.Ordinal);
        Assert.DoesNotContain("GenerateSafeSummary", articleService, StringComparison.Ordinal);
        Assert.DoesNotContain("GenerateSafeSummary", articleCache, StringComparison.Ordinal);
        Assert.Contains("ArticleSummaryProjection.Resolve(summary, body, MaxSummaryLength)", search, StringComparison.Ordinal);
        Assert.Contains("ArticleSummaryProjection.Resolve(request.Summary, request.Content, 180)", authoring, StringComparison.Ordinal);
        Assert.Contains("ArticleSummaryProjection.WasAutomaticallyGenerated(revision.DiffSummary)", authoring, StringComparison.Ordinal);
        Assert.Contains("ArticleSummaryProjection.ToPlainText(content, maxLength)", imageHelper, StringComparison.Ordinal);
    }
}
