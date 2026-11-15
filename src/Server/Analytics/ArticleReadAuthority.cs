using System.Net;
using System.Security.Cryptography;
using FsusBlog.V2.Server.Operations;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Analytics;

internal sealed class ArticleReadAuthority(string connectionString, InstanceLease lease, TimeProvider clock) : IAsyncDisposable
{
    private const int MaxReadsPerEpoch = 8192;
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ReconnectDelay = TimeSpan.FromSeconds(5);
    private readonly SemaphoreSlim _owner = new(1, 1);
    private readonly string _connectionString = new NpgsqlConnectionStringBuilder(connectionString)
    {
        ApplicationName = "fsus-article-read", Pooling = false, Enlist = false, Multiplexing = false, Timeout = 2,
        CommandTimeout = 1, CancellationTimeout = -1, IncludeErrorDetail = false, LogParameters = false
    }.ConnectionString;
    private Session? _session;
    private long? _lastReset;

    internal Task<byte[]?> Challenge(int id, long publication, IPAddress address, string userAgent, CancellationToken ct) =>
        Use<byte[]?>(open: true, ct, async (session, token) =>
        {
            if (session is null) throw new ArticleReadUnavailableException();
            var epoch = session.Observe(clock.GetUtcNow());
            if (epoch is null) throw new ArticleReadUnavailableException();
            await using var tx = await InstanceLease.BeginProtected(session.Connection, lease, token);
            await RequirePrivateSession(session.Connection, tx, token);
            if (!await IsActive(session.Connection, tx, id, publication, token)) return null;
            var now = clock.GetUtcNow();
            if (session.Observe(now) != epoch || !ArticleReadTickets.CanIssue(now, epoch.Value))
                throw new ArticleReadUnavailableException();
            var viewer = session.Tickets.Viewer(id, epoch.Value, address, userAgent);
            try { return session.Tickets.Issue(id, publication, epoch.Value, viewer); }
            finally { CryptographicOperations.ZeroMemory(viewer); }
        });

    internal Task<bool> Submit(int id, long publication, IPAddress address, string userAgent, ReadOnlyMemory<byte> ticket,
        int dwellMs, CancellationToken ct) => Use(open: false, ct, async (session, token) =>
    {
        if (session is null || session.Observe(clock.GetUtcNow()) is not { } epoch ||
            (session.CountEpoch == epoch && session.Accepted >= MaxReadsPerEpoch)) return false;
        var viewer = session.Tickets.Viewer(id, epoch, address, userAgent);
        try
        {
            if (!session.Tickets.Accept(id, publication, epoch, viewer, ticket.Span, dwellMs)) return false;
            await using var tx = await InstanceLease.BeginProtected(session.Connection, lease, token);
            await RequirePrivateSession(session.Connection, tx, token);
            if (!await IsActive(session.Connection, tx, id, publication, token)) return false;
            var now = clock.GetUtcNow();
            if (session.Observe(now) != epoch || !session.Tickets.Accept(id, publication, epoch, viewer, ticket.Span, dwellMs))
                return false;

            var rollover = session.CountEpoch != epoch;
            if (rollover)
            {
                await using var clear = Store.Sql(session.Connection, tx, "truncate table pg_temp.article_read_seen");
                await clear.ExecuteNonQueryAsync(token);
            }
            await using var consume = Store.Sql(session.Connection, tx, """
                insert into pg_temp.article_read_seen(viewer) values($1) on conflict do nothing
                """, viewer);
            if (await consume.ExecuteNonQueryAsync(token) != 1) return false;
            await AddCount(session.Connection, tx, id, now, epoch, ArticleReadTickets.DwellBucket(dwellMs), session.TrackTotals, token);
            await InstanceLease.CommitProtected(tx, lease, token);
            session.Accepted = rollover ? 1 : session.Accepted + 1;
            session.CountEpoch = epoch;
            return true;
        }
        finally { CryptographicOperations.ZeroMemory(viewer); }
    });

    private async Task<T> Use<T>(bool open, CancellationToken request, Func<Session?, CancellationToken, Task<T>> action)
    {
        request.ThrowIfCancellationRequested();
        if (!_owner.Wait(0)) throw new ArticleReadUnavailableException();
        try
        {
            lease.RequireCurrent();
            // Once admitted, the operation has its own deadline. A disconnected browser cannot abort the shared lane.
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(lease.Stopped);
            limit.CancelAfter(Deadline);
            if (open && _session is null)
            {
                if (_lastReset is { } reset && clock.GetElapsedTime(reset) < ReconnectDelay)
                    throw new ArticleReadUnavailableException();
                _session = await Open(limit.Token);
            }
            return await action(_session, limit.Token);
        }
        catch (Exception fault) when (fault is NpgsqlException or TimeoutException or OperationCanceledException or PublicUnavailableException)
        {
            await Retire();
            throw new ArticleReadUnavailableException();
        }
        finally { _owner.Release(); }
    }

