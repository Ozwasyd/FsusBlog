using System.Text.Json;

using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Localization;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotDocumentComposerTests
{
    [Fact]
    public void ComposeDocument_BindsResolvedLocaleToDocumentAndOpenGraph()
    {
        string template = Template();
        string prepared = PublicAotDocumentComposer.PreparePublicDocumentTemplate(template);
        LocaleDescriptor locale = LocaleCatalog.Enabled.Single(static candidate => candidate.Code == "ja-JP");

        string html = PublicAotDocumentComposer.ComposeDocument(new PublicAotDocumentModel(
            PublicPageKind.Home,
            template,
            prepared,
            "ホーム",
            "FsusBlog",
            "説明",
            "https://example.com/",
            "<main>ホーム</main>",
            AedsPayload(("pageKind", "Home"), ("renderLocale", "ja-JP")),
            AedsPayload(("pageKind", "Home"), ("renderLocale", "ja-JP")),
            string.Empty,
            string.Empty,
            string.Empty)
        {
            Locale = locale
        });

        Assert.Contains("<html lang=\"ja-JP\" dir=\"ltr\">", html, StringComparison.Ordinal);
        Assert.Contains("<main>ホーム</main>", html, StringComparison.Ordinal);
        Assert.Contains("property=\"og:locale\" content=\"ja_JP\"", html, StringComparison.Ordinal);
    }

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
            "https://example.com/",
            "<main>hello</main>",
            AedsPayload(("pageKind", "Home")),
            AedsPayload(("pageKind", "Home"), ("routeKey", "home")),
            string.Empty,
            "/assets/fsus-spa-entry.js",
            "    <link rel=\"stylesheet\" href=\"/assets/public-page-a.css\" data-fsusblog-style=\"public-manifest\" />",
            UsesSourceAssets: false,
            FrontendBuildIdentity: "release-build"));

        Assert.Contains("/assets/fsus-spa-entry.js", html);
        Assert.Contains("\"frontendBuildIdentity\":\"release-build\"", html);
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
    public void BuildSeoHeadModel_UsesVersionedDigestAndSameAtomicPayloadAsHtml()
    {
        PublicSeoHeadModel model = PublicAotDocumentComposer.BuildSeoHeadModel(
            PublicPageKind.ArticleDetail,
            "Article",
            "Blog",
            "Description",
            "https://example.com/article/42");

        string html = PublicAotDocumentComposer.BuildSeoHeadTags(model);

        Assert.Equal(PublicSeoHeadContract.Schema, model.Schema);
        Assert.Equal(PublicSeoHeadContract.Version, model.Version);
        Assert.True(model.HasValidContractAndDigest());
        Assert.False((model with
        {
            Description = "tampered"
        }).HasValidContractAndDigest());
        Assert.Contains("name=\"robots\"", html);
        Assert.Contains("data-fsus-seo-head-model", html);
        Assert.Contains(model.Digest, html);
        Assert.Contains("rel=\"canonical\" href=\"https://example.com/article/42\"", html);
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
    public void BuildSeoHeadTags_IncludesFeedDiscoveryWithoutIndexableSearchPageJsonLd()
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
        Assert.DoesNotContain("\"@type\":\"SearchAction\"", result);
        Assert.DoesNotContain("/search", result, StringComparison.Ordinal);
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
    public void BuildSeoHeadModel_TreatsDatabaseTimestampsAsUtc()
    {
        var databaseTimestamp = new DateTime(2026, 7, 17, 0, 56, 33, DateTimeKind.Unspecified);
        PublicSeoHeadModel model = PublicAotDocumentComposer.BuildSeoHeadModel(
            PublicPageKind.ArticleDetail,
            "Article",
            "Blog",
            "Description",
            "https://example.com/article/42",
            new PublicAotArticleSeoMetadata(
                "Article",
                "Description",
                "https://example.com/article/42",
                databaseTimestamp,
                databaseTimestamp,
                "Author",
                string.Empty,
                "Blog",
                string.Empty));

        using JsonDocument document = JsonDocument.Parse(model.JsonLdGraph);
        JsonElement posting = document.RootElement.GetProperty("@graph").EnumerateArray()
            .Single(static node => node.GetProperty("@type").GetString() == "BlogPosting");

        Assert.Equal("2026-07-17T00:56:33.0000000Z", posting.GetProperty("datePublished").GetString());
        Assert.Equal("2026-07-17T00:56:33.0000000Z", posting.GetProperty("dateModified").GetString());
        Assert.Equal(TimeSpan.Zero, model.ArticlePublishedAtUtc?.Offset);
        Assert.Equal(TimeSpan.Zero, model.ArticleModifiedAtUtc?.Offset);
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
    public void BuildSeoHeadTags_ArticleDetail_EmitsMultiAuthorProfilesWithoutUnsafeUrls()
    {
        string result = PublicAotDocumentComposer.BuildSeoHeadTags(
            PublicPageKind.ArticleDetail,
            "Article",
            "Blog",
            "Description",
            "https://example.com/article/42",
            new PublicAotArticleSeoMetadata(
                "Article",
                "Description",
                "https://example.com/article/42",
                DateTime.UnixEpoch,
                DateTime.UnixEpoch,
                "Fallback",
                string.Empty,
                "Blog",
                string.Empty,
                [
                    new PublicAotArticleAuthorMetadata("Alice", "https://example.com/authors/alice"),
                    new PublicAotArticleAuthorMetadata("Bob", "javascript:alert(1)")
                ]));

        using JsonDocument document = JsonDocument.Parse(ExtractJsonLd(result));
        JsonElement posting = document.RootElement.GetProperty("@graph").EnumerateArray()
            .Single(static node => node.GetProperty("@type").GetString() == "BlogPosting");
        JsonElement.ArrayEnumerator authors = posting.GetProperty("author").EnumerateArray();
        JsonElement[] authorItems = authors.ToArray();

        Assert.Equal(
            new[] { "Alice", "Bob" },
            authorItems.Select(static author => author.GetProperty("name").GetString() ?? string.Empty).ToArray());
        Assert.Equal("https://example.com/authors/alice", authorItems[0].GetProperty("url").GetString());
        Assert.False(authorItems[1].TryGetProperty("url", out _));
    }

    [Theory]
    [InlineData(PublicPageKind.Home, "WebPage")]
    [InlineData(PublicPageKind.About, "WebPage")]
    [InlineData(PublicPageKind.Archive, "CollectionPage")]
    [InlineData(PublicPageKind.Filter, "CollectionPage")]
    public void BuildSeoHeadModel_EmitsOneSiteNodeAndCorrectPageEntity(PublicPageKind kind, string expectedPageType)
    {
        PublicSeoHeadModel model = PublicAotDocumentComposer.BuildSeoHeadModel(
            kind,
            "Page",
            "Blog",
            "Page description",
            "https://example.com/page");

        using JsonDocument document = JsonDocument.Parse(model.JsonLdGraph);
        JsonElement[] graph = document.RootElement.GetProperty("@graph").EnumerateArray().ToArray();

        Assert.Single(graph, static node => node.GetProperty("@type").GetString() == "WebSite");
        Assert.Single(graph, node => node.GetProperty("@type").GetString() == expectedPageType);
    }

    [Theory]
    [InlineData("/uploads/article-cover.webp", "https://example.com/uploads/article-cover.webp")]
    [InlineData("javascript:alert(1)", "https://example.com/social/site.png")]
    [InlineData("", "https://example.com/social/site.png")]
    public void BuildSeoHeadModel_UsesOneValidatedAbsoluteSocialImage(string cover, string expected)
    {
        PublicSeoHeadModel model = PublicAotDocumentComposer.BuildSeoHeadModel(
            PublicPageKind.ArticleDetail,
            "Article",
            "Blog",
            "Description",
            "https://example.com/article/42",
            new PublicAotArticleSeoMetadata(
                "Article",
                "Description",
                "https://example.com/article/42",
                DateTime.UnixEpoch,
                DateTime.UnixEpoch.AddDays(1),
                "Author",
                cover,
                "Blog",
                "/logo.svg"),
            "/social/site.png");

        using JsonDocument document = JsonDocument.Parse(model.JsonLdGraph);
        JsonElement posting = document.RootElement.GetProperty("@graph").EnumerateArray()
            .Single(static node => node.GetProperty("@type").GetString() == "BlogPosting");

        Assert.Equal(expected, model.OpenGraph.ImageUrl);
        Assert.Equal(expected, model.Twitter.ImageUrl);
        Assert.Equal(expected, model.ArticleImageUrl);
        Assert.Equal(expected, posting.GetProperty("image").GetString());
    }

    [Fact]
    public void BuildSeoHeadTags_DoesNotEmitMetaKeywords()
    {
        string result = PublicAotDocumentComposer.BuildSeoHeadTags(
            PublicPageKind.Home, "Home", "Blog", "Description", "https://example.com/");

        Assert.DoesNotContain("name=\"keywords\"", result, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void BuildPublicBootMarkup_WithExplicitOverride_ReturnsConfigAndKernel()
    {
        string result = PublicAotDocumentComposer.BuildPublicBootMarkup(
            "<html></html>",
            "/assets/entry.js",
            frontendBuildIdentity: "release-build");
        Assert.Contains("fsus-public-boot-config", result);
        Assert.Contains("/assets/entry.js", result);
        Assert.Contains("\"frontendBuildIdentity\":\"release-build\"", result);
        Assert.Contains("/assets/fsus-public-boot-kernel.js", result);
        Assert.DoesNotContain("requestIdleCallback", result);
        Assert.DoesNotContain("createPolicy", result);
        Assert.DoesNotContain(" nonce=", result);
    }

    [Fact]
    public void BuildPublicBootMarkup_CspNonceIsOwnedByArtifactCompiler()
    {
        string markup = PublicAotDocumentComposer.BuildPublicBootMarkup(
            "<html></html>",
            "/assets/entry.js",
            frontendBuildIdentity: "release-build");

        CspNonceUtf8Template template = Assert.IsType<CspNonceUtf8Template>(
            CspNonceUtf8Template.Compile(
                $"<html><head></head><body>{markup}</body></html>",
                "public-boot:test"));

        Assert.DoesNotContain(" nonce=", markup);
        Assert.Equal(3, template.SlotCount);
        Assert.Contains(
            CspNonceUtf8Template.Placeholder,
            System.Text.Encoding.UTF8.GetString(template.IntegrityBytes.Span));
    }

    [Fact]
    public void BuildPublicBootMarkup_WithDevTemplate_PrefersSourceEntryOverProductionOverride()
    {
        string template = Template(
            headMarkup: "<script type=\"module\" src=\"/src/bootstrap/preTheme.ts\"></script>",
            spaScript: "<script type=\"module\" src=\"/src/bootstrap/entry.ts\"></script>");

        string result = PublicAotDocumentComposer.BuildPublicBootMarkup(template, "/assets/fsus-spa-entry.js", usesSourceAssets: true);

        Assert.Contains("\"entryUrl\":\"/src/bootstrap/entry.ts\"", result);
        Assert.Contains("/src/bootstrap/publicBootKernel.ts", result);
        Assert.DoesNotContain("/assets/fsus-spa-entry.js", result);
        Assert.DoesNotContain("preTheme.ts", result);
    }

    [Fact]
    public void BuildPublicBootMarkup_WithTakeoverAssets_OnlySerializesData()
    {
        string result = PublicAotDocumentComposer.BuildPublicBootMarkup(
            "<html></html>",
            "/assets/entry.js",
            ["/assets/full-app-core.js", "/assets/vendor-element-plus.js"],
            ["/assets/full-app-core.css"]);

        Assert.Contains("\"coreModulePreloads\":[\"/assets/full-app-core.js\",\"/assets/vendor-element-plus.js\"]", result);
        Assert.Contains("\"takeoverStylesheets\":[\"/assets/full-app-core.css\"]", result);
        Assert.DoesNotContain("requestIdleCallback", result);
        Assert.DoesNotContain("pointerdown", result);
    }

    [Fact]
    public void BuildPublicBootMarkup_NoEntryScript_ReturnsEmpty()
    {
        string result = PublicAotDocumentComposer.BuildPublicBootMarkup("<html></html>", null);
        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void InjectAppShell_CollapsesWhitespaceAroundSentinel()
    {
        string template = "<div id=\"app\">\n      <!--fsus:aot:app-->\n    </div>";
        string result = PublicAotDocumentComposer.InjectAppShell(template, "\n<div id=\"fsus-aot-shell\">ok</div>\n");
        Assert.Equal("<div id=\"app\"><div id=\"fsus-aot-shell\">ok</div></div>", result);
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
        const string Template = "<html><body><script type=\"module\" src=\"/assets/index.js\"></script></body></html>";
        string result = PublicAotDocumentComposer.PreparePublicDocumentTemplate(Template);
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

        Assert.Contains("<title data-fsus-aot-head>Public title - Blog</title>", html);
        Assert.Contains("<body class=\"source-body\" data-fsusblog-public-first-paint=\"true\" data-fsusblog-public-shell=\"true\">", html);
        string normalizedHtml = html.Replace("\r\n", "\n", StringComparison.Ordinal);
        // Template whitespace around the app sentinel must collapse so #app has
        // only the shell root (no pre-hydration client whitespace deletion).
        Assert.Contains("<div id=\"app\"><main>shell</main></div>", normalizedHtml);
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
        const string StartMarker = "<script type=\"application/ld+json\" data-fsus-aot-head>";
        int start = html.IndexOf(StartMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, "missing JSON-LD script");
        start += StartMarker.Length;
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
