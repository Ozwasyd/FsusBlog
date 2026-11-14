using System.Collections.Frozen;
using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Operations;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server;

internal sealed class PublicSnapshot
{
    private readonly IReadOnlyList<Article> _ordered;
    private readonly byte[][] _index;
    private readonly IReadOnlyList<byte[]>? _corpus;
    private readonly FrozenDictionary<int, Article> _byId;
    private readonly PublicArticleCache _details;
    private readonly PublicListProjection _listing;
    internal long Generation { get; }
    internal string GenerationHeader { get; }
    internal long Watermark { get; }
    internal long TaxonomyEpoch { get; }
    internal byte[] Home { get; }
    internal TaxonomyProjection Taxonomy { get; }
    internal RelatedReadingProjection RelatedReading { get; }
    internal DistributionSnapshot? Distribution { get; }
    internal int IndexPageCount => _index.Length;
    internal int CorpusPageCount => _corpus?.Count ?? 0;

    internal PublicSnapshot(long watermark, IReadOnlyList<Article> articles, TaxonomyRows taxonomy, WebPages pages, PublicListCursor cursor,
        PublicSnapshot? previous, ILogger log, RuntimeEvidence? evidence, DistributionSettings? distribution, CancellationToken cancellationToken,
        long taxonomyEpoch = 0)
    {
        Watermark = watermark;
        TaxonomyEpoch = taxonomyEpoch;
        _corpus = LocalSearchCorpus.Build(articles, cancellationToken);
        Generation = PublicGeneration(articles, taxonomyEpoch, _corpus, cancellationToken);
        GenerationHeader = Generation.ToString(CultureInfo.InvariantCulture);
        Taxonomy = new TaxonomyProjection(taxonomy, articles, pages);
        RelatedReading = new RelatedReadingProjection(articles, cancellationToken);
        _ordered = articles;
        _byId = articles.ToFrozenDictionary(article => article.Id);
        _details = new PublicArticleCache(_byId, pages, Generation, log, evidence);
        _details.Warm(articles.Take(1200), previous?._details, cancellationToken);
        _listing = new PublicListProjection(Generation, articles, cursor);
        var first = articles.Take(10).ToArray();
        Home = pages.Page($"<main><h1>{HtmlEncoder.Default.Encode(pages.SiteTitle)}</h1>" + (first.Length > 0
            ? "<ol>" + string.Concat(first.Select(article => $"<li><a href=\"/article/{article.Id}\">{HtmlEncoder.Default.Encode(article.Title)}</a></li>")) + "</ol>"
            : "<p>暂无文章</p>") + "</main>", publicPath: "/");
        _index = articles.Count == 0 ? [PublicArticles.EncodeSearch([], 0)] : articles.Chunk(WireLimits.SearchIndexPageSize)
            .Select(part => PublicArticles.EncodeSearch(part, part.Length)).ToArray();
        Distribution = DistributionSnapshot.Build(distribution, articles, cancellationToken);
    }

    internal Article? Article(int id) => _byId.GetValueOrDefault(id);

    internal bool HasArticle(int id) => _byId.ContainsKey(id);

    internal ValueTask<PublicArticleBytes?> Detail(int id, CancellationToken ct) => _details.Read(id, ct);

    internal byte[]? Index(int page) => page > 0 && page <= _index.Length ? _index[page - 1] : null;

    internal byte[]? Corpus(int page) => _corpus is not null && page > 0 && page <= _corpus.Count ? _corpus[page - 1] : null;

    internal byte[] List(string scope, int page, int size, string? keyword, string? sort, string? cursor,
        CancellationToken ct, Func<Article, bool>? filter = null) =>
        _listing.Read(PublicListQuery.Parse(scope, page, size, keyword, sort, cursor), ct, filter);

    internal byte[] Search(string? keyword)
    {
        var matching = Match(keyword);
        return PublicArticles.EncodeSearch(matching.Take(100).ToArray(), matching.Length);
    }

