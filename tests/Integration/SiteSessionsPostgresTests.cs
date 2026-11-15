using System.Security.Cryptography;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Sessions;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class SiteSessionsPostgresTests
{
    [PostgresFact]
    public async Task ListsAndRevokesOnlyActiveAccountSessionsAndPreservesCurrentAuthority()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var account = await AddAccount(db, "Reader", ct);
        var foreign = await AddAccount(db, "Another reader", ct);
        var credential = await AddCredential(db, account, ct);
        var expiry = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.ToUnixTimeSeconds()).AddMinutes(10);
        var current = await AddSession(db, account, expiry, ct, credential: credential, mfa: true);
        var targeted = await AddSession(db, account, expiry, ct);
        var other = await AddSession(db, account, expiry, ct, credential: credential);
        var foreignSession = await AddSession(db, foreign, expiry, ct);
        await AddSession(db, account, expiry.AddMinutes(-20), ct);
        await AddSession(db, account, expiry, ct, generation: 2);

        var listed = await SiteSessions.List(store, current.Token, current.Id, ct);
        Assert.False(listed.HasMore);
        Assert.Equal(3, listed.Sessions.Count);
        var active = Assert.Single(listed.Sessions, session => session.Current);
        Assert.Equal(current.Id, active.Id);
        Assert.Equal(expiry.ToUnixTimeMilliseconds(), active.ExpiresAt);
        Assert.Equal(2, active.Method);
        Assert.True(active.Mfa);
        var ticket = Assert.Single(listed.Sessions, session => session.Id == targeted.Id);
        Assert.Equal(1, ticket.Method);
        Assert.False(ticket.Mfa);
        Assert.DoesNotContain(listed.Sessions, session => session.Id == current.Token || session.Id == Convert.ToHexStringLower(current.Digest));
        Assert.DoesNotContain(listed.Sessions, session => session.Id == foreignSession.Id);
        Assert.NotEqual(current.Id, SiteSessions.Id(foreign, current.Digest));

        await Denied(Rejection.Conflict, () => SiteSessions.List(store, current.Token, targeted.Id, ct));
        await Denied(Rejection.Conflict, () => SiteSessions.Revoke(store, other.Token, current.Id, null, ct));
        await Denied(Rejection.NotFound, () => SiteSessions.Revoke(store, current.Token, current.Id, foreignSession.Id, ct));
        await Denied(Rejection.NotFound, () => SiteSessions.Revoke(store, current.Token, current.Id, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)), ct));
        await Denied(Rejection.Conflict, () => SiteSessions.Revoke(store, current.Token, current.Id, current.Id, ct));
        Assert.Equal(3, (await SiteSessions.List(store, current.Token, current.Id, ct)).Sessions.Count);

        await SiteSessions.Revoke(store, current.Token, current.Id, targeted.Id, ct);
        await Denied(Rejection.Unauthorized, () => ReadOwner(store, targeted.Token, ct));
        await Denied(Rejection.NotFound, () => SiteSessions.Revoke(store, current.Token, current.Id, targeted.Id, ct));
        Assert.Equal(account, (await ReadOwner(store, other.Token, ct)).Id);

        await SiteSessions.Revoke(store, current.Token, current.Id, null, ct);
        await SiteSessions.Revoke(store, current.Token, current.Id, null, ct);
        await Denied(Rejection.Unauthorized, () => ReadOwner(store, other.Token, ct));
        var remaining = Assert.Single((await SiteSessions.List(store, current.Token, current.Id, ct)).Sessions);
        Assert.Equal(current.Id, remaining.Id);
        Assert.True(remaining.Current);
        Assert.Equal(1L, (await ReadOwner(store, current.Token, ct)).Generation);
        Assert.Equal(foreign, (await ReadOwner(store, foreignSession.Token, ct)).Id);
    }

    [PostgresFact]
    public async Task RevocationWaitingForAccountLockRechecksAuthorityAfterGenerationChanges()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        await using var authority = await fixture.DataSource.OpenConnectionAsync(ct);
        await using var inspection = await fixture.DataSource.OpenConnectionAsync(ct);
        var account = await AddAccount(authority, "Concurrent account", ct);
        var expiry = DateTimeOffset.UtcNow.AddMinutes(10);
        var stale = await AddSession(authority, account, expiry, ct);
        var target = await AddSession(authority, account, expiry, ct);
        var remaining = await AddSession(authority, account, expiry, ct);

        await using var transaction = await authority.BeginTransactionAsync(ct);
        await using (var write = Store.Sql(authority, transaction,
            "update public.blog_user set generation=2 where id=$1", account))
            Assert.Equal(1, await write.ExecuteNonQueryAsync(ct));
        using var operationDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        operationDeadline.CancelAfter(TimeSpan.FromSeconds(15));
        var revocation = SiteSessions.Revoke(store, stale.Token, stale.Id, target.Id, operationDeadline.Token);
        await using var waiting = Store.Sql(inspection, null, """
            select exists (
                select from pg_catalog.pg_stat_activity activity
                where activity.datname=current_database() and $1 = any(pg_catalog.pg_blocking_pids(activity.pid))
            )
            """, authority.ProcessID);
        while (!revocation.IsCompleted && await waiting.ExecuteScalarAsync(operationDeadline.Token) is false)
            await Task.Delay(15, operationDeadline.Token);
        Assert.False(revocation.IsCompleted, "Revocation should wait for the account lock before accessing its target.");

        // Move the other sessions to the new generation while the actor's old authority expires.
        await using (var retain = Store.Sql(authority, transaction, """
            update public.user_session set generation=2 where user_id=$1 and digest<>$2
            """, account, stale.Digest))
            Assert.Equal(2, await retain.ExecuteNonQueryAsync(ct));
        await transaction.CommitAsync(ct);

        await Denied(Rejection.Unauthorized, () => revocation);
        await Denied(Rejection.Unauthorized, () => ReadOwner(store, stale.Token, ct));
        Assert.Equal(2L, (await ReadOwner(store, target.Token, ct)).Generation);
        Assert.Equal(2L, (await ReadOwner(store, remaining.Token, ct)).Generation);
    }

    private static Task<Identity> ReadOwner(Store store, string token, CancellationToken ct) =>
        store.WithSession(token, false, (_, _, actor) => Task.FromResult(actor), ct);

    private static async Task<Guid> AddAccount(NpgsqlConnection db, string name, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        await FixtureSql.SiteAccountAsync(db, null, ct, id, name, canAuthor: false);
        return id;
    }

    private static async Task<byte[]> AddCredential(NpgsqlConnection db, Guid account, CancellationToken ct)
    {
        var credential = RandomNumberGenerator.GetBytes(32);
        await FixtureSql.SitePasskeyAsync(db, null, ct, account, credential, RandomNumberGenerator.GetBytes(32));
        return credential;
    }

    private static Task<(string Token, string Id, byte[] Digest)> AddSession(NpgsqlConnection db, Guid account,
        DateTimeOffset expiry, CancellationToken ct, long generation = 1, byte[]? credential = null, bool mfa = false) =>
        FixtureSql.SiteSessionAsync(db, account, expiry, ct, generation, credential, mfa);

    private static async Task Denied(Rejection expected, Func<Task> action) =>
        Assert.Equal(expected, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);
}
