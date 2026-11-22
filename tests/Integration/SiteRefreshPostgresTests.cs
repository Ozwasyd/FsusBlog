using System.Security.Cryptography;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Passkeys;
using FsusBlog.V2.Server.Sessions;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class SiteRefreshPostgresTests
{
    [PostgresFact]
    public async Task SerializesCompetingRotationsAndRevokesOnlyTheProvenReplayFamily()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var refresh = new SiteRefreshStore(fixture.DataSource);
        var access = new Store(fixture.DataSource);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using var inspection = await fixture.DataSource.OpenConnectionAsync(ct);
        var (owner, credential) = await AddPasskeyAccount(db, "Persistent account", ct);
        var original = await Issue(db, owner, credential, persistent: true, ct);
        var other = await Issue(db, owner, credential, persistent: true, ct);
        var ordinary = await Issue(db, owner, credential, persistent: false, ct);
        var family = await ReadCurrentFamily(access, original.Access, ct);
        var continuity = SiteSessions.Continuity(owner, Assert.IsType<Guid>(family));
        var handle = SiteSessions.Id(owner, Store.TokenDigest(original.Access)!);
        Assert.Null(ordinary.Refresh);
        Assert.Null(ordinary.RefreshExpires);

        var unknown = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await Expect(refresh.Rotate(unknown, original.Access, ct), SiteRefreshStore.ResultKind.Rejected);
        await Expect(refresh.Rotate(original.Refresh, other.Access, ct), SiteRefreshStore.ResultKind.Rejected);
        Assert.True(await refresh.HasCurrent(original.Refresh, ct));
        Assert.True(await refresh.HasCurrent(other.Refresh, ct));

        await using var gate = await db.BeginTransactionAsync(ct);
        await using (var locked = Store.Sql(db, gate, "select id from public.blog_user where id=$1 for update", owner))
            Assert.Equal(owner, await locked.ExecuteScalarAsync(ct));
        var first = refresh.Rotate(original.Refresh, original.Access, ct);
        var second = refresh.Rotate(original.Refresh, original.Access, ct);
        await WaitForBlockedRequests(inspection, db.ProcessID, 2, ct);
        Assert.False(first.IsCompleted);
        Assert.False(second.IsCompleted);
        await gate.CommitAsync(ct);

        var responses = await Task.WhenAll(first, second);
        var winner = Assert.Single(responses, result => result.Kind == SiteRefreshStore.ResultKind.Rotated);
        var rotated = Assert.IsType<SiteRefreshStore.Issued>(winner.Cookies);
        Assert.Null(Assert.Single(responses, result => result.Kind == SiteRefreshStore.ResultKind.Contention).Cookies);
        Assert.NotEqual(original.Access, rotated.Access);
        Assert.NotEqual(handle, SiteSessions.Id(owner, Store.TokenDigest(rotated.Access)!));
        Assert.Equal(continuity, SiteSessions.Continuity(owner, Assert.IsType<Guid>(await ReadCurrentFamily(access, rotated.Access, ct))));
        Assert.NotEqual(continuity, SiteSessions.Continuity(owner, Assert.IsType<Guid>(await ReadCurrentFamily(access, other.Access, ct))));
        Assert.NotEqual(original.Refresh, rotated.Refresh);
        await NoAccess(access, original.Access, ct);
        Assert.Equal(owner, (await ReadOwner(access, rotated.Access, ct)).Id);
        Assert.False(await refresh.HasCurrent(original.Refresh, ct));
        Assert.True(await refresh.HasCurrent(rotated.Refresh, ct));
        Assert.True(await IsMfaSession(db, rotated.Access, credential, ct));
        Assert.Equal((2L, 1L), await RefreshCounts(db, ct));

        await using (var history = Store.Sql(db, null, """
            update public.site_session_refresh_tombstone
            set used_at=clock_timestamp()-interval '10 seconds' where refresh_digest=$1
            """, Store.TokenDigest(original.Refresh)!))
            Assert.Equal(1, await history.ExecuteNonQueryAsync(ct));
        await Expect(refresh.Rotate(original.Refresh, original.Access, ct), SiteRefreshStore.ResultKind.Compromised);
        await NoAccess(access, rotated.Access, ct);
        Assert.False(await refresh.HasCurrent(rotated.Refresh, ct));
        Assert.True(await refresh.HasCurrent(other.Refresh, ct));
        Assert.Equal(owner, (await ReadOwner(access, other.Access, ct)).Id);
        Assert.Equal(owner, (await ReadOwner(access, ordinary.Access, ct)).Id);
        Assert.Equal((1L, 0L), await RefreshCounts(db, ct));
    }

    private static Task<Guid?> ReadCurrentFamily(Store store, string token, CancellationToken ct) =>
        store.WithSession(token, false, (db, tx, _) => SiteRefreshStore.FindCurrentFamily(db, tx, Store.TokenDigest(token)!, ct), ct);

    [PostgresFact]
    public async Task RenewsPastAccessExpiryAndCapsIdleExpiryAtTheAbsoluteDeadline()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var refresh = new SiteRefreshStore(fixture.DataSource);
        var access = new Store(fixture.DataSource);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (owner, credential) = await AddPasskeyAccount(db, "Persistent expiry", ct);
        var original = await Issue(db, owner, credential, persistent: true, ct);
        var initial = await ReadFamily(db, original.Refresh, ct);
        Assert.Equal(TimeSpan.FromDays(30), initial.Idle - initial.RotatedAt);
        Assert.Equal(TimeSpan.FromDays(90), initial.Absolute - initial.RotatedAt);
        Assert.Equal(initial.Idle, original.RefreshExpires);
        Assert.Equal(0, initial.Generation);

        await using (var expireAccess = Store.Sql(db, null, """
            update public.user_session set expires_at=clock_timestamp()-interval '1 second' where digest=$1
            """, Store.TokenDigest(original.Access)!))
            Assert.Equal(1, await expireAccess.ExecuteNonQueryAsync(ct));
        await NoAccess(access, original.Access, ct);
        Assert.True(await refresh.HasCurrent(original.Refresh, ct));
        var renewed = await Rotated(refresh.Rotate(original.Refresh, original.Access, ct));
        var next = await ReadFamily(db, renewed.Refresh, ct);
        Assert.Equal(initial.Id, next.Id);
        Assert.Equal(initial.Absolute, next.Absolute);
        Assert.Equal(TimeSpan.FromDays(30), next.Idle - next.RotatedAt);
        Assert.Equal(next.Idle, renewed.RefreshExpires);
        Assert.Equal(1, next.Generation);
        Assert.Equal(owner, (await ReadOwner(access, renewed.Access, ct)).Id);

        await using (var approachDeadline = Store.Sql(db, null, """
            update public.site_session_refresh
            set idle_expires_at=statement_timestamp()+interval '1 hour',
                absolute_expires_at=statement_timestamp()+interval '1 hour' where family_id=$1
            """, next.Id))
            Assert.Equal(1, await approachDeadline.ExecuteNonQueryAsync(ct));
        var capped = await Rotated(refresh.Rotate(renewed.Refresh, null, ct));
        var final = await ReadFamily(db, capped.Refresh, ct);
        Assert.Equal(final.Absolute, final.Idle);
        Assert.Equal(final.Absolute, capped.RefreshExpires);
        Assert.Equal(final.Absolute, capped.AccessExpires);
        Assert.Equal(2, final.Generation);

        await using (var expire = Store.Sql(db, null, """
            update public.site_session_refresh
            set idle_expires_at=statement_timestamp()-interval '1 second',
                absolute_expires_at=statement_timestamp()-interval '1 second' where family_id=$1
            """, final.Id))
            Assert.Equal(1, await expire.ExecuteNonQueryAsync(ct));
        Assert.False(await refresh.HasCurrent(capped.Refresh, ct));
        await Expect(refresh.Rotate(capped.Refresh, capped.Access, ct), SiteRefreshStore.ResultKind.Rejected);
    }

    [PostgresFact]
    public async Task RechecksGenerationAfterAccountLockAndCascadesRevocationAndSignOut()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var refresh = new SiteRefreshStore(fixture.DataSource);
        var access = new Store(fixture.DataSource);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using var inspection = await fixture.DataSource.OpenConnectionAsync(ct);
        var (owner, credential) = await AddPasskeyAccount(db, "Revoked owner", ct);
        var (peer, peerCredential) = await AddPasskeyAccount(db, "Independent owner", ct);
        var original = await Issue(db, owner, credential, persistent: true, ct);
        var revoked = await Rotated(refresh.Rotate(original.Refresh, original.Access, ct));
        var independent = await Issue(db, peer, peerCredential, persistent: true, ct);
        var signedOut = await Rotated(refresh.Rotate(independent.Refresh, independent.Access, ct));
        Assert.Equal((2L, 2L), await RefreshCounts(db, ct));

        await using var revocation = await db.BeginTransactionAsync(ct);
        await using (var change = Store.Sql(db, revocation, "update public.blog_user set generation=generation+1 where id=$1", owner))
            Assert.Equal(1, await change.ExecuteNonQueryAsync(ct));
        var waiting = refresh.Rotate(revoked.Refresh, revoked.Access, ct);
        await WaitForBlockedRequests(inspection, db.ProcessID, 1, ct);
        Assert.False(waiting.IsCompleted);
        await revocation.CommitAsync(ct);
        await Expect(waiting, SiteRefreshStore.ResultKind.Rejected);
        Assert.False(await refresh.HasCurrent(revoked.Refresh, ct));
        await NoAccess(access, revoked.Access, ct);
        Assert.True(await refresh.HasCurrent(signedOut.Refresh, ct));

        await using (var endSessions = Store.Sql(db, null, "delete from public.user_session where user_id=$1", owner))
            Assert.Equal(1, await endSessions.ExecuteNonQueryAsync(ct));
        Assert.Equal((1L, 1L), await RefreshCounts(db, ct));

        await refresh.SignOut(signedOut.Refresh, revoked.Access, ct);
        Assert.True(await refresh.HasCurrent(signedOut.Refresh, ct));
        Assert.Equal(peer, (await ReadOwner(access, signedOut.Access, ct)).Id);
        await refresh.SignOut(signedOut.Refresh, null, ct);
        Assert.False(await refresh.HasCurrent(signedOut.Refresh, ct));
        await NoAccess(access, signedOut.Access, ct);
        Assert.Equal((0L, 0L), await RefreshCounts(db, ct));
    }

    [PostgresFact]
    public async Task ListsAndRevokesPersistentSessionsAfterTheirAccessHasExpired()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var refresh = new SiteRefreshStore(fixture.DataSource);
        var access = new Store(fixture.DataSource);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (owner, credential) = await AddPasskeyAccount(db, "Manage persistent sessions", ct);
        var ordinary = await Issue(db, owner, credential, persistent: false, ct);
        var original = await Issue(db, owner, credential, persistent: true, ct);
        var persistent = await Rotated(refresh.Rotate(original.Refresh, original.Access, ct));
        var ordinaryId = SiteSessions.Id(owner, Store.TokenDigest(ordinary.Access)!);
        var persistentDigest = Store.TokenDigest(persistent.Access)!;
        var persistentId = SiteSessions.Id(owner, persistentDigest);
        await using (var expire = Store.Sql(db, null, """
            update public.user_session set expires_at=clock_timestamp()-interval '1 second' where digest=$1
            """, persistentDigest))
            Assert.Equal(1, await expire.ExecuteNonQueryAsync(ct));

        var ordinaryList = await SiteSessions.List(access, ordinary.Access, ordinaryId, ct);
        Assert.Equal(ordinaryId, Assert.Single(ordinaryList.Sessions).Id);
        var withPersistent = await SiteSessions.List(access, ordinary.Access, ordinaryId, ct, persistent: true);
        Assert.Equal(2, withPersistent.Sessions.Count);
        Assert.Equal(ordinaryId, Assert.Single(withPersistent.Sessions, row => row.Current).Id);
        var target = Assert.Single(withPersistent.Sessions, row => row.Id == persistentId);
        Assert.Equal(persistent.RefreshExpires!.Value.ToUnixTimeMilliseconds(), target.ExpiresAt);
        Assert.Equal(2, target.Method);
        Assert.True(target.Mfa);

        await SiteSessions.Revoke(access, ordinary.Access, ordinaryId, persistentId, ct, persistent: true);
        Assert.False(await refresh.HasCurrent(persistent.Refresh, ct));
        Assert.Equal((0L, 0L), await RefreshCounts(db, ct));
        Assert.Equal(owner, (await ReadOwner(access, ordinary.Access, ct)).Id);
    }

    private static async Task WaitForBlockedRequests(NpgsqlConnection inspection, int blocker, int count, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        await using var command = Store.Sql(inspection, null, """
            with recursive blocked(pid) as (
                select $1
                union
                select activity.pid from blocked join pg_catalog.pg_stat_activity activity
                on activity.datname=current_database() and blocked.pid=any(pg_catalog.pg_blocking_pids(activity.pid))
            )
            select count(*)-1 from blocked
            """, blocker);
        while ((long)(await command.ExecuteScalarAsync(deadline.Token))! < count)
            await Task.Delay(15, deadline.Token);
    }

    private static async Task<(Guid Owner, byte[] Credential)> AddPasskeyAccount(
        NpgsqlConnection db, string name, CancellationToken ct)
    {
        var owner = Guid.NewGuid();
        var credential = RandomNumberGenerator.GetBytes(32);
        await FixtureSql.SiteAccountAsync(db, null, ct, owner, name);
        await FixtureSql.SitePasskeyAsync(db, null, ct, owner, credential, RandomNumberGenerator.GetBytes(32));
        return (owner, credential);
    }

    private static async Task<SiteRefreshStore.Issued> Issue(NpgsqlConnection db, Guid owner, byte[] credential,
        bool persistent, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(ct);
        var issued = await MfaStore.IssueSession(db, tx, owner, 1, credential, mfa: true, persistent, ct);
        await tx.CommitAsync(ct);
        return issued;
    }

    private static async Task<(Guid Id, long Generation, DateTimeOffset Idle, DateTimeOffset Absolute, DateTimeOffset RotatedAt)>
        ReadFamily(NpgsqlConnection db, string? refresh, CancellationToken ct)
    {
        await using var command = Store.Sql(db, null, """
            select family_id,generation,idle_expires_at,absolute_expires_at,rotated_at
            from public.site_session_refresh where refresh_digest=$1
            """, Store.TokenDigest(refresh)!);
        await using var row = await command.ExecuteReaderAsync(ct);
        Assert.True(await row.ReadAsync(ct));
        return (row.GetGuid(0), row.GetInt64(1), row.GetFieldValue<DateTimeOffset>(2),
            row.GetFieldValue<DateTimeOffset>(3), row.GetFieldValue<DateTimeOffset>(4));
    }

    private static async Task<(long Families, long Tombstones)> RefreshCounts(NpgsqlConnection db, CancellationToken ct)
    {
        await using var command = Store.Sql(db, null, """
            select (select count(*) from public.site_session_refresh),
                (select count(*) from public.site_session_refresh_tombstone)
            """);
        await using var row = await command.ExecuteReaderAsync(ct);
        Assert.True(await row.ReadAsync(ct));
        return (row.GetInt64(0), row.GetInt64(1));
    }

    private static async Task<bool> IsMfaSession(NpgsqlConnection db, string token, byte[] credential, CancellationToken ct)
    {
        await using var command = Store.Sql(db, null, """
            select exists (
                select from public.user_session where digest=$1 and passkey_credential_id=$2 and totp_verified_at is not null
            )
            """, Store.TokenDigest(token)!, credential);
        return await command.ExecuteScalarAsync(ct) is true;
    }

    private static async Task<SiteRefreshStore.Issued> Rotated(Task<SiteRefreshStore.Result> operation)
    {
        var result = await operation;
        Assert.Equal(SiteRefreshStore.ResultKind.Rotated, result.Kind);
        return Assert.IsType<SiteRefreshStore.Issued>(result.Cookies);
    }

    private static async Task Expect(Task<SiteRefreshStore.Result> operation, SiteRefreshStore.ResultKind expected)
    {
        var result = await operation;
        Assert.Equal(expected, result.Kind);
        Assert.Null(result.Cookies);
    }

    private static Task<Identity> ReadOwner(Store access, string token, CancellationToken ct) =>
        access.WithSession(token, false, (_, _, actor) => Task.FromResult(actor), ct);

    private static Task NoAccess(Store access, string token, CancellationToken ct) =>
        BusinessAssert.Denied(Rejection.Unauthorized, () => ReadOwner(access, token, ct));
}
