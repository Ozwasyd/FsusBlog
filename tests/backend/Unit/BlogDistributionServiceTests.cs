using System.Globalization;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Tests.TestInfrastructure;

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
    public void BuildSitemapAsync_SourceCachesByArticleListVersionAndLoadsInputsConcurrently()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Distribution/BlogDistributionService.cs");
        string build = ExtractMethod(source, "public async Task<string> BuildSitemapAsync", "public async Task<DistributionDiagnosticsCounts> GetDiagnosticsCountsAsync");
        string snapshot = ExtractMethod(source, "private async Task<DistributionSnapshot> LoadSnapshotAsync", "private async Task<int> CountPublicArticlesAsync");

        Assert.Contains("GetArticleListVersionAsync", build, StringComparison.Ordinal);
        Assert.Contains("sitemap:v:{version}", build, StringComparison.Ordinal);
        Assert.Contains("memoryCache.TryGetValue(cacheKey", build, StringComparison.Ordinal);
        Assert.Contains("Task.WhenAll(snapshotTask, categoriesTask, tagsTask)", build, StringComparison.Ordinal);
        Assert.Contains("memoryCache.Set(cacheKey, sitemap", build, StringComparison.Ordinal);
        Assert.Contains("Task.WhenAll(seoTask, complianceTask, rowsTask)", snapshot, StringComparison.Ordinal);
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

    private static string ExtractMethod(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        int endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        Assert.True(endIndex > startIndex, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }
}
