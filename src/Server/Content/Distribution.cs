using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Content;

internal sealed record DistributionSettings(PublicSiteConfiguration Site, IReadOnlyList<string> SitePagePaths)
{
    internal static string Number(int number) => number.ToString(CultureInfo.InvariantCulture);
}

internal sealed record DistributionSnapshot(byte[] Rss, byte[] Atom, byte[] Json, byte[] Sitemap, byte[][] SitemapPages, byte[] Robots)
{
    internal const string RssPath = "/feed/rss.xml";
    internal const string AtomPath = "/feed/atom.xml";
    internal const string JsonPath = "/feed/feed.json";
    internal const string SitemapPath = "/sitemap.xml";
    internal const string RobotsPath = "/robots.txt";
    internal const int SitemapPageSize = 45_000;
    private const int FeedLimit = 50;
    private const int SitemapMaxPages = 50_000;
    private static readonly XNamespace AtomNs = "http://www.w3.org/2005/Atom";
    private static readonly XNamespace SitemapNs = "http://www.sitemaps.org/schemas/sitemap/0.9";
    private static readonly XNamespace DublinCore = "http://purl.org/dc/elements/1.1/";
    private static readonly UTF8Encoding Utf8 = new(false, true);
    internal static readonly byte[] ClosedRobots = "User-agent: *\nDisallow: /\n"u8.ToArray();

    internal static DistributionSnapshot? Build(DistributionSettings? settings, IReadOnlyList<Article> articles, CancellationToken ct)
    {
        if (settings?.Site.Origin is not { } origin) return null;
        ct.ThrowIfCancellationRequested();

        var entries = articles.OrderByDescending(article => article.PublishedAt).ThenByDescending(article => article.Id)
            .Take(FeedLimit).Select(article => new Entry(ArticleUrl(origin, article.Id), XmlText(article.Title),
                XmlText(string.IsNullOrWhiteSpace(article.Summary) ? article.Title : article.Summary), article)).ToArray();
        var updated = entries.Select(entry => (DateTimeOffset?)Modified(entry.Article)).Max();
        return BuildDocuments(origin, entries, updated, settings, articles, ct);
    }

    private static DistributionSnapshot BuildDocuments(string origin, Entry[] entries, DateTimeOffset? updated,
        DistributionSettings settings, IReadOnlyList<Article> articles, CancellationToken ct)
    {
        var (title, description, author) = (settings.Site.Seo.Title, settings.Site.Seo.Description, settings.Site.Seo.Author);
        var copyright = settings.Site.Compliance is { Enabled: true } legal
            ? CopyrightText(legal, title, DateTimeOffset.UtcNow) : $"© {author}";
        var rss = Document(new XElement("rss", new XAttribute("version", "2.0"),
            new XAttribute(XNamespace.Xmlns + "dc", DublinCore), new XAttribute(XNamespace.Xmlns + "atom", AtomNs), new XElement("channel",
                new XElement("title", title), new XElement("link", origin + "/"),
                new XElement("description", HtmlEncoder.Default.Encode(description)), new XElement("language", "zh-CN"),
                AtomLink(origin + RssPath, "self"),
                new XElement("copyright", copyright),
                updated is { } rssDate ? new XElement("lastBuildDate", Rfc822(rssDate)) : null,
                entries.Select(entry => new XElement("item",
                    new XElement("title", entry.Title), new XElement("link", entry.Url),
                    new XElement("guid", new XAttribute("isPermaLink", "true"), entry.Url),
                    new XElement("description", HtmlEncoder.Default.Encode(entry.Summary)),
                    new XElement(DublinCore + "creator", author), new XElement("pubDate", Rfc822(entry.Article.PublishedAt)))))));
        var atom = Document(new XElement(AtomNs + "feed",
            new XElement(AtomNs + "title", title), new XElement(AtomNs + "subtitle", description),
            new XElement(AtomNs + "id", origin + "/"), new XElement(AtomNs + "updated", IsoDate(updated ?? DateTimeOffset.UnixEpoch)),
            AtomLink(origin + "/", "alternate"), AtomLink(origin + AtomPath, "self"),
            new XElement(AtomNs + "author", new XElement(AtomNs + "name", author)),
            entries.Select(entry => new XElement(AtomNs + "entry",
                new XElement(AtomNs + "title", entry.Title), new XElement(AtomNs + "id", entry.Url), AtomLink(entry.Url, "alternate"),
                new XElement(AtomNs + "published", IsoDate(entry.Article.PublishedAt)),
                new XElement(AtomNs + "updated", IsoDate(Modified(entry.Article))),
                new XElement(AtomNs + "summary", new XAttribute("type", "text"), entry.Summary)))));
        var json = JsonSerializer.SerializeToUtf8Bytes(new
        {
            version = "https://jsonfeed.org/version/1.1",
            title = title,
            home_page_url = origin + "/",
            feed_url = origin + JsonPath,
            description = description,
            authors = new[] { new { name = author } },
            items = entries.Select(entry => new
            {
                id = DistributionSettings.Number(entry.Article.Id), url = entry.Url, title = entry.Title,
                summary = entry.Summary, content_text = entry.Summary,
                date_published = entry.Article.PublishedAt.ToUniversalTime(), date_modified = Modified(entry.Article).ToUniversalTime()
            })
        });
        var paths = SitemapLocations(articles, settings.SitePagePaths, ct).ToArray();
        var sitemap = BuildSitemap(origin, paths, ct);
        var robots = Utf8.GetBytes("User-agent: *\nAllow: /\nAllow: /feed/\nAllow: /sitemap.xml\nAllow: /robots.txt\n" +
            "Disallow: /login\nDisallow: /register\nDisallow: /recover\nDisallow: /user\nDisallow: /admin\nDisallow: /api/\n" +
            $"Disallow: /search/index.bin\nDisallow: /search/patches/\nSitemap: {origin}{SitemapPath}\n");
        return new(rss, atom, json, sitemap.Root, sitemap.Pages, robots);
    }

