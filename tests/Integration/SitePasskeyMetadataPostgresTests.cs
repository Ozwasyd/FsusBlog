using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Passkeys;
using FsusBlog.V2.Server.Sessions;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Integration.Tests;

public sealed class SitePasskeyMetadataPostgresTests
{
    [PostgresFact]
    public async Task ReturnsOnlyTheOwnersMetadataAndMarksTheCredentialForTheExactSession()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(fixture.DataSource);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await AddAccount(db, "Passkey owner", ct);
        var other = await AddAccount(db, "Another account", ct);
        var now = DateTimeOffset.FromUnixTimeMilliseconds(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        var start = now.AddDays(-4);
        var firstUsage = now.AddMilliseconds(-127);
        var secondCreated = now.AddDays(-3);
        var thirdCreated = now.AddDays(-2);
        var thirdUsage = now.AddMilliseconds(-63);
        var otherCreated = now.AddDays(-1);
        var local = await AddCredential(db, owner, start, firstUsage, backupEligible: false, backedUp: false, ct);
        _ = await AddCredential(db, owner, secondCreated, null, backupEligible: true, backedUp: false, ct);
        var synced = await AddCredential(db, owner, thirdCreated, thirdUsage, backupEligible: true, backedUp: true, ct);
        var unrelated = await AddCredential(db, other, otherCreated, now, backupEligible: false, backedUp: false, ct);
        var expiry = now.AddMinutes(10);
        var current = await AddSession(db, owner, expiry, local, ct);
        var alternate = await AddSession(db, owner, expiry, synced, ct);
        var foreign = await AddSession(db, other, expiry, unrelated, ct);

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
        await Denied(Rejection.Conflict, () => SitePasskeys.List(store, current.Token, alternate.Id, ct));
        await Denied(Rejection.Conflict, () => SitePasskeys.List(store, current.Token, foreign.Id, ct));
        await Denied(Rejection.Conflict, () => SitePasskeys.List(store, foreign.Token, current.Id, ct));
        await Denied(Rejection.Conflict, () => SitePasskeys.List(store, current.Token, null, ct));
        await Denied(Rejection.Conflict, () => SitePasskeys.List(store, current.Token, "not-a-session-id", ct));
    }

    [PostgresFact]
    public async Task RequiresLivePasskeyAuthorityAndRejectsStaleSessionIdentifiersAfterRevocation()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(fixture.DataSource);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await AddAccount(db, "Session owner", ct);
        var disabled = await AddAccount(db, "Disabled account", ct, enabled: false);
        var now = DateTimeOffset.UtcNow;
        var expiry = now.AddMinutes(10);
        var credential = await AddCredential(db, owner, now.AddDays(-1), now, backupEligible: true, backedUp: false, ct);
        var disabledCredential = await AddCredential(db, disabled, now.AddDays(-1), now, backupEligible: false, backedUp: false, ct);
        var current = await AddSession(db, owner, expiry, credential, ct);
        var revoked = await AddSession(db, owner, expiry, credential, ct);
        var expired = await AddSession(db, owner, now.AddMinutes(-1), credential, ct);
        var ticket = await AddSession(db, owner, expiry, null, ct);
        var disabledSession = await AddSession(db, disabled, expiry, disabledCredential, ct);

        Assert.True(Assert.Single(await SitePasskeys.List(store, revoked.Token, revoked.Id, ct)).Current);
        await SiteSessions.Revoke(store, current.Token, current.Id, revoked.Id, ct);
        await Denied(Rejection.Unauthorized, () => SitePasskeys.List(store, revoked.Token, revoked.Id, ct));
        await Denied(Rejection.Conflict, () => SitePasskeys.List(store, current.Token, revoked.Id, ct));
        await Denied(Rejection.Unauthorized, () => SitePasskeys.List(store, ticket.Token, ticket.Id, ct));
        await Denied(Rejection.Unauthorized, () => SitePasskeys.List(store, expired.Token, expired.Id, ct));
        await Denied(Rejection.Unauthorized, () => SitePasskeys.List(store, disabledSession.Token, disabledSession.Id, ct));
        await Denied(Rejection.Unauthorized, () => SitePasskeys.List(store, null, current.Id, ct));
        await Denied(Rejection.Unauthorized, () => SitePasskeys.List(store, "not-a-session-token", current.Id, ct));

