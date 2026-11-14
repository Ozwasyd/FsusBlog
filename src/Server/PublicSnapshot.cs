using System.Collections.Frozen;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using Npgsql;

namespace FsusBlog.V2.Server;

internal sealed record PublicEntry(Article Article, byte[] Wire, byte[] Html);

internal sealed class PublicSnapshot
{
    private readonly PublicEntry[] _ordered;
    private readonly byte[][] _index;
    private readonly FrozenDictionary<int, PublicEntry> _byId;
    private readonly PublicListProjection _listing;
    internal long Generation { get; }
    internal long Watermark { get; }
    internal byte[] Home { get; }
    internal TaxonomyProjection Taxonomy { get; }
    internal int IndexPageCount => _index.Length;

    internal PublicSnapshot(long watermark, IReadOnlyList<Article> articles, TaxonomyRows taxonomy, WebPages pages, PublicListCursor cursor)
    {
        Watermark = watermark;
        Generation = PublicGeneration(articles);
        Taxonomy = new TaxonomyProjection(taxonomy, articles, pages);
        _ordered = articles.Select(article => new PublicEntry(article, PublicArticles.EncodeDetail(article),
            pages.Page(PublicArticleHtml.Render(article), article.Title, article.Summary))).ToArray();
        _byId = _ordered.ToFrozenDictionary(entry => entry.Article.Id);
        _listing = new PublicListProjection(Generation, articles, cursor);
        var first = articles.Take(10).ToArray();
        Home = pages.Page("<main><h1>FsusBlog</h1>" + (first.Length > 0
            ? "<ol>" + string.Concat(first.Select(article => $"<li><a href=\"/article/{article.Id}\">{HtmlEncoder.Default.Encode(article.Title)}</a></li>")) + "</ol>"
            : "<p>暂无文章</p>") + "</main>");
        _index = articles.Count == 0 ? [PublicArticles.EncodeSearch([], 0)] : articles.Chunk(WireLimits.SearchIndexPageSize)
            .Select(part => PublicArticles.EncodeSearch(part, part.Length)).ToArray();
    }

    internal PublicEntry? Article(int id) => _byId.GetValueOrDefault(id);

    internal byte[]? Index(int page) => page > 0 && page <= _index.Length ? _index[page - 1] : null;

    internal byte[] List(string scope, int page, int size, string? keyword, string? sort, string? cursor,
        CancellationToken ct, Func<Article, bool>? filter = null) =>
        _listing.Read(PublicListQuery.Parse(scope, page, size, keyword, sort, cursor), ct, filter);

    internal byte[] Search(string? keyword)
    {
        var matching = Match(keyword);
        return PublicArticles.EncodeSearch(matching.Take(100).ToArray(), matching.Length);
    }

    private static long PublicGeneration(IReadOnlyList<Article> articles)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> coordinates = stackalloc byte[20];
        foreach (var article in articles)
        {
            BinaryPrimitives.WriteInt32LittleEndian(coordinates, article.Id);
            BinaryPrimitives.WriteInt64LittleEndian(coordinates[4..], article.Revision);
            BinaryPrimitives.WriteInt64LittleEndian(coordinates[12..], article.Publication);
            hash.AppendData(coordinates);
            TaxonomyProjection.AppendGeneration(hash, article);
        }
        return BinaryPrimitives.ReadInt64LittleEndian(hash.GetHashAndReset()) & long.MaxValue;
    }

    private Article[] Match(string? keyword)
    {
        var query = _ordered.Select(entry => entry.Article);
        if (!string.IsNullOrWhiteSpace(keyword))
            query = query.Where(article => article.Title.Contains(keyword, StringComparison.OrdinalIgnoreCase) ||
                                           article.Body.Contains(keyword, StringComparison.OrdinalIgnoreCase));
        return query.ToArray();
    }

}

internal sealed class Publications(NpgsqlDataSource db, WebPages pages, ILogger<Publications> log)
{
    private readonly SemaphoreSlim _writers = new(1, 1);
    private readonly PublicListCursor _listCursor = new(TimeProvider.System);
    private PublicSnapshot? _snapshot;
    internal PublicSnapshot? Snapshot => Volatile.Read(ref _snapshot);

    // Admission requires a single v2 server per database. Its publications gate and instance lock
    // ensure no other server can keep serving a stale in-memory generation after withdrawal.
    internal const long InstanceLock = 716729109726707501L;

