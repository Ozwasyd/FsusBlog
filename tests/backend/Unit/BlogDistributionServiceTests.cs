using System.Globalization;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Tests.Unit;

namespace FsusBlog.Server.Tests;

public sealed class BlogDistributionServiceTests
{
    [Theory]
    [InlineData("en-US")]
    [InlineData("fa-IR")]
    [InlineData("ar-SA")]
    [InlineData("th-TH")]
    public void WireDateHelpers_UseInvariantGregorianOutput(string cultureName)
    {
        var timestamp = new DateTimeOffset(2026, 6, 25, 9, 30, 0, TimeSpan.Zero);

        (string sitemapDate, string atomDate) = RunWithCulture(
            cultureName,
            () => (
                BlogDistributionService.ToWireSitemapDateForTests(timestamp),
                BlogDistributionService.ToWireIsoDateForTests(timestamp)));

        Assert.Equal("2026-06-25", sitemapDate);
        Assert.Equal("2026-06-25T09:30:00.0000000+00:00", atomDate);
    }

    [Fact]
    public void FeedAndSitemap_RuntimeUseIndependentBoundedAndCompleteProjections()
    {
        string sitemap = RuntimeMetadataInspection.DescribeMethods(
            typeof(BlogDistributionService),
            "LoadSitemapArtifactSetAsync",
            "LoadSitemapCategoriesAsync",
            "LoadSitemapTagsAsync");
        string sitemapArticleQuery = RuntimeMetadataInspection.DescribeMethods(
            typeof(BlogDistributionService),
            "LoadSitemapArticlesAsync");
        string feed = RuntimeMetadataInspection.DescribeMethods(
            typeof(BlogDistributionService),
            "LoadFeedSnapshotAsync",
            "LoadFeedArticlesAsync");

        Assert.Contains("GetArticleListVersionAsync", sitemap, StringComparison.Ordinal);
        Assert.Contains("sitemap:v:", sitemap, StringComparison.Ordinal);
        Assert.Contains("LoadSitemapArticlesAsync", sitemap, StringComparison.Ordinal);
        Assert.Contains("LoadSitemapCategoriesAsync", sitemap, StringComparison.Ordinal);
        Assert.Contains("LoadSitemapTagsAsync", sitemap, StringComparison.Ordinal);
        Assert.Contains("article_body", sitemapArticleQuery, StringComparison.Ordinal);
        Assert.DoesNotContain("MarkdownContent", sitemapArticleQuery, StringComparison.Ordinal);
        Assert.DoesNotContain("Take", sitemapArticleQuery, StringComparison.Ordinal);
        Assert.DoesNotContain("LIMIT @Limit", sitemapArticleQuery, StringComparison.Ordinal);

        Assert.Contains("GetSeoConfigAsync", feed, StringComparison.Ordinal);
        Assert.Contains("GetSiteComplianceConfigAsync", feed, StringComparison.Ordinal);
        Assert.Contains("LoadFeedArticlesAsync", feed, StringComparison.Ordinal);
        Assert.Contains("LIMIT @Limit", feed, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll", sitemap, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll", feed, StringComparison.Ordinal);
    }

    private static T RunWithCulture<T>(string cultureName, Func<T> action)
    {
        CultureInfo previousCulture = CultureInfo.CurrentCulture;
        CultureInfo previousUiCulture = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo culture = CultureInfo.GetCultureInfo(cultureName);
            CultureInfo.CurrentCulture = culture;
            CultureInfo.CurrentUICulture = culture;
            return action();
        }
        finally
        {
            CultureInfo.CurrentCulture = previousCulture;
            CultureInfo.CurrentUICulture = previousUiCulture;
        }
    }

}
