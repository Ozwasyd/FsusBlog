using System.Xml.Linq;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using NSubstitute;
using SqlSugar;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Tests.TestInfrastructure;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class BlogDistributionArtifactTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly XNamespace s_sitemapNamespace = "http://www.sitemaps.org/schemas/sitemap/0.9";

    [Fact]
    public async Task FeedStaysBoundedWhileFinalSitemapContainsEveryPublicCanonicalUrl()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int categoryId = db.Insertable(new Category { Name = "SEO" }).ExecuteReturnIdentity();
        int tagId = db.Insertable(new Tag { Name = "canonical" }).ExecuteReturnIdentity();
        var articleIds = new List<int>(55);
        for (int index = 0; index < 55; index++)
        {
            DateTime publishedAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(index);
            int articleId = db.Insertable(new Article
            {
                Title = $"Public article {index + 1}",
                Summary = $"Summary {index + 1}",
                CoverImageUrl = $"/uploads/illustration/{index + 1}.webp",
                CategoryId = categoryId,
                CreateTime = publishedAt,
                PublishedAt = publishedAt,
                Status = ArticleStatus.Published,
                IsDeleted = false
            }).ExecuteReturnIdentity();
            articleIds.Add(articleId);
            db.Insertable(new ArticleBody
            {
                ArticleId = articleId,
                MarkdownContent = $"# Body {index + 1}",
                UpdatedAt = publishedAt.AddHours(6)
            }).ExecuteCommand();
            db.Insertable(new ArticleTag { ArticleId = articleId, TagId = tagId }).ExecuteCommand();
        }

        int draftId = db.Insertable(new Article
        {
            Title = "Draft must stay private",
            CategoryId = categoryId,
            CreateTime = DateTime.UtcNow,
            Status = ArticleStatus.Draft,
            IsDeleted = false
        }).ExecuteReturnIdentity();
        db.Insertable(new ArticleBody { ArticleId = draftId, MarkdownContent = "private" }).ExecuteCommand();
        InsertStaticPages(db);

        IUnifiedCache cache = CreateVersionCache("1");
        using var memory = new MemoryCache(new MemoryCacheOptions());
        BlogDistributionService service = CreateService(db, cache, memory);

        string rss = await service.BuildRssAsync();
        JsonFeedDocument jsonFeed = await service.BuildJsonFeedAsync();
        string sitemap = await service.BuildSitemapAsync();
        XDocument sitemapDocument = XDocument.Parse(sitemap);
        string[] locations = sitemapDocument.Descendants(s_sitemapNamespace + "loc")
            .Select(static node => node.Value)
            .ToArray();

        Assert.Equal(50, XDocument.Parse(rss).Descendants("item").Count());
        Assert.Equal(50, jsonFeed.Items.Count);
        Assert.Equal(StaticPageCount + 55 + 1 + 1, locations.Length);
        Assert.Equal(55, locations.Count(static location => location.Contains("/article/", StringComparison.Ordinal)));
        Assert.All(articleIds, id => Assert.Contains($"https://public.example/article/{id}", locations));
        Assert.DoesNotContain($"https://public.example/article/{draftId}", locations);
        Assert.DoesNotContain("/search", sitemap, StringComparison.Ordinal);
        Assert.DoesNotContain("priority", sitemap, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("2026-01-03", ReadLastmod(sitemap, "https://public.example/about"));

        DistributionDiagnosticsCounts diagnostics = await service.GetDiagnosticsCountsAsync();
        Assert.Equal(locations.Length, diagnostics.SitemapUrlCount);
        Assert.Equal(50, diagnostics.FeedItemCount);
    }

    [Fact]
    public async Task ArticleLastmodTracksBodyUpdateAndEmptySiteNeverInventsCurrentTime()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int categoryId = db.Insertable(new Category { Name = "Updates" }).ExecuteReturnIdentity();
        DateTime publishedAt = new(2026, 3, 1, 8, 0, 0, DateTimeKind.Utc);
        int articleId = db.Insertable(new Article
        {
            Title = "Updated body",
            CategoryId = categoryId,
            CreateTime = publishedAt,
            PublishedAt = publishedAt,
            Status = ArticleStatus.Published,
            IsDeleted = false
        }).ExecuteReturnIdentity();
        db.Insertable(new ArticleBody
        {
            ArticleId = articleId,
            MarkdownContent = "v1",
            UpdatedAt = new DateTime(2026, 3, 4, 9, 0, 0, DateTimeKind.Utc)
        }).ExecuteCommand();

        IUnifiedCache cache = CreateVersionCache("1");
        using var memory = new MemoryCache(new MemoryCacheOptions());
        BlogDistributionService service = CreateService(db, cache, memory);
        string first = await service.BuildSitemapAsync();
        JsonFeedDocument firstFeed = await service.BuildJsonFeedAsync();
        Assert.Equal("2026-03-04", ReadLastmod(first, $"https://public.example/article/{articleId}"));
        Assert.Equal("2026-03-04", ReadFeedModifiedDate(firstFeed, articleId));

        db.Updateable<Article>()
            .SetColumns(article => article.Summary == "Non-body metadata changed")
            .SetColumns(article => article.Views == article.Views + 1)
            .Where(article => article.Id == articleId)
            .ExecuteCommand();
        db.Insertable(new Comment
        {
            Id = 1,
            ArticleId = articleId,
            Content = "A new public comment must not change article lastmod.",
            CreateTime = new DateTime(2026, 3, 7, 12, 0, 0, DateTimeKind.Utc),
            AuthorMode = "anonymous",
            IsDeleted = false,
            ModerationStatus = CommentModerationStatus.Approved
        }).ExecuteCommand();
        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>("2"));
        string metadataOnly = await service.BuildSitemapAsync();
        JsonFeedDocument metadataOnlyFeed = await service.BuildJsonFeedAsync();
        Assert.Equal("2026-03-04", ReadLastmod(metadataOnly, $"https://public.example/article/{articleId}"));
        Assert.Equal("2026-03-04", ReadFeedModifiedDate(metadataOnlyFeed, articleId));

        db.Updateable<ArticleBody>()
            .SetColumns(body => body.MarkdownContent == "v2")
            .SetColumns(body => body.UpdatedAt == new DateTime(2026, 3, 8, 10, 0, 0, DateTimeKind.Utc))
            .Where(body => body.ArticleId == articleId)
            .ExecuteCommand();
        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>("3"));
        string second = await service.BuildSitemapAsync();
        JsonFeedDocument secondFeed = await service.BuildJsonFeedAsync();
        Assert.Equal("2026-03-08", ReadLastmod(second, $"https://public.example/article/{articleId}"));
        Assert.Equal("2026-03-08", ReadFeedModifiedDate(secondFeed, articleId));

        using SqlSugarClient emptyDb = await CreateDatabaseAsync();
        using var emptyMemory = new MemoryCache(new MemoryCacheOptions());
        BlogDistributionService emptyService = CreateService(emptyDb, CreateVersionCache("empty"), emptyMemory);
        string emptyFirst = await emptyService.BuildSitemapAsync();
        string emptySecond = await emptyService.BuildSitemapAsync();
        Assert.Equal(emptyFirst, emptySecond);
        Assert.Equal(StaticPageCount, XDocument.Parse(emptyFirst).Descendants(s_sitemapNamespace + "url").Count());
        Assert.Empty(XDocument.Parse(emptyFirst).Descendants(s_sitemapNamespace + "lastmod"));
    }

    [Fact]
    public void SitemapCapacityUsesIndexAndBoundedChildDocuments()
    {
        (string root, IReadOnlyList<string> pages) = BlogDistributionService.BuildSitemapArtifactSetForTests(
            "https://public.example",
            45_001);

        XDocument index = XDocument.Parse(root);
        Assert.Equal("sitemapindex", index.Root?.Name.LocalName);
        Assert.Equal(2, pages.Count);
        Assert.Equal(45_000, XDocument.Parse(pages[0]).Descendants(s_sitemapNamespace + "url").Count());
        Assert.Single(XDocument.Parse(pages[1]).Descendants(s_sitemapNamespace + "url"));
        Assert.Contains("https://public.example/sitemap/1.xml", root, StringComparison.Ordinal);
        Assert.Contains("https://public.example/sitemap/2.xml", root, StringComparison.Ordinal);
    }

    private const int StaticPageCount = 6;

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Category),
            typeof(Tag),
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleTag),
            typeof(Comment),
            typeof(PageContent));
        return db;
    }

    private static BlogDistributionService CreateService(
        ISqlSugarClient db,
        IUnifiedCache cache,
        IMemoryCache memory)
    {
        ISystemService system = Substitute.For<ISystemService>();
        system.GetSeoConfigAsync().Returns(Task.FromResult(new SeoConfigReadModel
        {
            Title = "Public site",
            Description = "Public description",
            Author = "Author",
            BaseUrl = "https://public.example"
        }));
        system.GetSiteComplianceConfigAsync().Returns(Task.FromResult(new SiteComplianceConfigReadModel()));
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Seo:BaseUrl"] = "https://public.example"
            })
            .Build();
        return new BlogDistributionService(db, system, cache, memory, configuration);
    }

    private static IUnifiedCache CreateVersionCache(string version)
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>(version));
        return cache;
    }

    private static void InsertStaticPages(SqlSugarClient db)
    {
        db.Insertable(new[]
        {
            new PageContent { Slug = "about", Content = "About", UpdatedAt = new DateTime(2026, 1, 3, 0, 0, 0, DateTimeKind.Utc) },
            new PageContent { Slug = "privacy", Content = "Privacy", UpdatedAt = new DateTime(2026, 1, 4, 0, 0, 0, DateTimeKind.Utc) },
            new PageContent { Slug = "guidelines", Content = "Guidelines", UpdatedAt = new DateTime(2026, 1, 5, 0, 0, 0, DateTimeKind.Utc) },
            new PageContent { Slug = "copyright", Content = "Copyright", UpdatedAt = new DateTime(2026, 1, 6, 0, 0, 0, DateTimeKind.Utc) }
        }).ExecuteCommand();
    }

    private static string? ReadLastmod(string sitemap, string location)
    {
        XElement? url = XDocument.Parse(sitemap)
            .Descendants(s_sitemapNamespace + "url")
            .SingleOrDefault(node => string.Equals(
                node.Element(s_sitemapNamespace + "loc")?.Value,
                location,
                StringComparison.Ordinal));
        return url?.Element(s_sitemapNamespace + "lastmod")?.Value;
    }

    private static string ReadFeedModifiedDate(JsonFeedDocument feed, int articleId)
        => feed.Items
            .Single(item => string.Equals(item.Id, articleId.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal))
            .DateModified
            .ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
}