        await using (var advance = Store.Sql(db, null,
            "update public.blog_user set generation=generation+1 where id=$1", owner))
            Assert.Equal(1, await advance.ExecuteNonQueryAsync(ct));
        await Denied(Rejection.Unauthorized, () => SitePasskeys.List(store, current.Token, current.Id, ct));
        var replacement = await AddSession(db, owner, expiry, credential, ct, generation: 2);
        await Denied(Rejection.Conflict, () => SitePasskeys.List(store, replacement.Token, current.Id, ct));
        Assert.True(Assert.Single(await SitePasskeys.List(store, replacement.Token, replacement.Id, ct)).Current);
    }

    [PostgresFact]
    public async Task ManagementTargetsAreBoundToTheExactSessionAndBeginNeverChangesTheName()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(fixture.DataSource);
        var passkeys = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost:54822"), "localhost"));
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var account = await AddAccount(db, "Name fixture", ct);
        var peer = await AddAccount(db, "Peer fixture", ct);
        var now = DateTimeOffset.UtcNow;
        var key = await AddCredential(db, account, now, null, backupEligible: false, backedUp: false, ct);
        var peerKey = await AddCredential(db, peer, now, null, backupEligible: false, backedUp: false, ct);
        var session = await AddSession(db, account, now.AddMinutes(10), key, ct);
        var alternate = await AddSession(db, account, now.AddMinutes(10), key, ct);
        var outsider = await AddSession(db, peer, now.AddMinutes(10), peerKey, ct);

        var current = Assert.Single(await SitePasskeys.Manage(store, session.Token, session.Id, ct));
        Assert.NotEqual(Convert.ToHexStringLower(key), current.Reference);
        Assert.NotEqual(current.Reference, Assert.Single(await SitePasskeys.Manage(store, alternate.Token, alternate.Id, ct)).Reference);
        Assert.NotEqual(current.Reference, Assert.Single(await SitePasskeys.Manage(store, outsider.Token, outsider.Id, ct)).Reference);
        Assert.Equal(0L, current.Revision);
        Assert.Empty(current.Name);
        var rename = new SitePasskeyRename(current.Reference, current.Revision, "New name");
        await Denied(Rejection.Conflict, () => passkeys.BeginSitePasskeyRename(session.Token, alternate.Id, rename, ct));
        await Denied(Rejection.NotFound, () => passkeys.BeginSitePasskeyRename(alternate.Token, alternate.Id, rename, ct));
        await Denied(Rejection.NotFound, () => passkeys.BeginSitePasskeyRename(outsider.Token, outsider.Id, rename, ct));
        await Denied(Rejection.Conflict, () => passkeys.BeginSitePasskeyRename(session.Token, session.Id, rename with { ExpectedRevision = 1 }, ct));
        await Denied(Rejection.Invalid, () => passkeys.BeginSitePasskeyRename(session.Token, session.Id, rename with { Name = "  " }, ct));
        var begin = await passkeys.BeginSitePasskeyRename(session.Token, session.Id, rename, ct);
        Assert.True(Aeds.Decode(begin, FrameType.PasskeyLoginBegin).Length > WireLayouts.PasskeyLoginBeginSize);
        using (var unpublished = Store.Sql(db, null, "select count(*) from public.site_passkey_name"))
            Assert.Equal(0L, await unpublished.ExecuteScalarAsync(ct));
        Assert.Equal(current, Assert.Single(await SitePasskeys.Manage(store, session.Token, session.Id, ct)));
        await store.SignOut(session.Token, ct);
        await Denied(Rejection.Unauthorized, () => passkeys.BeginSitePasskeyRename(session.Token, session.Id, rename, ct));
    }

    [PostgresFact]
    public async Task EnrollingADeviceRequiresTheCurrentPasskeySessionAndRespectsTheInventoryCap()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(fixture.DataSource);
        var passkeys = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost:54822"), "localhost"));
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await AddAccount(db, "Enrollment fixture", ct);
        var now = DateTimeOffset.UtcNow;
        var first = await AddCredential(db, owner, now, null, false, false, ct);
        var session = await AddSession(db, owner, now.AddMinutes(10), first, ct);
        var other = await AddSession(db, owner, now.AddMinutes(10), first, ct);
        var ticketOnly = await AddSession(db, owner, now.AddMinutes(10), null, ct);
        await Denied(Rejection.Unauthorized, () => passkeys.BeginSitePasskeyEnrollment(null, session.Id, ct));
        await Denied(Rejection.Unauthorized, () => passkeys.BeginSitePasskeyEnrollment(ticketOnly.Token, ticketOnly.Id, ct));
        await Denied(Rejection.Conflict, () => passkeys.BeginSitePasskeyEnrollment(session.Token, other.Id, ct));
        var approval = await passkeys.BeginSitePasskeyEnrollment(session.Token, session.Id, ct);
        Assert.True(Aeds.Decode(approval, FrameType.PasskeyLoginBegin).Length > WireLayouts.PasskeyLoginBeginSize);
        Assert.Single(await SitePasskeys.List(store, session.Token, session.Id, ct));
        for (var index = 1; index < WireLimits.SitePasskeyListSize; index++)
            await AddCredential(db, owner, now, null, false, false, ct);
        await Denied(Rejection.Conflict, () => passkeys.BeginSitePasskeyEnrollment(session.Token, session.Id, ct));
        await store.SignOut(session.Token, ct);
        await Denied(Rejection.Unauthorized, () => passkeys.BeginSitePasskeyEnrollment(session.Token, session.Id, ct));
    }

    [PostgresFact]
    public async Task DeviceRemovalRequiresAnOwnedCredentialAndASecondDevice()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(fixture.DataSource);
        var passkeys = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost:54822"), "localhost"));
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await AddAccount(db, "Removal fixture", ct);
        var now = DateTimeOffset.UtcNow;
        var first = await AddCredential(db, owner, now, null, false, false, ct);
        var session = await AddSession(db, owner, now.AddMinutes(10), first, ct);
        var last = Assert.Single(await SitePasskeys.Manage(store, session.Token, session.Id, ct));
        await Denied(Rejection.Conflict, () => passkeys.BeginSitePasskeyRemove(session.Token, session.Id, new(last.Reference, last.Revision), ct));
        var second = await AddCredential(db, owner, now, null, false, false, ct);
        var other = await AddSession(db, owner, now.AddMinutes(10), second, ct);
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
        DateTimeOffset? used, bool backupEligible, bool backedUp, bool current)
    {
        Assert.Equal(created.ToUnixTimeMilliseconds(), row.CreatedAt);
        Assert.Equal(used?.ToUnixTimeMilliseconds(), row.LastUsedAt);
        Assert.Equal(backupEligible, row.BackupEligible);
        Assert.Equal(backedUp, row.BackedUp);
        Assert.Equal(current, row.Current);
    }

    private static async Task<Guid> AddAccount(NpgsqlConnection db, string name, CancellationToken ct, bool enabled = true)
    {
        var owner = Guid.NewGuid();
        await using (var insert = Store.Sql(db, null, """
            insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,false,$3,1)
            """, owner, name, enabled))
            await insert.ExecuteNonQueryAsync(ct);
        await using var subject = Store.Sql(db, null, """
            insert into public.passkey_subject(user_id,user_handle) values($1,$2)
            """, owner, RandomNumberGenerator.GetBytes(32));
        await subject.ExecuteNonQueryAsync(ct);
        return owner;
    }

    private static async Task<byte[]> AddCredential(NpgsqlConnection db, Guid owner, DateTimeOffset created,
        DateTimeOffset? used, bool backupEligible, bool backedUp, CancellationToken ct)
    {
        var id = RandomNumberGenerator.GetBytes(32);
        var lastUsed = new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.TimestampTz, Value = (object?)used ?? DBNull.Value };
        await using var insert = Store.Sql(db, null, """
            insert into public.passkey_credential
                (credential_id,user_id,public_key,sign_count,backup_eligible,backed_up,created_at,last_used_at)
            values($1,$2,$3,0,$4,$5,$6,$7)
            """, id, owner, RandomNumberGenerator.GetBytes(32), backupEligible, backedUp, created, lastUsed);
        await insert.ExecuteNonQueryAsync(ct);
        return id;
    }

    private static async Task<(string Token, string Id)> AddSession(NpgsqlConnection db, Guid owner, DateTimeOffset expiry,
        byte[]? credential, CancellationToken ct, long generation = 1)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var digest = Store.TokenDigest(token)!;
        var passkey = new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bytea, Value = (object?)credential ?? DBNull.Value };
        await using var insert = Store.Sql(db, null, """
            insert into public.user_session(digest,user_id,generation,expires_at,passkey_credential_id)
            values($1,$2,$3,$4,$5)
            """, digest, owner, generation, expiry, passkey);
        await insert.ExecuteNonQueryAsync(ct);
        return (token, SiteSessions.Id(owner, digest));
    }

    private static async Task Denied(Rejection expected, Func<Task> action) =>
        Assert.Equal(expected, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);
}