    private static long PublicGeneration(IReadOnlyList<Article> articles, long taxonomyEpoch,
        IReadOnlyList<byte[]>? corpus, CancellationToken ct)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> coordinates = stackalloc byte[20];
        // One coordinate covers every HTTP representation. A restart with unchanged
        // article rows still cannot serve changed corpus bytes at the old coordinate.
        hash.AppendData("public-generation-corpus-v1\0"u8);
        AppendNumber(corpus?.Count ?? -1);
        if (corpus is not null)
        {
            foreach (var page in corpus)
            {
                ct.ThrowIfCancellationRequested();
                AppendNumber(page.Length);
                hash.AppendData(page);
            }
        }
        AppendNumber(articles.Count);
        foreach (var article in articles)
        {
            ct.ThrowIfCancellationRequested();
            BinaryPrimitives.WriteInt32LittleEndian(coordinates, article.Id);
            BinaryPrimitives.WriteInt64LittleEndian(coordinates[4..], article.Revision);
            BinaryPrimitives.WriteInt64LittleEndian(coordinates[12..], article.Publication);
            hash.AppendData(coordinates);
            TaxonomyProjection.AppendGeneration(hash, article);
        }
        if (taxonomyEpoch != 0)
        {
            hash.AppendData("taxonomy-epoch-v1"u8);
            BinaryPrimitives.WriteInt64LittleEndian(coordinates, taxonomyEpoch);
            hash.AppendData(coordinates[..sizeof(long)]);
        }
        return BinaryPrimitives.ReadInt64LittleEndian(hash.GetHashAndReset()) & long.MaxValue;

        void AppendNumber(int value)
        {
            Span<byte> number = stackalloc byte[sizeof(int)];
            BinaryPrimitives.WriteInt32LittleEndian(number, value);
            hash.AppendData(number);
        }
    }

    private Article[] Match(string? keyword)
    {
        IEnumerable<Article> query = _ordered;
        if (!string.IsNullOrWhiteSpace(keyword))
            query = query.Where(article => article.Title.Contains(keyword, StringComparison.OrdinalIgnoreCase) ||
                                           article.Body.Contains(keyword, StringComparison.OrdinalIgnoreCase));
        return query.ToArray();
    }

}

