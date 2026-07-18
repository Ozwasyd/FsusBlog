using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// PublicAotShellContractRules
// ──────────────────────────────────────────────────────────────────────────────

public class PublicAotShellContractRulesTests
{
    private const string DefaultPayload = "__default_payload__";

    private static PublicAotShellEntryContract MakeEntry(
        PublicPageId pageId = PublicPageId.Home,
        string routeKey = "home",
        string html = "<html>test</html>",
        string? bootstrap = DefaultPayload,
        string? hydration = DefaultPayload,
        string? rendererVersion = "public-app-ssr@1.0.0",
        int? articleId = null,
        string? islands = null)
        => new PublicAotShellEntryContract
        {
            PageId = pageId,
            RouteKey = routeKey,
            Html = html,
            BootstrapPayload = bootstrap == DefaultPayload ? Payload(("kind", "Home")) : bootstrap,
            HydrationPropsPayload = hydration == DefaultPayload ? Payload(("pageKind", "Home"), ("routeKey", "home")) : hydration,
            RendererVersion = rendererVersion,
            ArticleId = articleId,
            IslandsPayload = islands
        };

    // ─── TryValidateEntry ───────────────────────────────────────────────────

    [Fact]
    public void TryValidate_ValidHomeEntry_ReturnsTrue()
    {
        var entry = MakeEntry();
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out var route, out var html, out var err);
        Assert.True(ok);
        Assert.Equal(string.Empty, err);
        Assert.Equal("home", route);
    }

    [Fact]
    public void TryValidate_InvalidPageId_ReturnsFalse()
    {
        var entry = MakeEntry();
        entry = entry with
        {
            PageId = (PublicPageId)999
        };
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("页面类型非法", err);
    }

    [Fact]
    public void TryValidate_AccountEntry_ReturnsFalse()
    {
        var entry = MakeEntry(
            pageId: PublicPageId.Account,
            routeKey: "account",
            bootstrap: Payload(("kind", "Account"), ("pageKind", "Account"), ("routeKey", "account")),
            hydration: Payload(("pageKind", "Account"), ("routeKey", "account")));

        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);

        Assert.False(ok);
        Assert.Contains("未启用公开 shell", err);
    }

    [Fact]
    public void TryValidate_NullRendererVersion_ReturnsFalse()
    {
        var entry = MakeEntry(rendererVersion: null);
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("rendererVersion 为空", err);
    }

    [Fact]
    public void TryValidate_InvalidRendererVersionPrefix_ReturnsFalse()
    {
        var entry = MakeEntry(rendererVersion: "vite@1.0");
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("rendererVersion 非法", err);
    }

    [Fact]
    public void TryValidate_EmptyRouteKey_ReturnsFalse()
    {
        var entry = MakeEntry(routeKey: "   ");
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("路由为空", err);
    }

    [Fact]
    public void TryValidate_EmptyHtml_ReturnsFalse()
    {
        var entry = MakeEntry(html: "  ");
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("HTML 为空", err);
    }

    [Fact]
    public void TryValidate_EmptyBootstrapPayload_ReturnsFalse()
    {
        var entry = MakeEntry(bootstrap: null);
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("bootstrap 为空", err);
    }

    [Fact]
    public void TryValidate_EmptyHydrationPropsPayload_ReturnsFalse()
    {
        var entry = MakeEntry(hydration: "");
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("hydration props 为空", err);
    }

    [Fact]
    public void TryValidate_InvalidBootstrapPayload_ReturnsFalse()
    {
        var entry = MakeEntry(bootstrap: "not-aeds");
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("bootstrap 不是合法 AEDS", err);
    }

    // ─── NormalizeRouteKey ──────────────────────────────────────────────────

    [Fact]
    public void NormalizeRouteKey_Home_ReturnsHome()
    {
        string result = PublicAotShellContractRules.NormalizeRouteKey(PublicPageId.Home, "homepage", null);
        Assert.Equal("home", result);
    }

    [Fact]
    public void NormalizeRouteKey_HomePagination_PreservesNormalizedPageIdentity()
    {
        string result = PublicAotShellContractRules.NormalizeRouteKey(PublicPageId.Home, "home:page:2", null);
        Assert.Equal("home:page:2", result);
    }

    [Fact]
    public void NormalizeRouteKey_About_ReturnsAbout()
    {
        string result = PublicAotShellContractRules.NormalizeRouteKey(PublicPageId.About, "about-us", null);
        Assert.Equal("about", result);
    }

    [Fact]
    public void NormalizeRouteKey_Archive_ReturnsArchive()
    {
        string result = PublicAotShellContractRules.NormalizeRouteKey(PublicPageId.Archive, "archives", null);
        Assert.Equal("archive", result);
    }

    [Fact]
    public void NormalizeRouteKey_Account_ReturnsAccount()
    {
        string result = PublicAotShellContractRules.NormalizeRouteKey(PublicPageId.Account, "my-account", null);
        Assert.Equal("account", result);
    }

    [Fact]
    public void NormalizeRouteKey_OtherPageWithArticleId_ExpandsPlaceholder()
    {
        string result = PublicAotShellContractRules.NormalizeRouteKey(PublicPageId.Filter, "filter/{{articleId}}", 123);
        Assert.Equal("filter/123", result);
    }

    [Fact]
    public void NormalizeRouteKey_NoArticleId_KeepsPlaceholder()
    {
        string result = PublicAotShellContractRules.NormalizeRouteKey(PublicPageId.Filter, "filter/{{articleId}}", null);
        Assert.Equal("filter/{{articleId}}", result);
    }

    // ─── NormalizeHtml ──────────────────────────────────────────────────────

    [Fact]
    public void NormalizeHtml_NoArticleId_ReturnsSame()
    {
        string result = PublicAotShellContractRules.NormalizeHtml("<div>{{articleId}}</div>", null);
        Assert.Equal("<div>{{articleId}}</div>", result);
    }

    [Fact]
    public void NormalizeHtml_WithArticleId_ExpandsPlaceholder()
    {
        string result = PublicAotShellContractRules.NormalizeHtml("<div id='{{articleId}}'>content</div>", 42);
        Assert.Equal("<div id='42'>content</div>", result);
    }

    [Fact]
    public void NormalizeHtml_CaseInsensitive_Replaces()
    {
        string result = PublicAotShellContractRules.NormalizeHtml("<div>{{ARTICLEID}}</div>", 99);
        Assert.Equal("<div>99</div>", result);
    }

    // ─── Bootstrap validation ────────────────────────────────────────────────

    [Fact]
    public void ValidateBootstrapPayload_ArticleDetail_MissingArticleSection_ReturnsFalse()
    {
        var entry = MakeEntry(
            pageId: PublicPageId.ArticleDetail,
            articleId: 5,
            bootstrap: Payload(("kind", "ArticleDetail"), ("pageKind", "ArticleDetail")));
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("article 缺失", err);
    }

    [Fact]
    public void ValidateBootstrapPayload_ArticleDetail_WrongArticleId_ReturnsFalse()
    {
        var entry = MakeEntry(
            pageId: PublicPageId.ArticleDetail,
            articleId: 5,
            bootstrap: Payload(("article", new Dictionary<string, object?> { ["id"] = 10 })));
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("article.id 与 entry.articleId 不一致", err);
    }

    // ─── Hydration validation ────────────────────────────────────────────────

    [Fact]
    public void ValidateHydrationPropsPayload_MissingPageKind_ReturnsFalse()
    {
        var entry = MakeEntry(hydration: Payload());
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("hydration.pageKind", err);
    }

    [Fact]
    public void ValidateHydrationPropsPayload_WrongPageKind_ReturnsFalse()
    {
        var entry = MakeEntry(
            pageId: PublicPageId.Home,
            hydration: Payload(("pageKind", "About"), ("routeKey", "home")));
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("hydration.pageKind", err);
    }

    // ─── Islands validation ──────────────────────────────────────────────────

    [Fact]
    public void ValidateIslandsPayload_ArticleDetailWithoutIslands_ReturnsTrue()
    {
        var entry = MakeEntry(
            pageId: PublicPageId.ArticleDetail,
            routeKey: "article:5",
            articleId: 5,
            bootstrap: Payload(
                ("kind", "ArticleDetail"),
                ("pageKind", "ArticleDetail"),
                ("routeKey", "article:5"),
                ("article", new Dictionary<string, object?> { ["id"] = 5 })),
            hydration: Payload(
                ("pageKind", "ArticleDetail"),
                ("routeKey", "article:5"),
                ("articleId", 5),
                ("commentsIsland", new Dictionary<string, object?> { ["articleId"] = 5 })));

        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);

        Assert.True(ok, err);
    }

    [Fact]
    public void ValidateIslandsPayload_HomeWithIslands_ReturnsFalse()
    {
        var entry = MakeEntry(
            pageId: PublicPageId.Home,
            islands: Payload(("comments", new Dictionary<string, object?>())));
        bool ok = PublicAotShellContractRules.TryValidateEntry(entry, out _, out _, out var err);
        Assert.False(ok);
        Assert.Contains("payload retired", err);
    }

    private static string Payload(params (string Key, object? Value)[] values)
    {
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach ((string key, object? value) in values)
        {
            payload[key] = value;
        }

        return PublicAotBinaryPayload.EncodeObject(payload);
    }
}
