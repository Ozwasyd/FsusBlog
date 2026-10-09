using System.Data;

using SqlSugar;

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Integration;

/// <summary>
/// Exercises the original immutable revision writer in caller-owned disposable transactions.
/// These controls do not qualify the full publication or editor runtime.
/// </summary>
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleRevisionSourceCoordinateHookIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string Markdown = "\uFEFF# 原文\r\n\r\nemoji 😀\r\ntrailing spaces  \r\n";
    private readonly ArticleRelationSourceCoordinateAuthority _authority = new();
    private static DateTime Now => TestTemporalContext.FromEnvironment().BusinessEpochUtc.UtcDateTime;

    [Fact]
    public async Task SaveProvisionsBeforeCallerCommitAndReconnectPreservesExactSource()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int article = await CreateArticleAsync(db);
        await db.Ado.BeginTranAsync();
        IDbTransaction transaction = db.Ado.Transaction;
        ArticleRevisionWriteResult revision = await SaveAsync(db, article);
        ArticleRelationRevisionCoordinate coordinate = Assert.IsType<ArticleRelationRevisionCoordinate>(
            await _authority.ReadRevisionAsync(db, article, revision.Id));
        Assert.Equal(revision.RevisionNo, coordinate.RevisionNo);
        Assert.Same(transaction, db.Ado.Transaction);
        Assert.Same(db.Ado.Connection, transaction.Connection);
        Assert.Equal(Markdown, await ArticleRevisionContentBlockStore.LoadAsync(db, revision.ContentBlockId, default));
        await db.Ado.CommitTranAsync();

        using SqlSugarClient restarted = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(coordinate, await _authority.ReadRevisionAsync(restarted, article, revision.Id));
        Assert.Equal(Markdown, await ArticleRevisionContentBlockStore.LoadAsync(restarted, revision.ContentBlockId, default));
        Assert.Equal(coordinate, await ReadAndReprovisionAsync(restarted, article, revision.Id));
    }

    [Fact]
    public async Task NewRevisionRetainsArticleIdentityAndOriginalImmutableCoordinates()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int article = await CreateArticleAsync(db);
        await db.Ado.BeginTranAsync();
        ArticleRevisionWriteResult first = await SaveAsync(db, article);
        ArticleRelationRevisionCoordinate original = Assert.IsType<ArticleRelationRevisionCoordinate>(
            await _authority.ReadRevisionAsync(db, article, first.Id));
        await db.Ado.CommitTranAsync();

        await db.Ado.BeginTranAsync();
        ArticleRevisionWriteResult next = await SaveAsync(db, article);
        ArticleRelationRevisionCoordinate current = Assert.IsType<ArticleRelationRevisionCoordinate>(
            await _authority.ReadRevisionAsync(db, article, next.Id));
        Assert.Equal(first.RevisionNo + 1, next.RevisionNo);
        Assert.Equal(first.ContentBlockId, next.ContentBlockId);
        Assert.Equal(original.ArticleIdentity, current.ArticleIdentity);
        Assert.NotEqual(original.RevisionIdentity, current.RevisionIdentity);
        Assert.NotEqual(original.SourceEpoch, current.SourceEpoch);
        Assert.Equal(original, await _authority.ReadRevisionAsync(db, article, first.Id));
        await db.Ado.CommitTranAsync();
        Assert.Equal(2, await db.Queryable<ArticleRelationSourceCoordinate>().CountAsync());
    }

    [Fact]
    public async Task CallerRollbackRemovesRevisionAndCoordinatesAndAllowsFreshRetry()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int article = await CreateArticleAsync(db);
        await db.Ado.BeginTranAsync();
        ArticleRevisionWriteResult rolledBack = await SaveAsync(db, article);
        ArticleRelationRevisionCoordinate provisional = Assert.IsType<ArticleRelationRevisionCoordinate>(
            await _authority.ReadRevisionAsync(db, article, rolledBack.Id));
        await db.Ado.RollbackTranAsync();
        Assert.Null(await _authority.ReadRevisionAsync(db, article, rolledBack.Id));
        Assert.Equal(0, await db.Queryable<ArticleRevision>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleRelationArticleBinding>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleRelationSourceCoordinate>().CountAsync());
        // The original content-block owner intentionally commits immutable bytes independently.
        Assert.Equal(Markdown, await ArticleRevisionContentBlockStore.LoadAsync(db, rolledBack.ContentBlockId, default));

        await db.Ado.BeginTranAsync();
        ArticleRevisionWriteResult retried = await SaveAsync(db, article);
        ArticleRelationRevisionCoordinate saved = Assert.IsType<ArticleRelationRevisionCoordinate>(
            await _authority.ReadRevisionAsync(db, article, retried.Id));
        Assert.Equal(1, retried.RevisionNo);
        Assert.Equal(rolledBack.ContentBlockId, retried.ContentBlockId);
        Assert.NotEqual(provisional.ArticleIdentity, saved.ArticleIdentity);
        await db.Ado.CommitTranAsync();
        Assert.Equal(saved, await _authority.ReadRevisionAsync(db, article, retried.Id));
    }

    [Fact]
    public async Task MissingPublishedMigrationRefusesSaveWithoutRuntimeSchemaRepair()
    {
        using SqlSugarClient db = await CreateDatabaseAsync(provisionSchema: false);
        int article = await CreateArticleAsync(db);
        await db.Ado.BeginTranAsync();
        var error = await Assert.ThrowsAsync<Npgsql.PostgresException>(() => SaveAsync(db, article));
        Assert.Equal("42P01", error.SqlState);
        await db.Ado.RollbackTranAsync();
        Assert.Equal(0, await db.Queryable<ArticleRevision>().CountAsync());
        Assert.Equal(0, await fixture.QueryScalarAsync<int>(db.CurrentConnectionConfig.ConnectionString,
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('article_relation_article_binding', 'article_relation_source_coordinate');"));
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync(bool provisionSchema = true)
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        try
        {
            PostgresSqlSugarTestClient.InitTables(db, typeof(Article), typeof(ArticleRevision), typeof(ArticleRevisionContentBlock));
            if (provisionSchema)
            {
                await fixture.ExecuteAsync(db.CurrentConnectionConfig.ConnectionString,
                    ArticleRelationSourceCoordinateMigrationDefinitions.Sql);
            }
            return db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    private static Task<int> CreateArticleAsync(SqlSugarClient db)
        => db.Insertable(new Article
        {
            Title = "original writer coordinate hook",
            CreateTime = Now,
            MetadataUpdatedAt = Now,
            Status = ArticleStatus.Draft,
            IsDeleted = false
        }).ExecuteReturnIdentityAsync();

    private static Task<ArticleRevisionWriteResult> SaveAsync(SqlSugarClient db, int article)
        => ArticleRevisionPersistence.SaveAsync(db, article, "original source", Markdown, null, null,
            0, [], "original writer hook control", Now, 42);

    private async Task<ArticleRelationRevisionCoordinate> ReadAndReprovisionAsync(SqlSugarClient db, int article, long revision)
    {
        await db.Ado.BeginTranAsync();
        ArticleRelationRevisionCoordinate result = await _authority.ProvisionRevisionAsync(db, article, revision);
        await db.Ado.CommitTranAsync();
        return result;
    }
}
