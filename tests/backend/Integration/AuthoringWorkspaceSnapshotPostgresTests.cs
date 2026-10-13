using FsusBlog.Contracts.AuthoringWorkspace;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthoringWorkspaceSnapshotPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    private const string SourceDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly AuthoringWorkspaceSnapshotScope s_scope = new(1, "site:primary");

    [Fact]
    public async Task IndependentConnections_EnforceUniqueDefaultCasIsolationAndResetWithoutContentWrites()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient deviceDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        var first = Store(db);
        var second = Store(deviceDb);
        var layout = AuthoringWorkspaceSnapshotContract.DefaultLayout();
        Assert.Equal("missing", (await first.ReadAsync(s_scope)).Status);
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT count(*) FROM authoring_workspace_snapshot;"));
        AuthoringWorkspaceSnapshotResult[] create = await Task.WhenAll(
            first.WriteAsync(s_scope, 0, layout), second.WriteAsync(s_scope, 0, layout with
            {
                SplitRatioPermille = 600
            }));
        Assert.Single(create, result => result.Status == "applied");
        Assert.Single(create, result => result.Status == "conflict");
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT count(*) FROM authoring_workspace_snapshot;"));
        AuthoringWorkspaceSnapshotResult[] updates = await Task.WhenAll(
            first.WriteAsync(s_scope, 1, layout with
            {
                SplitRatioPermille = 400
            }),
            second.WriteAsync(s_scope, 1, layout with
            {
                SplitRatioPermille = 700
            }));
        Assert.Single(updates, result => result.Status == "applied");
        Assert.Single(updates, result => result.Status == "conflict");
        Assert.Equal(2, (await first.ReadAsync(s_scope)).Revision);
        Assert.Equal("missing", (await first.ReadAsync(new(2, s_scope.SiteId))).Status);
        Assert.Equal("missing", (await first.ReadAsync(new(1, "site:other"))).Status);
        await first.WriteAsync(new(2, s_scope.SiteId), 0, layout);
        await first.WriteAsync(new(1, "site:other"), 0, layout);
        AuthoringWorkspaceSnapshotResult reset = await first.ResetAsync(s_scope, 2,
            AuthoringWorkspaceSnapshotStore.ResetConfirmation(s_scope, 2, SourceDigest));
        Assert.Equal(3, reset.Revision);
        Assert.Equal(1, (await second.ReadAsync(new(2, s_scope.SiteId))).Revision);
        Assert.Equal(1, (await second.ReadAsync(new(1, "site:other"))).Revision);
        Assert.Equal(3, await db.Ado.GetIntAsync("SELECT count(*) FROM authoring_workspace_snapshot;"));
        Assert.Equal("retained-content", await db.Ado.GetStringAsync("SELECT payload FROM protected_content;"));
        Assert.True(AuthoringWorkspaceSnapshotStore.VerifyReceipt(reset));
    }

    [Fact]
    public async Task DatabaseConstraints_RejectSecondWorkspaceOversizeAndCorruptReadStaysZeroWrite()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = Store(db);
        await store.WriteAsync(s_scope, 0, AuthoringWorkspaceSnapshotContract.DefaultLayout());
        await Assert.ThrowsAnyAsync<Exception>(() => db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO authoring_workspace_snapshot(user_id, site_id, workspace_id, revision, snapshot_bytes)
            VALUES (1, 'site:primary', 'second', 1, @Bytes);
            """, new SugarParameter("@Bytes", new byte[] { 1 })));
        await Assert.ThrowsAnyAsync<Exception>(() => db.Ado.ExecuteCommandAsync(
            "UPDATE authoring_workspace_snapshot SET snapshot_bytes = @Bytes;", new SugarParameter("@Bytes", new byte[65_537])));
        await db.Ado.ExecuteCommandAsync("UPDATE authoring_workspace_snapshot SET snapshot_bytes = @Bytes;",
            new SugarParameter("@Bytes", System.Text.Encoding.UTF8.GetBytes("{}")));
        AuthoringWorkspaceSnapshotResult blocked = await store.ReadAsync(s_scope);
        Assert.Equal("blocked", blocked.Status);
        Assert.Equal(1, blocked.Revision);
        await Assert.ThrowsAsync<AuthoringWorkspaceSnapshotException>(() => store.WriteAsync(s_scope, 1, AuthoringWorkspaceSnapshotContract.DefaultLayout()));
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT revision FROM authoring_workspace_snapshot;"));
        Assert.Equal(2, await db.Ado.GetIntAsync("SELECT octet_length(snapshot_bytes) FROM authoring_workspace_snapshot;"));
        Assert.Equal("retained-content", await db.Ado.GetStringAsync("SELECT payload FROM protected_content;"));
    }

    private static AuthoringWorkspaceSnapshotStore Store(SqlSugarClient db)
        => new(new AuthoringWorkspaceSnapshotPostgresPersistence(db), TimeProvider.System, SourceDigest);

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync("""
            CREATE TABLE admin_principal(id bigint PRIMARY KEY);
            INSERT INTO admin_principal(id) VALUES (1), (2);
            CREATE TABLE protected_content(payload text NOT NULL);
            INSERT INTO protected_content(payload) VALUES ('retained-content');
            """);
        await db.Ado.ExecuteCommandAsync(AuthoringWorkspaceSnapshotPostgresPersistence.SchemaSql);
        return db;
    }
}
