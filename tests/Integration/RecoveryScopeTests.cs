using System.Net;
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
            using var publicHidden = await start.Client.GetAsync(WireRoutes.DraftRecoveryScope, ct);
            Assert.Equal(HttpStatusCode.NotFound, publicHidden.StatusCode);
            using var unauthorized = await Read(start, null);
            Assert.Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode);
            var scope = await Scope(start, await Login(first, alice));
            firstSite = scope.SiteId;
            Assert.Equal(alice, scope.UserId);
            Assert.Equal(new(firstSite, bob), await Scope(start, await Login(first, bob)));
            using var readOnly = await Read(start, await Login(first, reader));
            Assert.Equal(HttpStatusCode.Unauthorized, readOnly.StatusCode);
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
            await using var tx = await connection.BeginTransactionAsync(ct);
            if (author)
            {
                var digest = System.Security.Cryptography.SHA256.HashData(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
                await FixtureSql.ExecuteAsync(connection, tx, ct, FixtureSql.AdminSessionSql, FixtureSql.AdminSessionArguments(
                    id, ScratchDatabase.AdminHandle(name, id), System.Security.Cryptography.RandomNumberGenerator.GetBytes(32),
                    System.Security.Cryptography.RandomNumberGenerator.GetBytes(8), [1], digest, 5));
            }
            else
            {
                await FixtureSql.SiteAccountAsync(connection, tx, ct, id, name);
            }
            await tx.CommitAsync(ct);
        }

        async Task<string> Login(ScratchDatabase db, Guid id) => (await db.SignIn(id, ct)).Token;

        async Task<DraftRecoveryScope> Scope(ServerProcess server, string token)
        {
            using var response = await Read(server, token);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return Wire.DecodeDraftRecoveryScope(await response.Content.ReadAsByteArrayAsync(ct));
        }

        async Task<HttpResponseMessage> Read(ServerProcess server, string? token)
        {
            using var request = SiteAedsFixture.Request(HttpMethod.Get, WireRoutes.DraftRecoveryScope, null, token, null);
            return await server.Client.SendAsync(request, ct);
        }
    }
}
