namespace FsusBlog.V2.Integration.Tests;

public sealed class RecoveryScopeTests
{
    [PostgresFact]
    public async Task ScopeSurvivesReloginAndRestartAndRejectsOtherDatabasesAndAnonymousReaders()
    {
        await using var first = await ScratchDatabase.CreateTimed(out var ct);
        await using var another = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var alice = Guid.NewGuid();
        var bob = Guid.NewGuid();
        var reader = Guid.NewGuid();
        await first.AdminAsync(ScratchDatabase.AdminHandle("alice", alice), id: alice);
        await first.AdminAsync(ScratchDatabase.AdminHandle("bob", bob), id: bob);
        await first.SiteAccountAsync(reader, "reader");
        await another.AdminAsync(ScratchDatabase.AdminHandle("same uuid in another site", alice), id: alice, ct: ct);
        Guid firstSite;
        await using (var start = await ServerProcess.Start(first.ConnectionString, ct))
        {
            await CheckStatusAsync(NotFound, start.Client.GetAsync(WireRoutes.DraftRecoveryScope, ct));
            await SiteAedsFixture.SendStatus(start.Client, HttpMethod.Get, WireRoutes.DraftRecoveryScope, null, null, null, Unauthorized, ct);
            var scope = await Scope(start, await Login(first, alice));
            firstSite = scope.SiteId;
            Assert.Equal(alice, scope.UserId);
            Assert.Equal(new(firstSite, bob), await Scope(start, await Login(first, bob)));
            await SiteAedsFixture.SendStatus(start.Client, HttpMethod.Get, WireRoutes.DraftRecoveryScope, null, await Login(first, reader), null, Unauthorized, ct);
        }
        await using (var restart = await ServerProcess.Start(first.ConnectionString, ct))
            Assert.Equal(new(firstSite, alice), await Scope(restart, await Login(first, alice)));

        await using (var separate = await ServerProcess.Start(another.ConnectionString, ct))
        {
            var scope = await Scope(separate, await Login(another, alice));
            Assert.Equal(alice, scope.UserId);
            Assert.NotEqual(firstSite, scope.SiteId);
        }

        Assert.Equal(1, await first.Exec("update public.authoring_recovery_site set site_id=$1", Guid.Empty));
        await Assert.ThrowsAsync<InvalidOperationException>(() => first.WithConnection(c => CurrentSchema.VerifyAsync(c, ct)));

        async Task<string> Login(ScratchDatabase db, Guid id) => (await db.SignIn(id, ct)).Token;

        async Task<DraftRecoveryScope> Scope(ServerProcess server, string token) =>
            Wire.DecodeDraftRecoveryScope(await SiteAedsFixture.ExpectPrivate(server.Client, HttpMethod.Get,
                WireRoutes.DraftRecoveryScope, null, token, null, OK, ct));
    }
}
