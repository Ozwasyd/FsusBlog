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
        AssertMarkers(minimal, [], ["fsus-public-search-mode", "fsus-author-plugin-preview",
            "fsus-document-export-tasks", "fsus-pdf-export", "fsus-public-hot-articles", "fsus-article-read-proof"]);

        var enabled = WebPages.PrepareTemplate(BaselineTemplate, new PageShellCapabilities(
            PublicSearchMode: "server", PluginPreview: true, DocumentExportTasks: true,
            PdfExport: true, PublicHotArticles: true, ArticleReadProof: true));

        var headClose = enabled.IndexOf("</head>", StringComparison.Ordinal);
        Assert.True(headClose > 0);
        var head = enabled[..headClose];

        string[] expectedMarkers =
        [
            "<meta name=\"fsus-public-search-mode\" content=\"server\">",
            PluginPreviewEndpoints.Marker, DocumentExportEndpoints.Marker,
            PdfDocumentExport.PageMarker, PublicHotArticles.PageMarker, ArticleReadEndpoints.PageMarker,
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
            PublicSearchMode: "local", DocumentExportTasks: true, PublicHotArticles: true, ArticleReadProof: true), site, appearance);

        const string css = "<link rel=\"stylesheet\" href=\"/site-appearance/current.css\">";
        const string noIndex = "<meta name=\"robots\" content=\"noindex, follow\">";

        // 1. Public indexable shell
        AssertMarkers(Encoding.UTF8.GetString(pages.PublicPage("<p>Hello</p>", title: "Archive <1>", publicPath: "/archive", locale: "zh-CN")),
            ["<html lang=\"zh-CN\">", "<title>Archive &lt;1&gt; &#xB7; Fsu &lt;Blog&gt; &amp; Notes</title>", css,
             "<meta name=\"fsus-locale\" content=\"zh-CN\">", "<meta name=\"fsus-site-title\" content=\"Fsu &lt;Blog&gt; &amp; Notes\">",
             "<meta name=\"description\" content=\"Desc &quot;quoted&quot; &lt;tag&gt;\">", "<link rel=\"canonical\" href=\"https://blog.example.test/archive\">",
             $"href=\"{DistributionSnapshot.RssPath}\"", "<meta name=\"author\" content=\"Alice &amp; Bob\">", "<div class=\"public-initial\">"],
            ["name=\"robots\"", "fsus-public-origin"]);

        // 2. Public non-indexable search listing shell
        AssertMarkers(Encoding.UTF8.GetString(pages.PublicListingPage("page.search", "en", "/search")),
            ["<html lang=\"en\">", noIndex, css],
            ["rel=\"canonical\"", DistributionSnapshot.RssPath, "fsus-public-origin"]);

        // 3. Site Auth shell (/login, /register)
        AssertMarkers(Encoding.UTF8.GetString(pages.SiteLoginPage("en")),
            ["<header class=\"site-auth-header\">", noIndex, css],
            ["public-initial", "rel=\"canonical\"", "fsus-public-origin"]);

        // 4. Reader workspace app shell (/user/*, /subscribe)
        AssertMarkers(Encoding.UTF8.GetString(pages.Page()),
            [css, "<meta name=\"fsus-site-title\"", "<div id=\"app\"></div>"],
            ["public-initial", "site-auth-header", "fsus-public-origin"]);

        // 5. Admin & authoring shell (/admin*, /admin/articles/write, /admin/canvas, /admin/assets)
        AssertMarkers(Encoding.UTF8.GetString(pages.AdminPage(site.Origin)),
            [noIndex, "<meta name=\"fsus-public-origin\" content=\"https://blog.example.test\">",
             "<meta name=\"fsus-site-title\" content=\"Fsu &lt;Blog&gt; &amp; Notes\">", DocumentExportEndpoints.Marker, "<div id=\"app\"></div>"],
            ["/site-appearance/", "public-initial", "site-auth-header", "rel=\"canonical\"", DistributionSnapshot.RssPath, "name=\"author\""]);

        // Admin shell without configured public origin omits fsus-public-origin cleanly
        AssertMarkers(Encoding.UTF8.GetString(pages.AdminPage(null)),
            [noIndex], ["fsus-public-origin", "/site-appearance/"]);
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
        Assert.Equal(first, Encoding.UTF8.GetString(pages.AdminPage("https://blog.example.test")));
        AssertOnce(first, "fsus-public-origin", "name=\"robots\"", "fsus-site-title", DocumentExportEndpoints.Marker);

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
        AssertOnce(directPublic, "/site-appearance/current.css", "name=\"robots\"", "name=\"fsus-locale\"", "name=\"fsus-site-title\"");

        var directAdmin = Encoding.UTF8.GetString(direct.AdminPage("https://other.test"));
        AssertOnce(directAdmin, "name=\"fsus-public-origin\"", "name=\"robots\"");

        // Content containing </head> or slot marker must not inject head metadata inside body
        var trickyContent = "<pre></head><!--fsus-public-content--></pre>";
        var rendered = Encoding.UTF8.GetString(pages.PublicPage(trickyContent, publicPath: "/", locale: "en"));
        Assert.Contains(trickyContent, rendered, StringComparison.Ordinal);
        AssertOnce(rendered, "name=\"fsus-locale\"", "name=\"fsus-site-title\"");
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

    private static void AssertMarkers(string html, string[] present, string[] absent)
    {
        Assert.All(present, m => Assert.Contains(m, html, StringComparison.Ordinal));
        Assert.All(absent, m => Assert.DoesNotContain(m, html, StringComparison.Ordinal));
    }

    private static void AssertOnce(string html, params string[] tokens) =>
        Assert.All(tokens, t => Assert.Equal(1, CountOccurrences(html, t)));

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
