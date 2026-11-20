using System.Buffers.Binary;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminSignInHistoryPostgresTests
{
    [PostgresFact]
    public async Task RecentSignInsUseOnlyTheCurrentAdminPrincipalAndDoNotSynthesizeUnlinkedSessions()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = OpenStore(fixture);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await AddAdmin(db, "history-owner", ct);
        var other = await AddAdmin(db, "history-other", ct);
        var site = Guid.NewGuid();
        var siteToken = NewToken();
        await Execute(db, null, ct, "insert into public.blog_user(id,name,enabled,generation) values($1,'Site reader',true,1)", site);
        await Execute(db, null, ct, """
            insert into public.user_session(digest,user_id,generation,expires_at)
            values($1,$2,1,clock_timestamp()+interval '10 minutes')
            """, Digest(siteToken), site);
        Assert.Equal(site, await new Store(fixture.DataSource).WithSession(siteToken, false, (_, _, actor) => Task.FromResult(actor.Id), ct));
        await Denied(() => store.RecentSignIns(siteToken, ct));
        await Denied(() => store.RecentSignIns(null, ct));

        var preUpgrade = NewToken();
        await Execute(db, null, ct, """
            insert into public.admin_session(digest,principal_id,generation,expires_at)
            values($1,$2,1,clock_timestamp()+interval '10 minutes')
            """, Digest(preUpgrade), owner);
        var unlinked = await store.RecentSignIns(preUpgrade, ct);
        Assert.Empty(unlinked.History.SignIns);
        Assert.Equal((await store.SessionWithPermissionBinding(preUpgrade, ct)).PermissionSession, unlinked.PermissionSession);

        var ownerToken = await Record(db, owner, ct);
        var otherToken = await Record(db, other, ct);
        _ = await Record(db, other, ct);
        await Denied(() => store.RecentSignIns(preUpgrade, ct));
        await Denied(() => store.RecentSignIns(otherToken, ct));
        var current = await store.RecentSignIns(ownerToken, ct);
        Assert.Equal(1L, current.History.Generation);
        Assert.Equal(AdminSignInState.Current, Assert.Single(current.History.SignIns).State);
        Assert.Matches("^[a-f0-9]{64}$", current.PermissionSession);
        Assert.NotEqual(ownerToken, current.PermissionSession);
        Assert.NotEqual(unlinked.PermissionSession, current.PermissionSession);
        Assert.Equal((await store.SessionWithPermissionBinding(ownerToken, ct)).PermissionSession, current.PermissionSession);
        var packet = Wire.EncodeAdminSignInHistory(current.History);
        var body = Aeds.Decode(packet, FrameType.AdminSignInHistory).ToArray();
        Assert.Equal(37, body.Length);
        Assert.Equal(current.History.Generation, BinaryPrimitives.ReadInt64LittleEndian(body));
        Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(body.AsSpan(8)));
        Assert.Equal((byte)AdminSignInState.Current, body[^1]);
        Assert.Throws<ProtocolException>(() => Wire.EncodeAdminSignInHistory(new(1,
            [new(1, 5, 0, AdminSignInState.Current), new(1, 5, 0, AdminSignInState.Current)])));
        Assert.Throws<ProtocolException>(() => Wire.EncodeAdminSignInHistory(new(1, [new(1, 5, 3, AdminSignInState.Expired)])));

        await Execute(db, null, ct, "update public.admin_principal set enabled=false where id=$1", owner);
        await Denied(() => store.RecentSignIns(ownerToken, ct));
    }

    [PostgresFact]
    public async Task TracksReplacementLogoutAndNaturalExpiryWithoutRevokingAReplacementFromAnOldCookie()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = OpenStore(fixture);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await AddAdmin(db, "history-transitions", ct);
        var expiredToken = await Record(db, owner, ct);
        var expiry = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.ToUnixTimeSeconds()).AddMinutes(-5);
        await using (var adjust = await db.BeginTransactionAsync(ct))
        {
            await Execute(db, adjust, ct, """
                update public.admin_sign_in h set started_at=$3,expires_at=$2
                from public.admin_session s where s.digest=$1 and s.principal_id=h.principal_id and s.sign_in_id=h.id
                """, Digest(expiredToken), expiry, expiry.AddMinutes(-10));
            await Execute(db, adjust, ct, "update public.admin_session set expires_at=$2 where digest=$1", Digest(expiredToken), expiry);
            await adjust.CommitAsync(ct);
        }
        await Denied(() => store.RecentSignIns(expiredToken, ct));

        var replacedToken = await Record(db, owner, ct);
        var replacement = (await store.RecentSignIns(replacedToken, ct)).History;
        var expired = Assert.Single(replacement.SignIns, row => row.State == AdminSignInState.Expired);
        Assert.Equal(expiry.AddMinutes(-10).ToUnixTimeMilliseconds(), expired.StartedAt);
        Assert.Equal(expiry.ToUnixTimeMilliseconds(), expired.ExpiresAt);
        Assert.Equal(expired.ExpiresAt, expired.EndedAt);
        await using (var persisted = Store.Sql(db, null, """
            select ended_at=expires_at from public.admin_sign_in where principal_id=$1 and expires_at=$2
            """, owner, expiry))
            Assert.Equal(true, await persisted.ExecuteScalarAsync(ct));

        var loggedOutToken = await Record(db, owner, ct);
        await Denied(() => store.RecentSignIns(replacedToken, ct));
        await store.SignOut(replacedToken, ct);
        var beforeLogout = (await store.RecentSignIns(loggedOutToken, ct)).History;
        var active = Assert.Single(beforeLogout.SignIns, row => row.State == AdminSignInState.Current);
        Assert.Equal(0L, active.EndedAt);
        Assert.True(active.ExpiresAt > active.StartedAt);
        var replaced = Assert.Single(beforeLogout.SignIns, row => row.State == AdminSignInState.Ended);
        Assert.InRange(replaced.EndedAt, replaced.StartedAt, replaced.ExpiresAt - 1);
        await store.SignOut(loggedOutToken, ct);
        await Denied(() => store.RecentSignIns(loggedOutToken, ct));

        var renewedToken = await Record(db, owner, ct);
        var afterLogout = (await store.RecentSignIns(renewedToken, ct)).History;
        var ended = afterLogout.SignIns.Where(row => row.State == AdminSignInState.Ended).ToArray();
        Assert.Equal(2, ended.Length);
        Assert.Contains(replaced, ended);
        Assert.Contains(ended, row => row.StartedAt == active.StartedAt && row.ExpiresAt == active.ExpiresAt);
        Assert.Contains(expired, afterLogout.SignIns);
        var beforeRevocation = Assert.Single(afterLogout.SignIns, row => row.State == AdminSignInState.Current);

        await using (var revoke = await db.BeginTransactionAsync(ct))
        {
            await Execute(db, revoke, ct, "update public.admin_principal set generation=generation+1 where id=$1", owner);
            await AdminSignInHistory.RetireAsync(db, revoke, owner, null, ct);
            await revoke.CommitAsync(ct);
        }
        await Denied(() => store.RecentSignIns(renewedToken, ct));
        var nextToken = await Record(db, owner, ct);
        var afterRevocation = (await store.RecentSignIns(nextToken, ct)).History;
        Assert.Equal(2L, afterRevocation.Generation);
        Assert.Contains(afterRevocation.SignIns, row => row.State == AdminSignInState.Ended &&
            row.StartedAt == beforeRevocation.StartedAt && row.ExpiresAt == beforeRevocation.ExpiresAt);
    }

    [PostgresFact]
    public async Task KeepsOnlyTheFiftyMostRecentSuccessfulSignInsPerPrincipal()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = OpenStore(fixture);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await AddAdmin(db, "history-retention", ct);
        var other = await AddAdmin(db, "history-retention-other", ct);
        var otherToken = await Record(db, other, ct);
        var first = await Record(db, owner, ct);
        long oldest;
        await using (var read = Store.Sql(db, null, "select sign_in_id from public.admin_session where digest=$1", Digest(first)))
            oldest = (long)(await read.ExecuteScalarAsync(ct))!;

        var latest = first;
        for (var index = 0; index < 51; index++) latest = await Record(db, owner, ct);
        var observed = (await store.RecentSignIns(latest, ct)).History;
        Assert.Equal(50, observed.SignIns.Count);
        Assert.Equal(Assert.Single(observed.SignIns, row => row.State == AdminSignInState.Current), observed.SignIns[0]);
        Assert.All(observed.SignIns.Where(row => row.State != AdminSignInState.Current), row => Assert.Equal(AdminSignInState.Ended, row.State));
        Assert.Single((await store.RecentSignIns(otherToken, ct)).History.SignIns);
        await using (var remaining = Store.Sql(db, null, """
            select count(*)=50 and min(id)>$2 from public.admin_sign_in where principal_id=$1
            """, owner, oldest))
            Assert.Equal(true, await remaining.ExecuteScalarAsync(ct));
    }

    private static AdminPasskeyStore OpenStore(ScratchDatabase fixture) =>
        new(fixture.DataSource, null, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));

    private static async Task<Guid> AddAdmin(NpgsqlConnection db, string handle, CancellationToken ct)
    {
        var principal = Guid.NewGuid();
        await Execute(db, null, ct, "insert into public.admin_principal(id,handle,user_handle,enabled,generation) values($1,$2,$3,true,1)",
            principal, handle, RandomNumberGenerator.GetBytes(32));
        await Execute(db, null, ct, """
            insert into public.admin_passkey_credential(credential_id,principal_id,public_key,sign_count,backup_eligible,backed_up)
            values($1,$2,$3,0,false,false)
            """, RandomNumberGenerator.GetBytes(32), principal, new byte[] { 1 });
        return principal;
    }

    private static async Task<string> Record(NpgsqlConnection db, Guid principal, CancellationToken ct)
    {
        var token = NewToken();
        await using var transaction = await db.BeginTransactionAsync(ct);
        await using (var owner = Store.Sql(db, transaction, "select generation from public.admin_principal where id=$1 for update", principal))
        {
            var generation = (long)(await owner.ExecuteScalarAsync(ct))!;
            await AdminSignInHistory.RecordAsync(db, transaction, principal, Digest(token), generation, ct);
        }
        await transaction.CommitAsync(ct);
        return token;
    }

    private static string NewToken() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
    private static byte[] Digest(string token) => Store.TokenDigest(token)!;

    private static async Task Execute(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, string sql, params object[] args)
    {
        await using var command = Store.Sql(db, tx, sql, args);
        await command.ExecuteNonQueryAsync(ct);
    }

    private static async Task Denied(Func<Task> action) =>
        Assert.Equal(Rejection.Unauthorized, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);
}
