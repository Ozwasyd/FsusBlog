using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotDocumentComposerTests
{
    [Fact]
    public void ComposeDocument_UsesManifestEntryOverrideAndHeadLinks()
    {
        const string template = """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Loading...</title>
</head>
<body>
    <div id="app"></div>
    <script type="module" src="/assets/index-old.js"></script>
</body>
</html>
""";
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
    }

    [Fact]
    public void BuildSeoHeadTags_ArticleDetail_UsesArticleOgType()
    {
        string result = PublicAotDocumentComposer.BuildSeoHeadTags(
            PublicPageKind.ArticleDetail, "Title", "Site", "Desc", "https://example.com/");
        Assert.Contains("og:type\" content=\"article\"", result);
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
    public void BuildDeferredSpaBootScript_WithExplicitOverride_ReturnsScriptTag()
    {
        string result = PublicAotDocumentComposer.BuildDeferredSpaBootScript("<html></html>", "/assets/entry.js");
        Assert.Contains("fsus-spa-boot", result);
        Assert.Contains("/assets/entry.js", result);
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
    public void ComposeDocument_EmptyHeadLinks_NoExtraContent()
    {
        const string template = """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Loading...</title>
</head>
<body>
    <div id="app"></div>
</body>
</html>
""";
        string prepared = PublicAotDocumentComposer.PreparePublicDocumentTemplate(template);
        string html = PublicAotDocumentComposer.ComposeDocument(new PublicAotDocumentModel(
            PublicPageKind.Home, template, prepared, "Title", "Blog", "Desc",
            "https://example.com/", "<main/>", AedsPayload(("pageKind", "Home")), string.Empty, string.Empty, string.Empty, string.Empty));
        Assert.Contains("fsus-aot-bootstrap", html);
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
}
