using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

/// <summary>Ordinary persisted session controls using the original isolated PostgreSQL fixture.</summary>
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class DocumentExportSessionJobAuthorizationPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    private const string SiteScope = "https://export.example.test";
    private static readonly DocumentExportJobActor s_actor = new(1, SiteScope, "export-session");
    private static readonly DocumentExportArticleCoordinate s_coordinate = new(
        DocumentExportCoordinateKind.Publication, 42, null, 101, 202, 3);
    private static readonly DateTimeOffset s_now = new(2030, 1, 1, 0, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData(false, DocumentExportJobOperation.Read)]
    [InlineData(false, DocumentExportJobOperation.Download)]
    [InlineData(false, DocumentExportJobOperation.Create)]
    [InlineData(false, DocumentExportJobOperation.Cancel)]
    [InlineData(false, DocumentExportJobOperation.Retry)]
    [InlineData(false, DocumentExportJobOperation.Delete)]
    [InlineData(true, DocumentExportJobOperation.Read)]
    [InlineData(true, DocumentExportJobOperation.Download)]
    [InlineData(true, DocumentExportJobOperation.Create)]
    [InlineData(true, DocumentExportJobOperation.Cancel)]
    [InlineData(true, DocumentExportJobOperation.Retry)]
    [InlineData(true, DocumentExportJobOperation.Delete)]
    public async Task LiveSession_RootOrExplicitPermissionAllowsOperation(
        bool root, DocumentExportJobOperation operation)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        if (root)
        {
            await db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET isroot = TRUE, permissions = '' WHERE id = 1;");
        }
        DocumentExportSessionJobAuthorization authorization = CreateAuthorization(db);
        Assert.True(await authorization.IsAllowedAsync(s_actor, s_coordinate, operation, default));
    }

    [Theory]
    [InlineData("revoked")]
    [InlineData("idle")]
    [InlineData("absolute")]
    [InlineData("disabled")]
    [InlineData("permission")]
    [InlineData("archived")]
    [InlineData("deleted-status")]
    [InlineData("deleted-flag")]
    [InlineData("missing-article")]
    [InlineData("missing-session")]
    [InlineData("session-owner")]
    public async Task ChangedPersistedFacts_DenyNextReadAndWrite(string mutation)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        DocumentExportSessionJobAuthorization authorization = CreateAuthorization(db);
        Assert.True(await authorization.IsAllowedAsync(s_actor, s_coordinate, DocumentExportJobOperation.Read, default));
        Assert.True(await authorization.IsAllowedAsync(s_actor, s_coordinate, DocumentExportJobOperation.Create, default));
        string sql = mutation switch
        {
            "revoked" => "UPDATE admin_session SET revokedatutc = TIMESTAMP '2029-12-31 00:00:00';",
            "idle" => "UPDATE admin_session SET idleexpiresatutc = TIMESTAMP '2030-01-01 00:00:00';",
            "absolute" => "UPDATE admin_session SET absoluteexpiresatutc = TIMESTAMP '2030-01-01 00:00:00';",
            "disabled" => "UPDATE admin_principal SET status = 'disabled' WHERE id = 1;",
            "permission" => "UPDATE admin_principal SET permissions = 'article.publish' WHERE id = 1;",
            "archived" => $"UPDATE article SET status = {(int)ArticleStatus.Archived};",
            "deleted-status" => $"UPDATE article SET status = {(int)ArticleStatus.Deleted};",
            "deleted-flag" => "UPDATE article SET isdeleted = TRUE;",
            "missing-article" => "DELETE FROM article;",
            "missing-session" => "DELETE FROM admin_session;",
            _ => "UPDATE admin_session SET adminprincipalid = 2;"
        };
        await db.Ado.ExecuteCommandAsync(sql);
        Assert.False(await authorization.IsAllowedAsync(s_actor, s_coordinate, DocumentExportJobOperation.Read, default));
        Assert.False(await authorization.IsAllowedAsync(s_actor, s_coordinate, DocumentExportJobOperation.Create, default));
    }

    [Theory]
    [InlineData("site")]
    [InlineData("session")]
    [InlineData("principal")]
    public async Task PersistedIdentityMismatch_FailsClosed(string mutation)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        DocumentExportJobActor actor = mutation switch
        {
            "site" => s_actor with { SiteScope = "https://other.example.test" },
            "session" => s_actor with { SessionId = "missing-session" },
            _ => s_actor with { UserId = 3 }
        };
        Assert.False(await CreateAuthorization(db).IsAllowedAsync(actor, s_coordinate,
            DocumentExportJobOperation.Read, default));
    }

    [Fact]
    public async Task BoundHttpContext_StillUsesCurrentPersistedSession()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var context = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim("identity_kind", "admin_principal"),
                new Claim("admin_id", "1"),
                new Claim("admin_sid", s_actor.SessionId),
                new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
            ], "controlled-admin"))
        };
        DocumentExportSessionJobAuthorization authorization = CreateAuthorization(db, context);
        Assert.True(await authorization.IsAllowedAsync(s_actor, s_coordinate, DocumentExportJobOperation.Read, default));
        await db.Ado.ExecuteCommandAsync("UPDATE admin_session SET revokedatutc = TIMESTAMP '2029-12-31 00:00:00';");
        Assert.False(await authorization.IsAllowedAsync(s_actor, s_coordinate, DocumentExportJobOperation.Read, default));
    }

    [Fact]
    public async Task CanonicalReader_SealsCurrentFactsAndRereadsRowVersions()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var reader = new AuthorRecentArticleHistoryPersistedPermissionReader(db, Configuration(), new FixedTimeProvider());
        var request = new AuthorRecentArticleHistoryPermissionRequest(new(1, SiteScope), Guid.CreateVersion7(), [42]);
        AuthorRecentArticleHistoryPermissionSnapshot first = await reader.ResolveAsync(request, s_actor.SessionId);
        Assert.Equal(AuthorRecentArticleHistoryPermissionSnapshotStatus.Current, first.Status);
        Assert.Equal(request.Owner, first.Owner);
        Assert.True(Assert.Single(first.Decisions).CanWrite);
        Assert.Equal(AuthorRecentArticleHistoryContract.ComputePermissionDigest(first), first.ContentDigest);
        await db.Ado.ExecuteCommandAsync("UPDATE admin_session SET idleexpiresatutc = TIMESTAMP '2098-01-01 00:00:00';");
        AuthorRecentArticleHistoryPermissionSnapshot second = await reader.ResolveAsync(request, s_actor.SessionId);
        Assert.NotEqual(first.SessionRevision, second.SessionRevision);
        Assert.NotEqual(first.ContentDigest, second.ContentDigest);
        Assert.Equal(AuthorRecentArticleHistoryContract.ComputePermissionDigest(second), second.ContentDigest);
    }

    [Fact]
    public async Task CancelledReader_DoesNotIssueDatabaseQuery()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        var reader = new AuthorRecentArticleHistoryPersistedPermissionReader(db, Configuration(), new FixedTimeProvider());
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.ResolveAsync(
            new(new(1, SiteScope), Guid.CreateVersion7(), [42]), s_actor.SessionId, cancellation.Token));
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(
                id bigint PRIMARY KEY,
                status varchar(32) NOT NULL,
                isroot boolean NOT NULL,
                permissions text NOT NULL);
            INSERT INTO admin_principal(id, status, isroot, permissions)
            VALUES (1, 'active', FALSE, 'article.write'), (2, 'active', FALSE, 'article.write');
            CREATE TABLE admin_session(
                sessionid varchar(64) PRIMARY KEY,
                adminprincipalid bigint NOT NULL REFERENCES admin_principal(id),
                revokedatutc timestamp without time zone NULL,
                idleexpiresatutc timestamp without time zone NOT NULL,
                absoluteexpiresatutc timestamp without time zone NOT NULL);
            INSERT INTO admin_session(sessionid, adminprincipalid, revokedatutc, idleexpiresatutc, absoluteexpiresatutc)
            VALUES ('export-session', 1, NULL, TIMESTAMP '2099-01-01 00:00:00', TIMESTAMP '2099-01-02 00:00:00');
            CREATE TABLE article(id integer PRIMARY KEY, status integer NOT NULL, isdeleted boolean NOT NULL);
            INSERT INTO article(id, status, isdeleted) VALUES (42, 0, FALSE);
            """);
        return db;
    }

    private static DocumentExportSessionJobAuthorization CreateAuthorization(ISqlSugarClient db, HttpContext? context = null)
        => new(new AuthorRecentArticleHistoryPersistedPermissionReader(db, Configuration(), new FixedTimeProvider()),
            new HttpContextAccessor { HttpContext = context });

    private static IConfiguration Configuration()
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SITE_BASEURL"] = SiteScope
        }).Build();

    private sealed class FixedTimeProvider : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => s_now;
    }
}
