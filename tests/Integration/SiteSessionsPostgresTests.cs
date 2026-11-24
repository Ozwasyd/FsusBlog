namespace FsusBlog.V2.Integration.Tests;

public sealed class SiteSessionsPostgresTests
{
    [PostgresFact]
    public async Task ListsAndRevokesOnlyActiveAccountSessionsAndPreservesCurrentAuthority()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        var (account, credential) = await fixture.SitePasskeyAccountAsync("Reader");
        var foreign = Guid.NewGuid();
        await fixture.SiteAccountAsync(foreign, "Another reader");
        var expiry = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.ToUnixTimeSeconds()).AddMinutes(10);
        var current = await fixture.SiteSessionAsync(account, expiry, credential: credential, mfa: true);
        var targeted = await fixture.SiteSessionAsync(account, expiry);
        var other = await fixture.SiteSessionAsync(account, expiry, credential: credential);
        var foreignSession = await fixture.SiteSessionAsync(foreign, expiry);
        await fixture.SiteSessionAsync(account, expiry.AddMinutes(-20));
        await fixture.SiteSessionAsync(account, expiry, generation: 2);

        var listed = await SiteSessions.List(store, current.Token, current.Id, ct);
        Assert.False(listed.HasMore);
        Assert.Equal(3, listed.Sessions.Count);
        var active = Assert.Single(listed.Sessions, session => session.Current);
        Assert.Equal((current.Id, expiry.ToUnixTimeMilliseconds(), 2, true), (active.Id, active.ExpiresAt, active.Method, active.Mfa));
        var ticket = Assert.Single(listed.Sessions, session => session.Id == targeted.Id);
        Assert.Equal((1, false), (ticket.Method, ticket.Mfa));
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
        Assert.Equal((current.Id, true), (remaining.Id, remaining.Current));
        Assert.Equal(1L, (await ReadOwner(store, current.Token, ct)).Generation);
        Assert.Equal(foreign, (await ReadOwner(store, foreignSession.Token, ct)).Id);
    }

    [PostgresFact]
    public async Task RevocationWaitingForAccountLockRechecksAuthorityAfterGenerationChanges()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        var account = Guid.NewGuid();
        await fixture.SiteAccountAsync(account, "Concurrent account");
        var expiry = DateTimeOffset.UtcNow.AddMinutes(10);
        var stale = await fixture.SiteSessionAsync(account, expiry);
        var target = await fixture.SiteSessionAsync(account, expiry);
        var remaining = await fixture.SiteSessionAsync(account, expiry);

        using var operationDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        operationDeadline.CancelAfter(TimeSpan.FromSeconds(15));
        var revocation = await fixture.InTx(async (authority, transaction) =>
        {
            Assert.Equal(1, await FixtureSql.ExecuteAsync(authority, transaction, ct,
                "update public.blog_user set generation=2 where id=$1", account));
            var pending = SiteSessions.Revoke(store, stale.Token, stale.Id, target.Id, operationDeadline.Token);
            await fixture.WaitForBlocked(authority.ProcessID, ct: operationDeadline.Token);
            Assert.False(pending.IsCompleted, "Revocation should wait for the account lock before accessing its target.");
            // Move the other sessions to the new generation while the actor's old authority expires.
            Assert.Equal(2, await FixtureSql.ExecuteAsync(authority, transaction, ct,
                "update public.user_session set generation=2 where user_id=$1 and digest<>$2", account, stale.Digest));
            return pending;
        });

        await Denied(Rejection.Unauthorized, () => revocation);
        await Denied(Rejection.Unauthorized, () => ReadOwner(store, stale.Token, ct));
        Assert.Equal(2L, (await ReadOwner(store, target.Token, ct)).Generation);
        Assert.Equal(2L, (await ReadOwner(store, remaining.Token, ct)).Generation);
    }

    private static Task<Identity> ReadOwner(Store store, string token, CancellationToken ct) =>
        store.WithSession(token, false, (_, _, actor) => Task.FromResult(actor), ct);
}
