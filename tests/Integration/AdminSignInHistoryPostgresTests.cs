namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminSignInHistoryPostgresTests
{
    [PostgresFact]
    public async Task RecentSignInsUseOnlyTheCurrentAdminPrincipalAndDoNotSynthesizeUnlinkedSessions()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (gate, store) = OpenStore(fixture);
        var owner = await AddAdmin(fixture, "history-owner", ct);
        var other = await AddAdmin(fixture, "history-other", ct);
        var (site, siteToken, _) = await fixture.SignInSiteUser("Site reader", ct, minutes: 10);
        Assert.Equal(site, await new Store(fixture.DataSource).WithSession(siteToken, false, (_, _, actor) => Task.FromResult(actor.Id), ct));
        await Denied(() => store.RecentSignIns(siteToken, ct));
        await Denied(() => store.RecentSignIns(null, ct));

        var preUpgrade = NewToken();
        await fixture.Exec("""
            insert into public.admin_session(digest,principal_id,generation,expires_at)
            values($1,$2,1,clock_timestamp()+interval '10 minutes')
            """, Digest(preUpgrade), owner);
        var unlinked = await store.RecentSignIns(preUpgrade, ct);
        Assert.Empty(unlinked.History.SignIns);
        Assert.Equal((await gate.SessionWithPermissionBinding(preUpgrade, ct)).PermissionSession, unlinked.PermissionSession);

        var ownerToken = await Record(fixture, owner, ct);
        var otherToken = await Record(fixture, other, ct);
        _ = await Record(fixture, other, ct);
        await Denied(() => store.RecentSignIns(preUpgrade, ct));
        await Denied(() => store.RecentSignIns(otherToken, ct));
        var current = await store.RecentSignIns(ownerToken, ct);
        Assert.Equal((1L, AdminSignInState.Current), (current.History.Generation, Assert.Single(current.History.SignIns).State));
        Assert.Matches("^[a-f0-9]{64}$", current.PermissionSession);
        Assert.NotEqual(ownerToken, current.PermissionSession);
        Assert.NotEqual(unlinked.PermissionSession, current.PermissionSession);
        Assert.Equal((await gate.SessionWithPermissionBinding(ownerToken, ct)).PermissionSession, current.PermissionSession);
        var packet = Wire.EncodeAdminSignInHistorySnapshot(current.History);
        var roundtrip = Wire.DecodeAdminSignInHistorySnapshot(packet);
        Assert.Equal(current.History.Generation, roundtrip.Generation);
        Assert.Equal(current.History.SignIns, roundtrip.SignIns);
        var body = Aeds.Decode(packet, FrameType.AdminSignInHistory);
        Assert.Equal((37, current.History.Generation, 1, (byte)AdminSignInState.Current),
            (body.Length, BinaryPrimitives.ReadInt64LittleEndian(body), BinaryPrimitives.ReadInt32LittleEndian(body[8..]), body[^1]));
        Assert.Throws<ProtocolException>(() => Wire.EncodeAdminSignInHistorySnapshot(new(1,
            [new(1, 5, 0, AdminSignInState.Current), new(1, 5, 0, AdminSignInState.Current)])));
        Assert.Throws<ProtocolException>(() => Wire.EncodeAdminSignInHistorySnapshot(new(1, [new(1, 5, 3, AdminSignInState.Expired)])));

        await fixture.Exec("update public.admin_principal set enabled=false where id=$1", owner);
        await Denied(() => store.RecentSignIns(ownerToken, ct));
    }

    [PostgresFact]
    public async Task TracksReplacementLogoutAndNaturalExpiryWithoutRevokingAReplacementFromAnOldCookie()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (gate, store) = OpenStore(fixture);
        var owner = await AddAdmin(fixture, "history-transitions", ct);
        var expiredToken = await Record(fixture, owner, ct);
        var expiry = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.ToUnixTimeSeconds()).AddMinutes(-5);
        await fixture.InTx(async (db, adjust) =>
        {
            await FixtureSql.ExecuteAsync(db, adjust, ct, """
                update public.admin_sign_in h set started_at=$3,expires_at=$2
                from public.admin_session s where s.digest=$1 and s.principal_id=h.principal_id and s.sign_in_id=h.id
                """, Digest(expiredToken), expiry, expiry.AddMinutes(-10));
            await FixtureSql.ExecuteAsync(db, adjust, ct, "update public.admin_session set expires_at=$2 where digest=$1", Digest(expiredToken), expiry);
        }, ct);
        await Denied(() => store.RecentSignIns(expiredToken, ct));

        var replacedToken = await Record(fixture, owner, ct);
        var replacement = (await store.RecentSignIns(replacedToken, ct)).History;
        var expired = Assert.Single(replacement.SignIns, row => row.State == AdminSignInState.Expired);
        Assert.Equal((expiry.AddMinutes(-10).ToUnixTimeMilliseconds(), expiry.ToUnixTimeMilliseconds(), expiry.ToUnixTimeMilliseconds()),
            (expired.StartedAt, expired.ExpiresAt, expired.EndedAt));
        Assert.True(await fixture.Scalar<bool>("select ended_at=expires_at from public.admin_sign_in where principal_id=$1 and expires_at=$2", owner, expiry));

        var loggedOutToken = await Record(fixture, owner, ct);
        await Denied(() => store.RecentSignIns(replacedToken, ct));
        await gate.SignOut(replacedToken, ct);
        var beforeLogout = (await store.RecentSignIns(loggedOutToken, ct)).History;
        var active = Assert.Single(beforeLogout.SignIns, row => row.State == AdminSignInState.Current);
        Assert.Equal(0L, active.EndedAt);
        Assert.True(active.ExpiresAt > active.StartedAt);
        var replaced = Assert.Single(beforeLogout.SignIns, row => row.State == AdminSignInState.Ended);
        Assert.InRange(replaced.EndedAt, replaced.StartedAt, replaced.ExpiresAt - 1);
        await gate.SignOut(loggedOutToken, ct);
        await Denied(() => store.RecentSignIns(loggedOutToken, ct));

        var renewedToken = await Record(fixture, owner, ct);
        var afterLogout = (await store.RecentSignIns(renewedToken, ct)).History;
        var ended = afterLogout.SignIns.Where(row => row.State == AdminSignInState.Ended).ToArray();
        Assert.Equal(2, ended.Length);
        Assert.Contains(replaced, ended);
        Assert.Contains(ended, row => row.StartedAt == active.StartedAt && row.ExpiresAt == active.ExpiresAt);
        Assert.Contains(expired, afterLogout.SignIns);
        var beforeRevocation = Assert.Single(afterLogout.SignIns, row => row.State == AdminSignInState.Current);

        await fixture.InTx(async (db, revoke) =>
        {
            await FixtureSql.ExecuteAsync(db, revoke, ct, "update public.admin_principal set generation=generation+1 where id=$1", owner);
            await AdminSignInHistory.RetireAsync(db, revoke, owner, null, ct);
        }, ct);
        await Denied(() => store.RecentSignIns(renewedToken, ct));
        var afterRevocation = (await store.RecentSignIns(await Record(fixture, owner, ct), ct)).History;
        Assert.Equal(2L, afterRevocation.Generation);
        Assert.Contains(afterRevocation.SignIns, row => row.State == AdminSignInState.Ended &&
            row.StartedAt == beforeRevocation.StartedAt && row.ExpiresAt == beforeRevocation.ExpiresAt);
    }

    [PostgresFact]
    public async Task KeepsOnlyTheFiftyMostRecentSuccessfulSignInsPerPrincipal()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (_, store) = OpenStore(fixture);
        var owner = await AddAdmin(fixture, "history-retention", ct);
        var other = await AddAdmin(fixture, "history-retention-other", ct);
        var otherToken = await Record(fixture, other, ct);
        var first = await Record(fixture, owner, ct);
        var oldest = await fixture.Scalar<long>("select sign_in_id from public.admin_session where digest=$1", Digest(first));

        var latest = first;
        for (var index = 0; index < 51; index++) latest = await Record(fixture, owner, ct);
        var observed = (await store.RecentSignIns(latest, ct)).History;
        Assert.Equal(50, observed.SignIns.Count);
        Assert.Equal(Assert.Single(observed.SignIns, row => row.State == AdminSignInState.Current), observed.SignIns[0]);
        Assert.All(observed.SignIns.Where(row => row.State != AdminSignInState.Current), row => Assert.Equal(AdminSignInState.Ended, row.State));
        Assert.Single((await store.RecentSignIns(otherToken, ct)).History.SignIns);
        Assert.True(await fixture.Scalar<bool>("select count(*)=50 and min(id)>$2 from public.admin_sign_in where principal_id=$1", owner, oldest));
    }

    private static (AdminSessionGate Gate, AdminSignInHistoryStore Store) OpenStore(ScratchDatabase fixture)
    {
        var gate = new AdminSessionGate(fixture.DataSource, null);
        return (gate, new AdminSignInHistoryStore(gate));
    }

    private static async Task<Guid> AddAdmin(ScratchDatabase fixture, string handle, CancellationToken ct)
    {
        var principal = Guid.NewGuid();
        await fixture.AdminPrincipalAsync(principal, handle, ct: ct);
        await fixture.Exec("""
            insert into public.admin_passkey_credential(credential_id,principal_id,public_key,sign_count,backup_eligible,backed_up)
            values($1,$2,$3,0,false,false)
            """, RandomNumberGenerator.GetBytes(32), principal, new byte[] { 1 });
        return principal;
    }

    private static Task<string> Record(ScratchDatabase fixture, Guid principal, CancellationToken ct) =>
        fixture.InTx(async (db, transaction) =>
        {
            var token = NewToken();
            var generation = (long)(await FixtureSql.ScalarAsync(db, transaction, ct,
                "select generation from public.admin_principal where id=$1 for update", principal))!;
            await AdminSignInHistory.RecordAsync(db, transaction, principal, Digest(token), generation, ct);
            return token;
        }, ct);

    private static string NewToken() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
    private static byte[] Digest(string token) => Store.TokenDigest(token)!;
}
