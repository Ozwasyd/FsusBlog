using FsusBlog.Server.Infrastructure.PublicAot;
using System.Text.Json;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotDocumentComposerTests
{
    [Fact]
    public void ComposeDocument_UsesManifestEntryOverrideAndHeadLinks()
    {
        string template = Template(spaScript: "<script type=\"module\" src=\"/assets/index-old.js\"></script>");
        string prepared = PublicAotDocumentComposer.PreparePublicDocumentTemplate(template);

        string html = PublicAotDocumentComposer.ComposeDocument(new PublicAotDocumentModel(
            PublicPageKind.Home,
            template,
            prepared,
            "首页",
            "FsusBlog",
            "描述",
            "https://fsus.blog/",
            "<main>hello</main>",
            AedsPayload(("pageKind", "Home")),
            AedsPayload(("pageKind", "Home"), ("routeKey", "home")),
            string.Empty,
            "/assets/fsus-spa-entry.js",
            "    <link rel=\"stylesheet\" href=\"/assets/public-page-a.css\" data-fsusblog-style=\"public-manifest\" />"));

        Assert.Contains("/assets/fsus-spa-entry.js", html);
        Assert.Contains("/assets/public-page-a.css", html);
        Assert.DoesNotContain("/assets/index-old.js\" type=\"module\"", html);
        Assert.Contains("fsus-aot-bootstrap", html);
        Assert.Contains("data-fsus-aot-head", html);
    }

    [Fact]
    public void BuildSeoHeadTags_ArticleDetail_UsesArticleOgType()
    {
        string result = PublicAotDocumentComposer.BuildSeoHeadTags(
            PublicPageKind.ArticleDetail, "Title", "Site", "Desc", "https://example.com/");
        Assert.Contains("og:type\" content=\"article\"", result);
        Assert.All(result.Split('\n').Where(static line => line.Contains("<meta", StringComparison.Ordinal) || line.Contains("<link", StringComparison.Ordinal) || line.Contains("<script", StringComparison.Ordinal)), line => Assert.Contains("data-fsus-aot-head", line));
    }

    [Fact]
    public void ComposeDocument_RetiredIslandsPayload_IsNotEmbedded()
    {
        string template = Template();
        string prepared = PublicAotDocumentComposer.PreparePublicDocumentTemplate(template);

        string html = PublicAotDocumentComposer.ComposeDocument(new PublicAotDocumentModel(
            PublicPageKind.ArticleDetail,
            template,
            prepared,
            "Article",
            "Blog",
            "Desc",
            "https://example.com/article/1",
            "<main/>",
            AedsPayload(("pageKind", "ArticleDetail")),
            AedsPayload(("pageKind", "ArticleDetail"), ("routeKey", "article:1")),
            AedsPayload(("comments", new Dictionary<string, object?> { ["articleId"] = 1 })),
            string.Empty,
            string.Empty));

        Assert.DoesNotContain("fsus-aot-islands", html);
    }

    [Fact]
    public void ComposeDocument_HydrationPayload_UsesAedsSidecarMarker()
    {
        string template = Template();
        string prepared = PublicAotDocumentComposer.PreparePublicDocumentTemplate(template);
        string hydrationPayload = AedsPayload(("pageKind", "ArticleDetail"), ("routeKey", "article:1"));

        string html = PublicAotDocumentComposer.ComposeDocument(new PublicAotDocumentModel(
            PublicPageKind.ArticleDetail,
            template,
            prepared,
            "Article",
            "Blog",
            "Desc",
            "https://example.com/article/1",
            "<main/>",
            AedsPayload(("pageKind", "ArticleDetail")),
            hydrationPayload,
            string.Empty,
            string.Empty,
            string.Empty));

        Assert.Contains("id=\"fsus-aot-hydration-props\"", html);
        Assert.Contains("data-aeds-src=\"/aot-cache/payloads/", html);
        Assert.Contains(".aeds\"", html);
        Assert.DoesNotContain(hydrationPayload, html);
    }

    [Fact]
    public void BuildSeoHeadTags_NonArticle_UsesWebsiteOgType()
    {
        string result = PublicAotDocumentComposer.BuildSeoHeadTags(
            PublicPageKind.Home, "Title", "Site", "Desc", "https://example.com/");
        Assert.Contains("og:type\" content=\"website\"", result);
    }

    [Fact]
    public void BuildSeoHeadTags_EmptySiteTitle_UsesJustTitle()
    {
        string result = PublicAotDocumentComposer.BuildSeoHeadTags(
            PublicPageKind.Home, "MyTitle", "", "Desc", "https://example.com/");
        Assert.Contains("og:title\" content=\"MyTitle\"", result);
    }

    [Fact]
    public void BuildSeoHeadTags_WithSiteTitle_CombinesTitleAndSiteTitle()
    {
        string result = PublicAotDocumentComposer.BuildSeoHeadTags(
            PublicPageKind.Home, "Page", "Blog", "Desc", "https://example.com/");
        Assert.Contains("Page - Blog", result);
    }

    [Fact]
    public void BuildSeoHeadTags_IncludesFeedDiscoveryAndJsonLdSearchAction()
    {
        string result = PublicAotDocumentComposer.BuildSeoHeadTags(
            PublicPageKind.ArticleDetail, "Article", "Blog", "Desc", "https://example.com/article/1");

        Assert.Contains("rel=\"alternate\" type=\"application/rss+xml\"", result);
        Assert.Contains("href=\"/feed/rss.xml\"", result);
        Assert.Contains("rel=\"alternate\" type=\"application/atom+xml\"", result);
        Assert.Contains("href=\"/feed/atom.xml\"", result);
        Assert.Contains("rel=\"alternate\" type=\"application/feed+json\"", result);
        Assert.Contains("href=\"/feed/feed.json\"", result);
        Assert.Contains("\"@graph\"", result);
        Assert.Contains("\"@type\":\"WebSite\"", result);
        Assert.Contains("\"@type\":\"BlogPosting\"", result);
        Assert.Contains("\"@type\":\"BreadcrumbList\"", result);
        Assert.Contains("\"@type\":\"SearchAction\"", result);
        Assert.Contains("https://example.com/search?q={search_term_string}", result);
        Assert.Contains("\"position\":2", result);
    }

    [Fact]
    public void BuildSeoHeadTags_ArticleDetail_EmitsCompleteBlogPostingMetadata()
    {
        var publishedAt = new DateTime(2026, 06, 15, 12, 30, 0, DateTimeKind.Utc);
        var updatedAt = new DateTime(2026, 06, 16, 8, 15, 0, DateTimeKind.Utc);

        string result = PublicAotDocumentComposer.BuildSeoHeadTags(
            PublicPageKind.ArticleDetail,
            "标题 \"quote\" <tag> 🚀",
            "Blog",
            "摘要含有 <b>HTML</b> 与 CJK",
            "https://example.com/article/42",
            new PublicAotArticleSeoMetadata(
                "标题 \"quote\" <tag> 🚀",
                "摘要含有 <b>HTML</b> 与 CJK",
                "https://example.com/article/42",
                publishedAt,
                updatedAt,
                "Alice <Admin>",
                "/uploads/cover.png",
                "Blog",
                "/logo.svg"));

        using JsonDocument document = JsonDocument.Parse(ExtractJsonLd(result));
        JsonElement blogPosting = document.RootElement
            .GetProperty("@graph")
            .EnumerateArray()
            .Single(static item => item.GetProperty("@type").GetString() == "BlogPosting");

        Assert.Equal("标题 \"quote\" <tag> 🚀", blogPosting.GetProperty("headline").GetString());
        Assert.Equal("摘要含有 <b>HTML</b> 与 CJK", blogPosting.GetProperty("description").GetString());
        Assert.Equal("https://example.com/article/42", blogPosting.GetProperty("url").GetString());
        Assert.Equal("https://example.com/article/42", blogPosting.GetProperty("mainEntityOfPage").GetProperty("@id").GetString());
        Assert.Equal(publishedAt.ToString("O"), blogPosting.GetProperty("datePublished").GetString());
        Assert.Equal(updatedAt.ToString("O"), blogPosting.GetProperty("dateModified").GetString());
        Assert.Equal("Alice <Admin>", blogPosting.GetProperty("author").GetProperty("name").GetString());
        Assert.Equal("https://example.com/uploads/cover.png", blogPosting.GetProperty("image").GetString());
        Assert.Equal("Blog", blogPosting.GetProperty("publisher").GetProperty("name").GetString());
        Assert.Equal("https://example.com/logo.svg", blogPosting.GetProperty("publisher").GetProperty("logo").GetProperty("url").GetString());
        Assert.DoesNotContain("draft", result, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("moderation", result, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void BuildSeoHeadTags_NonArticle_DoesNotEmitArticleOnlyJsonLdFields()
    {
        string result = PublicAotDocumentComposer.BuildSeoHeadTags(
            PublicPageKind.About,
            "About",
            "Blog",
            "Desc",
            "https://example.com/about");

        Assert.DoesNotContain("\"@type\":\"BlogPosting\"", result);
        Assert.DoesNotContain("\"headline\"", result);
        Assert.DoesNotContain("\"datePublished\"", result);
        Assert.DoesNotContain("\"mainEntityOfPage\"", result);
    }

    [Fact]
    public void BuildDeferredSpaBootScript_WithExplicitOverride_ReturnsScriptTag()
    {
        string result = PublicAotDocumentComposer.BuildDeferredSpaBootScript("<html></html>", "/assets/entry.js");
        Assert.Contains("fsus-spa-boot", result);
        Assert.Contains("/assets/entry.js", result);
    }

    [Fact]
    public void BuildDeferredSpaBootScript_WithDevTemplate_PrefersSourceEntryOverProductionOverride()
    {
        string template = Template(
            headMarkup: "<script type=\"module\" src=\"/src/bootstrap/preTheme.ts\"></script>",
            spaScript: "<script type=\"module\" src=\"/src/bootstrap/entry.ts\"></script>");

        string result = PublicAotDocumentComposer.BuildDeferredSpaBootScript(template, "/assets/fsus-spa-entry.js");

        Assert.Contains("data-fsusblog-spa-entry=\"/src/bootstrap/entry.ts\"", result);
        Assert.Contains("const entrySrc = \"/src/bootstrap/entry.ts\";", result);
        Assert.DoesNotContain("/assets/fsus-spa-entry.js", result);
        Assert.DoesNotContain("preTheme.ts", result);
    }

    [Fact]
    public void BuildDeferredSpaBootScript_WithTakeoverAssets_DefersPreloadsUntilIdleOrIntent()
    {
        string result = PublicAotDocumentComposer.BuildDeferredSpaBootScript(
            "<html></html>",
            "/assets/entry.js",
            ["/assets/full-app-core.js", "/assets/vendor-element-plus.js"],
            ["/assets/full-app-core.css"]);

        Assert.Contains("const takeoverModulePreloads = [\"/assets/full-app-core.js\",\"/assets/vendor-element-plus.js\"]", result);
        Assert.Contains("const takeoverStylesheets = [\"/assets/full-app-core.css\"]", result);
        Assert.Contains("requestIdleCallback", result);
        Assert.Contains("window.addEventListener('pointerdown', onIntent", result);
        Assert.Contains("warmPreload();", result);
        Assert.DoesNotContain("rel = 'preload'", result);
        Assert.DoesNotContain("as = 'style'", result);
        Assert.DoesNotContain("window.requestAnimationFrame(() => {\n        warmPreload();", result);
    }

    [Fact]
    public void BuildDeferredSpaBootScript_NoEntryScript_ReturnsEmpty()
    {
        string result = PublicAotDocumentComposer.BuildDeferredSpaBootScript("<html></html>", null);
        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void EnsureShellRoot_NoExistingShell_WrapsContent()
    {
        string result = PublicAotDocumentComposer.EnsureShellRoot("<p>content</p>", PublicPageKind.Home);
        Assert.Contains("id=\"fsus-aot-shell\"", result);
        Assert.Contains("<p>content</p>", result);
    }

    [Fact]
    public void EnsureShellRoot_ExistingShellWithoutKind_AddsHydrationKind()
    {
        string html = "<div id=\"fsus-aot-shell\">content</div>";
        string result = PublicAotDocumentComposer.EnsureShellRoot(html, PublicPageKind.ArticleDetail);
        // Still contains the shell id
        Assert.Contains("id=\"fsus-aot-shell\"", result);
    }

    [Fact]
    public void ExtractAttributeValue_DoubleQuotes_ReturnsValue()
    {
        string result = PublicAotDocumentComposer.ExtractAttributeValue("<script src=\"/assets/entry.js\">", "src");
        Assert.Equal("/assets/entry.js", result);
    }

    [Fact]
    public void ExtractAttributeValue_SingleQuotes_ReturnsValue()
    {
        string result = PublicAotDocumentComposer.ExtractAttributeValue("<script src='/assets/entry.js'>", "src");
        Assert.Equal("/assets/entry.js", result);
    }

    [Fact]
    public void ExtractAttributeValue_AttributeNotPresent_ReturnsEmpty()
    {
        string result = PublicAotDocumentComposer.ExtractAttributeValue("<script type=\"module\">", "src");
        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void PreparePublicDocumentTemplate_StripsModuleScripts()
    {
        const string template = "<html><body><script type=\"module\" src=\"/assets/index.js\"></script></body></html>";
        string result = PublicAotDocumentComposer.PreparePublicDocumentTemplate(template);
        Assert.DoesNotContain("/assets/index.js", result);
    }

    [Fact]
    public void PreparePublicDocumentTemplate_StripsDevPreThemeAndEntryScripts()
    {
        string template = Template(
            headMarkup: "<script type=\"module\" src=\"/src/bootstrap/preTheme.ts\"></script>",
            spaScript: "<script type=\"module\" src=\"/src/bootstrap/entry.ts\"></script>");

        string result = PublicAotDocumentComposer.PreparePublicDocumentTemplate(template);

        Assert.DoesNotContain("/src/bootstrap/preTheme.ts", result);
        Assert.DoesNotContain("/src/bootstrap/entry.ts", result);
    }

    [Fact]
    public void ComposeDocument_EmptyHeadLinks_NoExtraContent()
    {
        string template = Template();
        string prepared = PublicAotDocumentComposer.PreparePublicDocumentTemplate(template);
        string html = PublicAotDocumentComposer.ComposeDocument(new PublicAotDocumentModel(
            PublicPageKind.Home, template, prepared, "Title", "Blog", "Desc",
            "https://example.com/", "<main/>", AedsPayload(("pageKind", "Home")), string.Empty, string.Empty, string.Empty, string.Empty));
        Assert.Contains("fsus-aot-bootstrap", html);
    }

    [Fact]
    public void ComposeDocument_WithTemplateVariants_InjectsBySentinel()
    {
        string template = Template(
            title: "Changed bootstrap title",
            bodyAttributes: " class=\"source-body\"",
            appMarkup: """
<div id="app">
    <!--fsus:aot:app-->
</div>
""");
        string prepared = PublicAotDocumentComposer.PreparePublicDocumentTemplate(template);

        string html = PublicAotDocumentComposer.ComposeDocument(new PublicAotDocumentModel(
            PublicPageKind.Home,
            template,
            prepared,
            "Public title",
            "Blog",
            "Desc",
            "https://example.com/",
            "<main>shell</main>",
            AedsPayload(("pageKind", "Home")),
            string.Empty,
            string.Empty,
            string.Empty,
            string.Empty));

        Assert.Contains("<title>Public title - Blog</title>", html);
        Assert.Contains("<body class=\"source-body\" data-fsusblog-public-first-paint=\"true\" data-fsusblog-public-shell=\"true\">", html);
        string normalizedHtml = html.Replace("\r\n", "\n", StringComparison.Ordinal);
        Assert.Contains("<div id=\"app\">\n    <main>shell</main>\n</div>", normalizedHtml);
    }

    [Fact]
    public void ComposeDocument_MissingSentinel_ThrowsClearError()
    {
        string template = Template().Replace("<!--fsus:aot:payloads-->", string.Empty, StringComparison.Ordinal);
        string prepared = PublicAotDocumentComposer.PreparePublicDocumentTemplate(template);

        var ex = Assert.Throws<InvalidOperationException>(() => PublicAotDocumentComposer.ComposeDocument(new PublicAotDocumentModel(
            PublicPageKind.Home,
            template,
            prepared,
            "Title",
            "Blog",
            "Desc",
            "https://example.com/",
            "<main/>",
            AedsPayload(("pageKind", "Home")),
            string.Empty,
            string.Empty,
            string.Empty,
            string.Empty)));

        Assert.Contains("public_aot_template_sentinel_missing:payloads", ex.Message);
    }

    private static string AedsPayload(params (string Key, object? Value)[] values)
    {
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach ((string key, object? value) in values)
        {
            payload[key] = value;
        }

        return PublicAotBinaryPayload.EncodeObject(payload);
    }

    private static string ExtractJsonLd(string html)
    {
        const string startMarker = "<script type=\"application/ld+json\" data-fsus-aot-head>";
        int start = html.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, "missing JSON-LD script");
        start += startMarker.Length;
        int end = html.IndexOf("</script>", start, StringComparison.Ordinal);
        Assert.True(end > start, "malformed JSON-LD script");
        return html[start..end];
    }

    private static string Template(
        string title = "Loading...",
        string bodyAttributes = "",
        string appMarkup = "<div id=\"app\"><!--fsus:aot:app--></div>",
        string headMarkup = "",
        string spaScript = "")
        => $"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    {headMarkup}
    <!--fsus:aot:head-start-->
    <title>{title}</title>
    <!--fsus:aot:head-end-->
</head>
<body{bodyAttributes}>
    {appMarkup}
    <!--fsus:aot:payloads-->
    <!--fsus:aot:spa-boot-->
    {spaScript}
</body>
</html>
""";
}
