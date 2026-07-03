using System.Globalization;
using System.Diagnostics;
using System.Text.Json.Serialization;
using System.Xml.Linq;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Caching.Memory;
using SqlSugar;

namespace FsusBlog.Server.Services.Distribution;

public sealed class BlogDistributionService(
    ISqlSugarClient db,
    ISystemService systemService,
    IUnifiedCache cache,
    IMemoryCache memoryCache)
{
    private const int FeedLimit = 50;
    private const int StaticSitemapPageCount = 6;
    private const string DiagnosticsCacheKey = "distribution:diagnostics-counts:v1";
    private static readonly TimeSpan DiagnosticsCacheTtl = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan SitemapCacheTtl = TimeSpan.FromMinutes(5);
    private static readonly XNamespace AtomNamespace = "http://www.w3.org/2005/Atom";

    public async Task<string> BuildRssAsync(CancellationToken cancellationToken = default)
    {
        DistributionSnapshot snapshot = await LoadSnapshotAsync(cancellationToken);
        var channel = new XElement(
            "channel",
            new XElement("title", snapshot.Seo.Title),
            new XElement("link", snapshot.BaseUrl),
            new XElement("description", snapshot.Seo.Description),
            new XElement("language", "zh-CN"),
            new XElement("copyright", ResolveCopyrightText(snapshot.Seo, snapshot.Compliance)),
            new XElement("lastBuildDate", FormatRfc822(snapshot.UpdatedAt)),
            snapshot.Articles.Select(article => new XElement(
                "item",
                new XElement("title", article.Title),
                new XElement("link", article.CanonicalUrl),
                new XElement("guid", new XAttribute("isPermaLink", "true"), article.CanonicalUrl),
                new XElement("description", article.Summary),
                new XElement("author", snapshot.Seo.Author),
                new XElement("pubDate", FormatRfc822(article.UpdatedAt)),
                string.IsNullOrWhiteSpace(article.CoverImageUrl)
                    ? null
                    : new XElement("enclosure", new XAttribute("url", MakeAbsoluteUrl(snapshot.BaseUrl, article.CoverImageUrl)), new XAttribute("type", "image/*")))));

        var document = new XDocument(
            new XDeclaration("1.0", "utf-8", null),
            new XElement(
                "rss",
                new XAttribute("version", "2.0"),
                channel));
        return document.ToString(SaveOptions.DisableFormatting);
    }

    public async Task<string> BuildAtomAsync(CancellationToken cancellationToken = default)
    {
        DistributionSnapshot snapshot = await LoadSnapshotAsync(cancellationToken);
        var document = new XDocument(
            new XDeclaration("1.0", "utf-8", null),
            new XElement(
                AtomNamespace + "feed",
                new XElement(AtomNamespace + "title", snapshot.Seo.Title),
                new XElement(AtomNamespace + "subtitle", snapshot.Seo.Description),
                new XElement(AtomNamespace + "id", snapshot.BaseUrl),
                new XElement(AtomNamespace + "updated", ToWireIsoDate(snapshot.UpdatedAt)),
                new XElement(AtomNamespace + "link", new XAttribute("href", snapshot.BaseUrl), new XAttribute("rel", "alternate")),
                new XElement(AtomNamespace + "link", new XAttribute("href", $"{snapshot.BaseUrl}/feed/atom.xml"), new XAttribute("rel", "self")),
                new XElement(AtomNamespace + "author", new XElement(AtomNamespace + "name", snapshot.Seo.Author)),
                snapshot.Articles.Select(article => new XElement(
                    AtomNamespace + "entry",
                    new XElement(AtomNamespace + "title", article.Title),
                    new XElement(AtomNamespace + "id", article.CanonicalUrl),
                    new XElement(AtomNamespace + "link", new XAttribute("href", article.CanonicalUrl), new XAttribute("rel", "alternate")),
                    new XElement(AtomNamespace + "updated", ToWireIsoDate(article.UpdatedAt)),
                    new XElement(AtomNamespace + "summary", article.Summary)))));
        return document.ToString(SaveOptions.DisableFormatting);
    }

    public async Task<JsonFeedDocument> BuildJsonFeedAsync(CancellationToken cancellationToken = default)
    {
        DistributionSnapshot snapshot = await LoadSnapshotAsync(cancellationToken);
        return new JsonFeedDocument(
            "https://jsonfeed.org/version/1.1",
            snapshot.Seo.Title,
            snapshot.BaseUrl,
            $"{snapshot.BaseUrl}/feed/feed.json",
            snapshot.Seo.Description,
            [new JsonFeedAuthor(snapshot.Seo.Author)],
            snapshot.Articles.Select(article => new JsonFeedItem(
                article.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                article.CanonicalUrl,
                article.Title,
                article.Summary,
                article.UpdatedAt.ToUniversalTime(),
                string.IsNullOrWhiteSpace(article.CoverImageUrl) ? null : MakeAbsoluteUrl(snapshot.BaseUrl, article.CoverImageUrl))).ToArray());
    }

    public async Task<string> BuildSitemapAsync(CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        long version = await GetArticleListVersionAsync(cancellationToken);
        string cacheKey = $"sitemap:v:{version}";
        if (memoryCache.TryGetValue(cacheKey, out string? cached) && cached is not null)
        {
            FsusObservability.RecordSitemapBuild(cacheHit: true, FsusObservability.GetElapsed(startedAt));
            return cached;
        }

        DistributionSnapshot snapshot = await LoadSnapshotAsync(cancellationToken);
        IReadOnlyList<DistributionTaxonomyRow> categories = await LoadCategoriesAsync(cancellationToken);
        IReadOnlyList<DistributionTaxonomyRow> tags = await LoadTagsAsync(cancellationToken);

        var urls = new List<(string Location, DateTimeOffset UpdatedAt, string Priority)>
        {
            ($"{snapshot.BaseUrl}/", snapshot.UpdatedAt, "1.0"),
            ($"{snapshot.BaseUrl}/archive", snapshot.UpdatedAt, "0.7"),
            ($"{snapshot.BaseUrl}/about", snapshot.UpdatedAt, "0.6"),
            ($"{snapshot.BaseUrl}/privacy", snapshot.UpdatedAt, "0.4"),
            ($"{snapshot.BaseUrl}/guidelines", snapshot.UpdatedAt, "0.4"),
            ($"{snapshot.BaseUrl}/copyright", snapshot.UpdatedAt, "0.4")
        };
        urls.AddRange(snapshot.Articles.Select(article => (article.CanonicalUrl, article.UpdatedAt, "0.9")));
        urls.AddRange(categories.Select(category => ($"{snapshot.BaseUrl}/category/{category.Id}", snapshot.UpdatedAt, "0.5")));
        urls.AddRange(tags.Select(tag => ($"{snapshot.BaseUrl}/tag/{tag.Id}", snapshot.UpdatedAt, "0.5")));

        XNamespace ns = "http://www.sitemaps.org/schemas/sitemap/0.9";
        var document = new XDocument(
            new XDeclaration("1.0", "utf-8", null),
            new XElement(
                ns + "urlset",
                urls.Select(url => new XElement(
                    ns + "url",
                    new XElement(ns + "loc", url.Location),
                    new XElement(ns + "lastmod", ToWireSitemapDate(url.UpdatedAt)),
                    new XElement(ns + "priority", url.Priority)))));
        string sitemap = document.ToString(SaveOptions.DisableFormatting);
        memoryCache.Set(cacheKey, sitemap, SitemapCacheTtl);
        FsusObservability.RecordSitemapBuild(cacheHit: false, FsusObservability.GetElapsed(startedAt));
        return sitemap;
    }

    public async Task<DistributionDiagnosticsCounts> GetDiagnosticsCountsAsync(CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        if (memoryCache.TryGetValue(DiagnosticsCacheKey, out DistributionDiagnosticsCounts? cached) && cached is not null)
        {
            FsusObservability.RecordDistributionDiagnostics(cacheHit: true, dbCommandCount: 0, FsusObservability.GetElapsed(startedAt));
            return cached;
        }

        int dbCommandCount = 0;
        int publicArticleCount = await CountPublicArticlesAsync(cancellationToken);
        dbCommandCount++;
        int publicCategoryCount = await CountPublicCategoriesAsync(cancellationToken);
        dbCommandCount++;
        int publicTagCount = await CountPublicTagsAsync(cancellationToken);
        dbCommandCount++;

        DateTimeOffset checkedAt = DateTimeOffset.UtcNow;
        var counts = new DistributionDiagnosticsCounts(
            StaticSitemapPageCount + publicArticleCount + publicCategoryCount + publicTagCount,
            Math.Min(publicArticleCount, FeedLimit),
            checkedAt);
        memoryCache.Set(DiagnosticsCacheKey, counts, DiagnosticsCacheTtl);
        FsusObservability.RecordDistributionDiagnostics(cacheHit: false, dbCommandCount, FsusObservability.GetElapsed(startedAt));
        return counts;
    }

    public async Task<int> CountSitemapUrlsAsync(CancellationToken cancellationToken = default)
        => (await GetDiagnosticsCountsAsync(cancellationToken)).SitemapUrlCount;

    public async Task<int> CountFeedItemsAsync(CancellationToken cancellationToken = default)
        => (await GetDiagnosticsCountsAsync(cancellationToken)).FeedItemCount;

    public async Task<string> BuildRobotsAsync(CancellationToken cancellationToken = default)
    {
        SeoConfigReadModel seo = await systemService.GetSeoConfigAsync();
        string baseUrl = NormalizeBaseUrl(seo.BaseUrl);
        return string.Join('\n',
            "User-agent: *",
            "Allow: /",
            "Allow: /feed/",
            "Allow: /sitemap.xml",
            "Allow: /robots.txt",
            "Allow: /api/public/",
            "Disallow: /login",
            "Disallow: /register",
            "Disallow: /user",
            "Disallow: /admin",
            "Disallow: /api/",
            "Disallow: /search/index.bin",
            "Disallow: /search/patches/",
            $"Sitemap: {baseUrl}/sitemap.xml",
            string.Empty);
    }

    private async Task<DistributionSnapshot> LoadSnapshotAsync(CancellationToken cancellationToken)
    {
        SeoConfigReadModel seo = await systemService.GetSeoConfigAsync();
        SiteComplianceConfigReadModel compliance = await systemService.GetSiteComplianceConfigAsync();
        List<DistributionArticleRow> rows = await LoadDistributionArticlesAsync(cancellationToken);
        string baseUrl = NormalizeBaseUrl(seo.BaseUrl);

        DateTimeOffset updatedAt = rows.Count == 0
            ? DateTimeOffset.UtcNow
            : rows.Max(static row => new DateTimeOffset(row.UpdatedAt, TimeSpan.Zero));
        return new DistributionSnapshot(
            seo,
            compliance,
            baseUrl,
            updatedAt,
            rows.Select(row => new DistributionArticle(
                row.Id,
                row.Title,
                string.IsNullOrWhiteSpace(row.Summary) ? row.Title : row.Summary!,
                row.CoverImageUrl,
                $"{baseUrl}{PublicRouteIdentity.BuildCanonicalPath(PublicPageId.ArticleDetail, PublicRouteIdentity.BuildArticleRouteKey(row.Id), row.Id)}",
                new DateTimeOffset(row.UpdatedAt, TimeSpan.Zero))).ToArray());
    }

    private async Task<List<DistributionArticleRow>> LoadDistributionArticlesAsync(CancellationToken cancellationToken)
    {
        DateTime now = DateTime.UtcNow;
        return await db.Queryable<Article, Category>((article, category) => article.CategoryId == category.Id)
            .Where((article, category) => article.IsDeleted == false
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= now)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= now))
            .OrderByDescending((article, category) => article.PublishedAt ?? article.CreateTime)
            .Take(FeedLimit)
            .Select((article, category) => new DistributionArticleRow
            {
                Id = article.Id,
                Title = article.Title,
                Summary = article.Summary,
                CoverImageUrl = article.CoverImageUrl,
                CreatedAt = article.CreateTime,
                PublishedAt = article.PublishedAt,
                CategoryId = article.CategoryId,
                CategoryName = category.Name
            })
            .ToListAsync(cancellationToken);
    }

    private async ValueTask<long> GetArticleListVersionAsync(CancellationToken cancellationToken)
    {
        string? version = await cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", cancellationToken);
        return long.TryParse(version, out long parsed) ? parsed : 0;
    }

    private async Task<int> CountPublicArticlesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int count = await db.Ado.GetIntAsync("""
            SELECT COUNT(1)
            FROM article a
            WHERE a.isdeleted = false
              AND a.status = @Status
              AND (a.published_at IS NULL OR a.published_at <= @Now)
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now);
            """, CreatePublicVisibilityParameters());
        cancellationToken.ThrowIfCancellationRequested();
        return count;
    }

    private async Task<int> CountPublicCategoriesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int count = await db.Ado.GetIntAsync("""
            SELECT COUNT(DISTINCT a.categoryid)
            FROM article a
            WHERE a.isdeleted = false
              AND a.status = @Status
              AND (a.published_at IS NULL OR a.published_at <= @Now)
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now);
            """, CreatePublicVisibilityParameters());
        cancellationToken.ThrowIfCancellationRequested();
        return count;
    }

    private async Task<int> CountPublicTagsAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int count = await db.Ado.GetIntAsync("""
            SELECT COUNT(DISTINCT at.tagid)
            FROM article_tag at
            INNER JOIN article a ON a.id = at.articleid
            WHERE a.isdeleted = false
              AND a.status = @Status
              AND (a.published_at IS NULL OR a.published_at <= @Now)
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now);
            """, CreatePublicVisibilityParameters());
        cancellationToken.ThrowIfCancellationRequested();
        return count;
    }

    private async Task<IReadOnlyList<DistributionTaxonomyRow>> LoadCategoriesAsync(CancellationToken cancellationToken)
    {
        DateTime now = DateTime.UtcNow;
        return await db.Queryable<Category, Article>((category, article) => category.Id == article.CategoryId)
            .Where((category, article) => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= now)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= now))
            .GroupBy((category, article) => new { category.Id, category.Name })
            .OrderBy((category, article) => category.Id)
            .Select((category, article) => new DistributionTaxonomyRow
            {
                Id = category.Id,
                Name = category.Name
            })
            .ToListAsync(cancellationToken);
    }

    private async Task<IReadOnlyList<DistributionTaxonomyRow>> LoadTagsAsync(CancellationToken cancellationToken)
    {
        DateTime now = DateTime.UtcNow;
        return await db.Queryable<Tag, ArticleTag, Article>((tag, articleTag, article) => tag.Id == articleTag.TagId && articleTag.ArticleId == article.Id)
            .Where((tag, articleTag, article) => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= now)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= now))
            .GroupBy((tag, articleTag, article) => new { tag.Id, tag.Name })
            .OrderBy((tag, articleTag, article) => tag.Id)
            .Select((tag, articleTag, article) => new DistributionTaxonomyRow
            {
                Id = tag.Id,
                Name = tag.Name
            })
            .ToListAsync(cancellationToken);
    }

    private static string NormalizeBaseUrl(string? raw)
        => string.IsNullOrWhiteSpace(raw) ? "https://fsus.blog" : raw.Trim().TrimEnd('/');

    private static SugarParameter[] CreatePublicVisibilityParameters()
        =>
        [
            new("@Status", (int)ArticleStatus.Published),
            new("@Now", DateTime.UtcNow)
        ];

    private static string MakeAbsoluteUrl(string baseUrl, string url)
        => Uri.TryCreate(url, UriKind.Absolute, out _)
            ? url
            : string.Concat(baseUrl, "/", url.TrimStart('/'));

    private static string ResolveCopyrightText(SeoConfigReadModel seo, SiteComplianceConfigReadModel compliance)
    {
        int currentYear = DateTime.UtcNow.Year;
        string owner = !string.IsNullOrWhiteSpace(compliance.CopyrightOwner)
            ? compliance.CopyrightOwner.Trim()
            : !string.IsNullOrWhiteSpace(seo.Title)
                ? seo.Title.Trim()
                : "FsusBlog";
        string yearRange = compliance.CopyrightStartYear is > 0 && compliance.CopyrightStartYear < currentYear
            ? $"{compliance.CopyrightStartYear}-{currentYear}"
            : currentYear.ToString(System.Globalization.CultureInfo.InvariantCulture);
        string text = !string.IsNullOrWhiteSpace(compliance.CopyrightText)
            ? compliance.CopyrightText.Trim()
            : "保留所有权利。";

        return $"© {yearRange} {owner}。{text}";
    }

    private static string FormatRfc822(DateTimeOffset value)
        => value.ToUniversalTime().ToString("r", CultureInfo.InvariantCulture);

    private static string ToWireIsoDate(DateTimeOffset value)
        => value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private static string ToWireSitemapDate(DateTimeOffset value)
        => value.ToUniversalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    internal static string ToWireIsoDateForTests(DateTimeOffset value)
        => ToWireIsoDate(value);

    internal static string ToWireSitemapDateForTests(DateTimeOffset value)
        => ToWireSitemapDate(value);

    private sealed record DistributionSnapshot(
        SeoConfigReadModel Seo,
        SiteComplianceConfigReadModel Compliance,
        string BaseUrl,
        DateTimeOffset UpdatedAt,
        IReadOnlyList<DistributionArticle> Articles);

    private sealed record DistributionArticle(
        int Id,
        string Title,
        string Summary,
        string? CoverImageUrl,
        string CanonicalUrl,
        DateTimeOffset UpdatedAt);

    private sealed class DistributionArticleRow
    {
        public int Id { get; init; }
        public string Title { get; init; } = string.Empty;
        public string? Summary { get; init; }
        public string? CoverImageUrl { get; init; }
        public DateTime CreatedAt { get; init; }
        public DateTime? PublishedAt { get; init; }
        public int CategoryId { get; init; }
        public string CategoryName { get; init; } = string.Empty;
        public DateTime UpdatedAt => PublishedAt ?? CreatedAt;
    }

    private sealed class DistributionTaxonomyRow
    {
        public int Id { get; init; }
        public string Name { get; init; } = string.Empty;
    }
}

public sealed record JsonFeedDocument(
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("home_page_url")] string HomePageUrl,
    [property: JsonPropertyName("feed_url")] string FeedUrl,
    [property: JsonPropertyName("description")] string Description,
    [property: JsonPropertyName("authors")] IReadOnlyList<JsonFeedAuthor> Authors,
    [property: JsonPropertyName("items")] IReadOnlyList<JsonFeedItem> Items);

public sealed record JsonFeedAuthor(
    [property: JsonPropertyName("name")] string Name);

public sealed record JsonFeedItem(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("url")] string Url,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("summary")] string Summary,
    [property: JsonPropertyName("date_published")] DateTimeOffset DatePublished,
    [property: JsonPropertyName("image")] string? Image);

public sealed record DistributionDiagnosticsCounts(
    int SitemapUrlCount,
    int FeedItemCount,
    DateTimeOffset CheckedAt);
