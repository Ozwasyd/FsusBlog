namespace FsusBlog.V2.Integration.Tests;

public sealed class SiteRefreshPostgresTests
{
    [PostgresFact]
    public async Task SerializesCompetingRotationsAndRevokesOnlyTheProvenReplayFamily()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var refresh = new SiteRefreshStore(fixture.DataSource);
        var access = new Store(fixture.DataSource);
        var (owner, credential) = await fixture.SitePasskeyAccountAsync("Persistent account");
        var original = await Issue(fixture, owner, credential, persistent: true, ct);
        var other = await Issue(fixture, owner, credential, persistent: true, ct);
        var ordinary = await Issue(fixture, owner, credential, persistent: false, ct);
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

        var (first, second) = await fixture.InTx(async (db, gate) =>
        {
            Assert.Equal(owner, await FixtureSql.ScalarAsync(db, gate, ct, "select id from public.blog_user where id=$1 for update", owner));
            var a = refresh.Rotate(original.Refresh, original.Access, ct);
            var b = refresh.Rotate(original.Refresh, original.Access, ct);
            await fixture.WaitForBlocked(db.ProcessID, 2);
            Assert.False(a.IsCompleted);
            Assert.False(b.IsCompleted);
            return (a, b);
        });

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
        Assert.True(await fixture.Scalar<bool>("""
            select exists (select from public.user_session where digest=$1 and passkey_credential_id=$2 and totp_verified_at is not null)
            """, Store.TokenDigest(rotated.Access)!, credential));
        Assert.Equal((2L, 1L), await RefreshCounts(fixture));

