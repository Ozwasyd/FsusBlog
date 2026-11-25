namespace FsusBlog.V2.Integration.Tests;

// These tests exercise the production lease heartbeat and SQL deadlines on a real cluster.
[CollectionDefinition("Article read authority", DisableParallelization = true)]
public sealed class ArticleReadAuthorityCollection;

[Collection("Article read authority")]
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
        foreach (var (art, pub, ep, v, dwell) in new[]
        {
            (12, 23L, epoch, viewer, 7999), (12, 23L, epoch, viewer, 8001),
            (12, 24L, epoch, viewer, 8000), (13, 23L, epoch, viewer, 8000),
            (12, 23L, epoch + 1, viewer, 8000), (12, 23L, epoch, tickets.Viewer(12, epoch, IPAddress.IPv6Loopback, "browser"), 8000),
        })
            Assert.False(tickets.Accept(art, pub, ep, v, ticket, dwell));
        Assert.True(tickets.Accept(12, 23, epoch, viewer, ticket, 8000));
        clock.Advance(TimeSpan.FromMinutes(5));
        Assert.False(tickets.Accept(12, 23, epoch, viewer, ticket, 8000));
    }

    [PostgresFact]
    public async Task FailedTransactionRollsBackAndLostConnectorClosesTheOccupiedEpoch()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        await using var lease = new InstanceLease(database.ConnectionString);
        await lease.Start(NullLogger.Instance, ct);
        var clock = new ReadClock();
        await using var authority = new ArticleReadAuthority(PrivateConnection(database.ConnectionString), lease, clock);
        var (id, publication) = await Publish(database, ct);
        var epoch = ArticleReadTickets.Epoch(clock.GetUtcNow());
        const string browser = "FsusBlog read integration viewer";

        var first = Assert.IsType<byte[]>(await authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        await database.Exec("alter table public.article_read_dwell add constraint synthetic_failure check (count<0)");
        clock.Advance(TimeSpan.FromSeconds(8));
        var failure = await Assert.ThrowsAsync<ArticleReadUnavailableException>(
            () => authority.Submit(id, publication, IPAddress.Loopback, browser, first, 8000, ct));
        Assert.Equal($"PostgreSQL error ({PostgresErrorCodes.CheckViolation}).", failure.Message);
        await AssertAggregates(database, id, 0, DBNull.Value);
        await database.Exec("alter table public.article_read_dwell drop constraint synthetic_failure");

        clock.Advance(TimeSpan.FromSeconds(5));
        var next = Assert.IsType<byte[]>(await authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        clock.Advance(TimeSpan.FromSeconds(8));
        Assert.False(await authority.Submit(id, publication, IPAddress.Loopback, browser, first, 8000, ct));
        Assert.True(await authority.Submit(id, publication, IPAddress.Loopback, browser, next, 8000, ct));
        Assert.False(await authority.Submit(id, publication, IPAddress.Loopback, browser, next, 8000, ct));
        await AssertAggregates(database, id, 1, epoch);

        Assert.True(await database.Scalar<bool>("""
            select pg_catalog.pg_terminate_backend(pid,5000) from pg_catalog.pg_stat_activity
            where datname=current_database() and application_name='fsus-article-read'
            """));
        await Assert.ThrowsAsync<ArticleReadUnavailableException>(() => authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        clock.Advance(TimeSpan.FromSeconds(5));
        await Assert.ThrowsAsync<ArticleReadUnavailableException>(() => authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        Assert.False(await authority.Submit(id, publication, IPAddress.Loopback, browser, next, 8000, ct));
        clock.Advance(TimeSpan.FromMinutes(15));
        var afterRestart = Assert.IsType<byte[]>(await authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        clock.Advance(TimeSpan.FromSeconds(8));
        Assert.True(await authority.Submit(id, publication, IPAddress.Loopback, browser, afterRestart, 8000, ct));
        await AssertAggregates(database, id, 2, epoch + 1);
    }

    [UnixPostgresFact]
    public async Task LostCommitAcknowledgmentLeavesOnlyAggregatesAndCannotBeReplayed()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(30));
        await using var lease = new InstanceLease(database.ConnectionString);
        await lease.Start(NullLogger.Instance, ct);
        await using var proxy = new PostgresCommitAckDrop(PrivateConnection(database.ConnectionString));
        var clock = new ReadClock();
        await using var authority = new ArticleReadAuthority(proxy.ConnectionString, lease, clock);
        var (id, publication) = await Publish(database, ct);

        const string browser = "FsusBlog read acknowledgement probe";
        var ticket = Assert.IsType<byte[]>(await authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        var lost = proxy.DropNextCommitAcknowledgment();
        clock.Advance(TimeSpan.FromSeconds(8));
        await Assert.ThrowsAsync<ArticleReadUnavailableException>(() => authority.Submit(id, publication, IPAddress.Loopback, browser, ticket, 8000, ct));
        await lost.WaitAsync(ct);
        await AssertAggregates(database, id, 1, ArticleReadTickets.Epoch(clock.GetUtcNow()));

        clock.Advance(TimeSpan.FromSeconds(5));
        await Assert.ThrowsAsync<ArticleReadUnavailableException>(() => authority.Challenge(id, publication, IPAddress.Loopback, browser, ct));
        Assert.False(await authority.Submit(id, publication, IPAddress.Loopback, browser, ticket, 8000, ct));
        Assert.Equal((1L, 1L, 1), (await Count(database, "article_read_hour"), await Count(database, "article_read_dwell"), await Total(database, id)));
        Assert.True(await database.Scalar<bool>("select bool_and(relpersistence='t') from pg_catalog.pg_class where relname='article_read_seen'"));
    }

    [PostgresFact]
    public async Task RankedTotalSaturatesWhileHourlyAndDwellAggregatesContinue()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(30));
        await using var lease = new InstanceLease(database.ConnectionString);
        await lease.Start(NullLogger.Instance, ct);
        var (id, publication) = await Publish(database, ct);
        var clock = new ReadClock();
        var now = clock.GetUtcNow();
        await database.Exec("""
            with hourly as (
                insert into public.article_read_hour(article_id,hour_utc,count) values($1,$2,2147483646) returning article_id
            ), total as (
                insert into public.article_read_total(article_id,views) select article_id,2147483646 from hourly
            )
            update public.article_read_epoch set last_epoch=$3 where singleton
            """, id, now, ArticleReadTickets.Epoch(now) - 1);

        await using var authority = new ArticleReadAuthority(PrivateConnection(database.ConnectionString), lease, clock);
        foreach (var viewer in new[] { IPAddress.Loopback, IPAddress.IPv6Loopback })
        {
            var ticket = Assert.IsType<byte[]>(await authority.Challenge(id, publication, viewer, "Read probe", ct));
            clock.Advance(TimeSpan.FromSeconds(8));
            Assert.True(await authority.Submit(id, publication, viewer, "Read probe", ticket, 8000, ct));
            Assert.Equal(int.MaxValue, await Total(database, id));
        }
        Assert.Equal(((long)int.MaxValue + 1, 2L), (await Count(database, "article_read_hour"), await Count(database, "article_read_dwell")));
    }

    [PostgresFact]
    public async Task OlderAggregateSchemaCountsReadsWithoutTheOptionalTotal()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(30));
        await database.Exec("drop table public.article_read_total");
        await using var lease = new InstanceLease(database.ConnectionString);
        await lease.Start(NullLogger.Instance, ct);
        var (id, publication) = await Publish(database, ct);
        var clock = new ReadClock();
        await using var authority = new ArticleReadAuthority(PrivateConnection(database.ConnectionString), lease, clock);

        var ticket = Assert.IsType<byte[]>(await authority.Challenge(id, publication, IPAddress.Loopback, "Read probe", ct));
        clock.Advance(TimeSpan.FromSeconds(8));
        Assert.True(await authority.Submit(id, publication, IPAddress.Loopback, "Read probe", ticket, 8000, ct));
        Assert.Equal((1L, 1L), (await Count(database, "article_read_hour"), await Count(database, "article_read_dwell")));
    }

    private static string PrivateConnection(string connection)
    {
        var settings = new NpgsqlConnectionStringBuilder(connection);
        settings.Options = (settings.Options + " -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0").Trim();
        return settings.ConnectionString;
    }

    private static Task<(int Id, long Publication)> Publish(ScratchDatabase database, CancellationToken ct) =>
        database.InTx(async (db, tx) =>
        {
            var actor = new Identity(Guid.NewGuid(), "read-proof-owner", 1, true, DateTimeOffset.UtcNow.AddHours(1));
            await FixtureSql.AdminPrincipalAsync(db, tx, ct, actor.Id, actor.Name);
            var (saved, _) = await Store.Execute(db, tx, actor, ArticleAction.Save, new(0, 0, Guid.NewGuid(), "Read article", "Public body."), ct);
            _ = await Store.Execute(db, tx, actor, ArticleAction.Publish, new(saved.Id, saved.Revision, Guid.NewGuid(), "", ""), ct);
            return (saved.Id, (long)(await FixtureSql.ScalarAsync(db, tx, ct, "select publication_id from public.article_publication"))!);
        }, ct);

    private static async Task AssertAggregates(ScratchDatabase database, int id, int count, object expectedEpoch)
    {
        Assert.Equal(((long)count, (long)count, count),
            (await Count(database, "article_read_hour"), await Count(database, "article_read_dwell"), await Total(database, id)));
        Assert.Equal(expectedEpoch, await database.Scalar("select last_epoch from public.article_read_epoch"));
    }

    private static Task<long> Count(ScratchDatabase database, string table) =>
        database.Scalar<long>($"select coalesce(sum(count),0)::bigint from public.{table}");

    private static async Task<int> Total(ScratchDatabase database, int article) =>
        await database.Scalar("select views from public.article_read_total where article_id=$1", article) is int views ? views : 0;

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
