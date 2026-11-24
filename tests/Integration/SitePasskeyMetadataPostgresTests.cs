using NpgsqlTypes;

namespace FsusBlog.V2.Integration.Tests;

public sealed class SitePasskeyMetadataPostgresTests
{
    [PostgresFact]
    public async Task ReturnsOnlyTheOwnersMetadataAndMarksTheCredentialForTheExactSession()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        var owner = await AddAccount(fixture, "Passkey owner");
        var other = await AddAccount(fixture, "Another account");
        var now = DateTimeOffset.FromUnixTimeMilliseconds(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        var start = now.AddDays(-4);
        var firstUsage = now.AddMilliseconds(-127);
        var secondCreated = now.AddDays(-3);
        var thirdCreated = now.AddDays(-2);
        var thirdUsage = now.AddMilliseconds(-63);
        var otherCreated = now.AddDays(-1);
        var local = await AddCredential(fixture, owner, start, firstUsage, backupEligible: false, backedUp: false);
        _ = await AddCredential(fixture, owner, secondCreated, null, backupEligible: true, backedUp: false);
        var synced = await AddCredential(fixture, owner, thirdCreated, thirdUsage, backupEligible: true, backedUp: true);
        var unrelated = await AddCredential(fixture, other, otherCreated, now, backupEligible: false, backedUp: false);
        var expiry = now.AddMinutes(10);
        var current = await fixture.SiteSessionAsync(owner, expiry, credential: local);
        var alternate = await fixture.SiteSessionAsync(owner, expiry, credential: synced);
        var foreign = await fixture.SiteSessionAsync(other, expiry, credential: unrelated);

        var rows = await SitePasskeys.List(store, current.Token, current.Id, ct);
        Assert.Equal(3, rows.Count);
        AssertMetadata(rows[0], start, firstUsage, backupEligible: false, backedUp: false, current: true);
        AssertMetadata(Assert.Single(rows, row => row.CreatedAt == secondCreated.ToUnixTimeMilliseconds()),
            secondCreated, null, backupEligible: true, backedUp: false, current: false);
        AssertMetadata(Assert.Single(rows, row => row.CreatedAt == thirdCreated.ToUnixTimeMilliseconds()),
            thirdCreated, thirdUsage, backupEligible: true, backedUp: true, current: false);

        var alternateRows = await SitePasskeys.List(store, alternate.Token, alternate.Id, ct);
        Assert.Equal(Assert.Single(alternateRows, row => row.Current), alternateRows[0]);
        AssertMetadata(alternateRows[0], thirdCreated, thirdUsage, backupEligible: true, backedUp: true, current: true);
        AssertMetadata(Assert.Single(await SitePasskeys.List(store, foreign.Token, foreign.Id, ct)),
            otherCreated, now, backupEligible: false, backedUp: false, current: true);
        foreach (var (token, id) in new[] { (current.Token, alternate.Id), (current.Token, foreign.Id), (foreign.Token, current.Id),
            (current.Token, (string?)null), (current.Token, "not-a-session-id") })
            await Denied(Rejection.Conflict, () => SitePasskeys.List(store, token, id, ct));
    }

    [PostgresFact]
    public async Task RequiresLivePasskeyAuthorityAndRejectsStaleSessionIdentifiersAfterRevocation()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        var owner = await AddAccount(fixture, "Session owner");
        var disabled = await AddAccount(fixture, "Disabled account", enabled: false);
        var now = DateTimeOffset.UtcNow;
        var expiry = now.AddMinutes(10);
        var credential = await AddCredential(fixture, owner, now.AddDays(-1), now, backupEligible: true, backedUp: false);
        var disabledCredential = await AddCredential(fixture, disabled, now.AddDays(-1), now, backupEligible: false, backedUp: false);
        var current = await fixture.SiteSessionAsync(owner, expiry, credential: credential);
        var revoked = await fixture.SiteSessionAsync(owner, expiry, credential: credential);
        var expired = await fixture.SiteSessionAsync(owner, now.AddMinutes(-1), credential: credential);
        var ticket = await fixture.SiteSessionAsync(owner, expiry);
        var disabledSession = await fixture.SiteSessionAsync(disabled, expiry, credential: disabledCredential);

        Assert.True(Assert.Single(await SitePasskeys.List(store, revoked.Token, revoked.Id, ct)).Current);
        await SiteSessions.Revoke(store, current.Token, current.Id, revoked.Id, ct);
        await Denied(Rejection.Conflict, () => SitePasskeys.List(store, current.Token, revoked.Id, ct));
        foreach (var (token, id) in new[] { (revoked.Token, revoked.Id), (ticket.Token, ticket.Id), (expired.Token, expired.Id),
            (disabledSession.Token, disabledSession.Id), ((string?)null, current.Id), ("not-a-session-token", current.Id) })
            await Denied(Rejection.Unauthorized, () => SitePasskeys.List(store, token, id, ct));

