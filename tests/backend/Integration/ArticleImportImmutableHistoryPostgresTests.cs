using System.Reflection;
using System.Text.Json;

using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleImportImmutableHistoryPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTime s_now = new(2026, 10, 18, 0, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData(ArticleStatus.Draft)]
    [InlineData(ArticleStatus.Published)]
    public async Task ImportHistory_PreservesIssuedCurrentPublicationAndSnapshots_WhenNumbersOverlap(ArticleStatus status)
    {
        using SqlSugarClient db = await DatabaseAsync();
        int articleId = await CreateAsync(db, status);
        string original = await CoordinatesAsync(db, articleId);
        ArticleMutationOutboxEvent created = await db.Queryable<ArticleMutationOutboxEvent>().SingleAsync();

        Assert.Equal(2, await RestoreAsync(db, articleId, 1, 3));

        Assert.Equal(original, await CoordinatesAsync(db, articleId));
        Assert.Equal(new[] { 1, 2, 4 }, (await db.Queryable<ArticleRevision>()
            .Where(row => row.ArticleId == articleId).OrderBy(row => row.RevisionNo)
            .ToListAsync()).Select(row => row.RevisionNo));
        ArticleMutationOutboxEvent imported = await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(row => row.EventId != created.EventId).SingleAsync();
        Assert.Equal(created.ArticleRevisionId, imported.ArticleRevisionId);
        Assert.Equal(created.RightsSnapshotId, imported.RightsSnapshotId);
        Assert.Equal(created.ResponsibilitySnapshotId, imported.ResponsibilitySnapshotId);
        Assert.Equal(created.ArticlePublicationId, imported.ArticlePublicationId);
        Assert.Equal(2, await db.Queryable<ArticleSourceMutation>().CountAsync());
        Assert.Equal(new ArticleSourceCursor(articleId, 2, 2),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, articleId));
    }

    [Theory]
    [InlineData(ArticleStatus.Draft)]
    [InlineData(ArticleStatus.Published)]
    public async Task ImportHistory_EnrollmentFailureRollsBackHistoryEventAndClockTogether(ArticleStatus status)
    {
        using SqlSugarClient db = await DatabaseAsync();
        int articleId = await CreateAsync(db, status);
        string original = await CoordinatesAsync(db, articleId);
        await db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION fail_import_enrollment() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'import enrollment failed'; END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER fail_import_enrollment BEFORE INSERT ON article_source_mutation
                FOR EACH ROW EXECUTE FUNCTION fail_import_enrollment();
            """);

        Exception error = await Assert.ThrowsAnyAsync<Exception>(() => RestoreAsync(db, articleId, 1, 3));
        Assert.Contains("import enrollment failed", error.ToString());
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(original, await CoordinatesAsync(observer, articleId));
        Assert.Equal(1, await observer.Queryable<ArticleRevision>().CountAsync());
        Assert.Equal(1, await observer.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        Assert.Equal(1, await observer.Queryable<ArticleSourceMutation>().CountAsync());
        Assert.Equal(new ArticleSourceCursor(articleId, 1, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(observer, articleId));
        // The original content-block owner independently retains unreachable immutable
        // blocks. This test proves the history/event/cursor transaction, not full-graph cleanup.
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(1, 1)]
    public async Task ImportHistory_InvalidOrDuplicateSourceNumbersDoNotChangeCoordinates(int first, int second)
    {
        using SqlSugarClient db = await DatabaseAsync();
        int articleId = await CreateAsync(db, ArticleStatus.Draft);
        string original = await CoordinatesAsync(db, articleId);
        await Assert.ThrowsAsync<InvalidOperationException>(() => RestoreAsync(db, articleId, first, second));
        Assert.Equal(original, await CoordinatesAsync(db, articleId));
        Assert.Equal(1, await db.Queryable<ArticleRevision>().CountAsync());
        Assert.Equal(new ArticleSourceCursor(articleId, 1, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, articleId));
    }

    private static async Task<string> CoordinatesAsync(SqlSugarClient db, int articleId)
    {
        Article article = await db.Queryable<Article>().Where(row => row.Id == articleId).SingleAsync();
        ArticleRevision revision = await db.Queryable<ArticleRevision>()
            .Where(row => row.Id == article.CurrentRevisionId).SingleAsync();
        return JsonSerializer.Serialize(new
        {
            Article = article,
            Revision = revision,
            Rights = await db.Queryable<ArticleRightsSnapshot>().OrderBy(row => row.Id).ToListAsync(),
            Responsibility = await db.Queryable<ArticleResponsibilitySnapshot>().OrderBy(row => row.Id).ToListAsync(),
            Publications = await db.Queryable<ArticlePublicationRecord>().OrderBy(row => row.Id).ToListAsync()
        });
    }

    private static Task<int> RestoreAsync(SqlSugarClient db, int articleId, params int[] numbers)
    {
        var service = new AuthoringContentTransferService(db, Substitute.For<IArticleCoreService>(),
            Configuration(), Substitute.For<IAuthoringPrepublishPolicy>(), Substitute.For<IAuthoringAuditWriter>(),
            NullLogger<AuthoringContentTransferService>.Instance);
        var metadata = new ContentExportMetadataResponse(articleId, 1, [], ArticleStatus.Draft, null, null,
            numbers.Length, numbers.Select(number => new ContentRevisionExportResponse(number,
                $"Imported {number}", $"# historical {number}", null, null, 1, [], "import", s_now.AddDays(-1))).ToArray());
        MethodInfo restore = typeof(AuthoringContentTransferService).GetMethod("RestoreImportedRevisionsAsync",
            BindingFlags.Instance | BindingFlags.NonPublic)!;
        return (Task<int>)restore.Invoke(service, [articleId, metadata, CancellationToken.None])!;
    }

    private static async Task<int> CreateAsync(SqlSugarClient db, ArticleStatus status)
    {
        long admin = await db.Insertable(new AdminPrincipal
        {
            Handle = "import-admin", DisplayName = "Import tests", Status = AdminPrincipalStatus.Active,
            Permissions = string.Join('\n', AdminPermissions.ArticleWrite, AdminPermissions.ArticlePublish),
            CreatedAtUtc = s_now
        }).ExecuteReturnBigIdentityAsync();
        ArticleLifecycleTransitionWriter.Result? created = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
            created = await ArticleLifecycleTransitionWriter.CreateAsync(db, Configuration(), new(
                "Current", "# current", null, null, 1, [], status, null, s_now, admin, null,
                new ArticleResponsibilityDraft(true, [new ArticleResponsiblePerson("Import author", null)],
                    null, [], "import-test", "import-test", null, null, null, null, null,
                    true, false, false, false, 0), "import-tests")));
        Assert.True(transaction.IsSuccess, transaction.ErrorException?.ToString());
        return created!.ArticleId;
    }

    private async Task<SqlSugarClient> DatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Article), typeof(ArticleBody), typeof(ArticleTag),
            typeof(ArticleRevision), typeof(ArticleRevisionContentBlock), typeof(ArticleRightsPolicy),
            typeof(ArticleRightsSnapshot), typeof(ArticleResponsibilitySnapshot), typeof(ArticlePublicationRecord),
            typeof(ArticleMutationOutboxEvent), typeof(ArticleMutationCommand), typeof(AdminPrincipal), typeof(AuditLog),
            typeof(ContentAsset), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem));
        return db;
    }

    private static IConfiguration Configuration()
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Audit:TamperEvidenceKey"] = "import-history-test-signing-key-0123456789"
        }).Build();
}
