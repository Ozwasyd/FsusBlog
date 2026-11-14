using System.Buffers.Binary;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server.Content;
using Microsoft.Extensions.Configuration;

public sealed class PublicSiteConfigurationPostgresTests
{
    [Theory]
    [InlineData("FSUSBLOG_PUBLIC_SEO:OgImage", "//example.test/image")]
    [InlineData("FSUSBLOG_PUBLIC_SEO:OgImage", "/assets/../api/binary/media")]
    [InlineData("FSUSBLOG_PUBLIC_SEO:OgImage", "/assets/%2e%2e/oops.png")]
    [InlineData("FSUSBLOG_PUBLIC_SEO:OgImage", "https://user@example.test/icon.png")]
    [InlineData("FSUSBLOG_PUBLIC_SEO:OgImage", "https://example.test/icon.png?credential=one")]
    [InlineData("FSUSBLOG_PUBLIC_SEO:ThemeColor", "#11223344")]
    [InlineData("FSUSBLOG_PUBLIC_COMPLIANCE:ContactEmail", "Name <public@example.test>")]
    [InlineData("FSUSBLOG_PUBLIC_COMPLIANCE:CopyrightStartYear", "1982")]
    [InlineData("FSUSBLOG_PUBLIC_COMPLIANCE:IcpRecordUrl", "https://example.test/without-number")]
    [InlineData("FSUSBLOG_PUBLIC_COMPLIANCE:RegionMode", "request-country")]
    [InlineData("FSUSBLOG_PUBLIC_SEO:Title", "not valid \uFFFE")]
    public void InvalidPublicValueFailsBeforeServing(string key, string value)
    {
        var settings = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { [key] = value }).Build();
        var error = Assert.Throws<InvalidOperationException>(() => PublicSiteConfiguration.Read(settings));
        Assert.Contains(key, error.Message);
        Assert.DoesNotContain(value, error.Message);
    }

    [PostgresFact]
    public async Task PublicPodMetadataHtmlAndFeedsShareOneExplicitSite()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var ct = deadline.Token;
        await using var database = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var settings = new Dictionary<string, string>
        {
            ["FSUSBLOG_PUBLIC_ORIGIN"] = "https://blog.example.test:443/",
            ["FSUSBLOG_PUBLIC_SEO__Title"] = "North & <South>",
            ["FSUSBLOG_PUBLIC_SEO__Description"] = "Visible <script>description</script> & text",
            ["FSUSBLOG_PUBLIC_SEO__Author"] = "Public Author",
            ["FSUSBLOG_PUBLIC_SEO__ThemeColor"] = "#123456",
            ["FSUSBLOG_PUBLIC_SEO__OgImage"] = "/assets/site-social.png",
            ["FSUSBLOG_PUBLIC_SEO__FaviconSvgUrl"] = "/assets/favicon.svg",
            ["FSUSBLOG_PUBLIC_SEO__BaseUrl"] = "https://incorrect-config.example/",
            ["FSUSBLOG_PUBLIC_SEO__AdminLogoUrl"] = "https://admin-private.example/secret",
            ["FSUSBLOG_PUBLIC_SEO__Keywords"] = "private_compatibility_value",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__Enabled"] = "true",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__RegionMode"] = "mainland-cn",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__CopyrightOwner"] = "North Company",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__CopyrightStartYear"] = "2004",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__CopyrightText"] = "Some rights reserved",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__ContentLicenseName"] = "CC BY 4.0",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__ContentLicenseUrl"] = "https://creativecommons.org/licenses/by/4.0/",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__IcpRecordNumber"] = "Sample-public-number",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__ContactEmail"] = "info@example.test",
            ["FSUSBLOG_DB__PoolPassword"] = "postgres-private-placeholder"
        };
        await using var server = await ServerProcess.Start(database.ConnectionString, ct, settings);
        var seo = Read(Aeds.Decode(await ReadFrame(WireRoutes.PublicSeo), FrameType.SeoConfig).ToArray(),
            WireLayouts.SeoConfigPodBytes, WireLayouts.SeoConfigDescriptionOffset);
        Assert.Equal(settings["FSUSBLOG_PUBLIC_SEO__Title"], seo.Fixed(0, 256));
        Assert.Equal(settings["FSUSBLOG_PUBLIC_SEO__Description"], seo.Blob);
        Assert.Equal("https://blog.example.test", seo.Fixed(WireLayouts.SeoConfigBaseUrlOffset, WireLayouts.SeoConfigFaviconSvgUrlOffset));
        Assert.Equal("#123456", seo.Fixed(WireLayouts.SeoConfigThemeColorOffset, WireLayouts.SeoConfigBackgroundColorOffset));
        Assert.Empty(seo.Fixed(WireLayouts.SeoConfigKeywordsOffset, WireLayouts.SeoConfigAuthorOffset));
        Assert.Empty(seo.Fixed(WireLayouts.SeoConfigAdminLogoUrlOffset, WireLayouts.SeoConfigPodBytes));
        var compliance = Read(Aeds.Decode(await ReadFrame(WireRoutes.PublicCompliance), FrameType.SiteComplianceConfig).ToArray(),
            WireLayouts.SiteCompliancePodBytes, WireLayouts.SiteComplianceCopyrightTextOffset);
        Assert.Equal(1, compliance.Bytes[0]);
        Assert.Equal("mainland-cn", compliance.Fixed(WireLayouts.SiteComplianceRegionModeOffset, WireLayouts.SiteComplianceCopyrightStartYearOffset));
        Assert.Equal(2004, BinaryPrimitives.ReadInt32LittleEndian(compliance.Bytes.AsSpan(WireLayouts.SiteComplianceCopyrightStartYearOffset)));
        Assert.Equal("Some rights reserved", compliance.Blob);
        Assert.Equal("https://beian.miit.gov.cn/", compliance.Fixed(WireLayouts.SiteComplianceIcpRecordUrlOffset, WireLayouts.SiteCompliancePoliceRecordNumberOffset));
        Assert.Equal("info@example.test", compliance.Fixed(WireLayouts.SiteComplianceContactEmailOffset, WireLayouts.SiteCompliancePodBytes));

        using var homeResponse = await Request("/");
        var html = await homeResponse.Content.ReadAsStringAsync(ct);
        Assert.Contains("<title>North &amp; &lt;South&gt;</title>", html);
        Assert.Contains("href=\"https://blog.example.test/\"", html);
        Assert.Contains("name=\"theme-color\" content=\"#123456\"", html);
        Assert.Contains("href=\"/assets/favicon.svg\"", html);
        Assert.DoesNotContain("<script>description", html);
        Assert.DoesNotContain("meta name=\"keywords\"", html);
        Assert.DoesNotContain("incorrect-config", html);
        Assert.DoesNotContain("forged.example", html);
        var rss = XDocument.Parse(await server.Client.GetStringAsync("/feed/rss.xml", ct));
        Assert.Equal(seo.Fixed(0, 256), rss.Root!.Element("channel")!.Element("title")!.Value);
        Assert.Equal(seo.Blob, WebUtility.HtmlDecode(rss.Root!.Element("channel")!.Element("description")!.Value));
        Assert.Contains("North Company", rss.Root!.Element("channel")!.Element("copyright")!.Value);
        using var json = JsonDocument.Parse(await server.Client.GetStringAsync("/feed/feed.json", ct));
        Assert.Equal(seo.Fixed(0, 256), json.RootElement.GetProperty("title").GetString());
        Assert.Equal("https://blog.example.test/", json.RootElement.GetProperty("home_page_url").GetString());
        Assert.Equal("Public Author", Assert.Single(json.RootElement.GetProperty("authors").EnumerateArray()).GetProperty("name").GetString());

        using var admin = await Request("/api/binary/system/admin/seo");
        Assert.Equal(HttpStatusCode.NotFound, admin.StatusCode);
        using var head = await Request(WireRoutes.PublicCompliance, HttpMethod.Head);
        Assert.Equal("application/octet-stream", head.Content.Headers.ContentType!.MediaType);
        Assert.Empty(await head.Content.ReadAsByteArrayAsync(ct));

        async Task<byte[]> ReadFrame(string path)
        {
            using var response = await Request(path);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.True(response.Headers.CacheControl!.NoStore);
            Assert.Equal("application/octet-stream", response.Content.Headers.ContentType!.MediaType);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }

        async Task<HttpResponseMessage> Request(string path, HttpMethod? method = null)
        {
            using var request = new HttpRequestMessage(method ?? HttpMethod.Get, path);
            request.Headers.Host = "forged.example";
            return await server.Client.SendAsync(request, ct);
        }
    }

    private sealed record Pod(byte[] Bytes, string Blob)
    {
        internal string Fixed(int start, int end) => Encoding.UTF8.GetString(Bytes.AsSpan(start, end - start)).TrimEnd('\0');
    }

    private static Pod Read(byte[] bytes, int podSize, int slice)
    {
        var length = bytes.Length - podSize - 4;
        Assert.Equal(0, BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(slice)));
        Assert.Equal(length, BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(slice + 4)));
        Assert.Equal(length, BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(podSize)));
        return new(bytes, Encoding.UTF8.GetString(bytes.AsSpan(podSize + 4, length)));
    }
}