    private async Task<Session> Open(CancellationToken ct)
    {
        var connection = new NpgsqlConnection(_connectionString);
        try
        {
            await connection.OpenAsync(ct);
            await using var tx = await InstanceLease.BeginProtected(connection, lease, ct);
            await RequirePrivateSession(connection, tx, ct);
            if (!await CurrentSchema.HasArticleReadSchemaAsync(connection, tx, ct)) throw new PublicUnavailableException();
            var trackTotals = await CurrentSchema.HasArticleReadTotalSchemaAsync(connection, tx, ct);
            await using var read = Store.Sql(connection, tx, "select last_epoch from public.article_read_epoch where singleton");
            var watermark = await read.ExecuteScalarAsync(ct);
            if (watermark is not (DBNull or long)) throw new PublicUnavailableException();
            await using var create = Store.Sql(connection, tx, """
                create temporary table article_read_seen(viewer bytea primary key) on commit preserve rows
                """);
            await create.ExecuteNonQueryAsync(ct);
            await InstanceLease.CommitProtected(tx, lease, ct);
            return new(connection, new ArticleReadTickets(clock), watermark is long epoch ? epoch : -1, trackTotals);
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    private static async Task RequirePrivateSession(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var settings = Store.Sql(db, tx, """
            select pg_catalog.current_setting('log_parameter_max_length')='0'
                and pg_catalog.current_setting('log_parameter_max_length_on_error')='0'
                and coalesce(pg_catalog.current_setting('pgaudit.log_parameter',true),'off') in ('off','false','0')
                and coalesce(pg_catalog.current_setting('auto_explain.log_parameter_max_length',true),'0')='0'
            """);
        if (await settings.ExecuteScalarAsync(ct) is not true) throw new PublicUnavailableException();
    }

    private static async Task<bool> IsActive(NpgsqlConnection db, NpgsqlTransaction tx, int id, long publication, CancellationToken ct)
    {
        await using var predecessor = Store.Sql(db, tx, """
            select 1 from public.article a join public.article_publication p on p.article_id=a.id
            join public.article_publication_rights r on r.article_id=p.article_id and r.publication_id=p.publication_id and r.revision=p.revision
            where a.id=$1 and p.publication_id=$2 and not a.deleted and a.published_revision=p.revision
            for share of a,p
            """, id, publication);
        return await predecessor.ExecuteScalarAsync(ct) is not null;
    }

    private static async Task AddCount(NpgsqlConnection db, NpgsqlTransaction tx, int id, DateTimeOffset utc,
        long epoch, int dwellBucket, bool trackTotals, CancellationToken ct)
    {
        var hour = new DateTimeOffset(utc.Year, utc.Month, utc.Day, utc.Hour, 0, 0, TimeSpan.Zero);
        await using var watermark = Store.Sql(db, tx, """
            update public.article_read_epoch set last_epoch=$1 where singleton and (last_epoch is null or last_epoch<=$1)
            """, epoch);
        if (await watermark.ExecuteNonQueryAsync(ct) != 1) throw new PublicUnavailableException();
        const string incrementHour = """
            insert into public.article_read_hour(article_id,hour_utc,count) values($1,$2,1)
            on conflict(article_id,hour_utc) do update set count=article_read_hour.count+1
            """;
        // A saturated total remains at Int32.MaxValue while the accepted hourly aggregate continues independently.
        const string incrementHourAndTotal = $"""
            with counted as (
                {incrementHour}
                returning article_id
            )
            insert into public.article_read_total(article_id,views)
            select article_id,1 from counted
            on conflict(article_id) do update set views=article_read_total.views+1
            where article_read_total.views<2147483647
            """;
        await using var count = Store.Sql(db, tx, trackTotals ? incrementHourAndTotal : incrementHour, id, hour);
        await count.ExecuteNonQueryAsync(ct);
        await using var dwell = Store.Sql(db, tx, """
            insert into public.article_read_dwell(article_id,day_utc,bucket,count) values($1,$2,$3,1)
            on conflict(article_id,day_utc,bucket) do update set count=article_read_dwell.count+1
            """, id, DateOnly.FromDateTime(utc.UtcDateTime), dwellBucket);
        await dwell.ExecuteNonQueryAsync(ct);
    }

    private async Task Retire()
    {
        var previous = _session;
        _session = null;
        _lastReset = clock.GetTimestamp();
        if (previous is null) return;
        previous.Tickets.Dispose();
        try { await previous.Connection.DisposeAsync(); }
        catch (NpgsqlException) { }
    }

    public async ValueTask DisposeAsync()
    {
        await _owner.WaitAsync();
        try { await Retire(); }
        finally { _owner.Dispose(); }
    }

    private sealed class Session(NpgsqlConnection connection, ArticleReadTickets tickets, long restoreWatermark, bool trackTotals)
    {
        internal NpgsqlConnection Connection { get; } = connection;
        internal ArticleReadTickets Tickets { get; } = tickets;
        internal bool TrackTotals { get; } = trackTotals;
        internal long CountEpoch { get; set; } = -1;
        internal int Accepted { get; set; }
        private readonly long _restoreWatermark = restoreWatermark;
        private long _observedEpoch = restoreWatermark;

        internal long? Observe(DateTimeOffset utc)
        {
            var epoch = ArticleReadTickets.Epoch(utc);
            if (epoch < _observedEpoch || epoch <= _restoreWatermark) return null;
            _observedEpoch = epoch;
            return epoch;
        }
    }
}

internal sealed class ArticleReadUnavailableException : Exception;
