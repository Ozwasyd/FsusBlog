using System.Net;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Integration.Tests;

public sealed class RecoveryScopeTests
{
    [PostgresFact]
    public async Task ScopeSurvivesReloginAndRestartAndRejectsOtherDatabasesAndAnonymousReaders()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        var dsn = Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!;
        await using var first = await ScratchDatabase.Create(dsn, ct);
        await using var another = await ScratchDatabase.Create(dsn, ct);
        var alice = Guid.NewGuid();
        var bob = Guid.NewGuid();
        var reader = Guid.NewGuid();
        await Add(first, alice, "alice", true);
        await Add(first, bob, "bob", true);
        await Add(first, reader, "reader", false);
        await Add(another, alice, "same uuid in another site", true);
        Guid firstSite;
        await using (var start = await ServerProcess.Start(first.ConnectionString, ct))
        {
            using var unauthorized = await start.Client.GetAsync(WireRoutes.DraftRecoveryScope, ct);
            Assert.Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode);
            var scope = await Scope(start, await Login(first, alice));
            firstSite = scope.SiteId;
            Assert.Equal(alice, scope.UserId);
            Assert.Equal(new(firstSite, bob), await Scope(start, await Login(first, bob)));
            using var readOnly = await Read(start, await Login(first, reader));
            Assert.Equal(HttpStatusCode.Forbidden, readOnly.StatusCode);
        }
        await using (var restart = await ServerProcess.Start(first.ConnectionString, ct))
            Assert.Equal(new(firstSite, alice), await Scope(restart, await Login(first, alice)));

        await using (var separate = await ServerProcess.Start(another.ConnectionString, ct))
        {
            var scope = await Scope(separate, await Login(another, alice));
            Assert.Equal(alice, scope.UserId);
            Assert.NotEqual(firstSite, scope.SiteId);
        }

        await using var connection = await first.DataSource.OpenConnectionAsync(ct);
        await using (var bad = Store.Sql(connection, null, "update public.authoring_recovery_site set site_id=$1", Guid.Empty))
            Assert.Equal(1, await bad.ExecuteNonQueryAsync(ct));
        await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(connection, ct));

        async Task Add(ScratchDatabase db, Guid id, string name, bool author)
        {
            await using var connection = await db.DataSource.OpenConnectionAsync(ct);
            await using var row = Store.Sql(connection, null,
                "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)", id, name, author);
            await row.ExecuteNonQueryAsync(ct);
        }

        async Task<string> Login(ScratchDatabase db, Guid id)
        {
            var secret = RandomNumberGenerator.GetBytes(32);
            await using var connection = await db.DataSource.OpenConnectionAsync(ct);
            await using var ticket = Store.Sql(connection, null,
                "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '2 minute')",
                SHA256.HashData(secret), id);
            await ticket.ExecuteNonQueryAsync(ct);
            return (await new Store(db.DataSource).SignIn(Convert.ToHexStringLower(secret), ct)).Token;
        }

        async Task<DraftRecoveryScope> Scope(ServerProcess server, string token)
        {
            using var response = await Read(server, token);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return Wire.DecodeDraftRecoveryScope(await response.Content.ReadAsByteArrayAsync(ct));
        }

        async Task<HttpResponseMessage> Read(ServerProcess server, string token)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, WireRoutes.DraftRecoveryScope);
            request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            return await server.Client.SendAsync(request, ct);
        }
    }
}
