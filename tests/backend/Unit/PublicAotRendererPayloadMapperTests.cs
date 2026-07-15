using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotRendererPayloadMapperTests
{
    [Fact]
    public void HomeOptions_UseFlatBootstrapShape()
    {
        IReadOnlyDictionary<string, object?> payload = PublicAotRendererPayloadMapper.ToBuildEntryPayload(new PublicAotRenderRequest(
            new PublicAotRouteMatch(PublicPageKind.Home, PublicPageId.Home, "home:page:2", "/", "/", "?page=2") { Page = 2 },
            new PublicHomePageSnapshot(
                Seo(),
                Page: 2,
                Size: 10,
                Total: 1,
                Items:
                [
                    new PublicAotArticleSummarySnapshot(
                        10,
                        "Home article",
                        "Summary",
                        7,
                        DateTime.UnixEpoch,
                        new PublicAotArticleCategorySnapshot(2, "Category"),
                        [new PublicAotArticleTagSnapshot(3, "Tag")])
                ],
                FeaturedArticles:
                [
                    new PublicAotFeaturedArticleSnapshot(
                        10,
                        "Home article",
                        "/cover.svg",
                        7,
                        DateTime.UnixEpoch,
                        new PublicAotArticleCategorySnapshot(2, "Category"))
                ],
                HotArticles:
                [
                    new PublicAotHotArticleSnapshot(10, "Home article", 7)
                ])));

        IReadOnlyDictionary<string, object?> options = GetOptions(payload);

        Assert.False(options.ContainsKey("response"));
        Assert.Equal("home:page:2", options["routeKey"]);
        Assert.Equal(1, options["total"]);
        Assert.Single(Assert.IsType<Dictionary<string, object?>[]>(options["articles"]));
        Assert.Single(Assert.IsType<Dictionary<string, object?>[]>(options["featuredArticles"]));
        Assert.Single(Assert.IsType<Dictionary<string, object?>[]>(options["hotArticles"]));
    }

    [Fact]
    public void ArticleDetailOptions_UseHydrationBodyContentName()
    {
        IReadOnlyDictionary<string, object?> payload = PublicAotRendererPayloadMapper.ToBuildEntryPayload(new PublicAotRenderRequest(
            new PublicAotRouteMatch(PublicPageKind.ArticleDetail, PublicPageId.ArticleDetail, "article:42", "/article/42", "/article/42", string.Empty),
            new PublicArticlePageSnapshot(
                Seo(),
                ArticleId: 42,
                Title: "Article",
                Content: "# Body",
                Summary: "Summary",
                Views: 9,
                AuthorName: "Author",
                CreateTime: DateTime.UnixEpoch,
                Category: new PublicAotArticleCategorySnapshot(2, "Category"),
                Tags: [new PublicAotArticleTagSnapshot(3, "Tag")],
                Rights: Rights(),
                RelatedReading: null)
            {
                Authors =
                [
                    new PublicAotResponsiblePersonSnapshot("Alice", "https://example.test/alice"),
                    new PublicAotResponsiblePersonSnapshot("Bob", null)
                ]
            }));

        IReadOnlyDictionary<string, object?> options = GetOptions(payload);

        Assert.False(options.ContainsKey("content"));
        Assert.Equal("# Body", options["bodyContent"]);
        Dictionary<string, object?>[] authors = Assert.IsType<Dictionary<string, object?>[]>(options["authors"]);
        Assert.Equal(new[] { "Alice", "Bob" }, authors.Select(static author => author["name"] as string ?? string.Empty).ToArray());
    }

    [Fact]
    public void ArticleDetailOptions_ExposeRightsForPublicHydration()
    {
        IReadOnlyDictionary<string, object?> payload = PublicAotRendererPayloadMapper.ToBuildEntryPayload(new PublicAotRenderRequest(
            new PublicAotRouteMatch(PublicPageKind.ArticleDetail, PublicPageId.ArticleDetail, "article:42", "/article/42", "/article/42", string.Empty),
            new PublicArticlePageSnapshot(
                Seo(),
                ArticleId: 42,
                Title: "Article",
                Content: "# Body",
                Summary: "Summary",
                Views: 9,
                AuthorName: "Author",
                CreateTime: DateTime.UnixEpoch,
                Category: new PublicAotArticleCategorySnapshot(2, "Category"),
                Tags: [],
                Rights: Rights(),
                RelatedReading: null)));

        IReadOnlyDictionary<string, object?> options = GetOptions(payload);
        IReadOnlyDictionary<string, object?> rights = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(options["rights"]);

        Assert.Equal("901", rights["snapshotId"]);
        Assert.Equal("CC-BY-4.0", rights["licenseType"]);
        Assert.Equal("append-attribution", rights["copyPolicy"]);
        Assert.Equal("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", rights["policyHash"]);
    }

    [Fact]
    public void FilterOptions_ExposeFilterSubObject()
    {
        IReadOnlyDictionary<string, object?> payload = PublicAotRendererPayloadMapper.ToBuildEntryPayload(new PublicAotRenderRequest(
            new PublicAotRouteMatch(PublicPageKind.Filter, PublicPageId.Filter, "category:2", "/category/2", "/category/2", string.Empty),
            new PublicFilterPageSnapshot(
                Seo(),
                RouteKey: "category:2",
                FilterType: "category",
                FilterKey: "category:2",
                FilterId: 2,
                FilterName: "Category",
                IsInvalidTarget: false,
                PageIndex: 1,
                PageSize: 10,
                Total: 0,
                Articles: [],
                Title: "Category")));

        IReadOnlyDictionary<string, object?> options = GetOptions(payload);
        IReadOnlyDictionary<string, object?> filter = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(options["filter"]);

        Assert.Equal("category", filter["filterType"]);
        Assert.Equal("category:2", filter["filterKey"]);
        Assert.Equal(2, filter["filterId"]);
        Assert.Equal("Category", filter["filterName"]);
        Assert.Equal(false, filter["isInvalidTarget"]);
        Assert.Equal(1, filter["pageIndex"]);
        Assert.Equal(10, filter["pageSize"]);
        Assert.Equal(0, filter["total"]);
    }

    private static IReadOnlyDictionary<string, object?> GetOptions(IReadOnlyDictionary<string, object?> payload)
        => Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(payload["options"]);

    private static PublicAotSeoSnapshot Seo()
        => new("FsusBlog", "Description", "https://example.test");

    private static PublicAotArticleRightsSnapshot Rights()
        => new(
            SnapshotId: 901,
            RevisionId: 801,
            RevisionNo: 7,
            Enabled: true,
            LicenseType: "CC-BY-4.0",
            CopyrightHolder: "Fsus",
            CopyrightYear: 2026,
            RightsStatement: "Reuse with attribution.",
            AttributionTemplate: "{title} - {holder}",
            CopyPolicy: "append-attribution",
            MaxExcerptChars: 300,
            AllowCodeCopy: true,
            ShowPublicBadge: true,
            ProofBindingEnabled: true,
            CanonicalUrl: "https://fsus.example/article/42",
            PolicyHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ContentCanonicalHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ProofUrl: "urn:fsus:rights-proof:901",
            ProofStatus: "ready");
}
