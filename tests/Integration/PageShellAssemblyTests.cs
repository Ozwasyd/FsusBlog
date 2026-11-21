using System.Text;
using System.Text.RegularExpressions;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Analytics;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Operations;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PageShellAssemblyTests
{
    private const string BaselineTemplate =
        "<!doctype html><html lang=\"en\"><head><meta charset=\"UTF-8\"><title>Fsu's Blog</title>" +
        "<script type=\"module\" src=\"/assets/app.js\"></script></head>" +
        "<body><div id=\"app\"><!--fsus-public-content--></div></body></html>";

    [Fact]
    public void PrepareTemplateInjectsOnlyEnabledCapabilityMarkersOnceInCanonicalOrder()
    {
        var minimal = WebPages.PrepareTemplate(BaselineTemplate, new PageShellCapabilities());
        Assert.Equal(BaselineTemplate, minimal);
        Assert.DoesNotContain("fsus-public-search-mode", minimal, StringComparison.Ordinal);
        Assert.DoesNotContain("fsus-author-plugin-preview", minimal, StringComparison.Ordinal);
        Assert.DoesNotContain("fsus-document-export-tasks", minimal, StringComparison.Ordinal);
        Assert.DoesNotContain("fsus-pdf-export", minimal, StringComparison.Ordinal);
        Assert.DoesNotContain("fsus-public-hot-articles", minimal, StringComparison.Ordinal);
        Assert.DoesNotContain("fsus-article-read-proof", minimal, StringComparison.Ordinal);

        var enabled = WebPages.PrepareTemplate(BaselineTemplate, new PageShellCapabilities(
            PublicSearchMode: "server",
            PluginPreview: true,
            DocumentExportTasks: true,
            PdfExport: true,
            PublicHotArticles: true,
            ArticleReadProof: true));

        var headClose = enabled.IndexOf("</head>", StringComparison.Ordinal);
        Assert.True(headClose > 0);
        var head = enabled[..headClose];

        string[] expectedMarkers =
        [
            "<meta name=\"fsus-public-search-mode\" content=\"server\">",
            PluginPreviewEndpoints.Marker,
            DocumentExportEndpoints.Marker,
            PdfDocumentExport.PageMarker,
            PublicHotArticles.PageMarker,
            ArticleReadEndpoints.PageMarker,
        ];

        var previousIndex = -1;
        foreach (var marker in expectedMarkers)
        {
            var index = head.IndexOf(marker, StringComparison.Ordinal);
            Assert.True(index > previousIndex, $"Expected marker '{marker}' after index {previousIndex}.");
            Assert.Equal(1, CountOccurrences(enabled, marker));
            previousIndex = index;
        }

        Assert.Contains("<script type=\"module\" src=\"/assets/app.js\"></script>", head, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(enabled, WebPages.ContentSlot));
    }

    [Fact]
    public void PublicAuthReaderAndAdminShellsPreserveSurfaceBoundariesWithoutCrossSurfaceLeakage()
    {
        var site = PublicSiteConfiguration.Read(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
                [$"{PublicSiteConfiguration.SeoKey}:Title"] = "Fsu <Blog> & Notes",
                [$"{PublicSiteConfiguration.SeoKey}:Description"] = "Desc \"quoted\" <tag>",
                [$"{PublicSiteConfiguration.SeoKey}:Author"] = "Alice & Bob",
                [$"{PublicSiteConfiguration.SeoKey}:ThemeColor"] = "#112233",
                [$"{PublicSiteConfiguration.SeoKey}:OgImage"] = "https://cdn.example.test/og.png",
                [$"{PublicSiteConfiguration.SeoKey}:FaviconSvgUrl"] = "/assets/favicon.svg",
            })
            .Build());
        var appearance = new AppearanceAssets(null!, online: true);
        var pages = WebPages.Create(BaselineTemplate, new PageShellCapabilities(
            PublicSearchMode: "local",
            DocumentExportTasks: true,
            PublicHotArticles: true,
            ArticleReadProof: true), site, appearance);

        // 1. Public indexable shell
        var publicHtml = Encoding.UTF8.GetString(pages.PublicPage(
            "<p>Hello</p>", title: "Archive <1>", publicPath: "/archive", locale: "zh-CN"));
        Assert.Contains("<html lang=\"zh-CN\">", publicHtml, StringComparison.Ordinal);
        Assert.Contains("<title>Archive &lt;1&gt; &#xB7; Fsu &lt;Blog&gt; &amp; Notes</title>", publicHtml, StringComparison.Ordinal);
        Assert.Contains("<link rel=\"stylesheet\" href=\"/site-appearance/current.css\">", publicHtml, StringComparison.Ordinal);
        Assert.Contains("<meta name=\"fsus-locale\" content=\"zh-CN\">", publicHtml, StringComparison.Ordinal);
        Assert.Contains("<meta name=\"fsus-site-title\" content=\"Fsu &lt;Blog&gt; &amp; Notes\">", publicHtml, StringComparison.Ordinal);
        Assert.Contains("<meta name=\"description\" content=\"Desc &quot;quoted&quot; &lt;tag&gt;\">", publicHtml, StringComparison.Ordinal);
        Assert.Contains("<link rel=\"canonical\" href=\"https://blog.example.test/archive\">", publicHtml, StringComparison.Ordinal);
        Assert.Contains($"href=\"{DistributionSnapshot.RssPath}\"", publicHtml, StringComparison.Ordinal);
        Assert.Contains("<meta name=\"author\" content=\"Alice &amp; Bob\">", publicHtml, StringComparison.Ordinal);
        Assert.Contains("<div class=\"public-initial\">", publicHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("name=\"robots\"", publicHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("fsus-public-origin", publicHtml, StringComparison.Ordinal);

        // 2. Public non-indexable search listing shell
        var searchHtml = Encoding.UTF8.GetString(pages.PublicListingPage("page.search", "en", "/search"));
        Assert.Contains("<html lang=\"en\">", searchHtml, StringComparison.Ordinal);
        Assert.Contains("<meta name=\"robots\" content=\"noindex, follow\">", searchHtml, StringComparison.Ordinal);
        Assert.Contains("<link rel=\"stylesheet\" href=\"/site-appearance/current.css\">", searchHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("rel=\"canonical\"", searchHtml, StringComparison.Ordinal);
        Assert.DoesNotContain(DistributionSnapshot.RssPath, searchHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("fsus-public-origin", searchHtml, StringComparison.Ordinal);

        // 3. Site Auth shell (/login, /register)
        var loginHtml = Encoding.UTF8.GetString(pages.SiteLoginPage("en"));
        Assert.Contains("<header class=\"site-auth-header\">", loginHtml, StringComparison.Ordinal);
        Assert.Contains("<meta name=\"robots\" content=\"noindex, follow\">", loginHtml, StringComparison.Ordinal);
        Assert.Contains("<link rel=\"stylesheet\" href=\"/site-appearance/current.css\">", loginHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("public-initial", loginHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("rel=\"canonical\"", loginHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("fsus-public-origin", loginHtml, StringComparison.Ordinal);

        // 4. Reader workspace app shell (/user/*, /subscribe)
        var readerHtml = Encoding.UTF8.GetString(pages.Page());
        Assert.Contains("<link rel=\"stylesheet\" href=\"/site-appearance/current.css\">", readerHtml, StringComparison.Ordinal);
        Assert.Contains("<meta name=\"fsus-site-title\"", readerHtml, StringComparison.Ordinal);
        Assert.Contains("<div id=\"app\"></div>", readerHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("public-initial", readerHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("site-auth-header", readerHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("fsus-public-origin", readerHtml, StringComparison.Ordinal);

        // 5. Admin & authoring shell (/admin*, /admin/articles/write, /admin/canvas, /admin/assets)
        var adminHtml = Encoding.UTF8.GetString(pages.AdminPage(site.Origin));
        Assert.Contains("<meta name=\"robots\" content=\"noindex, follow\">", adminHtml, StringComparison.Ordinal);
        Assert.Contains("<meta name=\"fsus-public-origin\" content=\"https://blog.example.test\">", adminHtml, StringComparison.Ordinal);
        Assert.Contains("<meta name=\"fsus-site-title\" content=\"Fsu &lt;Blog&gt; &amp; Notes\">", adminHtml, StringComparison.Ordinal);
        Assert.Contains(DocumentExportEndpoints.Marker, adminHtml, StringComparison.Ordinal);
        Assert.Contains("<div id=\"app\"></div>", adminHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("/site-appearance/", adminHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("public-initial", adminHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("site-auth-header", adminHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("rel=\"canonical\"", adminHtml, StringComparison.Ordinal);
        Assert.DoesNotContain(DistributionSnapshot.RssPath, adminHtml, StringComparison.Ordinal);
        Assert.DoesNotContain("name=\"author\"", adminHtml, StringComparison.Ordinal);

        // Admin shell without configured public origin omits fsus-public-origin cleanly
        var adminNoOrigin = Encoding.UTF8.GetString(pages.AdminPage(null));
        Assert.DoesNotContain("fsus-public-origin", adminNoOrigin, StringComparison.Ordinal);
        Assert.DoesNotContain("/site-appearance/", adminNoOrigin, StringComparison.Ordinal);
        Assert.Contains("<meta name=\"robots\" content=\"noindex, follow\">", adminNoOrigin, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminPageHtmlEncodesPublicOriginAndRejectsNullBytes()
    {
        var pages = WebPages.Create(BaselineTemplate, new PageShellCapabilities());
        var encoded = Encoding.UTF8.GetString(pages.AdminPage("https://blog.example.test/\"<>&'"));
        Assert.Contains(
            "<meta name=\"fsus-public-origin\" content=\"https://blog.example.test/&quot;&lt;&gt;&amp;&#x27;\">",
            encoded, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(encoded, "fsus-public-origin"));

        Assert.Throws<InvalidOperationException>(() => pages.AdminPage("https://blog.example.test\0evil"));
    }

    [Fact]
    public void RenderPagePreventsDuplicateInjectionAndIgnoresContentSlotTokensInsideContent()
    {
        var appearance = new AppearanceAssets(null!, online: true);
        var site = PublicSiteConfiguration.Read(new ConfigurationBuilder().Build());

        // Repeated renders on the same WebPages instance must remain pure and produce identical output
        var pages = WebPages.Create(BaselineTemplate, new PageShellCapabilities(DocumentExportTasks: true), site, appearance);
        var first = Encoding.UTF8.GetString(pages.AdminPage("https://blog.example.test"));
        var second = Encoding.UTF8.GetString(pages.AdminPage("https://blog.example.test"));
        Assert.Equal(first, second);
        Assert.Equal(1, CountOccurrences(first, "fsus-public-origin"));
        Assert.Equal(1, CountOccurrences(first, "name=\"robots\""));
        Assert.Equal(1, CountOccurrences(first, "fsus-site-title"));
        Assert.Equal(1, CountOccurrences(first, DocumentExportEndpoints.Marker));

        // Direct WebPages construction with pre-existing head meta/stylesheet still must not duplicate tags
        var prePopulated = "<!doctype html><html lang=\"en\"><head>" +
            "<link rel=\"stylesheet\" href=\"/site-appearance/current.css\">" +
            "<meta name=\"robots\" content=\"noindex, follow\">" +
            "<meta name=\"fsus-locale\" content=\"en\">" +
            "<meta name=\"fsus-site-title\" content=\"Existing\">" +
            "<meta name=\"fsus-public-origin\" content=\"https://existing.test\">" +
            "</head><body><!--fsus-public-content--></body></html>";
        var direct = new WebPages(prePopulated, site, appearance);
        var directPublic = Encoding.UTF8.GetString(direct.PublicPage("hello", noIndex: true, locale: "en"));
        Assert.Equal(1, CountOccurrences(directPublic, "/site-appearance/current.css"));
        Assert.Single(Regex.Matches(directPublic, @"name=""robots"""));
        Assert.Single(Regex.Matches(directPublic, @"name=""fsus-locale"""));
        Assert.Single(Regex.Matches(directPublic, @"name=""fsus-site-title"""));

        var directAdmin = Encoding.UTF8.GetString(direct.AdminPage("https://other.test"));
        Assert.Single(Regex.Matches(directAdmin, @"name=""fsus-public-origin"""));
        Assert.Single(Regex.Matches(directAdmin, @"name=""robots"""));

        // Content containing </head> or slot marker must not inject head metadata inside body
        var trickyContent = "<pre></head><!--fsus-public-content--></pre>";
        var rendered = Encoding.UTF8.GetString(pages.PublicPage(trickyContent, publicPath: "/", locale: "en"));
        Assert.Contains(trickyContent, rendered, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(rendered, "name=\"fsus-locale\""));
        Assert.Equal(1, CountOccurrences(rendered, "name=\"fsus-site-title\""));
    }

    [Theory]
    [InlineData("", "template is invalid")]
    [InlineData("<html><head></head><body>\0<!--fsus-public-content--></body></html>", "template is invalid")]
    [InlineData("<html><head></head><body>no slot</body></html>", "missing the public content slot")]
    [InlineData("<html><head></head><body><!--fsus-public-content--><!--fsus-public-content--></body></html>", "duplicate public content slots")]
    [InlineData("<html><body><!--fsus-public-content--></body></html>", "missing a closing head tag")]
    [InlineData("<html><head></head><head></HEAD><body><!--fsus-public-content--></body></html>", "duplicate closing head tags")]
    [InlineData("<html><body><!--fsus-public-content--></body></head></html>", "invalid head/content slot order")]
    [InlineData("<html><head><meta name=\"fsus-pdf-export\" content=\"1\"></head><body><!--fsus-public-content--></body></html>", "must not pre-define server marker")]
    [InlineData("<html><head><meta name='fsus-public-origin' content='https://evil.test'></head><body><!--fsus-public-content--></body></html>", "must not pre-define server marker")]
    [InlineData("<html><head><meta name = fsus-locale content=en></head><body><!--fsus-public-content--></body></html>", "must not pre-define server marker")]
    [InlineData("<html><head><link rel=\"stylesheet\" href=\"/site-appearance/current.css\"></head><body><!--fsus-public-content--></body></html>", "must not pre-define site appearance")]
    public void PrepareTemplateFailsClosedOnMalformedOrTamperedShellInputs(string rawHtml, string expectedReason)
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            WebPages.PrepareTemplate(rawHtml, new PageShellCapabilities()));
        Assert.Contains(expectedReason, error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void PrepareTemplateFailsClosedOnInvalidPublicSearchMode()
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            WebPages.PrepareTemplate(BaselineTemplate, new PageShellCapabilities(PublicSearchMode: "hybrid")));
        Assert.Contains(SiteCapabilities.PublicSearchModeSetting, error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ContentSecurityPolicyPreservesRequiredDirectives()
    {
        const string expected =
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob: https:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
        Assert.Equal(expected, ServerHttp.ContentSecurityPolicy);
    }

    private static int CountOccurrences(string text, string value)
    {
        var count = 0;
        var index = 0;
        while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }
        return count;
    }
}
