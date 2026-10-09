using System.Text;

using SqlSugar;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Ordinary module reads through the real PostgreSQL, permission and revision readers.</summary>
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class CurrentArticleEmbedTargetReaderTests(PostgresSchemaMigrationFixture fixture)
{
    private readonly ArticleRelationSourceCoordinateAuthority _coordinates = new();
    private static DateTime Now => TestTemporalContext.FromEnvironment().BusinessEpochUtc.UtcDateTime;

    [Fact]
    public async Task AuthorizedPersistedArticleReadsExactSourceInReadOnlyTransaction()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        await db.Ado.BeginTranAsync();
        await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
        try
        {
            CurrentArticleEmbedTargetSource source = Assert.IsType<CurrentArticleEmbedTargetSource>(
                await Reader(db).ReadAsync(context, Target(saved)));
            Assert.Equal(saved, source.Coordinate);
            Assert.Equal("# exact source\n\n正文 🧭", Encoding.UTF8.GetString(source.Package.RawMarkdown.AsSpan()));
            Assert.True(RevisionComparePackageSeal.Verify(source.Package));
            Assert.Equal(saved.RevisionId, source.Package.RevisionId);
            Assert.Equal(saved.RevisionNo, source.Package.RevisionNo);
            Assert.Contains(source.Package.Metadata, value => value.FieldId == "title" && value.CanonicalValue == "immutable title");
            Assert.Null(source.Package.DocumentEpoch);
            Assert.NotEqual(Guid.Empty, source.Coordinate.SourceEpoch);
            Assert.NotNull(db.Ado.Transaction);
        }
        finally
        {
            await db.Ado.RollbackTranAsync();
        }
        Assert.Equal(1, await db.Queryable<ArticleRelationArticleBinding>().CountAsync());
        Assert.Equal(1, await db.Queryable<ArticleRelationSourceCoordinate>().CountAsync());
    }

    [Fact]
    public async Task DeniedAndMissingTargetsReturnNoSourceAndDeniedDoesNotReadRevision()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        await db.Updateable<AdminPrincipal>().SetColumns(row => new AdminPrincipal { Permissions = "" })
            .Where(row => row.Id == context.AdminPrincipalId).ExecuteCommandAsync();
        var statements = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => statements.Add(sql);
        Assert.Null(await Reader(db).ReadAsync(context, Target(saved)));
        Assert.DoesNotContain(statements, sql => sql.Contains("article_revision", StringComparison.OrdinalIgnoreCase));
        Assert.Null(await Reader(db).ReadAsync(context, Target(saved) with
        {
            PortableArticleIdentity = "article:44bc896e-4d27-4900-a814-c7a7d5de45bc"
        }));
    }

    [Fact]
    public async Task WrongSiteAndDeletedArticleCannotExposeAuthorizedSource()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        Assert.Null(await Reader(db).ReadAsync(context with
        {
            SiteScope = "other"
        }, Target(saved)));
        await db.Updateable<Article>().SetColumns(row => new Article { IsDeleted = true })
            .Where(row => row.Id == saved.ArticleId).ExecuteCommandAsync();
        Assert.Null(await Reader(db).ReadAsync(context, Target(saved)));
    }

    [Fact]
    public async Task UnprovisionedSourceBindingIsNotLazilyWritten()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        await db.Deleteable<ArticleRelationSourceCoordinate>().Where(row => row.RevisionId == saved.RevisionId).ExecuteCommandAsync();
        await db.Ado.BeginTranAsync();
        await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
        try
        {
            Assert.Null(await Reader(db).ReadAsync(context, Target(saved)));
            Assert.Equal(0, await db.Queryable<ArticleRelationSourceCoordinate>().CountAsync());
        }
        finally
        {
            await db.Ado.RollbackTranAsync();
        }
    }

    [Fact]
    public async Task DraftWithoutCurrentImmutableRevisionIsUnavailable()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        await db.Updateable<Article>().SetColumns(row => new Article { CurrentRevisionId = null })
            .Where(row => row.Id == saved.ArticleId).ExecuteCommandAsync();
        Assert.Null(await Reader(db).ReadAsync(context, Target(saved)));
        Assert.Equal(1, await db.Queryable<ArticleRelationSourceCoordinate>().CountAsync());
    }

    [Fact]
    public async Task IdenticalSourceBytesDoNotSharePortableRevisionOrIncarnation()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate first, RevisionCompareReadContext firstContext) = await SeedAsync(db);
        (ArticleRelationRevisionCoordinate second, RevisionCompareReadContext secondContext) = await SeedAsync(db, "embed-reader-2");
        CurrentArticleEmbedTargetSource firstSource = Assert.IsType<CurrentArticleEmbedTargetSource>(
            await Reader(db).ReadAsync(firstContext, Target(first)));
        CurrentArticleEmbedTargetSource secondSource = Assert.IsType<CurrentArticleEmbedTargetSource>(
            await Reader(db).ReadAsync(secondContext, Target(second)));
        Assert.Equal(firstSource.Package.SourceDigest, secondSource.Package.SourceDigest);
        Assert.NotEqual(firstSource.Coordinate.ArticleIdentity, secondSource.Coordinate.ArticleIdentity);
        Assert.NotEqual(firstSource.Coordinate.RevisionIdentity, secondSource.Coordinate.RevisionIdentity);
        Assert.NotEqual(firstSource.Coordinate.SourceEpoch, secondSource.Coordinate.SourceEpoch);
    }

    [Fact]
    public async Task CurrentPointerDriftDuringReadDiscardsCapturedSource()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        var reader = Reader(db, async _ =>
        {
            await db.Updateable<Article>().SetColumns(row => new Article { CurrentRevisionId = null })
                .Where(row => row.Id == saved.ArticleId).ExecuteCommandAsync();
        });
        Assert.Null(await reader.ReadAsync(context, Target(saved)));
    }

    [Fact]
    public async Task PermissionRevocationDuringReadDiscardsCapturedSource()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        var reader = Reader(db, async _ =>
        {
            await db.Updateable<AdminPrincipal>().SetColumns(row => new AdminPrincipal { Permissions = "" })
                .Where(row => row.Id == context.AdminPrincipalId).ExecuteCommandAsync();
        });
        Assert.Null(await reader.ReadAsync(context, Target(saved)));
    }

    [Fact]
    public async Task PersistedIncarnationTamperDuringReadDiscardsCapturedSource()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        var reader = Reader(db, async _ =>
        {
            Guid replacementEpoch = Guid.NewGuid();
            await db.Updateable<ArticleRelationSourceCoordinate>()
                .SetColumns(row => new ArticleRelationSourceCoordinate { SourceEpoch = replacementEpoch })
                .Where(row => row.RevisionId == saved.RevisionId).ExecuteCommandAsync();
        });
        Assert.Null(await reader.ReadAsync(context, Target(saved)));
    }

    [Fact]
    public async Task CancellationBeforeAndAfterSourceReadPropagates()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Reader(db).ReadAsync(context, Target(saved), cancelled.Token));
        using var during = new CancellationTokenSource();
        var reader = Reader(db, _ =>
        {
            during.Cancel();
            return Task.CompletedTask;
        });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => reader.ReadAsync(context, Target(saved), during.Token));
    }

    [Fact]
    public async Task InvalidOrUnprojectedKindsFailBeforeDatabaseAccess()
    {
        var reader = new CurrentArticleEmbedTargetReader(null!, _coordinates, null!, null!);
        var context = new RevisionCompareReadContext(1, "primary", Guid.NewGuid());
        foreach (ArticleEmbedTargetIdentity target in new ArticleEmbedTargetIdentity[]
        {
            new("article:1", ArticleEmbedTargetKind.Article, null, null),
            new("article:44bc896e-4d27-4900-a814-c7a7d5de45bc", ArticleEmbedTargetKind.Heading,
                "heading:8a237476-26a7-42b9-b98b-2342496e756f", null),
            new("article:44bc896e-4d27-4900-a814-c7a7d5de45bc", ArticleEmbedTargetKind.Block, null,
                "anchor-1")
        })
        {
            if (target.Kind != ArticleEmbedTargetKind.Article)
            {
                Assert.True(ArticleEmbedTargetCodec.Validate(target).IsValid);
            }
            Assert.Null(await reader.ReadAsync(context, target));
        }
    }

    private CurrentArticleEmbedTargetReader Reader(SqlSugarClient db, Func<RevisionComparePackageReadResult, Task>? afterRead = null)
    {
        // The read path uses the real lifecycle; these write-only collaborators must not be invoked.
        var lifecycle = new AuthoringDraftLifecycleService(db, null!, null!, null!);
        var authority = new AuthoringRevisionCompareAuthority(db, lifecycle);
        IRevisionComparePackageReader packages = new AuthoringRevisionComparePackageReader(
            authority, new AuthoringRevisionCompareDraftContextAuthority([]));
        if (afterRead is not null)
        {
            packages = new AfterReadPackageReader(packages, afterRead);
        }
        return new(db, _coordinates, authority, packages);
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Article), typeof(ArticleRevision), typeof(ArticleRevisionContentBlock),
            typeof(AdminPrincipal), typeof(ArticleRightsSnapshot), typeof(ArticleResponsibilitySnapshot), typeof(ArticlePublicationRecord));
        await fixture.ExecuteAsync(db.CurrentConnectionConfig.ConnectionString, ArticleRelationSourceCoordinateMigrationDefinitions.Sql);
        return db;
    }

    private async Task<(ArticleRelationRevisionCoordinate Coordinate, RevisionCompareReadContext Context)> SeedAsync(
        SqlSugarClient db, string handle = "embed-reader")
    {
        long principal = await db.Insertable(new AdminPrincipal
        {
            Handle = handle,
            Permissions = AdminPermissions.ArticleWrite,
            CreatedAtUtc = Now
        }).ExecuteReturnBigIdentityAsync();
        int article = await db.Insertable(new Article
        {
            Title = "mutable title",
            Status = ArticleStatus.Draft,
            CreateTime = Now,
            MetadataUpdatedAt = Now
        }).ExecuteReturnIdentityAsync();
        long block = await ArticleRevisionContentBlockStore.GetOrCreateAsync(db, "# exact source\n\n正文 🧭", Now, CancellationToken.None);
        long revision = await db.Insertable(new ArticleRevision
        {
            ArticleId = article,
            RevisionNo = 1,
            Title = "immutable title",
            ContentBlockId = block,
            DiffSummary = "module fixture",
            CreatedAt = Now,
            CreatedByAdminPrincipalId = principal
        }).ExecuteReturnBigIdentityAsync();
        await db.Updateable<Article>().SetColumns(row => new Article { CurrentRevisionId = revision })
            .Where(row => row.Id == article).ExecuteCommandAsync();
        await db.Ado.BeginTranAsync();
        ArticleRelationRevisionCoordinate coordinate = await _coordinates.ProvisionRevisionAsync(db, article, revision);
        await db.Ado.CommitTranAsync();
        return (coordinate, new(principal, AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope, Guid.NewGuid()));
    }

    private static ArticleEmbedTargetIdentity Target(ArticleRelationRevisionCoordinate coordinate)
        => new(coordinate.ArticleIdentity, ArticleEmbedTargetKind.Article, null, null);

    private sealed class AfterReadPackageReader(
        IRevisionComparePackageReader inner,
        Func<RevisionComparePackageReadResult, Task> afterRead) : IRevisionComparePackageReader
    {
        public async Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(
            RevisionCompareReadContext context, int articleId, RevisionCompareSourceSelector selector,
            CancellationToken cancellationToken = default)
        {
            RevisionComparePackageReadResult result = await inner.ReadAuthorizedAsync(context, articleId, selector, cancellationToken);
            Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
            await afterRead(result);
            return result;
        }
    }
}
