namespace FsusBlog.V2.Server.Analytics;

internal sealed class PublicHotArticles(Publications publications, NpgsqlDataSource db, InstanceLease lease,
    ILogger<PublicHotArticles> log, RuntimeEvidence? evidence = null) : BackgroundService
{
    internal const string Setting = "FSUSBLOG_PUBLIC_HOT_ARTICLES";
    internal const string PageMarker = """<meta name="fsus-public-hot-articles" content="1">""";
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan MaxAge = TimeSpan.FromMinutes(1);
    private static readonly TimeProvider Clock = TimeProvider.System;
    private Ranking? _ranking;

    internal sealed record Payload(byte[] Bytes, string Tag);
    private sealed record Ranking(WeakReference<PublicSnapshot> Snapshot, long LoadedAt, Payload[] Frames);

    internal Payload? Read(PublicSnapshot snapshot, int size)
    {
        var ranking = Volatile.Read(ref _ranking);
        return ranking is not null && IsSame(ranking.Snapshot, snapshot) &&
            Clock.GetElapsedTime(ranking.LoadedAt) <= MaxAge
            ? ranking.Frames[Math.Min(size, ranking.Frames.Length - 1)]
            : null;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, lease.Stopped);
        using var pulse = new PeriodicTimer(TimeSpan.FromSeconds(1));
        WeakReference<PublicSnapshot>? attempted = null;
        long lastAttempt = 0;
        try
        {
            do
            {
                if (publications.Snapshot is not { } snapshot ||
                    IsSame(attempted, snapshot) && Clock.GetElapsedTime(lastAttempt) < RefreshInterval)
                    continue;
                attempted = new(snapshot);
                lastAttempt = Clock.GetTimestamp();
                await Refresh(snapshot, stop.Token);
            } while (await pulse.WaitForNextTickAsync(stop.Token));
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }

    private async Task Refresh(PublicSnapshot snapshot, CancellationToken ct)
    {
        using var marker = evidence?.PublicationWork();
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(TimeSpan.FromSeconds(2));
        try
        {
            var rows = await ReadCurrent(snapshot, budget.Token);
            if (rows is null) return;
            var frames = new Payload[rows.Length + 1];
            for (var count = 0; count < frames.Length; count++)
            {
                budget.Token.ThrowIfCancellationRequested();
                var bytes = ArticleHotWire.Encode(rows.AsSpan(0, count).ToArray());
                frames[count] = new(bytes, $"\"{Convert.ToHexStringLower(SHA256.HashData(bytes))}\"");
            }
            if (ReferenceEquals(snapshot, publications.Snapshot))
                Volatile.Write(ref _ranking, new(new(snapshot), Clock.GetTimestamp(), frames));
        }
        catch (NpgsqlException error) when (!ct.IsCancellationRequested)
        {
            log.LogWarning(error, "The public article ranking could not be refreshed.");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            log.LogWarning("The public article ranking refresh exceeded its time budget.");
        }
    }

    private async Task<ArticleHotItem[]?> ReadCurrent(PublicSnapshot snapshot, CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var query = Store.Sql(connection, null, """
            with active as not materialized (
                select a.id,p.revision,p.publication_id
                from public.article a
                join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision
                join public.article_publication_rights r on r.publication_id=p.publication_id
                    and r.article_id=a.id and r.revision=p.revision
                where not a.deleted
            ), candidates as (
                (select a.*,r.views from public.article_read_total r join active a on a.id=r.article_id
                    order by r.views desc,r.article_id desc limit $1)
                union all
                (select a.*,0 as views from active a
                    where not exists(select from public.article_read_total r where r.article_id=a.id)
                    order by a.id desc limit $1)
            )
            select id,revision,publication_id,views from candidates order by views desc,id desc limit $1
            """, WireLimits.PublicArticleHotMaxSize);
        await using var reader = await query.ExecuteReaderAsync(ct);
        var rows = new List<ArticleHotItem>();
        while (await reader.ReadAsync(ct))
        {
            var id = reader.GetInt32(0);
            if (snapshot.Article(id) is not { } article || article.Revision != reader.GetInt64(1) ||
                article.Publication != reader.GetInt64(2))
                return null;
            rows.Add(new(id, reader.GetInt32(3), article.Title));
        }
        return rows.ToArray();
    }

    private static bool IsSame(WeakReference<PublicSnapshot>? reference, PublicSnapshot snapshot) =>
        reference is not null && reference.TryGetTarget(out var target) && ReferenceEquals(snapshot, target);
}