internal sealed class Publications(NpgsqlDataSource db, WebPages pages, ILogger<Publications> log, InstanceLease? lease = null,
    RuntimeEvidence? evidence = null, DistributionSettings? distribution = null)
{
    private readonly SemaphoreSlim _writers = new(1, 1);
    private readonly PublicListCursor _listCursor = new(TimeProvider.System);
    private PublicSnapshot? _snapshot;
    private PublicSnapshot? _lastProjection;
    private bool? _taxonomyEpochInstalled;
    internal PublicSnapshot? Snapshot => lease?.IsCurrent is false ? null : Volatile.Read(ref _snapshot);
    internal bool LeaseCurrent => lease?.IsCurrent is not false;

    internal async Task<(ArticleState Article, bool Changed)> Command(Store store, string? token,
        ArticleAction action, Edit edit, CancellationToken ct, string? expectedSession = null) =>
        await Change(action is ArticleAction.Publish or ArticleAction.Retract or ArticleAction.Delete,
            invalidate => store.WithSession(token, true, async (connection, tx, actor) =>
            {
                FsusBlog.V2.Server.Sessions.SiteSessions.IfCurrent(actor.Id, token, expectedSession);
                var update = await Store.Execute(connection, tx, actor, action, edit, ct);
                if (update.Changed) invalidate();
                return update;
            }, ct), ct);

    internal Task<T> AdministrativePublication<T>(Func<Action, Task<T>> transact, CancellationToken ct) =>
        Change(invalidate: true, transact, ct);

    private async Task<T> Change<T>(bool invalidate, Func<Action, Task<T>> transact, CancellationToken ct)
    {
        lease?.RequireCurrent();
        if (!await _writers.WaitAsync(TimeSpan.FromSeconds(5), ct)) throw new PublicUnavailableException();
        try
        {
            lease?.RequireCurrent();
            var result = await transact(() =>
            {
                // After an ambiguous commit or interruption, the old public bytes remain unservable.
                // The worker rebuilds from the committed durable state.
                if (invalidate) Volatile.Write(ref _snapshot, null);
            });

            if (invalidate && Snapshot is null)
            {
                try { await Rebuild(ct); }
                catch (OperationCanceledException) when (!LeaseCurrent && !ct.IsCancellationRequested)
                {
                    throw new PublicUnavailableException();
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "The article command committed; public projection awaits durable outbox recovery.");
                    throw new PublicUnavailableException();
                }
            }
            lease?.RequireCurrent();
            return result;
        }
        finally { _writers.Release(); }
    }

    internal async Task Refresh(CancellationToken ct)
    {
        lease?.RequireCurrent();
        await _writers.WaitAsync(ct);
        try
        {
            try { await PublishScheduled(ct); }
            catch (NpgsqlException error) when (LeaseCurrent && !ct.IsCancellationRequested)
            {
                log.LogError(error, "Scheduled publication batch rolled back or awaits outbox recovery.");
            }
            await Rebuild(ct);
        }
        finally { _writers.Release(); }
    }

    private async Task PublishScheduled(CancellationToken ct)
    {
        using var attribution = evidence?.PublicationWork();
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(connection, lease, ct);
        if (await Authoring.ArticleScheduleStore.PublishDue(connection, tx, ct) != 0)
            Volatile.Write(ref _snapshot, null);
        await InstanceLease.CommitProtected(tx, lease, ct);
    }

    private async Task Rebuild(CancellationToken ct)
    {
        using var attribution = evidence?.PublicationWork();
        lease?.RequireCurrent();
        using var stop = lease is null ? null : CancellationTokenSource.CreateLinkedTokenSource(ct, lease.Stopped);
        ct = stop?.Token ?? ct;
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(connection, lease, ct, System.Data.IsolationLevel.RepeatableRead);
        var (maxEvent, taxonomyEpoch) = await ReadWatermarks(connection, tx, ct);
        var next = Snapshot;
        var rebuilt = next is null || next.Watermark != maxEvent || next.TaxonomyEpoch != taxonomyEpoch;
        if (rebuilt)
        {
            var taxonomy = await TaxonomyStore.Read(connection, tx, ct);
            await using var cmd = Store.Sql(connection, tx, """
                select a.id,r.revision,p.publication_id,r.title,r.body,a.created_at,r.happened_at,p.published_at,
                    p.publication_no, c.id, c.name, tags.ids, tags.names, s.id,
                    w.enabled,w.license_type,w.copyright_holder,w.copyright_year,w.rights_statement,w.attribution_template,
                    w.copy_policy,w.max_excerpt_chars,w.allow_code_copy,w.show_public_badge,w.proof_binding_enabled
                from public.article_publication p join public.article a on a.id=p.article_id
                join public.article_revision r on r.article_id=p.article_id and r.revision=p.revision
                join public.article_publication_rights s on s.article_id=p.article_id and s.publication_id=p.publication_id and s.revision=p.revision
                join public.article_revision_rights w on w.article_id=s.article_id and w.revision=s.revision
                left join public.article_revision_category link on link.article_id=p.article_id and link.revision=p.revision
                left join public.category c on c.id=link.category_id
                left join lateral (
                    select array_agg(t.id order by t.id) as ids, array_agg(t.name order by t.id) as names
                    from public.article_revision_tag tag_link join public.tag t on t.id=tag_link.tag_id
                    where tag_link.article_id=p.article_id and tag_link.revision=p.revision
                ) tags on true
                where not a.deleted and a.published_revision=p.revision
                order by a.created_at desc, a.id desc
                """);
            await using var row = await cmd.ExecuteReaderAsync(ct);
            var articles = new List<Article>();
            while (await row.ReadAsync(ct))
            {
                var revision = row.GetInt64(1);
                var publication = row.GetInt64(2);
                var id = row.GetInt32(0);
                PublishedArticleRights rights;
                try
                {
                    rights = new(row.GetInt64(13), Authoring.PublicationRightsStore.ReadPolicy(row, 14, id, revision));
                }
                catch (ProtocolException)
                {
                    log.LogWarning("Article {ArticleId} publication {PublicationId} has an invalid immutable rights policy.", id, publication);
                    continue;
                }
                var body = row.GetString(4);
                var limit = Math.Min(body.Length, 200);
                if (limit > 0 && char.IsHighSurrogate(body[limit - 1])) limit--;
                var category = row.IsDBNull(9) ? null : new TaxonomyName(row.GetInt32(9), row.GetString(10));
                var tags = row.IsDBNull(11) ? [] : row.GetFieldValue<int[]>(11).Zip(row.GetFieldValue<string[]>(12),
                    (tagId, name) => new TaxonomyName(tagId, name)).ToArray();
                articles.Add(new Article(id, revision, publication, checked((int)revision), row.GetInt32(8),
                    row.GetString(3), body, row.GetFieldValue<DateTimeOffset>(5), row.GetFieldValue<DateTimeOffset>(6),
                    row.GetFieldValue<DateTimeOffset>(7), body[..limit], category, tags, rights));
            }
            next = new PublicSnapshot(maxEvent, articles, taxonomy, pages, _listCursor, _lastProjection, log, evidence, distribution, ct, taxonomyEpoch);
        }
        await using (var advance = Store.Sql(connection, tx, """
            update public.blog_outbox set processed_at=now() where processed_at is null
            """)) await advance.ExecuteNonQueryAsync(ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
        _lastProjection = next;
        Volatile.Write(ref _snapshot, next);
        evidence?.CountRefresh(rebuilt);
    }

    private async Task<(long Article, long Taxonomy)> ReadWatermarks(NpgsqlConnection connection, NpgsqlTransaction tx, CancellationToken ct)
    {
        _taxonomyEpochInstalled ??= await CurrentSchema.HasAdminTagMetadataAsync(connection, tx, ct);
        const string articles = "select coalesce(max(id),0) from public.blog_outbox where kind in ('publish','retract','delete')";
        var sql = _taxonomyEpochInstalled.Value ? "select (" + articles + "),(select revision from public.taxonomy_epoch where singleton)" : articles;
        await using var command = Store.Sql(connection, tx, sql);
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new InvalidOperationException("The public watermarks are missing.");
        return (row.GetInt64(0), _taxonomyEpochInstalled.Value ? row.GetInt64(1) : 0);
    }
}

