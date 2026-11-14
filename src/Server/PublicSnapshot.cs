using System.Collections.Frozen;
using System.Text;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server;

internal sealed record PublicEntry(Article Article, byte[] Wire, byte[] Html);

internal sealed class PublicSnapshot
{
    private readonly PublicEntry[] _ordered;
    private readonly byte[][] _index;
    private readonly FrozenDictionary<int, PublicEntry> _byId;
    internal long Generation { get; }
    internal byte[] Home { get; }
    internal byte[] FirstPage { get; }
    internal int IndexPageCount => _index.Length;

    internal PublicSnapshot(long generation, IReadOnlyList<Article> articles, WebPages pages)
    {
        Generation = generation;
        _ordered = articles.Select(article => new PublicEntry(article, PublicArticles.EncodeDetail(article),
            pages.Page($"<main><article><h1>{HtmlEncoder.Default.Encode(article.Title)}</h1><pre>{HtmlEncoder.Default.Encode(article.Body)}</pre></article></main>", article.Title))).ToArray();
        _byId = _ordered.ToFrozenDictionary(entry => entry.Article.Id);
        var first = articles.Take(10).ToArray();
        FirstPage = PublicArticles.EncodeList(first, articles.Count);
        Home = pages.Page("<main><h1>FsusBlog</h1>" + (first.Length > 0
            ? "<ol>" + string.Concat(first.Select(article => $"<li><a href=\"/article/{article.Id}\">{HtmlEncoder.Default.Encode(article.Title)}</a></li>")) + "</ol>"
            : "<p>暂无文章</p>") + "</main>");
        _index = articles.Count == 0 ? [PublicArticles.EncodeSearch([], 0)] : articles.Chunk(WireLimits.SearchIndexPageSize)
            .Select(part => PublicArticles.EncodeSearch(part, part.Length)).ToArray();
    }

    internal PublicEntry? Article(int id) => _byId.GetValueOrDefault(id);

    internal byte[]? Index(int page) => page > 0 && page <= _index.Length ? _index[page - 1] : null;

    internal byte[] List(int page, int size, string? keyword, string? sort)
    {
        if (page == 1 && size == 10 && string.IsNullOrWhiteSpace(keyword) && string.IsNullOrEmpty(sort)) return FirstPage;
        var matching = Match(keyword, sort);
        var skip = ((long)page - 1) * size;
        return PublicArticles.EncodeList(skip < matching.Length ? matching.Skip((int)skip).Take(size).ToArray() : [], matching.Length);
    }

    internal byte[] Search(string? keyword)
    {
        var matching = Match(keyword, null);
        return PublicArticles.EncodeSearch(matching.Take(100).ToArray(), matching.Length);
    }

    private Article[] Match(string? keyword, string? sort)
    {
        var query = _ordered.Select(entry => entry.Article);
        if (!string.IsNullOrWhiteSpace(keyword))
            query = query.Where(article => article.Title.Contains(keyword, StringComparison.OrdinalIgnoreCase) ||
                                           article.Body.Contains(keyword, StringComparison.OrdinalIgnoreCase));
        if (sort == "oldest") query = query.Reverse();
        return query.ToArray();
    }

}

internal sealed class Publications(NpgsqlDataSource db, WebPages pages, ILogger<Publications> log)
{
    private readonly SemaphoreSlim _writers = new(1, 1);
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
        if (next is null || next.Generation != maxEvent)
        {
            await using var cmd = Store.Sql(connection, tx, """
                select a.id,r.revision,p.publication_id,r.title,r.body,a.created_at,r.happened_at,p.published_at
                from public.article_publication p join public.article a on a.id=p.article_id
                join public.article_revision r on r.article_id=p.article_id and r.revision=p.revision
                where not a.deleted and a.published_revision=p.revision
                order by p.published_at desc, a.id desc
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
                articles.Add(new Article(row.GetInt32(0), revision, publication, checked((int)revision), checked((int)publication),
                    row.GetString(3), body, row.GetFieldValue<DateTimeOffset>(5), row.GetFieldValue<DateTimeOffset>(6),
                    row.GetFieldValue<DateTimeOffset>(7), body[..limit]));
            }
            next = new PublicSnapshot(maxEvent, articles, pages);
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
    internal byte[] Page(string content = "", string? title = null)
    {
        var document = template.Replace("<!--fsus-public-content-->", content, StringComparison.Ordinal);
        if (title is not null)
            document = document.Replace("<title>Fsu's Blog</title>", $"<title>{HtmlEncoder.Default.Encode(title)} · Fsu's Blog</title>", StringComparison.Ordinal);
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