        Assert.Equal(1, await fixture.Exec("""
            update public.site_session_refresh_tombstone set used_at=clock_timestamp()-interval '10 seconds' where refresh_digest=$1
            """, Store.TokenDigest(original.Refresh)!));
        await Expect(refresh.Rotate(original.Refresh, original.Access, ct), SiteRefreshStore.ResultKind.Compromised);
        await NoAccess(access, rotated.Access, ct);
        Assert.False(await refresh.HasCurrent(rotated.Refresh, ct));
        Assert.True(await refresh.HasCurrent(other.Refresh, ct));
        Assert.Equal(owner, (await ReadOwner(access, other.Access, ct)).Id);
        Assert.Equal(owner, (await ReadOwner(access, ordinary.Access, ct)).Id);
        Assert.Equal((1L, 0L), await RefreshCounts(fixture));
    }

    private static Task<Guid?> ReadCurrentFamily(Store store, string token, CancellationToken ct) =>
        store.WithSession(token, false, (db, tx, _) => SiteRefreshStore.FindCurrentFamily(db, tx, Store.TokenDigest(token)!, ct), ct);

    [PostgresFact]
    public async Task RenewsPastAccessExpiryAndCapsIdleExpiryAtTheAbsoluteDeadline()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var refresh = new SiteRefreshStore(fixture.DataSource);
        var access = new Store(fixture.DataSource);
        var (owner, credential) = await fixture.SitePasskeyAccountAsync("Persistent expiry");
        var original = await Issue(fixture, owner, credential, persistent: true, ct);
        var initial = await ReadFamily(fixture, original.Refresh);
        Assert.Equal((TimeSpan.FromDays(30), TimeSpan.FromDays(90), original.RefreshExpires, 0L),
            (initial.Idle - initial.RotatedAt, initial.Absolute - initial.RotatedAt, initial.Idle, initial.Generation));

        Assert.Equal(1, await fixture.Exec(
            "update public.user_session set expires_at=clock_timestamp()-interval '1 second' where digest=$1",
            Store.TokenDigest(original.Access)!));
        await NoAccess(access, original.Access, ct);
        Assert.True(await refresh.HasCurrent(original.Refresh, ct));
        var renewed = await Rotated(refresh.Rotate(original.Refresh, original.Access, ct));
        var next = await ReadFamily(fixture, renewed.Refresh);
        Assert.Equal((initial.Id, initial.Absolute, TimeSpan.FromDays(30), renewed.RefreshExpires, 1L),
            (next.Id, next.Absolute, next.Idle - next.RotatedAt, next.Idle, next.Generation));
        Assert.Equal(owner, (await ReadOwner(access, renewed.Access, ct)).Id);

        Assert.Equal(1, await fixture.Exec("""
            update public.site_session_refresh
            set idle_expires_at=statement_timestamp()+interval '1 hour',
                absolute_expires_at=statement_timestamp()+interval '1 hour' where family_id=$1
            """, next.Id));
        var capped = await Rotated(refresh.Rotate(renewed.Refresh, null, ct));
        var final = await ReadFamily(fixture, capped.Refresh);
        Assert.Equal((final.Absolute, final.Absolute, final.Absolute, 2L),
            (final.Idle, capped.RefreshExpires, capped.AccessExpires, final.Generation));

        Assert.Equal(1, await fixture.Exec("""
            update public.site_session_refresh
            set idle_expires_at=statement_timestamp()-interval '1 second',
                absolute_expires_at=statement_timestamp()-interval '1 second' where family_id=$1
            """, final.Id));
        Assert.False(await refresh.HasCurrent(capped.Refresh, ct));
        await Expect(refresh.Rotate(capped.Refresh, capped.Access, ct), SiteRefreshStore.ResultKind.Rejected);
    }

    [PostgresFact]
    public async Task RechecksGenerationAfterAccountLockAndCascadesRevocationAndSignOut()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var refresh = new SiteRefreshStore(fixture.DataSource);
        var access = new Store(fixture.DataSource);
        var (owner, credential) = await fixture.SitePasskeyAccountAsync("Revoked owner");
        var (peer, peerCredential) = await fixture.SitePasskeyAccountAsync("Independent owner");
        var original = await Issue(fixture, owner, credential, persistent: true, ct);
        var revoked = await Rotated(refresh.Rotate(original.Refresh, original.Access, ct));
        var independent = await Issue(fixture, peer, peerCredential, persistent: true, ct);
        var signedOut = await Rotated(refresh.Rotate(independent.Refresh, independent.Access, ct));
        Assert.Equal((2L, 2L), await RefreshCounts(fixture));

        var waiting = await fixture.InTx(async (db, revocation) =>
        {
            Assert.Equal(1, await FixtureSql.ExecuteAsync(db, revocation, ct, "update public.blog_user set generation=generation+1 where id=$1", owner));
            var pending = refresh.Rotate(revoked.Refresh, revoked.Access, ct);
            await fixture.WaitForBlocked(db.ProcessID);
            Assert.False(pending.IsCompleted);
            return pending;
        });
        await Expect(waiting, SiteRefreshStore.ResultKind.Rejected);
        Assert.False(await refresh.HasCurrent(revoked.Refresh, ct));
        await NoAccess(access, revoked.Access, ct);
        Assert.True(await refresh.HasCurrent(signedOut.Refresh, ct));

        Assert.Equal(1, await fixture.Exec("delete from public.user_session where user_id=$1", owner));
        Assert.Equal((1L, 1L), await RefreshCounts(fixture));

        await refresh.SignOut(signedOut.Refresh, revoked.Access, ct);
        Assert.True(await refresh.HasCurrent(signedOut.Refresh, ct));
        Assert.Equal(peer, (await ReadOwner(access, signedOut.Access, ct)).Id);
        await refresh.SignOut(signedOut.Refresh, null, ct);
        Assert.False(await refresh.HasCurrent(signedOut.Refresh, ct));
        await NoAccess(access, signedOut.Access, ct);
        Assert.Equal((0L, 0L), await RefreshCounts(fixture));
    }

    [PostgresFact]
    public async Task ListsAndRevokesPersistentSessionsAfterTheirAccessHasExpired()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var refresh = new SiteRefreshStore(fixture.DataSource);
        var access = new Store(fixture.DataSource);
        var (owner, credential) = await fixture.SitePasskeyAccountAsync("Manage persistent sessions");
        var ordinary = await Issue(fixture, owner, credential, persistent: false, ct);
        var original = await Issue(fixture, owner, credential, persistent: true, ct);
        var persistent = await Rotated(refresh.Rotate(original.Refresh, original.Access, ct));
        var ordinaryId = SiteSessions.Id(owner, Store.TokenDigest(ordinary.Access)!);
        var persistentDigest = Store.TokenDigest(persistent.Access)!;
        var persistentId = SiteSessions.Id(owner, persistentDigest);
        Assert.Equal(1, await fixture.Exec(
            "update public.user_session set expires_at=clock_timestamp()-interval '1 second' where digest=$1", persistentDigest));

        var ordinaryList = await SiteSessions.List(access, ordinary.Access, ordinaryId, ct);
        Assert.Equal(ordinaryId, Assert.Single(ordinaryList.Sessions).Id);
        var withPersistent = await SiteSessions.List(access, ordinary.Access, ordinaryId, ct, persistent: true);
        Assert.Equal(2, withPersistent.Sessions.Count);
        Assert.Equal(ordinaryId, Assert.Single(withPersistent.Sessions, row => row.Current).Id);
        var target = Assert.Single(withPersistent.Sessions, row => row.Id == persistentId);
        Assert.Equal((persistent.RefreshExpires!.Value.ToUnixTimeMilliseconds(), 2, true), (target.ExpiresAt, target.Method, target.Mfa));

        await SiteSessions.Revoke(access, ordinary.Access, ordinaryId, persistentId, ct, persistent: true);
        Assert.False(await refresh.HasCurrent(persistent.Refresh, ct));
        Assert.Equal((0L, 0L), await RefreshCounts(fixture));
        Assert.Equal(owner, (await ReadOwner(access, ordinary.Access, ct)).Id);
    }

    private static Task<SiteRefreshStore.Issued> Issue(ScratchDatabase fixture, Guid owner, byte[] credential,
        bool persistent, CancellationToken ct) =>
        fixture.InTx((db, tx) => MfaStore.IssueSession(db, tx, owner, 1, credential, mfa: true, persistent, ct), ct);

    private static Task<(Guid Id, long Generation, DateTimeOffset Idle, DateTimeOffset Absolute, DateTimeOffset RotatedAt)>
        ReadFamily(ScratchDatabase fixture, string? refresh) => fixture.QueryRow("""
            select family_id,generation,idle_expires_at,absolute_expires_at,rotated_at
            from public.site_session_refresh where refresh_digest=$1
            """, r => (r.GetGuid(0), r.GetInt64(1), r.GetFieldValue<DateTimeOffset>(2),
                r.GetFieldValue<DateTimeOffset>(3), r.GetFieldValue<DateTimeOffset>(4)), Store.TokenDigest(refresh)!);

    private static Task<(long Families, long Tombstones)> RefreshCounts(ScratchDatabase fixture) => fixture.QueryRow("""
            select (select count(*) from public.site_session_refresh),
                (select count(*) from public.site_session_refresh_tombstone)
            """, r => (r.GetInt64(0), r.GetInt64(1)));

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