internal sealed class WebPages(string template, PublicSiteConfiguration? site = null, AppearanceAssets? appearance = null)
{
    internal string SiteTitle => site?.Seo.Title ?? PublicSiteConfiguration.DefaultTitle;

    internal byte[] Page(string content = "", string? title = null, string? description = null, string? language = null,
        bool noIndex = false, string? publicPath = null, bool useAppearance = true)
    {
        var document = useAppearance && appearance is not null ? appearance.WithStylesheet(template) : template;
        var titleText = title is null ? SiteTitle : $"{title} · {SiteTitle}";
        document = document.Replace("<title>Fsu's Blog</title>", $"<title>{HtmlEncoder.Default.Encode(titleText)}</title>", StringComparison.Ordinal);
        var canonical = publicPath is not null && !noIndex && site?.Origin is { } origin ? origin + publicPath : null;
        if (publicPath is not null && !noIndex)
            description = string.IsNullOrWhiteSpace(description) ? site?.Seo.Description : description;
        if (!string.IsNullOrWhiteSpace(description))
            document = document.Replace("</head>", $"<meta name=\"description\" content=\"{HtmlEncoder.Default.Encode(description)}\"></head>", StringComparison.Ordinal);
        if (language is not null)
            document = document.Replace("<html lang=\"en\">", $"<html lang=\"{HtmlEncoder.Default.Encode(language)}\">", StringComparison.Ordinal);
        if (noIndex)
            document = document.Replace("</head>", "<meta name=\"robots\" content=\"noindex, follow\"></head>", StringComparison.Ordinal);
        if (canonical is not null)
        {
            document = document.Replace("</head>", $"""
                <link rel="canonical" href="{HtmlEncoder.Default.Encode(canonical)}">
                <link rel="alternate" type="application/rss+xml" title="RSS" href="{DistributionSnapshot.RssPath}">
                <link rel="alternate" type="application/atom+xml" title="Atom" href="{DistributionSnapshot.AtomPath}">
                <link rel="alternate" type="application/feed+json" title="JSON Feed" href="{DistributionSnapshot.JsonPath}">
                </head>
                """, StringComparison.Ordinal);
        }
        if (site is not null)
        {
            var encoder = HtmlEncoder.Default;
            var metadata = new StringBuilder($"<meta name=\"fsus-site-title\" content=\"{encoder.Encode(SiteTitle)}\">");
            if (publicPath is not null && !noIndex)
            {
                Meta("author", site.Seo.Author);
                Meta("theme-color", site.Seo.ThemeColor);
                Meta("og:image", site.Seo.OgImage, "property");
                Link("icon", site.Seo.FaviconSvgUrl, "image/svg+xml");
                Link("icon", site.Seo.FaviconIcoUrl, "image/x-icon");
                Link("icon", site.Seo.FaviconPngUrl, "image/png");
                Link("apple-touch-icon", site.Seo.AppleTouchIconUrl, null);
            }
            document = document.Replace("</head>", metadata.Append("</head>").ToString(), StringComparison.Ordinal);

            void Meta(string name, string value, string attribute = "name")
            {
                if (value.Length > 0) metadata.Append($"<meta {attribute}=\"{name}\" content=\"{encoder.Encode(value)}\">");
            }

            void Link(string relation, string url, string? type)
            {
                if (url.Length == 0) return;
                var typed = type is null ? "" : $" type=\"{type}\"";
                metadata.Append($"<link rel=\"{relation}\"{typed} href=\"{encoder.Encode(url)}\">");
            }
        }
        return Encoding.UTF8.GetBytes(document.Replace("<!--fsus-public-content-->", content, StringComparison.Ordinal));
    }
}

internal sealed class PublicUnavailableException : Exception;

internal sealed class OutboxWorker(Publications publications, ILogger<OutboxWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            if (!publications.LeaseCurrent) return;
            try { await publications.Refresh(stoppingToken); }
            catch (Exception) when (!publications.LeaseCurrent) { return; }
            catch (Exception error) when (!stoppingToken.IsCancellationRequested)
            {
                log.LogError(error, "Public projection refresh failed; pending work remains durable.");
            }
        }
    }
}