    private static IEnumerable<Location> SitemapLocations(IReadOnlyList<Article> articles, IReadOnlyList<string> sitePages, CancellationToken ct)
    {
        var updated = articles.Select(article => (DateTimeOffset?)Modified(article)).Max();
        yield return new("/", updated);
        yield return new("/archive", updated);
        foreach (var page in sitePages) yield return new(page, null);

        var categories = new SortedDictionary<int, DateTimeOffset>();
        var tags = new SortedDictionary<int, DateTimeOffset>();
        foreach (var article in articles.OrderBy(article => article.Id))
        {
            ct.ThrowIfCancellationRequested();
            var modified = Modified(article);
            if (article.Category is { } category) Record(categories, category.Id, modified);
            foreach (var tag in article.Tags ?? []) Record(tags, tag.Id, modified);
            yield return new(ArticlePath(article.Id), modified);
        }
        foreach (var (id, date) in categories) yield return new($"/category/{DistributionSettings.Number(id)}", date);
        foreach (var (id, date) in tags) yield return new($"/tag/{DistributionSettings.Number(id)}", date);

        static void Record(SortedDictionary<int, DateTimeOffset> dates, int id, DateTimeOffset modified)
        {
            if (!dates.TryGetValue(id, out var previous) || previous < modified) dates[id] = modified;
        }
    }

