using System.Net;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Analytics;
using FsusBlog.V2.Server.Operations;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class ArticleReadAuthorityPostgresTests
{
    [Fact]
    public void TicketRequiresElapsedAndClaimedDwellAndBindsEveryCoordinate()
    {
        var clock = new ReadClock();
        using var tickets = new ArticleReadTickets(clock);
        var epoch = ArticleReadTickets.Epoch(clock.GetUtcNow());
        var viewer = tickets.Viewer(12, epoch, IPAddress.Loopback, "browser");
        var ticket = tickets.Issue(12, 23, epoch, viewer);
        Assert.Equal(WireLayouts.ArticleReadTicketSize, ticket.Length);
        clock.Advance(TimeSpan.FromMilliseconds(7999));
        Assert.False(tickets.Accept(12, 23, epoch, viewer, ticket, 8000));
        clock.Advance(TimeSpan.FromMilliseconds(1));
        Assert.False(tickets.Accept(12, 23, epoch, viewer, ticket, 7999));
        Assert.False(tickets.Accept(12, 23, epoch, viewer, ticket, 8001));
        Assert.False(tickets.Accept(12, 24, epoch, viewer, ticket, 8000));
        Assert.False(tickets.Accept(13, 23, epoch, viewer, ticket, 8000));
        Assert.False(tickets.Accept(12, 23, epoch + 1, viewer, ticket, 8000));
        Assert.False(tickets.Accept(12, 23, epoch, tickets.Viewer(12, epoch, IPAddress.IPv6Loopback, "browser"), ticket, 8000));
        Assert.True(tickets.Accept(12, 23, epoch, viewer, ticket, 8000));
        clock.Advance(TimeSpan.FromMinutes(5));
        Assert.False(tickets.Accept(12, 23, epoch, viewer, ticket, 8000));
    }

    [PostgresFact]
    public async Task FailedTransactionRollsBackAndLostConnectorClosesTheOccupiedEpoch()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        var ct = timeout.Token;
        await using var database = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await database.DataSource.OpenConnectionAsync(ct);
        await using var lease = new InstanceLease(database.ConnectionString);
        await lease.Start(NullLogger.Instance, ct);
        var clock = new ReadClock();
        await using var authority = new ArticleReadAuthority(PrivateConnection(database.ConnectionString), lease, clock);
        var (id, publication) = await Publish(db, ct);
        var epoch = ArticleReadTickets.Epoch(clock.GetUtcNow());
        const string browser = "FsusBlog read integration viewer";

        var first = Assert.IsType<byte[]>(await authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        await Execute(db, "alter table public.article_read_dwell add constraint synthetic_failure check (count<0)", ct);
        clock.Advance(TimeSpan.FromSeconds(8));
        await Assert.ThrowsAsync<ArticleReadUnavailableException>(async () =>
            await authority.Submit(id, publication, IPAddress.Loopback, browser, first, 8000, ct));
        Assert.Equal(0L, await Count(db, "article_read_hour", ct));
        Assert.Equal(0L, await Count(db, "article_read_dwell", ct));
        Assert.Equal(DBNull.Value, await Scalar(db, "select last_epoch from public.article_read_epoch", ct));
        await Execute(db, "alter table public.article_read_dwell drop constraint synthetic_failure", ct);

        clock.Advance(TimeSpan.FromSeconds(5));
        var next = Assert.IsType<byte[]>(await authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        clock.Advance(TimeSpan.FromSeconds(8));
        Assert.False(await authority.Submit(id, publication, IPAddress.Loopback, browser, first, 8000, ct));
        Assert.True(await authority.Submit(id, publication, IPAddress.Loopback, browser, next, 8000, ct));
        Assert.False(await authority.Submit(id, publication, IPAddress.Loopback, browser, next, 8000, ct));
        Assert.Equal(1L, await Count(db, "article_read_hour", ct));
        Assert.Equal(1L, await Count(db, "article_read_dwell", ct));
        Assert.Equal(epoch, await Scalar(db, "select last_epoch from public.article_read_epoch", ct));

        Assert.Equal(true, await Scalar(db, """
            select pg_catalog.pg_terminate_backend(pid,5000) from pg_catalog.pg_stat_activity
            where datname=current_database() and application_name='fsus-article-read'
            """, ct));
        await Assert.ThrowsAsync<ArticleReadUnavailableException>(() =>
            authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        clock.Advance(TimeSpan.FromSeconds(5));
        await Assert.ThrowsAsync<ArticleReadUnavailableException>(() =>
            authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        Assert.False(await authority.Submit(id, publication, IPAddress.Loopback, browser, next, 8000, ct));
        clock.Advance(TimeSpan.FromMinutes(15));
        var afterRestart = Assert.IsType<byte[]>(await authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        clock.Advance(TimeSpan.FromSeconds(8));
        Assert.True(await authority.Submit(id, publication, IPAddress.Loopback, browser, afterRestart, 8000, ct));
        Assert.Equal(2L, await Count(db, "article_read_hour", ct));
        Assert.Equal(2L, await Count(db, "article_read_dwell", ct));
        Assert.Equal(epoch + 1, await Scalar(db, "select last_epoch from public.article_read_epoch", ct));
    }

    [UnixPostgresFact]
    public async Task LostCommitAcknowledgmentLeavesOnlyAggregatesAndCannotBeReplayed()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var ct = timeout.Token;
        await using var database = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await database.DataSource.OpenConnectionAsync(ct);
        await using var lease = new InstanceLease(database.ConnectionString);
        await lease.Start(NullLogger.Instance, ct);
        await using var proxy = new PostgresCommitAckDrop(PrivateConnection(database.ConnectionString));
        var clock = new ReadClock();
        await using var authority = new ArticleReadAuthority(proxy.ConnectionString, lease, clock);
        var (id, publication) = await Publish(db, ct);

        const string browser = "FsusBlog read acknowledgement probe";
        var ticket = Assert.IsType<byte[]>(await authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        var lost = proxy.DropNextCommitAcknowledgment();
        clock.Advance(TimeSpan.FromSeconds(8));
        await Assert.ThrowsAsync<ArticleReadUnavailableException>(async () =>
            await authority.Submit(id, publication, IPAddress.Loopback, browser, ticket, 8000, ct));
        await lost.WaitAsync(ct);
        Assert.Equal(1L, await Count(db, "article_read_hour", ct));
        Assert.Equal(1L, await Count(db, "article_read_dwell", ct));
        Assert.Equal(ArticleReadTickets.Epoch(clock.GetUtcNow()), await Scalar(db, "select last_epoch from public.article_read_epoch", ct));

        clock.Advance(TimeSpan.FromSeconds(5));
        await Assert.ThrowsAsync<ArticleReadUnavailableException>(() =>
            authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        Assert.False(await authority.Submit(id, publication, IPAddress.Loopback, browser, ticket, 8000, ct));
        Assert.Equal(1L, await Count(db, "article_read_hour", ct));
        Assert.Equal(1L, await Count(db, "article_read_dwell", ct));
        Assert.Equal(true, await Scalar(db, """
            select bool_and(relpersistence='t') from pg_catalog.pg_class where relname='article_read_seen'
            """, ct));
    }

    private static string PrivateConnection(string connection)
    {
        var settings = new NpgsqlConnectionStringBuilder(connection);
        settings.Options = (settings.Options + " -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0").Trim();
        return settings.ConnectionString;
    }

    private static async Task<(int Id, long Publication)> Publish(NpgsqlConnection db, CancellationToken ct)
    {
        var actor = new Identity(Guid.NewGuid(), "read-proof-owner", 1, true, DateTimeOffset.UtcNow.AddHours(1));
        await using var tx = await db.BeginTransactionAsync(ct);
        await using (var user = Store.Sql(db, tx,
            "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,true,true,1)", actor.Id, actor.Name))
            await user.ExecuteNonQueryAsync(ct);
        var (saved, _) = await Store.Execute(db, tx, actor, ArticleAction.Save, new(0, 0, Guid.NewGuid(), "Read article", "Public body."), ct);
        _ = await Store.Execute(db, tx, actor, ArticleAction.Publish, new(saved.Id, saved.Revision, Guid.NewGuid(), "", ""), ct);
        await tx.CommitAsync(ct);
        return (saved.Id, (long)(await Scalar(db, "select publication_id from public.article_publication", ct))!);
    }

    private static async Task<long> Count(NpgsqlConnection db, string table, CancellationToken ct) =>
        (long)(await Scalar(db, $"select coalesce(sum(count),0)::bigint from public.{table}", ct))!;

    private static async Task<object?> Scalar(NpgsqlConnection db, string sql, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(sql, db);
        return await cmd.ExecuteScalarAsync(ct);
    }

    private static async Task Execute(NpgsqlConnection db, string sql, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(sql, db);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private sealed class ReadClock : TimeProvider
    {
        private static readonly DateTimeOffset Start = new(2030, 1, 1, 8, 0, 0, TimeSpan.Zero);
        private TimeSpan _elapsed;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => _elapsed.Ticks;
        public override DateTimeOffset GetUtcNow() => Start + _elapsed;
        internal void Advance(TimeSpan elapsed) => _elapsed += elapsed;
    }

    private sealed class UnixPostgresFactAttribute : FactAttribute
    {
        public UnixPostgresFactAttribute()
        {
            if (OperatingSystem.IsWindows() || Environment.GetEnvironmentVariable(ScratchDatabase.Variable) is not { Length: > 0 } connection ||
                new NpgsqlConnectionStringBuilder(connection).Host is not { Length: > 0 } host || !Path.IsPathFullyQualified(host))
                Skip = $"Set {ScratchDatabase.Variable} to a PostgreSQL Unix socket for commit acknowledgment fault injection.";
        }
    }
}