        Assert.Equal(1, await fixture.Exec("update public.blog_user set generation=generation+1 where id=$1", owner));
        await Denied(Rejection.Unauthorized, () => SitePasskeys.List(store, current.Token, current.Id, ct));
        var replacement = await fixture.SiteSessionAsync(owner, expiry, generation: 2, credential: credential);
        await Denied(Rejection.Conflict, () => SitePasskeys.List(store, replacement.Token, current.Id, ct));
        Assert.True(Assert.Single(await SitePasskeys.List(store, replacement.Token, replacement.Id, ct)).Current);
    }

    [PostgresFact]
    public async Task ManagementTargetsAreBoundToTheExactSessionAndBeginNeverChangesTheName()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        var store = new Store(fixture.DataSource);
        var passkeys = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost:54822"), "localhost"));
        var account = await AddAccount(fixture, "Name fixture");
        var peer = await AddAccount(fixture, "Peer fixture");
        var now = DateTimeOffset.UtcNow;
        var key = await AddCredential(fixture, account, now, null, backupEligible: false, backedUp: false);
        var peerKey = await AddCredential(fixture, peer, now, null, backupEligible: false, backedUp: false);
        var session = await fixture.SiteSessionAsync(account, now.AddMinutes(10), credential: key);
        var alternate = await fixture.SiteSessionAsync(account, now.AddMinutes(10), credential: key);
        var outsider = await fixture.SiteSessionAsync(peer, now.AddMinutes(10), credential: peerKey);

        var current = Assert.Single(await SitePasskeys.Manage(store, session.Token, session.Id, ct));
        Assert.NotEqual(Convert.ToHexStringLower(key), current.Reference);
        Assert.NotEqual(current.Reference, Assert.Single(await SitePasskeys.Manage(store, alternate.Token, alternate.Id, ct)).Reference);
        Assert.NotEqual(current.Reference, Assert.Single(await SitePasskeys.Manage(store, outsider.Token, outsider.Id, ct)).Reference);
        Assert.Equal((0L, ""), (current.Revision, current.Name));
        var rename = new SitePasskeyRename(current.Reference, current.Revision, "New name");
        await Denied(Rejection.Conflict, () => passkeys.BeginSitePasskeyRename(session.Token, alternate.Id, rename, ct));
        await Denied(Rejection.NotFound, () => passkeys.BeginSitePasskeyRename(alternate.Token, alternate.Id, rename, ct));
        await Denied(Rejection.NotFound, () => passkeys.BeginSitePasskeyRename(outsider.Token, outsider.Id, rename, ct));
        await Denied(Rejection.Conflict, () => passkeys.BeginSitePasskeyRename(session.Token, session.Id, rename with { ExpectedRevision = 1 }, ct));
        await Denied(Rejection.Invalid, () => passkeys.BeginSitePasskeyRename(session.Token, session.Id, rename with { Name = "  " }, ct));
        var begin = await passkeys.BeginSitePasskeyRename(session.Token, session.Id, rename, ct);
        Assert.True(Aeds.Decode(begin, FrameType.PasskeyLoginBegin).Length > WireLayouts.PasskeyLoginBeginSize);
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.site_passkey_name"));
        Assert.Equal(current, Assert.Single(await SitePasskeys.Manage(store, session.Token, session.Id, ct)));
        await store.SignOut(session.Token, ct);
        await Denied(Rejection.Unauthorized, () => passkeys.BeginSitePasskeyRename(session.Token, session.Id, rename, ct));
    }

    [PostgresFact]
    public async Task EnrollingADeviceRequiresTheCurrentPasskeySessionAndRespectsTheInventoryCap()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        var store = new Store(fixture.DataSource);
        var passkeys = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost:54822"), "localhost"));
        var owner = await AddAccount(fixture, "Enrollment fixture");
        var now = DateTimeOffset.UtcNow;
        var first = await AddCredential(fixture, owner, now, null, false, false);
        var session = await fixture.SiteSessionAsync(owner, now.AddMinutes(10), credential: first);
        var other = await fixture.SiteSessionAsync(owner, now.AddMinutes(10), credential: first);
        var ticketOnly = await fixture.SiteSessionAsync(owner, now.AddMinutes(10));
        await Denied(Rejection.Unauthorized, () => passkeys.BeginSitePasskeyEnrollment(null, session.Id, ct));
        await Denied(Rejection.Unauthorized, () => passkeys.BeginSitePasskeyEnrollment(ticketOnly.Token, ticketOnly.Id, ct));
        await Denied(Rejection.Conflict, () => passkeys.BeginSitePasskeyEnrollment(session.Token, other.Id, ct));
        var approval = await passkeys.BeginSitePasskeyEnrollment(session.Token, session.Id, ct);
        Assert.True(Aeds.Decode(approval, FrameType.PasskeyLoginBegin).Length > WireLayouts.PasskeyLoginBeginSize);
        Assert.Single(await SitePasskeys.List(store, session.Token, session.Id, ct));
        for (var index = 1; index < WireLimits.SitePasskeyListSize; index++)
            await AddCredential(fixture, owner, now, null, false, false);
        await Denied(Rejection.Conflict, () => passkeys.BeginSitePasskeyEnrollment(session.Token, session.Id, ct));
        await store.SignOut(session.Token, ct);
        await Denied(Rejection.Unauthorized, () => passkeys.BeginSitePasskeyEnrollment(session.Token, session.Id, ct));
    }

    [PostgresFact]
    public async Task DeviceRemovalRequiresAnOwnedCredentialAndASecondDevice()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        var store = new Store(fixture.DataSource);
        var passkeys = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost:54822"), "localhost"));
        var owner = await AddAccount(fixture, "Removal fixture");
        var now = DateTimeOffset.UtcNow;
        var first = await AddCredential(fixture, owner, now, null, false, false);
        var session = await fixture.SiteSessionAsync(owner, now.AddMinutes(10), credential: first);
        var last = Assert.Single(await SitePasskeys.Manage(store, session.Token, session.Id, ct));
        await Denied(Rejection.Conflict, () => passkeys.BeginSitePasskeyRemove(session.Token, session.Id, new(last.Reference, last.Revision), ct));
        var second = await AddCredential(fixture, owner, now, null, false, false);
        var other = await fixture.SiteSessionAsync(owner, now.AddMinutes(10), credential: second);
        var rows = await SitePasskeys.Manage(store, session.Token, session.Id, ct);
        var current = Assert.Single(rows, row => row.Metadata.Current);
        var target = Assert.Single(rows, row => !row.Metadata.Current);
        var removal = new SitePasskeyRemove(target.Reference, target.Revision);
        var currentProof = await passkeys.BeginSitePasskeyRemove(session.Token, session.Id, new(current.Reference, current.Revision), ct);
        Assert.True(Aeds.Decode(currentProof, FrameType.PasskeyLoginBegin).Length > WireLayouts.PasskeyLoginBeginSize);
        await Denied(Rejection.Conflict, () => passkeys.BeginSitePasskeyRemove(session.Token, session.Id, removal with { ExpectedRevision = 1 }, ct));
        await Denied(Rejection.NotFound, () => passkeys.BeginSitePasskeyRemove(other.Token, other.Id, removal, ct));
        var proof = await passkeys.BeginSitePasskeyRemove(session.Token, session.Id, removal, ct);
        Assert.True(Aeds.Decode(proof, FrameType.PasskeyLoginBegin).Length > WireLayouts.PasskeyLoginBeginSize);
        Assert.Equal(rows, await SitePasskeys.Manage(store, session.Token, session.Id, ct));
    }

    private static void AssertMetadata(SitePasskeyRow row, DateTimeOffset created,
        DateTimeOffset? used, bool backupEligible, bool backedUp, bool current) =>
        Assert.Equal((created.ToUnixTimeMilliseconds(), used?.ToUnixTimeMilliseconds(), backupEligible, backedUp, current),
            (row.CreatedAt, row.LastUsedAt, row.BackupEligible, row.BackedUp, row.Current));

    private static async Task<Guid> AddAccount(ScratchDatabase fixture, string name, bool enabled = true)
    {
        var owner = Guid.NewGuid();
        await fixture.SiteAccountAsync(owner, name, enabled);
        await fixture.WithConnection(db => FixtureSql.SitePasskeySubjectAsync(db, null, default, owner));
        return owner;
    }

    private static async Task<byte[]> AddCredential(ScratchDatabase fixture, Guid owner, DateTimeOffset created,
        DateTimeOffset? used, bool backupEligible, bool backedUp)
    {
        var id = RandomNumberGenerator.GetBytes(32);
        var lastUsed = new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.TimestampTz, Value = (object?)used ?? DBNull.Value };
        await fixture.Exec("""
            insert into public.passkey_credential
                (credential_id,user_id,public_key,sign_count,backup_eligible,backed_up,created_at,last_used_at)
            values($1,$2,$3,0,$4,$5,$6,$7)
            """, id, owner, RandomNumberGenerator.GetBytes(32), backupEligible, backedUp, created, lastUsed);
        return id;
    }
}
