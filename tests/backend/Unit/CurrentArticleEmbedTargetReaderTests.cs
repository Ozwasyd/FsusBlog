using System.Text;

using Npgsql;

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
        (int article, long revision, RevisionCompareReadContext context) = await SeedRowsAsync(db);
        await db.Ado.BeginTranAsync();
        ArticleRelationArticleCoordinate binding = await _coordinates.ProvisionImportedArticleAsync(
            db, article, "article:44bc896e-4d27-4900-a814-c7a7d5de45bc");
        await db.Ado.CommitTranAsync();
        await db.Ado.BeginTranAsync();
        await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
        try
        {
            Assert.Equal(revision, await db.Queryable<Article>().Where(row => row.Id == article)
                .Select(row => row.CurrentRevisionId).FirstAsync());
            Assert.Null(await Reader(db).ReadAsync(context,
                new ArticleEmbedTargetIdentity(binding.ArticleIdentity, ArticleEmbedTargetKind.Article, null, null)));
            Assert.Equal(1, await db.Queryable<ArticleRelationArticleBinding>().CountAsync());
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
        CurrentArticleEmbedTargetSource? returned = null;
        PostgresException refused = await Assert.ThrowsAsync<PostgresException>(async () =>
        {
            returned = await reader.ReadAsync(context, Target(saved));
        });
        Assert.Equal("23514", refused.SqlState);
        Assert.Equal("article_relation_coordinate_immutable", refused.MessageText);
        Assert.Null(returned);
        Assert.Equal(saved, await _coordinates.ReadRevisionAsync(db, saved.ArticleId, saved.RevisionId));
        Assert.Equal(1, await db.Queryable<ArticleRelationSourceCoordinate>().CountAsync());
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

    [Theory]
    [InlineData("REPEATABLE READ", "permission")]
    [InlineData("REPEATABLE READ", "pointer")]
    [InlineData("REPEATABLE READ", "delete")]
    [InlineData("SERIALIZABLE", "permission")]
    [InlineData("SERIALIZABLE", "pointer")]
    [InlineData("SERIALIZABLE", "delete")]
    public async Task RetainedSnapshotAfterCommittedChangeIsRefused(string isolation, string change)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        using SqlSugarClient committer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await db.Ado.BeginTranAsync();
        Assert.Contains(isolation, new[] { "REPEATABLE READ", "SERIALIZABLE" });
        await db.Ado.ExecuteCommandAsync("SET TRANSACTION ISOLATION LEVEL " + isolation + ", READ ONLY;");
        NpgsqlTransaction caller = Assert.IsType<NpgsqlTransaction>(db.Ado.Transaction);
        var lifecycle = new AuthoringDraftLifecycleService(db, null!, null!, null!);
        var admission = new AuthoringRevisionCompareAuthority(db, lifecycle);
        try
        {
            Assert.Equal(saved.RevisionId, (await admission.GetAuthorizedArticleAsync(context, saved.ArticleId, default))!.CurrentRevisionId);
            await CommitExternalChangeAsync(committer, saved, context, change);
            Assert.NotEqual(((NpgsqlConnection)db.Ado.Connection).ProcessID, _lastCommitterPid);
            // Establish the retained snapshot with the real unchanged authority, after B has committed.
            Assert.Equal(saved.RevisionId, (await admission.GetAuthorizedArticleAsync(context, saved.ArticleId, default))!.CurrentRevisionId);
            Assert.Null(await Reader(db).ReadAsync(context, Target(saved)));
            Assert.Same(caller, db.Ado.Transaction);
            Assert.Same(db.Ado.Connection, caller.Connection);
            Assert.Equal(1, await db.Ado.SqlQuerySingleAsync<int>("SELECT 1;"));
        }
        finally
        {
            await db.Ado.RollbackTranAsync();
        }
    }

    [Theory]
    [InlineData(false, "permission")]
    [InlineData(false, "pointer")]
    [InlineData(false, "delete")]
    [InlineData(true, "permission")]
    [InlineData(true, "pointer")]
    [InlineData(true, "delete")]
    public async Task CommittedChangeDuringReadRefusesSourceWithFreshStatements(bool callerTransaction, string change)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        using SqlSugarClient committer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        NpgsqlTransaction? caller = null;
        if (callerTransaction)
        {
            await db.Ado.BeginTranAsync();
            await db.Ado.ExecuteCommandAsync("SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY;");
            caller = Assert.IsType<NpgsqlTransaction>(db.Ado.Transaction);
        }
        bool committed = false;
        var reader = Reader(db, async _ =>
        {
            int readerPid = await db.Ado.SqlQuerySingleAsync<int>("SELECT pg_backend_pid();");
            await CommitExternalChangeAsync(committer, saved, context, change);
            Assert.NotEqual(readerPid, _lastCommitterPid);
            committed = true;
        });
        try
        {
            Assert.Null(await reader.ReadAsync(context, Target(saved)));
            Assert.True(committed);
            Assert.Same(caller, db.Ado.Transaction);
            if (caller is not null)
            {
                Assert.Same(db.Ado.Connection, caller.Connection);
                Assert.Equal(1, await db.Ado.SqlQuerySingleAsync<int>("SELECT 1;"));
            }
        }
        finally
        {
            if (caller is not null)
            {
                await db.Ado.RollbackTranAsync();
            }
        }
    }

    [Fact]
    public async Task CallerTransactionReplacementDuringReadIsRefusedWithoutEndingIt()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        NpgsqlTransaction? replacement = null;
        var reader = Reader(db, async _ =>
        {
            await db.Ado.BeginTranAsync();
            await db.Ado.ExecuteCommandAsync("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;");
            replacement = Assert.IsType<NpgsqlTransaction>(db.Ado.Transaction);
        });
        try
        {
            Assert.Null(await reader.ReadAsync(context, Target(saved)));
            Assert.NotNull(replacement);
            Assert.Same(replacement, db.Ado.Transaction);
            Assert.Same(db.Ado.Connection, replacement.Connection);
            Assert.Equal(1, await db.Ado.SqlQuerySingleAsync<int>("SELECT 1;"));
        }
        finally
        {
            if (replacement is not null)
            {
                await db.Ado.RollbackTranAsync();
            }
        }
    }

    [Fact]
    public async Task ActiveAmbientTransactionIsRefusedWithoutChangingCallerContext()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        using var ambient = new System.Transactions.TransactionScope(
            System.Transactions.TransactionScopeOption.Required,
            System.Transactions.TransactionScopeAsyncFlowOption.Enabled);
        System.Transactions.Transaction? caller = System.Transactions.Transaction.Current;
        Assert.NotNull(caller);
        Assert.Null(await Reader(db).ReadAsync(context, Target(saved)));
        Assert.Same(caller, System.Transactions.Transaction.Current);
        Assert.Null(db.Ado.Transaction);
        ambient.Complete();
    }

    [Fact]
    public async Task SuppressedAmbientRetainedSnapshotIsRefusedByActualServerIsolation()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleRelationRevisionCoordinate saved, RevisionCompareReadContext context) = await SeedAsync(db);
        using SqlSugarClient committer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        db.CurrentConnectionConfig.IsAutoCloseConnection = false;
        using var ambient = new System.Transactions.TransactionScope(
            System.Transactions.TransactionScopeOption.Required,
            new System.Transactions.TransactionOptions { IsolationLevel = System.Transactions.IsolationLevel.RepeatableRead },
            System.Transactions.TransactionScopeAsyncFlowOption.Enabled);
        db.Ado.Open();
        await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
        var admission = new AuthoringRevisionCompareAuthority(db, new AuthoringDraftLifecycleService(db, null!, null!, null!));
        Assert.Equal(saved.RevisionId, (await admission.GetAuthorizedArticleAsync(context, saved.ArticleId, default))!.CurrentRevisionId);
        using (var suppression = new System.Transactions.TransactionScope(
            System.Transactions.TransactionScopeOption.Suppress,
            System.Transactions.TransactionScopeAsyncFlowOption.Enabled))
        {
            await CommitExternalChangeAsync(committer, saved, context, "permission");
            Assert.Null(System.Transactions.Transaction.Current);
            Assert.Null(db.Ado.Transaction);
            Assert.Equal("repeatable read", await db.Ado.SqlQuerySingleAsync<string>("SHOW transaction_isolation;"));
            Assert.Equal(saved.RevisionId, (await admission.GetAuthorizedArticleAsync(context, saved.ArticleId, default))!.CurrentRevisionId);
            Assert.Null(await Reader(db).ReadAsync(context, Target(saved)));
            Assert.Equal(1, await db.Ado.SqlQuerySingleAsync<int>("SELECT 1;"));
            suppression.Complete();
        }
        Assert.NotNull(System.Transactions.Transaction.Current);
        ambient.Complete();
    }

    private int _lastCommitterPid;

    private async Task CommitExternalChangeAsync(SqlSugarClient committer, ArticleRelationRevisionCoordinate saved,
        RevisionCompareReadContext context, string change)
    {
        await committer.Ado.BeginTranAsync();
        _lastCommitterPid = ((NpgsqlConnection)committer.Ado.Connection).ProcessID;
        switch (change)
        {
            case "permission":
                await committer.Updateable<AdminPrincipal>().SetColumns(row => new AdminPrincipal { Permissions = "" })
                    .Where(row => row.Id == context.AdminPrincipalId).ExecuteCommandAsync();
                break;
            case "pointer":
                await committer.Updateable<Article>().SetColumns(row => new Article { CurrentRevisionId = null })
                    .Where(row => row.Id == saved.ArticleId).ExecuteCommandAsync();
                break;
            case "delete":
                await committer.Updateable<Article>().SetColumns(row => new Article { IsDeleted = true })
                    .Where(row => row.Id == saved.ArticleId).ExecuteCommandAsync();
                break;
            default:
                throw new InvalidOperationException("unknown fixture change");
        }
        await committer.Ado.CommitTranAsync();
        if (change == "permission")
        {
            Assert.Equal("", await committer.Queryable<AdminPrincipal>().Where(row => row.Id == context.AdminPrincipalId)
                .Select(row => row.Permissions).FirstAsync());
        }
        else if (change == "pointer")
        {
            Assert.Null(await committer.Queryable<Article>().Where(row => row.Id == saved.ArticleId)
                .Select(row => row.CurrentRevisionId).FirstAsync());
        }
        else
        {
            Assert.True(await committer.Queryable<Article>().Where(row => row.Id == saved.ArticleId)
                .Select(row => row.IsDeleted).FirstAsync());
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
        (int article, long revision, RevisionCompareReadContext context) = await SeedRowsAsync(db, handle);
        await db.Ado.BeginTranAsync();
        ArticleRelationRevisionCoordinate coordinate = await _coordinates.ProvisionRevisionAsync(db, article, revision);
        await db.Ado.CommitTranAsync();
        return (coordinate, context);
    }

    private static async Task<(int Article, long Revision, RevisionCompareReadContext Context)> SeedRowsAsync(
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
        return (article, revision, new(principal, AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope, Guid.NewGuid()));
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
