using System.Globalization;
using FsusBlog.Server.Services.Distribution;

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