    internal async Task<(ArticleState Article, bool Changed)> Command(Store store, string? token,
        ArticleAction action, Edit edit, CancellationToken ct)
    {
        if (!await _writers.WaitAsync(TimeSpan.FromSeconds(5), ct)) throw new PublicUnavailableException();
        try
        {
            var invalidate = action is ArticleAction.Publish or ArticleAction.Retract or ArticleAction.Delete;
            var result = await store.WithSession(token, true, async (connection, tx, actor) =>
            {
                // After an ambiguous commit or interruption, the old public bytes remain unservable.
                // The worker rebuilds from the committed durable state.
                var update = await Store.Execute(connection, tx, actor, action, edit, ct);
                if (invalidate && update.Changed) Volatile.Write(ref _snapshot, null);
                return update;
            }, ct);

            if (invalidate && Snapshot is null)
            {
                try { await Rebuild(ct); }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "The article command committed; public projection awaits durable outbox recovery.");
                    throw new PublicUnavailableException();
                }
            }
            return result;
        }
        finally { _writers.Release(); }
    }

    internal async Task Refresh(CancellationToken ct)
    {
        await _writers.WaitAsync(ct);
        try { await Rebuild(ct); }
        finally { _writers.Release(); }
    }

    private async Task Rebuild(CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await connection.BeginTransactionAsync(System.Data.IsolationLevel.RepeatableRead, ct);
        long maxEvent;
        await using (var watermark = Store.Sql(connection, tx, "select coalesce(max(id),0) from public.blog_outbox"))
            maxEvent = (long)(await watermark.ExecuteScalarAsync(ct))!;
        var next = Snapshot;
        if (next is null || next.Watermark != maxEvent)
        {
            var taxonomy = await TaxonomyStore.Read(connection, tx, ct);
            await using var cmd = Store.Sql(connection, tx, """
                select a.id,r.revision,p.publication_id,r.title,r.body,a.created_at,r.happened_at,p.published_at,
                    p.publication_no, c.id, c.name, tags.ids, tags.names
                from public.article_publication p join public.article a on a.id=p.article_id
                join public.article_revision r on r.article_id=p.article_id and r.revision=p.revision
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
                var body = row.GetString(4);
                var limit = Math.Min(body.Length, 200);
                if (limit > 0 && char.IsHighSurrogate(body[limit - 1])) limit--;
                var category = row.IsDBNull(9) ? null : new TaxonomyName(row.GetInt32(9), row.GetString(10));
                var tags = row.IsDBNull(11) ? [] : row.GetFieldValue<int[]>(11).Zip(row.GetFieldValue<string[]>(12),
                    (id, name) => new TaxonomyName(id, name)).ToArray();
                articles.Add(new Article(row.GetInt32(0), revision, publication, checked((int)revision), row.GetInt32(8),
                    row.GetString(3), body, row.GetFieldValue<DateTimeOffset>(5), row.GetFieldValue<DateTimeOffset>(6),
                    row.GetFieldValue<DateTimeOffset>(7), body[..limit], category, tags));
            }
            next = new PublicSnapshot(maxEvent, articles, taxonomy, pages, _listCursor);
        }
        await using (var advance = Store.Sql(connection, tx, """
            update public.blog_outbox set processed_at=now() where id<=$1 and processed_at is null
            """, maxEvent)) await advance.ExecuteNonQueryAsync(ct);
        await tx.CommitAsync(ct);
        Volatile.Write(ref _snapshot, next);
    }
}

internal sealed class WebPages(string template)
{
    internal byte[] Page(string content = "", string? title = null, string? description = null)
    {
        var document = template.Replace("<!--fsus-public-content-->", content, StringComparison.Ordinal);
        if (title is not null)
            document = document.Replace("<title>Fsu's Blog</title>", $"<title>{HtmlEncoder.Default.Encode(title)} · Fsu's Blog</title>", StringComparison.Ordinal);
        if (!string.IsNullOrWhiteSpace(description))
            document = document.Replace("</head>", $"<meta name=\"description\" content=\"{HtmlEncoder.Default.Encode(description)}\"></head>", StringComparison.Ordinal);
        return Encoding.UTF8.GetBytes(document);
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
            try { await publications.Refresh(stoppingToken); }
            catch (Exception error) when (!stoppingToken.IsCancellationRequested)
            {
                log.LogError(error, "Public projection refresh failed; pending work remains durable.");
            }
        }
    }
}
