using System.Security.Claims;
using System.Text.Json;

using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Services.DocumentExport.Sources;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class DocumentExportSourceCatalogPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    private const int ArticleId = 204;
    private const string Site = "https://catalog.example.test";
    private static readonly DocumentExportJobActor s_actor = new(7, Site, "catalog-session-7");
    private static readonly DocumentExportSourceRequest s_draft = new(DocumentExportCoordinateKind.Draft, ArticleId, "owned-draft");

    [Fact]
    public async Task ExactRevisionAndSelectedPublication_RetainBindingAfterDatabaseReopen()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var (revisionId, publicationId, responsibilityId) = await SeedPublicationAsync(db);
        var request = new DocumentExportSourceRequest(DocumentExportCoordinateKind.Publication, ArticleId,
            RevisionId: revisionId, PublicationId: publicationId);
        var catalog = Catalog(db);
        DocumentExportSourceChoice publication = Assert.Single(await catalog.CaptureAsync(s_actor, [request]));
        Assert.True(publication.Coordinate.SourceVersion > 0);
        Assert.NotEqual(revisionId, publication.Coordinate.SourceVersion);
        Assert.Matches("^[0-9a-f]{64}$", publication.ChoiceId);
        Assert.Equal(publication, Assert.Single(await catalog.CaptureAsync(s_actor, [request])));
        DocumentExportBoundSource source = await catalog.ReadBoundAsync(s_actor, publication.ChoiceId, publication.Coordinate);
        Assert.Equal(publicationId, source.Publication!.Id);
        Assert.Equal(responsibilityId, source.Responsibility!.Id);
        Assert.Equal("# exact revision\r\n正文😀  ", source.Revision!.MarkdownContent);
        Assert.Equal("immutable title", publication.Label);
        Assert.Null(source.Draft);
        Assert.Equal(publication, (await catalog.ReadBoundAsync(s_actor, publication.Coordinate)).Choice);
        db.Ado.Close();
        using SqlSugarClient reopened = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(publication, Assert.Single(await Catalog(reopened).CaptureAsync(s_actor, [request])));
        DocumentExportSourceChoice revision = Assert.Single(await Catalog(reopened).CaptureAsync(s_actor,
            [request with { Kind = DocumentExportCoordinateKind.Revision, PublicationId = null }]));
        Assert.NotEqual(publication.ChoiceId, revision.ChoiceId);
        Assert.NotEqual(publication.Coordinate.SourceVersion, revision.Coordinate.SourceVersion);
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => Catalog(reopened).ReadBoundAsync(
            s_actor, publication.ChoiceId, publication.Coordinate with
            {
                SourceVersion = revision.Coordinate.SourceVersion
            }));
    }

    [Fact]
    public async Task ConcurrentExactFingerprintCapture_AllocatesOnePersistedBinding()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient otherDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        // Each request needs its own ambient HttpContextAccessor scope, as in production.
        DocumentExportSourceChoice[][] captures = await Task.WhenAll(
            Task.Run(() => CaptureDraftAsync(Catalog(db))),
            Task.Run(() => CaptureDraftAsync(Catalog(otherDb))));
        Assert.Equal(Assert.Single(captures[0]), Assert.Single(captures[1]));
        Assert.Equal(1, await CountAsync(db));
    }

    [Fact]
    public async Task ChangedOwnedDraftBytesMetadataAndServerRevision_AllocateNewBindingAndRejectOldVersion()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var catalog = Catalog(db);
        DocumentExportSourceChoice first = Assert.Single(await catalog.CaptureAsync(s_actor, [s_draft]));
        Assert.Equal("# private draft\r\n😀  ", (await catalog.ReadBoundAsync(s_actor, first.ChoiceId, first.Coordinate)).Draft!.Content);
        await db.Ado.ExecuteCommandAsync(
            "UPDATE article_draft SET markdown_content = @Content WHERE owner_admin_principal_id = 7 AND draft_key = 'owned-draft';",
            new SugarParameter("@Content", "# changed bytes\r\n😀  "));
        DocumentExportSourceChoice bytes = Assert.Single(await catalog.CaptureAsync(s_actor, [s_draft]));
        await db.Ado.ExecuteCommandAsync(
            "UPDATE article_draft SET summary = 'changed metadata' WHERE owner_admin_principal_id = 7 AND draft_key = 'owned-draft';");
        DocumentExportSourceChoice metadata = Assert.Single(await catalog.CaptureAsync(s_actor, [s_draft]));
        await db.Ado.ExecuteCommandAsync(
            "UPDATE article_draft SET server_revision = server_revision + 1 WHERE owner_admin_principal_id = 7 AND draft_key = 'owned-draft';");
        DocumentExportSourceChoice revision = Assert.Single(await catalog.CaptureAsync(s_actor, [s_draft]));
        Assert.Equal(4, new[] { first, bytes, metadata, revision }.Select(choice => choice.ChoiceId).Distinct().Count());
        Assert.Equal(4, new[] { first, bytes, metadata, revision }.Select(choice => choice.Coordinate.SourceVersion).Distinct().Count());
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.ReadBoundAsync(s_actor, first.ChoiceId, first.Coordinate));
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.ReadBoundAsync(s_actor, first.Coordinate));
        Assert.Equal(revision, Assert.Single(await catalog.CaptureAsync(s_actor, [s_draft])));
        Assert.Equal(4, await CountAsync(db));
    }

    [Fact]
    public async Task WrongOwnerSiteSessionAndRevokedPermission_RefuseWithoutBindingWrites()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var catalog = Catalog(db);
        foreach (DocumentExportJobActor actor in new[]
        {
            s_actor with { UserId = 8 }, s_actor with { SiteScope = "primary" }, s_actor with { SessionId = "other" }
        })
        {
            await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.CaptureAsync(actor, [s_draft]));
        }
        await db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET permissions = '' WHERE id = 7;");
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.CaptureAsync(s_actor, [s_draft]));
        await db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET permissions = 'article.write' WHERE id = 7;");
        DocumentExportSourceChoice choice = Assert.Single(await catalog.CaptureAsync(s_actor, [s_draft]));
        await db.Ado.ExecuteCommandAsync("UPDATE admin_session SET revokedatutc = TIMESTAMP '2024-01-01' WHERE adminprincipalid = 7;");
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.ReadBoundAsync(s_actor, choice.ChoiceId, choice.Coordinate));
        Assert.Equal(1, await CountAsync(db));
    }

    [Fact]
    public async Task IncorrectPublicationRelationAndMissingOrDeletedData_RefuseWithoutLatestFallback()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var (revisionId, publicationId, _) = await SeedPublicationAsync(db);
        var catalog = Catalog(db);
        var request = new DocumentExportSourceRequest(DocumentExportCoordinateKind.Publication, ArticleId,
            RevisionId: revisionId, PublicationId: publicationId);
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() =>
            catalog.CaptureAsync(s_actor, [request with { RevisionId = revisionId - 1 }]));
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() =>
            catalog.CaptureAsync(s_actor, [s_draft with { DraftKey = "other-owner-only" }]));
        Assert.Equal(0, await CountAsync(db));
        DocumentExportSourceChoice choice = Assert.Single(await catalog.CaptureAsync(s_actor, [request]));
        DocumentExportBoundSource original = await catalog.ReadBoundAsync(s_actor, choice.Coordinate);
        long wrongRightsId = await db.Insertable(new ArticleRightsSnapshot
        {
            ArticleId = ArticleId,
            ArticleRevisionId = revisionId - 1,
            RevisionNo = 10
        }).ExecuteReturnBigIdentityAsync();
        await db.Ado.ExecuteCommandAsync("UPDATE article_publication SET rights_snapshot_id = @Rights WHERE id = @Publication;",
            new SugarParameter("@Rights", wrongRightsId), new SugarParameter("@Publication", publicationId));
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.ReadBoundAsync(s_actor, choice.Coordinate));
        await db.Ado.ExecuteCommandAsync("UPDATE article_publication SET rights_snapshot_id = @Rights WHERE id = @Publication;",
            new SugarParameter("@Rights", original.Rights!.Id), new SugarParameter("@Publication", publicationId));
        await db.Ado.ExecuteCommandAsync("DELETE FROM article_responsibility_snapshot WHERE id = @Id;",
            new SugarParameter("@Id", (await catalog.ReadBoundAsync(s_actor, choice.ChoiceId, choice.Coordinate)).Responsibility!.Id));
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.ReadBoundAsync(s_actor, choice.ChoiceId, choice.Coordinate));
        await db.Ado.ExecuteCommandAsync("DELETE FROM article_revision_content_block WHERE id = @Id;",
            new SugarParameter("@Id", original.Revision!.ContentBlockId));
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.CaptureAsync(s_actor,
            [request with { Kind = DocumentExportCoordinateKind.Revision, PublicationId = null }]));
        DocumentExportSourceChoice draft = Assert.Single(await catalog.CaptureAsync(s_actor, [s_draft]));
        await db.Ado.ExecuteCommandAsync("DELETE FROM article_draft WHERE owner_admin_principal_id = 7 AND draft_key = 'owned-draft';");
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.ReadBoundAsync(s_actor, draft.ChoiceId, draft.Coordinate));
        await db.Ado.ExecuteCommandAsync("UPDATE article SET isdeleted = TRUE WHERE id = 204;");
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.CaptureAsync(s_actor,
            [request with { Kind = DocumentExportCoordinateKind.Revision, PublicationId = null }]));
        Assert.Equal(2, await CountAsync(db));
    }

    [Fact]
    public async Task FailedAndCancelledTransactions_RollBackNewBindings()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var catalog = Catalog(db);
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.CaptureAsync(s_actor,
            [s_draft, s_draft with { DraftKey = "missing" }]));
        Assert.Equal(0, await CountAsync(db));
        var store = new DocumentExportSourceCatalogStore(db);
        using var cancellation = new CancellationTokenSource();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => store.InTransactionAsync(async () =>
        {
            await store.CaptureAsync(s_actor, s_draft, new string('a', 64), cancellation.Token);
            cancellation.Cancel();
        }, cancellation.Token));
        Assert.Null(db.Ado.Transaction);
        Assert.False(db.Ado.CancellationToken?.IsCancellationRequested ?? false);
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(0, await CountAsync(observer));
        Assert.Single(await Catalog(observer).CaptureAsync(s_actor, [s_draft]));
    }

    [Fact]
    public async Task OriginalRevisionList_RetainsFiftyRowBound()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long blockId = await ArticleRevisionContentBlockStore.GetOrCreateAsync(db, "# bounded history", DateTime.UtcNow, default);
        for (int number = 1; number <= 51; number++)
        {
            await db.Insertable(new ArticleRevision
            {
                ArticleId = ArticleId,
                RevisionNo = number,
                Title = $"revision {number}",
                ContentBlockId = blockId
            }).ExecuteCommandAsync();
        }
        IReadOnlyList<DocumentExportSourceChoice> choices = await Catalog(db).CaptureRevisionsAsync(s_actor, ArticleId);
        Assert.Equal(50, choices.Count);
        Assert.DoesNotContain(choices, choice => choice.Label == "revision 1");
        Assert.Equal(50, await CountAsync(db));
    }

    [Fact]
    public async Task PrivateScopeIsolationAndCapacity_DoNotExposeRawSourceOrSnapshotIdentities()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var firstCatalog = Catalog(db);
        DocumentExportSourceChoice first = Assert.Single(await firstCatalog.CaptureAsync(s_actor, [s_draft]));
        var otherActor = new DocumentExportJobActor(8, Site, "catalog-session-8");
        var otherCatalog = Catalog(db, otherActor);
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => otherCatalog.ReadBoundAsync(otherActor, first.ChoiceId, first.Coordinate));
        DocumentExportSourceChoice other = Assert.Single(await otherCatalog.CaptureAsync(otherActor, [s_draft]));
        Assert.NotEqual(first.ChoiceId, other.ChoiceId);
        var otherSiteActor = s_actor with
        {
            SiteScope = "https://other.example.test"
        };
        var otherSite = Catalog(db, otherSiteActor);
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => otherSite.ReadBoundAsync(otherSiteActor, first.ChoiceId, first.Coordinate));
        DocumentExportSourceChoice scoped = Assert.Single(await otherSite.CaptureAsync(otherSiteActor, [s_draft]));
        Assert.NotEqual(first.ChoiceId, scoped.ChoiceId);
        string ui = JsonSerializer.Serialize(first);
        Assert.DoesNotContain("private draft", ui);
        Assert.DoesNotContain("Fingerprint", ui);
        Assert.DoesNotContain("SnapshotId", ui);
        string[] columns = (await db.Ado.SqlQueryAsync<ColumnName>(
            "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'document_export_source_catalog';"))
            .Select(column => column.Name).ToArray();
        Assert.Equal(10, columns.Length);
        Assert.DoesNotContain("markdown_content", columns);
        Assert.DoesNotContain("title", columns);
        // Populate only this disposable scope to exercise the producer's retained binding bound.
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO document_export_source_catalog
                (choice_id, owner_admin_principal_id, site_scope, source_kind, article_id, draft_key, fingerprint)
            SELECT lpad(to_hex(n), 64, '0'), 7, @Site, 1, 204, 'owned-draft', lpad(to_hex(n), 64, '0')
            FROM generate_series(1, 511) AS n;
            """, new SugarParameter("@Site", Site));
        await db.Ado.ExecuteCommandAsync("UPDATE article_draft SET server_revision = 2 WHERE owner_admin_principal_id = 7;");
        await Assert.ThrowsAsync<DocumentExportSourceCapacityException>(() => Catalog(db).CaptureAsync(s_actor, [s_draft]));
        Assert.Equal(512, await db.Ado.GetIntAsync("SELECT count(*) FROM document_export_source_catalog WHERE owner_admin_principal_id = 7 AND site_scope = @Site;",
            new SugarParameter("@Site", Site)));
    }

    private static async Task<DocumentExportSourceChoice[]> CaptureDraftAsync(DocumentExportSourceCatalog catalog)
        => [.. await catalog.CaptureAsync(s_actor, [s_draft])];

    private static Task<int> CountAsync(ISqlSugarClient db)
        => db.Ado.GetIntAsync("SELECT count(*) FROM document_export_source_catalog;");

    private static DocumentExportSourceCatalog Catalog(SqlSugarClient db, DocumentExportJobActor? actor = null)
    {
        actor ??= s_actor;
        var accessor = new HttpContextAccessor
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                [
                    new Claim("identity_kind", "admin_principal"),
                    new Claim("admin_id", actor.UserId.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                    new Claim("admin_sid", actor.SessionId),
                    new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
                ], "test"))
            }
        };
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SITE_BASEURL"] = actor.SiteScope + "/"
        }).Build();
        var lifecycle = new AuthoringDraftLifecycleService(db, Substitute.For<IArticleCoreService>(),
            Substitute.For<IArticlePublicationValidator>(), Substitute.For<IAuthoringAuditWriter>());
        return new(db, lifecycle, new(db, accessor, configuration, TimeProvider.System), accessor, configuration, new(db));
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(id bigint PRIMARY KEY, status varchar(32) NOT NULL, isroot boolean NOT NULL, permissions text NOT NULL);
            INSERT INTO admin_principal VALUES (7, 'active', FALSE, 'article.write'), (8, 'active', FALSE, 'article.write');
            CREATE TABLE admin_session(sessionid varchar(64) PRIMARY KEY, adminprincipalid bigint NOT NULL,
                revokedatutc timestamp NULL, idleexpiresatutc timestamp NOT NULL, absoluteexpiresatutc timestamp NOT NULL);
            INSERT INTO admin_session VALUES
                ('catalog-session-7', 7, NULL, TIMESTAMP '2099-01-01', TIMESTAMP '2099-01-02'),
                ('catalog-session-8', 8, NULL, TIMESTAMP '2099-01-01', TIMESTAMP '2099-01-02');
            CREATE TABLE article(id integer PRIMARY KEY, status integer NOT NULL, isdeleted boolean NOT NULL);
            INSERT INTO article VALUES (204, 0, FALSE);
            """);
        PostgresSqlSugarTestClient.InitTables(db, typeof(ArticleDraft), typeof(ArticleRevision), typeof(ArticleRevisionContentBlock),
            typeof(ArticlePublicationRecord), typeof(ArticleRightsSnapshot), typeof(ArticleResponsibilitySnapshot));
        await db.Ado.ExecuteCommandAsync(DocumentExportSourceCatalogSchema.Sql);
        foreach (long owner in new long[] { 7, 8 })
        {
            await db.Insertable(new ArticleDraft
            {
                OwnerAdminPrincipalId = owner,
                ArticleId = ArticleId,
                DraftKey = "owned-draft",
                Title = "draft title",
                MarkdownContent = "# private draft\r\n😀  ",
                ServerRevision = 1
            }).ExecuteCommandAsync();
        }
        await db.Insertable(new ArticleDraft
        {
            OwnerAdminPrincipalId = 8,
            ArticleId = ArticleId,
            DraftKey = "other-owner-only",
            Title = "secret",
            MarkdownContent = "secret"
        }).ExecuteCommandAsync();
        return db;
    }

    private static async Task<(long Revision, long Publication, long Responsibility)> SeedPublicationAsync(SqlSugarClient db)
    {
        long blockId = await ArticleRevisionContentBlockStore.GetOrCreateAsync(db, "# exact revision\r\n正文😀  ", DateTime.UtcNow, default);
        long revisionId = 0;
        for (int number = 1; number <= 11; number++)
        {
            revisionId = await db.Insertable(new ArticleRevision
            {
                ArticleId = ArticleId,
                RevisionNo = number,
                Title = "immutable title",
                Summary = "stored summary",
                CoverImageUrl = "/cover.png",
                CategoryId = 3,
                TagIds = "2,4",
                ContentBlockId = blockId
            }).ExecuteReturnBigIdentityAsync();
        }
        long rightsId = await db.Insertable(new ArticleRightsSnapshot
        {
            ArticleId = ArticleId,
            ArticleRevisionId = revisionId,
            RevisionNo = 11
        }).ExecuteReturnBigIdentityAsync();
        long responsibilityId = await db.Insertable(new ArticleResponsibilitySnapshot
        {
            ArticleId = ArticleId,
            ArticleRevisionId = revisionId,
            RevisionNo = 11,
            ResponsibilityVersion = 1
        }).ExecuteReturnBigIdentityAsync();
        long laterResponsibilityId = await db.Insertable(new ArticleResponsibilitySnapshot
        {
            ArticleId = ArticleId,
            ArticleRevisionId = revisionId,
            RevisionNo = 11,
            ResponsibilityVersion = 2
        }).ExecuteReturnBigIdentityAsync();
        long publicationId = await db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = ArticleId,
            ArticleRevisionId = revisionId,
            RevisionNo = 11,
            PublicationNo = 1,
            RightsSnapshotId = rightsId,
            ResponsibilitySnapshotId = responsibilityId,
            TransitionKind = "publish"
        }).ExecuteReturnBigIdentityAsync();
        await db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = ArticleId,
            ArticleRevisionId = revisionId,
            RevisionNo = 11,
            PublicationNo = 2,
            RightsSnapshotId = rightsId,
            ResponsibilitySnapshotId = laterResponsibilityId,
            TransitionKind = "republish"
        }).ExecuteCommandAsync();
        return (revisionId, publicationId, responsibilityId);
    }

    private sealed class ColumnName
    {
        public string Name { get; set; } = string.Empty;
    }
}
