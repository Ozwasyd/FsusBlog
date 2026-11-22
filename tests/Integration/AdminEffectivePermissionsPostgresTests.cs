using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using static FsusBlog.V2.Integration.Tests.BusinessAssert;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminEffectivePermissionsPostgresTests
{
    [PostgresFact]
    public async Task SessionBindingTracksLiveUnifiedAdministratorGenerationAndRevocation()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var store = new AdminSessionGate(fixture.DataSource, null);
        var operations = new AdminOperationsStore(store);
        var commentQueue = new AdminCommentQueueStore(store);
        var publications = PublicationFixture.Project(fixture.DataSource);
        var (owner, firstToken) = await Add("first");
        var (other, secondToken) = await Add("second");
        var siteUser = await fixture.SignInSiteUser("ordinary-site-user", ct);

        var snapshot = await store.SessionWithPermissionBinding(firstToken, ct);
        Assert.Equal(1L, snapshot.Snapshot.Generation);
        Assert.Matches("^[a-f0-9]{64}$", snapshot.PermissionSession);
        Assert.NotEqual(firstToken, snapshot.PermissionSession);

        var sibling = await store.SessionWithPermissionBinding(secondToken, ct);
        Assert.Equal(snapshot.Snapshot.Generation, sibling.Snapshot.Generation);
        Assert.NotEqual(snapshot.PermissionSession, sibling.PermissionSession);
        await operations.OperationsStatus(firstToken, publications, ct);
        await commentQueue.CommentQueue(firstToken, Microsoft.AspNetCore.Http.QueryCollection.Empty, ct);
        await Denied(() => store.SessionWithPermissionBinding(null, ct));
        await Denied(() => store.SessionWithPermissionBinding(siteUser.Token, ct));

        // Rotating the principal generation retires its prior session and binds a fresh opaque session digest.
        var newToken = NewToken();
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            await ExecuteIn(tx, "update public.admin_principal set generation=generation+1 where id=$1", owner);
            await ExecuteIn(tx, "delete from public.admin_session where principal_id=$1", owner);
            await ExecuteIn(tx, """
                insert into public.admin_session(digest,principal_id,generation,expires_at)
                    values($2,$1,2,clock_timestamp()+interval '10 minutes')
                """, owner, Store.TokenDigest(newToken)!);
            await tx.CommitAsync(ct);
        }
        await Denied(() => store.SessionWithPermissionBinding(firstToken, ct));
        var renewed = await store.SessionWithPermissionBinding(newToken, ct);
        Assert.Equal(2L, renewed.Snapshot.Generation);
        Assert.NotEqual(snapshot.PermissionSession, renewed.PermissionSession);
        await operations.OperationsStatus(newToken, publications, ct);
        await commentQueue.CommentQueue(newToken, Microsoft.AspNetCore.Http.QueryCollection.Empty, ct);
        Assert.Equal(sibling.PermissionSession, (await store.SessionWithPermissionBinding(secondToken, ct)).PermissionSession);
        await Execute("update public.admin_principal set enabled=false where id=$1", other);
        await Denied(() => store.SessionWithPermissionBinding(secondToken, ct));

        async Task<(Guid Id, string Token)> Add(string handle)
        {
            var (id, token, _) = await FixtureSql.AdminAsync(db, ct, handle, 10, RandomNumberGenerator.GetBytes(32), [1]);
            return (id, token);
        }

        Task Execute(string sql, params object[] args) => ExecuteIn(null, sql, args);

        Task ExecuteIn(Npgsql.NpgsqlTransaction? transaction, string sql, params object[] args) =>
            FixtureSql.ExecuteAsync(db, transaction, ct, sql, args);
    }

    [PostgresFact]
    public async Task BootstrapCreatesUnifiedAdministratorWithFullAuthoringAndManagementAccess()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);

        var unifiedSecret = await RunMigrateBootstrap(fixture.ConnectionString, ["admin-identity", "bootstrap", "unified-admin"], ct);
        Assert.Matches("^[0-9a-f]{64}$", unifiedSecret);

        var principalId = (Guid)(await FixtureSql.ScalarAsync(db, null, ct,
            "select id from public.admin_principal where handle=$1 and enabled", "unified-admin"))!;
        Assert.Equal(1L, (long)(await FixtureSql.ScalarAsync(db, null, ct,
            "select count(*) from public.admin_invitation where principal_id=$1 and digest=$2",
            principalId, SHA256.HashData(Convert.FromHexString(unifiedSecret))))!);

        var token = NewToken();
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.admin_passkey_credential(credential_id,principal_id,public_key,sign_count,backup_eligible,backed_up)
            values($1,$2,$3,0,false,false)
            """, RandomNumberGenerator.GetBytes(32), principalId, new byte[] { 1 });
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.admin_session(digest,principal_id,generation,expires_at)
            values($1,$2,1,clock_timestamp()+interval '10 minutes')
            """, Store.TokenDigest(token)!, principalId);

        var adminStore = new AdminSessionGate(fixture.DataSource, null);
        var operations = new AdminOperationsStore(adminStore);
        var commentQueue = new AdminCommentQueueStore(adminStore);
        var publications = PublicationFixture.Project(fixture.DataSource);
        var active = await adminStore.SessionWithPermissionBinding(token, ct);
        Assert.Equal("unified-admin", active.Snapshot.Handle);
        await operations.OperationsStatus(token, publications, ct);
        await commentQueue.CommentQueue(token, Microsoft.AspNetCore.Http.QueryCollection.Empty, ct);
        var article = (await publications.Command(new Store(fixture.DataSource), token, ArticleAction.Save,
            new Edit(0, 0, Guid.NewGuid(), "Unified admin article", "Body"), ct)).Article;
        Assert.True(article.Id > 0);
        Assert.Equal(principalId, (Guid)(await FixtureSql.ScalarAsync(db, null, ct,
            "select owner_id from public.article where id=$1", article.Id))!);
    }

    private static async Task<string> RunMigrateBootstrap(string connectionString, string[] arguments, CancellationToken ct)
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null && !File.Exists(Path.Combine(current.FullName, "FsusBlog.V2.slnx")))
            current = current.Parent;
        Assert.NotNull(current);
        var configuration = new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name;
        var cliDll = Path.Combine(current!.FullName, "src", "Cli", "bin", configuration, "net10.0", "FsusBlog.V2.Cli.dll");
        if (!File.Exists(cliDll))
            cliDll = Path.Combine(current.FullName, "src", "Cli", "bin", "Release", "net10.0", "FsusBlog.V2.Cli.dll");

        var start = FixtureProcess.Command("dotnet", [cliDll, .. arguments]);
        start.Environment["FSUSBLOG_DB"] = connectionString;
        var result = await FixtureProcess.Run(start, ct);
        Assert.True(result.Code == 0, $"Cli exited with {result.Code}: {result.Error}");
        return result.Output.Trim();
    }

    private static string NewToken() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
}
