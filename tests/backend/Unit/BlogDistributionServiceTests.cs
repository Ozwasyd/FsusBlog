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
    public void BuildSitemapAsync_RuntimeCachesByArticleListVersionAndAvoidsConcurrentDbUse()
    {
        string build = RuntimeMetadataInspection.DescribeMethods(
            typeof(BlogDistributionService),
            nameof(BlogDistributionService.BuildSitemapAsync));
        string snapshot = RuntimeMetadataInspection.DescribeMethods(
            typeof(BlogDistributionService),
            "LoadSnapshotAsync");

        Assert.Contains("GetArticleListVersionAsync", build, StringComparison.Ordinal);
        Assert.Contains("sitemap:v:", build, StringComparison.Ordinal);
        Assert.Contains("TryGetValue", build, StringComparison.Ordinal);
        Assert.Contains("LoadSnapshotAsync", build, StringComparison.Ordinal);
        Assert.Contains("LoadCategoriesAsync", build, StringComparison.Ordinal);
        Assert.Contains("LoadTagsAsync", build, StringComparison.Ordinal);
        Assert.Contains("Set", build, StringComparison.Ordinal);
        Assert.Contains("GetSeoConfigAsync", snapshot, StringComparison.Ordinal);
        Assert.Contains("GetSiteComplianceConfigAsync", snapshot, StringComparison.Ordinal);
        Assert.Contains("LoadDistributionArticlesAsync", snapshot, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll", build, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll", snapshot, StringComparison.Ordinal);
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
