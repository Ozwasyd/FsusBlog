using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
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
    IMemoryCache memoryCache,
    IConfiguration configuration)
{
    private const int FeedLimit = 50;
    private const int SitemapPageSize = 45_000;
    private const int StaticSitemapPageCount = 6;
    private const string DiagnosticsCacheKey = "distribution:diagnostics-counts:v2";
    private static readonly TimeSpan DiagnosticsCacheTtl = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan SitemapCacheTtl = TimeSpan.FromMinutes(5);
    private static readonly XNamespace AtomNamespace = "http://www.w3.org/2005/Atom";

    public async Task<string> BuildRssAsync(CancellationToken cancellationToken = default)
    {
        DistributionFeedSnapshot snapshot = await LoadFeedSnapshotAsync(cancellationToken);
        var channel = new XElement(
            "channel",
            new XElement("title", snapshot.Seo.Title),
            new XElement("link", snapshot.BaseUrl),
            new XElement("description", snapshot.Seo.Description),
            new XElement("language", "zh-CN"),
            new XElement("copyright", ResolveCopyrightText(snapshot.Seo, snapshot.Compliance)),
            snapshot.UpdatedAt is DateTimeOffset updatedAt
                ? new XElement("lastBuildDate", FormatRfc822(updatedAt))
                : null,
            snapshot.Articles.Select(article => new XElement(
                "item",
                new XElement("title", article.Title),
                new XElement("link", article.CanonicalUrl),
                new XElement("guid", new XAttribute("isPermaLink", "true"), article.CanonicalUrl),
                new XElement("description", article.Summary),
                new XElement("author", snapshot.Seo.Author),
                new XElement("pubDate", FormatRfc822(article.PublishedAt)),
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
        DistributionFeedSnapshot snapshot = await LoadFeedSnapshotAsync(cancellationToken);
        var document = new XDocument(
            new XDeclaration("1.0", "utf-8", null),
            new XElement(
                AtomNamespace + "feed",
                new XElement(AtomNamespace + "title", snapshot.Seo.Title),
                new XElement(AtomNamespace + "subtitle", snapshot.Seo.Description),
                new XElement(AtomNamespace + "id", snapshot.BaseUrl),
                snapshot.UpdatedAt is DateTimeOffset updatedAt
                    ? new XElement(AtomNamespace + "updated", ToWireIsoDate(updatedAt))
                    : null,
                new XElement(AtomNamespace + "link", new XAttribute("href", snapshot.BaseUrl), new XAttribute("rel", "alternate")),
                new XElement(AtomNamespace + "link", new XAttribute("href", $"{snapshot.BaseUrl}/feed/atom.xml"), new XAttribute("rel", "self")),
                new XElement(AtomNamespace + "author", new XElement(AtomNamespace + "name", snapshot.Seo.Author)),
                snapshot.Articles.Select(article => new XElement(
                    AtomNamespace + "entry",
                    new XElement(AtomNamespace + "title", article.Title),
                    new XElement(AtomNamespace + "id", article.CanonicalUrl),
                    new XElement(AtomNamespace + "link", new XAttribute("href", article.CanonicalUrl), new XAttribute("rel", "alternate")),
                    new XElement(AtomNamespace + "published", ToWireIsoDate(article.PublishedAt)),
                    new XElement(AtomNamespace + "updated", ToWireIsoDate(article.ModifiedAt)),
                    new XElement(AtomNamespace + "summary", article.Summary)))));
        return document.ToString(SaveOptions.DisableFormatting);
    }

    public async Task<JsonFeedDocument> BuildJsonFeedAsync(CancellationToken cancellationToken = default)
    {
        DistributionFeedSnapshot snapshot = await LoadFeedSnapshotAsync(cancellationToken);
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
                article.PublishedAt.ToUniversalTime(),
                article.ModifiedAt.ToUniversalTime(),
                string.IsNullOrWhiteSpace(article.CoverImageUrl) ? null : MakeAbsoluteUrl(snapshot.BaseUrl, article.CoverImageUrl))).ToArray());
    }

    public async Task<string> BuildSitemapAsync(CancellationToken cancellationToken = default)
        => (await LoadSitemapArtifactSetAsync(cancellationToken)).RootDocument;

    public async Task<string?> BuildSitemapPageAsync(int page, CancellationToken cancellationToken = default)
    {
        SitemapArtifactSet artifact = await LoadSitemapArtifactSetAsync(cancellationToken);
        return page >= 1 && page <= artifact.PageDocuments.Count
            ? artifact.PageDocuments[page - 1]
            : null;
    }

    public async Task<DistributionDiagnosticsCounts> GetDiagnosticsCountsAsync(CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        long version = await GetArticleListVersionAsync(cancellationToken);
        string baseUrl = await ResolvePublicOriginAsync(cancellationToken);
        string cacheKey = $"{DiagnosticsCacheKey}:v:{version}:origin:{baseUrl}";
        if (memoryCache.TryGetValue(cacheKey, out DistributionDiagnosticsCounts? cached) && cached is not null)
        {
            FsusObservability.RecordDistributionDiagnostics(cacheHit: true, dbCommandCount: 0, FsusObservability.GetElapsed(startedAt));
            return cached;
        }

        SitemapArtifactSet sitemap = await LoadSitemapArtifactSetAsync(cancellationToken);
        string rss = await BuildRssAsync(cancellationToken);
        int sitemapUrlCount = CountSitemapUrlsFromFinalArtifacts(sitemap);
        int feedItemCount = XDocument.Parse(rss).Descendants("item").Count();

        DateTimeOffset checkedAt = DateTimeOffset.UtcNow;
        var counts = new DistributionDiagnosticsCounts(
            sitemapUrlCount,
            feedItemCount,
            checkedAt);
        memoryCache.Set(cacheKey, counts, DiagnosticsCacheTtl);
        FsusObservability.RecordDistributionDiagnostics(cacheHit: false, dbCommandCount: 0, FsusObservability.GetElapsed(startedAt));
        return counts;
    }

    public async Task<int> CountSitemapUrlsAsync(CancellationToken cancellationToken = default)
        => (await GetDiagnosticsCountsAsync(cancellationToken)).SitemapUrlCount;

    public async Task<int> CountFeedItemsAsync(CancellationToken cancellationToken = default)
        => (await GetDiagnosticsCountsAsync(cancellationToken)).FeedItemCount;

    public async Task<string> BuildRobotsAsync(CancellationToken cancellationToken = default)
    {
        string baseUrl = await ResolvePublicOriginAsync(cancellationToken);
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

    private async Task<DistributionFeedSnapshot> LoadFeedSnapshotAsync(CancellationToken cancellationToken)
    {
        SeoConfigReadModel seo = await systemService.GetSeoConfigAsync();
        SiteComplianceConfigReadModel compliance = await systemService.GetSiteComplianceConfigAsync();
        List<DistributionArticleRow> rows = await LoadFeedArticlesAsync(cancellationToken);
        string baseUrl = PublicOriginPolicy.Resolve(configuration["Seo:BaseUrl"], seo.BaseUrl);

        DateTimeOffset? updatedAt = rows.Count == 0
            ? null
            : rows.Max(static row => ToUtcOffset(row.ModifiedAt));
        return new DistributionFeedSnapshot(
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
                ToUtcOffset(row.PublishedAt),
                ToUtcOffset(row.ModifiedAt))).ToArray());
    }

    private async Task<List<DistributionArticleRow>> LoadFeedArticlesAsync(CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT
                a.id AS "Id",
                a.title AS "Title",
                a.summary AS "Summary",
                a.coverimageurl AS "CoverImageUrl",
                COALESCE(a.published_at, a.createtime) AS "PublishedAt",
                COALESCE(body.updated_at, a.published_at, a.createtime) AS "ModifiedAt"
            FROM article a
            LEFT JOIN article_body body ON body.article_id = a.id
            WHERE a.isdeleted = false
              AND a.status = @Status
              AND (a.published_at IS NULL OR a.published_at <= @Now)
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)
            ORDER BY COALESCE(a.published_at, a.createtime) DESC, a.id DESC
            LIMIT @Limit;
            """;
        var rows = new List<DistributionArticleRow>(FeedLimit);
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            sql,
            CreatePublicVisibilityParameters(new SugarParameter("@Limit", FeedLimit)));
        while (await reader.ReadAsync(cancellationToken))
        {
            rows.Add(new DistributionArticleRow
            {
                Id = reader.GetInt32(reader.GetOrdinal("Id")),
                Title = reader.GetString(reader.GetOrdinal("Title")),
                Summary = ReadNullableString(reader, "Summary"),
                CoverImageUrl = ReadNullableString(reader, "CoverImageUrl"),
                PublishedAt = reader.GetDateTime(reader.GetOrdinal("PublishedAt")),
                ModifiedAt = reader.GetDateTime(reader.GetOrdinal("ModifiedAt"))
            });
        }
        return rows;
    }

    private async ValueTask<long> GetArticleListVersionAsync(CancellationToken cancellationToken)
    {
        string? version = await cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", cancellationToken);
        return long.TryParse(version, out long parsed) ? parsed : 0;
    }

    private async Task<SitemapArtifactSet> LoadSitemapArtifactSetAsync(CancellationToken cancellationToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        SeoConfigReadModel seo = await systemService.GetSeoConfigAsync();
        string baseUrl = PublicOriginPolicy.Resolve(configuration["Seo:BaseUrl"], seo.BaseUrl);
        long version = await GetArticleListVersionAsync(cancellationToken);
        IReadOnlyDictionary<string, DateTimeOffset> staticPageUpdates = await LoadStaticPageUpdatesAsync(cancellationToken);
        string staticVersion = string.Join(
            ',',
            staticPageUpdates.OrderBy(static pair => pair.Key, StringComparer.Ordinal)
                .Select(static pair => $"{pair.Key}:{pair.Value.UtcTicks}"));
        string cacheKey = $"sitemap:v:{version}:origin:{baseUrl}:static:{staticVersion}";
        if (memoryCache.TryGetValue(cacheKey, out SitemapArtifactSet? cached) && cached is not null)
        {
            FsusObservability.RecordSitemapBuild(cacheHit: true, FsusObservability.GetElapsed(startedAt));
            return cached;
        }

        IReadOnlyList<SitemapArticleRow> articles = await LoadSitemapArticlesAsync(cancellationToken);
        IReadOnlyList<SitemapTaxonomyRow> categories = await LoadSitemapCategoriesAsync(cancellationToken);
        IReadOnlyList<SitemapTaxonomyRow> tags = await LoadSitemapTagsAsync(cancellationToken);
        DateTimeOffset? collectionUpdatedAt = articles.Count == 0
            ? null
            : articles.Max(static article => article.ModifiedAt);
        var entries = new List<SitemapEntry>(StaticSitemapPageCount + articles.Count + categories.Count + tags.Count)
        {
            new($"{baseUrl}/", collectionUpdatedAt),
            new($"{baseUrl}/archive", collectionUpdatedAt),
            new($"{baseUrl}/about", GetOptionalUpdate(staticPageUpdates, "about")),
            new($"{baseUrl}/privacy", GetOptionalUpdate(staticPageUpdates, "privacy")),
            new($"{baseUrl}/guidelines", GetOptionalUpdate(staticPageUpdates, "guidelines")),
            new($"{baseUrl}/copyright", GetOptionalUpdate(staticPageUpdates, "copyright"))
        };
        entries.AddRange(articles.Select(article => new SitemapEntry(
            $"{baseUrl}{PublicRouteIdentity.BuildCanonicalPath(PublicPageId.ArticleDetail, PublicRouteIdentity.BuildArticleRouteKey(article.Id), article.Id)}",
            article.ModifiedAt)));
        entries.AddRange(categories.Select(category => new SitemapEntry($"{baseUrl}/category/{category.Id}", category.ModifiedAt)));
        entries.AddRange(tags.Select(tag => new SitemapEntry($"{baseUrl}/tag/{tag.Id}", tag.ModifiedAt)));

        SitemapArtifactSet artifact = BuildSitemapArtifactSet(baseUrl, entries);
        memoryCache.Set(cacheKey, artifact, SitemapCacheTtl);
        FsusObservability.RecordSitemapBuild(cacheHit: false, FsusObservability.GetElapsed(startedAt));
        return artifact;
    }

    private async Task<IReadOnlyList<SitemapArticleRow>> LoadSitemapArticlesAsync(CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT
                a.id AS "Id",
                COALESCE(body.updated_at, a.published_at, a.createtime) AS "ModifiedAt"
            FROM article a
            LEFT JOIN article_body body ON body.article_id = a.id
            WHERE a.isdeleted = false
              AND a.status = @Status
              AND (a.published_at IS NULL OR a.published_at <= @Now)
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)
            ORDER BY a.id;
            """;
        var rows = new List<SitemapArticleRow>();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, CreatePublicVisibilityParameters());
        while (await reader.ReadAsync(cancellationToken))
        {
            rows.Add(new SitemapArticleRow(
                reader.GetInt32(reader.GetOrdinal("Id")),
                ToUtcOffset(reader.GetDateTime(reader.GetOrdinal("ModifiedAt")))));
        }
        return rows;
    }

    private async Task<IReadOnlyList<SitemapTaxonomyRow>> LoadSitemapCategoriesAsync(CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT
                category.id AS "Id",
                MAX(COALESCE(body.updated_at, a.published_at, a.createtime)) AS "ModifiedAt"
            FROM category
            INNER JOIN article a ON a.categoryid = category.id
            LEFT JOIN article_body body ON body.article_id = a.id
            WHERE a.isdeleted = false
              AND a.status = @Status
              AND (a.published_at IS NULL OR a.published_at <= @Now)
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)
            GROUP BY category.id
            ORDER BY category.id;
            """;
        return await ReadSitemapTaxonomyRowsAsync(sql, cancellationToken);
    }

    private async Task<IReadOnlyList<SitemapTaxonomyRow>> LoadSitemapTagsAsync(CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT
                tag.id AS "Id",
                MAX(COALESCE(body.updated_at, a.published_at, a.createtime)) AS "ModifiedAt"
            FROM tag
            INNER JOIN article_tag article_tag ON article_tag.tagid = tag.id
            INNER JOIN article a ON a.id = article_tag.articleid
            LEFT JOIN article_body body ON body.article_id = a.id
            WHERE a.isdeleted = false
              AND a.status = @Status
              AND (a.published_at IS NULL OR a.published_at <= @Now)
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)
            GROUP BY tag.id
            ORDER BY tag.id;
            """;
        return await ReadSitemapTaxonomyRowsAsync(sql, cancellationToken);
    }

    private async Task<IReadOnlyList<SitemapTaxonomyRow>> ReadSitemapTaxonomyRowsAsync(
        string sql,
        CancellationToken cancellationToken)
    {
        var rows = new List<SitemapTaxonomyRow>();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, CreatePublicVisibilityParameters());
        while (await reader.ReadAsync(cancellationToken))
        {
            rows.Add(new SitemapTaxonomyRow(
                reader.GetInt32(reader.GetOrdinal("Id")),
                ToUtcOffset(reader.GetDateTime(reader.GetOrdinal("ModifiedAt")))));
        }
        return rows;
    }

    private async Task<IReadOnlyDictionary<string, DateTimeOffset>> LoadStaticPageUpdatesAsync(CancellationToken cancellationToken)
    {
        string[] slugs = ["about", "privacy", "guidelines", "copyright"];
        List<SitemapStaticPageRow> rows = await db.Queryable<PageContent>()
            .In(page => page.Slug, slugs)
            .Select(page => new SitemapStaticPageRow
            {
                Slug = page.Slug,
                UpdatedAt = page.UpdatedAt
            })
            .ToListAsync(cancellationToken);
        return rows.ToDictionary(
            static row => row.Slug,
            static row => ToUtcOffset(row.UpdatedAt),
            StringComparer.Ordinal);
    }

    private async Task<string> ResolvePublicOriginAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        SeoConfigReadModel seo = await systemService.GetSeoConfigAsync();
        cancellationToken.ThrowIfCancellationRequested();
        return PublicOriginPolicy.Resolve(configuration["Seo:BaseUrl"], seo.BaseUrl);
    }

    private static DateTimeOffset? GetOptionalUpdate(
        IReadOnlyDictionary<string, DateTimeOffset> updates,
        string slug)
        => updates.TryGetValue(slug, out DateTimeOffset value) ? value : null;

    private static SitemapArtifactSet BuildSitemapArtifactSet(string baseUrl, IReadOnlyList<SitemapEntry> entries)
    {
        if (entries.Count <= SitemapPageSize)
        {
            return new SitemapArtifactSet(BuildSitemapUrlSet(entries), []);
        }

        var pages = new List<string>((entries.Count + SitemapPageSize - 1) / SitemapPageSize);
        var pageUpdatedAt = new List<DateTimeOffset?>(pages.Capacity);
        for (int offset = 0; offset < entries.Count; offset += SitemapPageSize)
        {
            SitemapEntry[] page = entries.Skip(offset).Take(SitemapPageSize).ToArray();
            pages.Add(BuildSitemapUrlSet(page));
            DateTimeOffset?[] updated = page.Where(static entry => entry.LastModified.HasValue)
                .Select(static entry => entry.LastModified)
                .ToArray();
            pageUpdatedAt.Add(updated.Length == 0 ? null : updated.Max());
        }

        XNamespace ns = "http://www.sitemaps.org/schemas/sitemap/0.9";
        var index = new XDocument(
            new XDeclaration("1.0", "utf-8", null),
            new XElement(
                ns + "sitemapindex",
                pages.Select((_, index) => new XElement(
                    ns + "sitemap",
                    new XElement(ns + "loc", $"{baseUrl}/sitemap/{index + 1}.xml"),
                    pageUpdatedAt[index] is DateTimeOffset updatedAt
                        ? new XElement(ns + "lastmod", ToWireSitemapDate(updatedAt))
                        : null))));
        return new SitemapArtifactSet(index.ToString(SaveOptions.DisableFormatting), pages);
    }

    internal static (string RootDocument, IReadOnlyList<string> PageDocuments) BuildSitemapArtifactSetForTests(
        string baseUrl,
        int urlCount)
    {
        SitemapEntry[] entries = Enumerable.Range(1, urlCount)
            .Select(id => new SitemapEntry($"{baseUrl}/article/{id}", DateTimeOffset.UnixEpoch.AddDays(id % 365)))
            .ToArray();
        SitemapArtifactSet artifact = BuildSitemapArtifactSet(baseUrl, entries);
        return (artifact.RootDocument, artifact.PageDocuments);
    }

    private static string BuildSitemapUrlSet(IReadOnlyList<SitemapEntry> entries)
    {
        XNamespace ns = "http://www.sitemaps.org/schemas/sitemap/0.9";
        var document = new XDocument(
            new XDeclaration("1.0", "utf-8", null),
            new XElement(
                ns + "urlset",
                entries.Select(entry => new XElement(
                    ns + "url",
                    new XElement(ns + "loc", entry.Location),
                    entry.LastModified is DateTimeOffset updatedAt
                        ? new XElement(ns + "lastmod", ToWireSitemapDate(updatedAt))
                        : null))));
        return document.ToString(SaveOptions.DisableFormatting);
    }

    private static int CountSitemapUrlsFromFinalArtifacts(SitemapArtifactSet artifact)
    {
        XNamespace ns = "http://www.sitemaps.org/schemas/sitemap/0.9";
        IEnumerable<string> documents = artifact.PageDocuments.Count == 0
            ? [artifact.RootDocument]
            : artifact.PageDocuments;
        return documents.Sum(document => XDocument.Parse(document).Descendants(ns + "url").Count());
    }

    private static SugarParameter[] CreatePublicVisibilityParameters(params SugarParameter[] additional)
        => [
            new("@Status", (int)ArticleStatus.Published),
            new("@Now", DateTime.UtcNow),
            .. additional
        ];

    private static string? ReadNullableString(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static DateTimeOffset ToUtcOffset(DateTime value)
        => new(value.Kind == DateTimeKind.Utc ? value : DateTime.SpecifyKind(value, DateTimeKind.Utc));

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

    private sealed record DistributionFeedSnapshot(
        SeoConfigReadModel Seo,
        SiteComplianceConfigReadModel Compliance,
        string BaseUrl,
        DateTimeOffset? UpdatedAt,
        IReadOnlyList<DistributionArticle> Articles);

    private sealed record DistributionArticle(
        int Id,
        string Title,
        string Summary,
        string? CoverImageUrl,
        string CanonicalUrl,
        DateTimeOffset PublishedAt,
        DateTimeOffset ModifiedAt);

    private sealed class DistributionArticleRow
    {
        public int Id
        {
            get; init;
        }
        public string Title { get; init; } = string.Empty;
        public string? Summary
        {
            get; init;
        }
        public string? CoverImageUrl
        {
            get; init;
        }
        public DateTime PublishedAt
        {
            get; init;
        }
        public DateTime ModifiedAt
        {
            get; init;
        }
    }

    private sealed class SitemapStaticPageRow
    {
        public string Slug { get; init; } = string.Empty;
        public DateTime UpdatedAt
        {
            get; init;
        }
    }

    private sealed record SitemapArtifactSet(
        string RootDocument,
        IReadOnlyList<string> PageDocuments);

    private sealed record SitemapEntry(string Location, DateTimeOffset? LastModified);

    private sealed record SitemapArticleRow(int Id, DateTimeOffset ModifiedAt);

    private sealed record SitemapTaxonomyRow(int Id, DateTimeOffset ModifiedAt);
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
    [property: JsonPropertyName("date_modified")] DateTimeOffset DateModified,
    [property: JsonPropertyName("image")] string? Image);

public sealed record DistributionDiagnosticsCounts(
    int SitemapUrlCount,
    int FeedItemCount,
    DateTimeOffset CheckedAt);