    internal static (byte[] Root, byte[][] Pages) BuildSitemap(string origin, Location[] paths, CancellationToken ct)
    {
        if (paths.Length <= SitemapPageSize) return (UrlSet(paths), []);
        if ((paths.LongLength + SitemapPageSize - 1) / SitemapPageSize > SitemapMaxPages)
            throw new InvalidOperationException("Public sitemap exceeds its index budget.");
        var pages = paths.Chunk(SitemapPageSize).Select(page => (Bytes: UrlSet(page), Date: page.Max(value => value.Date))).ToArray();
        var root = Document(new XElement(SitemapNs + "sitemapindex", pages.Select((page, i) =>
            SitemapLocation("sitemap", new($"/sitemap/{DistributionSettings.Number(i + 1)}.xml", page.Date)))));
        return (root, pages.Select(page => page.Bytes).ToArray());

        byte[] UrlSet(Location[] entries)
        {
            ct.ThrowIfCancellationRequested();
            var xml = Document(new XElement(SitemapNs + "urlset", entries.Select(entry => SitemapLocation("url", entry))));
            ct.ThrowIfCancellationRequested();
            return xml;
        }

        XElement SitemapLocation(string kind, Location entry) => new(SitemapNs + kind,
            new XElement(SitemapNs + "loc", origin + entry.Path),
            entry.Date is { } modified
                ? new XElement(SitemapNs + "lastmod", modified.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))
                : null);
    }

    private static string XmlText(string text)
    {
        var result = new StringBuilder(text.Length);
        foreach (var rune in text.EnumerateRunes())
            result.Append(rune.Value > char.MaxValue || XmlConvert.IsXmlChar((char)rune.Value) ? rune.ToString() : "\uFFFD");
        return result.ToString();
    }

    private static string CopyrightText(SiteCompliance config, string author, DateTimeOffset date)
    {
        var owner = config.CopyrightOwner.Length == 0 ? author : config.CopyrightOwner;
        var end = date.UtcDateTime.Year;
        var year = config.CopyrightStartYear is { } start && start < end ? $"{DistributionSettings.Number(start)}–{DistributionSettings.Number(end)}" : DistributionSettings.Number(end);
        var notice = config.CopyrightText.Length == 0 ? "" : $" {config.CopyrightText}";
        return $"© {year} {owner}{notice}";
    }

    private static string ArticlePath(int id) => $"/article/{DistributionSettings.Number(id)}";
    private static string ArticleUrl(string origin, int id) => origin + ArticlePath(id);
    private static DateTimeOffset Modified(Article article) => article.UpdatedAt > article.PublishedAt ? article.UpdatedAt : article.PublishedAt;
    private static XElement AtomLink(string url, string rel) => new(AtomNs + "link", new XAttribute("href", url), new XAttribute("rel", rel));
    private static string Rfc822(DateTimeOffset date) => date.ToUniversalTime().ToString("r", CultureInfo.InvariantCulture);
    private static string IsoDate(DateTimeOffset date) => date.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
    private static byte[] Document(XElement element)
    {
        using var bytes = new MemoryStream();
        using (var xml = XmlWriter.Create(bytes, new XmlWriterSettings { Encoding = Utf8, NewLineHandling = NewLineHandling.Entitize }))
        {
            xml.WriteStartDocument();
            element.WriteTo(xml);
            xml.WriteEndDocument();
        }
        return bytes.ToArray();
    }

    private sealed record Entry(string Url, string Title, string Summary, Article Article);
    internal sealed record Location(string Path, DateTimeOffset? Date);
}

internal static class DistributionEndpoints
{
    private const string Xml = "application/xml; charset=utf-8";
    private const string Text = "text/plain; charset=utf-8";
    private static readonly string[] ReadMethods = [HttpMethods.Get, HttpMethods.Head];

    internal static void Map(WebApplication app, Publications publications, DistributionSettings settings)
    {
        const string rss = "application/rss+xml; charset=utf-8";
        MapArtifact(DistributionSnapshot.RssPath, rss, snapshot => snapshot.Rss);
        MapArtifact("/api/Article/rss", rss, snapshot => snapshot.Rss);
        MapArtifact(DistributionSnapshot.AtomPath, "application/atom+xml; charset=utf-8", snapshot => snapshot.Atom);
        MapArtifact(DistributionSnapshot.JsonPath, "application/feed+json; charset=utf-8", snapshot => snapshot.Json);
        MapArtifact(DistributionSnapshot.SitemapPath, Xml, snapshot => snapshot.Sitemap);
        app.MapMethods("/sitemap/{page:int}.xml", ReadMethods, (int page) =>
            new Artifact(publications, Xml, snapshot => page > 0 && page <= snapshot.SitemapPages.Length ? snapshot.SitemapPages[page - 1] : null));
        app.MapMethods(DistributionSnapshot.RobotsPath, ReadMethods, (HttpContext ctx) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            return settings.Site.Origin is null ? Results.Bytes(DistributionSnapshot.ClosedRobots, Text)
                : (IResult)new Artifact(publications, Text, snapshot => snapshot.Robots);
        });

        void MapArtifact(string path, string contentType, Func<DistributionSnapshot, byte[]?> select) =>
            app.MapMethods(path, ReadMethods, () => new Artifact(publications, contentType, select));
    }

    private sealed record Artifact(Publications Publications, string MediaType, Func<DistributionSnapshot, byte[]?> Select) : IResult
    {
        public Task ExecuteAsync(HttpContext context)
        {
            // Take one public snapshot at response time. This also checks the instance lease.
            context.Response.Headers.CacheControl = "no-store";
            var current = Publications.Snapshot;
            if (current?.Distribution is not { } artifacts) return Results.StatusCode(503).ExecuteAsync(context);
            var bytes = Select(artifacts);
            if (bytes is null) return Results.NotFound().ExecuteAsync(context);
            if (!ReferenceEquals(current, Publications.Snapshot)) return Results.StatusCode(503).ExecuteAsync(context);
            context.Response.Headers[WireHeaders.SearchIndexGeneration] = current.Generation.ToString(CultureInfo.InvariantCulture);
            return Results.Bytes(bytes, MediaType).ExecuteAsync(context);
        }
    }
}
