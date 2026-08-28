using System.Reflection;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Core.Services.Implementations;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleRevisionConcurrencyTests(
    PostgresSchemaMigrationFixture fixture,
    ArticleRevisionConcurrencyDatabaseFixture classDatabase)
    : IClassFixture<ArticleRevisionConcurrencyDatabaseFixture>, IAsyncLifetime
{
    private static readonly MethodInfo s_saveRevisionMethod = typeof(ArticleService)
        .GetMethod("SaveArticleRevisionAsync", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("SaveArticleRevisionAsync should exist.");

    [Fact]
    public async Task CreateAsync_ResponseLossRetryReturnsOriginalResultWithoutDuplicateWrites()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(classDatabase.ConnectionString);
        CreateTables(db);
        await SeedTaxonomyAsync(db);
        IArticleMutationCommandService commands = CreateService(db);
        string mutationId = Guid.NewGuid().ToString("D");
        var request = CreateDraftRequest("retry-safe");

        Result<ArticleMutationResult> first = await commands.CreateAsync(17, mutationId, new string('A', 64), request);
        Result<ArticleMutationResult> retry = await commands.CreateAsync(17, mutationId, new string('A', 64), request);

        Assert.True(first.IsSuccess, first.Error.Message);
        Assert.True(retry.IsSuccess, retry.Error.Message);
        Assert.False(first.Value.IdempotencyReplay);
        Assert.True(retry.Value.IdempotencyReplay);
        Assert.Equal(first.Value.ArticleId, retry.Value.ArticleId);
        Assert.Equal(first.Value.RevisionId, retry.Value.RevisionId);
        Assert.Equal(1, await db.Queryable<Article>().CountAsync());
        Assert.Equal(1, await db.Queryable<ArticleMutationCommand>().CountAsync());
        Assert.Equal(1, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
    }

    [Fact]
    public async Task CreateAsync_SameIdentityDifferentBodyReturnsConflictWithoutSecondArticle()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(classDatabase.ConnectionString);
        CreateTables(db);
        await SeedTaxonomyAsync(db);
        IArticleMutationCommandService commands = CreateService(db);
        string mutationId = Guid.NewGuid().ToString("D");

        Result<ArticleMutationResult> first = await commands.CreateAsync(19, mutationId, new string('A', 64), CreateDraftRequest("first"));
        Result<ArticleMutationResult> conflict = await commands.CreateAsync(19, mutationId, new string('B', 64), CreateDraftRequest("changed"));

        Assert.True(first.IsSuccess, first.Error.Message);
        Assert.False(conflict.IsSuccess);
        Assert.Equal(ErrorCode.Conflict, conflict.Error.Code);
        Assert.Equal("article_mutation_content_conflict", conflict.Error.Message);
        Assert.Equal(1, await db.Queryable<Article>().CountAsync());
        Assert.Equal(1, await db.Queryable<ArticleMutationCommand>().CountAsync());
    }

    [Fact]
    public async Task CreateAsync_ConcurrentDoubleClickCommitsOneArticleAndReplaysWinner()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedTaxonomyAsync(setupDb);
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        IArticleMutationCommandService first = CreateService(firstDb);
        IArticleMutationCommandService second = CreateService(secondDb);
        string mutationId = Guid.NewGuid().ToString("D");
        var request = CreateDraftRequest("double-click");
        using var barrier = new Barrier(2);

        Result<ArticleMutationResult>[] results = await Task.WhenAll(
            StartBarrierTaskAsync(barrier, () => first.CreateAsync(23, mutationId, new string('C', 64), request)),
            StartBarrierTaskAsync(barrier, () => second.CreateAsync(23, mutationId, new string('C', 64), request)));

        Assert.All(results, result => Assert.True(result.IsSuccess, result.Error.Message));
        Assert.Single(results, result => result.Value.IdempotencyReplay);
        Assert.Single(results, result => !result.Value.IdempotencyReplay);
        Assert.Equal(results[0].Value.ArticleId, results[1].Value.ArticleId);
        Assert.Equal(1, await setupDb.Queryable<Article>().CountAsync());
        Assert.Equal(1, await setupDb.Queryable<ArticleMutationCommand>().CountAsync());
        Assert.Equal(1, await setupDb.Queryable<ArticleMutationOutboxEvent>().CountAsync());
    }

    [Fact]
    public async Task UpdateAsync_ExactRequestReturnsNoChangeWithoutRevisionPublicationOrEvent()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(classDatabase.ConnectionString);
        CreateTables(db);
        await SeedTaxonomyAsync(db);
        IArticleMutationCommandService commands = CreateService(db);
        ArticleWriteRequestCoreModel initial = CreateDraftRequest("fixed");
        Result<ArticleMutationResult> created = await commands.CreateAsync(
            31,
            Guid.NewGuid().ToString("D"),
            new string('D', 64),
            initial);
        Assert.True(created.IsSuccess, created.Error.Message);
        int revisionCount = await db.Queryable<ArticleRevision>().CountAsync();
        int publicationCount = await db.Queryable<ArticlePublicationRecord>().CountAsync();
        int outboxCount = await db.Queryable<ArticleMutationOutboxEvent>().CountAsync();

        Result<ArticleMutationResult> repeated = await commands.UpdateAsync(
            created.Value.ArticleId,
            initial with
            {
                BaseRevisionId = created.Value.RevisionId
            });

        Assert.True(repeated.IsSuccess, repeated.Error.Message);
        Assert.Equal(ArticleMutationOutcome.NoChange, repeated.Value.Outcome);
        Assert.Equal(created.Value.RevisionId, repeated.Value.RevisionId);
        Assert.Equal(created.Value.ReleaseId, repeated.Value.ReleaseId);
        Assert.Equal(revisionCount, await db.Queryable<ArticleRevision>().CountAsync());
        Assert.Equal(publicationCount, await db.Queryable<ArticlePublicationRecord>().CountAsync());
        Assert.Equal(outboxCount, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
    }

    [Fact]
    public async Task UpdateAsync_MetadataAndCopyrightOnlyReuseBodyBlockWhileBodyChangeAllocatesOne()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(classDatabase.ConnectionString);
        CreateTables(db);
        await SeedTaxonomyAsync(db);
        IArticleMutationCommandService commands = CreateService(db);
        ArticleWriteRequestCoreModel initial = CreateDraftRequest("storage");
        Result<ArticleMutationResult> created = await commands.CreateAsync(
            37,
            Guid.NewGuid().ToString("D"),
            new string('E', 64),
            initial);
        Assert.True(created.IsSuccess, created.Error.Message);
        long initialBlockId = (await db.Queryable<ArticleRevision>().InSingleAsync(created.Value.RevisionId)).ContentBlockId;

        Result<ArticleMutationResult> metadataOnly = await commands.UpdateAsync(
            created.Value.ArticleId,
            initial with
            {
                Title = "Metadata only",
                BaseRevisionId = created.Value.RevisionId
            });
        Assert.True(metadataOnly.IsSuccess, metadataOnly.Error.Message);
        Assert.Equal(ArticleMutationOutcome.Applied, metadataOnly.Value.Outcome);
        Assert.Equal(
            initialBlockId,
            (await db.Queryable<ArticleRevision>().InSingleAsync(metadataOnly.Value.RevisionId)).ContentBlockId);
        Assert.Equal(1, await db.Queryable<ArticleRevisionContentBlock>().CountAsync());

        var copyright = new ArticleRightsRequestCoreModel(
            true,
            "all-rights-reserved",
            "Fixed Owner",
            2026,
            null,
            null,
            "append-attribution",
            300,
            true,
            true,
            true);
        Result<ArticleMutationResult> copyrightOnly = await commands.UpdateAsync(
            created.Value.ArticleId,
            initial with
            {
                Title = "Metadata only",
                Rights = copyright,
                RightsMutation = ArticleRightsMutationMode.Replace,
                BaseRevisionId = metadataOnly.Value.RevisionId
            });
        Assert.True(copyrightOnly.IsSuccess, copyrightOnly.Error.Message);
        Assert.Equal(
            initialBlockId,
            (await db.Queryable<ArticleRevision>().InSingleAsync(copyrightOnly.Value.RevisionId)).ContentBlockId);
        Assert.Equal(1, await db.Queryable<ArticleRevisionContentBlock>().CountAsync());

        Result<ArticleMutationResult> bodyChanged = await commands.UpdateAsync(
            created.Value.ArticleId,
            initial with
            {
                Title = "Metadata only",
                Content = "# A different fixed body",
                Rights = copyright,
                RightsMutation = ArticleRightsMutationMode.Replace,
                BaseRevisionId = copyrightOnly.Value.RevisionId
            });
        Assert.True(bodyChanged.IsSuccess, bodyChanged.Error.Message);
        Assert.NotEqual(
            initialBlockId,
            (await db.Queryable<ArticleRevision>().InSingleAsync(bodyChanged.Value.RevisionId)).ContentBlockId);
        Assert.Equal(2, await db.Queryable<ArticleRevisionContentBlock>().CountAsync());
        Assert.Equal(4, await db.Queryable<ArticleRevision>().CountAsync());
    }

    [Fact]
    public async Task ContentBlockReachabilityAndCleanupDeleteOnlyUnreferencedBlocks()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(classDatabase.ConnectionString);
        CreateTables(db);
        long reachable = await ArticleRevisionContentBlockStore.GetOrCreateAsync(
            db,
            "# reachable",
            DateTime.UtcNow.AddHours(-2),
            CancellationToken.None);
        _ = await db.Insertable(new ArticleRevision
        {
            ArticleId = 91,
            RevisionNo = 1,
            Title = "Reachable",
            CategoryId = 1,
            ContentBlockId = reachable,
            DiffSummary = "seed",
            CreatedByAdminPrincipalId = 1
        }).ExecuteReturnBigIdentityAsync();
        _ = await ArticleRevisionContentBlockStore.GetOrCreateAsync(
            db,
            "# orphan",
            DateTime.UtcNow.AddHours(-2),
            CancellationToken.None);

        ArticleRevisionContentReachability before = await ArticleRevisionContentBlockStore.CheckReachabilityAsync(db);
        int deleted = await ArticleRevisionContentBlockStore.DeleteUnreferencedAsync(db, DateTime.UtcNow.AddHours(-1));
        ArticleRevisionContentReachability after = await ArticleRevisionContentBlockStore.CheckReachabilityAsync(db);

        Assert.Equal(1, before.RevisionCount);
        Assert.Equal(2, before.ContentBlockCount);
        Assert.Equal(1, before.OrphanContentBlockCount);
        Assert.Equal(0, before.MissingReferenceCount);
        Assert.Equal(1, deleted);
        Assert.Equal(1, after.ContentBlockCount);
        Assert.Equal(0, after.OrphanContentBlockCount);
    }

    [Fact]
    public async Task UpdateAsync_TwoConnectionsWithSameBaseRevision_OnlyFirstWriterCommits()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedTaxonomyAsync(setupDb);
        int articleId = await SeedArticleAsync(setupDb);
        await SeedBodyAsync(setupDb, articleId, "# original");
        await SeedTagsAsync(setupDb, articleId, [1]);
        await SeedRevisionAsync(setupDb, articleId, revisionNo: 1);
        ArticleRevision seededRevision = await setupDb.Queryable<ArticleRevision>()
            .Where(revision => revision.ArticleId == articleId)
            .FirstAsync();
        await setupDb.Updateable<Article>()
            .SetColumns(article => article.CurrentRevisionId == seededRevision.Id)
            .Where(article => article.Id == articleId)
            .ExecuteCommandAsync();
        Article original = await setupDb.Queryable<Article>().InSingleAsync(articleId);
        Assert.NotNull(original.CurrentRevisionId);

        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        var first = new ArticleCoreService(CreateService(firstDb));
        var second = new ArticleCoreService(CreateService(secondDb));
        ArticleWriteRequestCoreModel Write(string title, string content, int categoryId, int[] tags) => new(
            title,
            content,
            "edited",
            null,
            categoryId,
            tags,
            (int)ArticleStatus.Draft,
            Rights: new ArticleRightsRequestCoreModel(
                true,
                "all-rights-reserved",
                null,
                null,
                null,
                null,
                "append-attribution",
                300,
                true,
                true,
                true),
            BaseRevisionId: original.CurrentRevisionId);

        Result firstResult = await first.UpdateAsync(new UpdateArticleCommand(
            articleId,
            Write("First tab", "# first", 2, [2])));
        Assert.True(firstResult.IsSuccess, $"{firstResult.Error.Code}:{firstResult.Error.Message}:{firstResult.Error.Details}");
        int revisionCountAfterFirst = await setupDb.Queryable<ArticleRevision>().CountAsync(item => item.ArticleId == articleId);
        int rightsCountAfterFirst = await setupDb.Queryable<ArticleRightsSnapshot>().CountAsync(item => item.ArticleId == articleId);
        int outboxCountAfterFirst = await setupDb.Queryable<ArticleMutationOutboxEvent>().CountAsync(item => item.AggregateId == articleId);
        Result staleRetry = await second.UpdateAsync(new UpdateArticleCommand(
            articleId,
            Write("Delayed autosave retry", "# stale", 1, [1])));

        Assert.False(staleRetry.IsSuccess);
        Assert.Equal(ErrorCode.Conflict, staleRetry.Error.Code);
        Assert.Equal("article_revision_conflict", staleRetry.Error.Message);
        Assert.Contains("\"currentRevisionId\"", staleRetry.Error.Details, StringComparison.Ordinal);

        Article persisted = await setupDb.Queryable<Article>().InSingleAsync(articleId);
        ArticleBody body = await setupDb.Queryable<ArticleBody>().InSingleAsync(articleId);
        List<int> tags = await setupDb.Queryable<ArticleTag>()
            .Where(tag => tag.ArticleId == articleId)
            .Select(tag => tag.TagId)
            .ToListAsync();
        Assert.Equal("First tab", persisted.Title);
        Assert.Equal(2, persisted.CategoryId);
        Assert.Equal("# first", body.MarkdownContent);
        Assert.Equal([2], tags);
        Assert.Equal(revisionCountAfterFirst, await setupDb.Queryable<ArticleRevision>().CountAsync(item => item.ArticleId == articleId));
        Assert.Equal(rightsCountAfterFirst, await setupDb.Queryable<ArticleRightsSnapshot>().CountAsync(item => item.ArticleId == articleId));
        Assert.Equal(outboxCountAfterFirst, await setupDb.Queryable<ArticleMutationOutboxEvent>().CountAsync(item => item.AggregateId == articleId));
    }

    [Fact]
    public async Task SaveArticleRevisionAsync_ConcurrentWritersProduceOnlyOneNextRevisionNumber()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        int articleId = await SeedArticleAsync(setupDb);
        await SeedRevisionAsync(setupDb, articleId, revisionNo: 1);

        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService firstService = CreateService(firstDb);
        ArticleService secondService = CreateService(secondDb);
        using var barrier = new Barrier(2);

        await Task.WhenAll(
                StartBarrierTaskAsync(barrier, () => SaveRevisionInTransactionAsync(firstDb, firstService, articleId, "first concurrent update")),
                StartBarrierTaskAsync(barrier, () => SaveRevisionInTransactionAsync(secondDb, secondService, articleId, "second concurrent update")))
            .WaitAsync(TimeSpan.FromSeconds(30));

        List<int> revisionNumbers = await setupDb.Queryable<ArticleRevision>()
            .Where(revision => revision.ArticleId == articleId)
            .OrderBy(revision => revision.RevisionNo)
            .Select(revision => revision.RevisionNo)
            .ToListAsync();

        Assert.Equal([1, 2, 3], revisionNumbers);
        Assert.Equal(1, revisionNumbers.Count(static revisionNo => revisionNo == 2));
    }

    [Fact]
    public async Task SaveArticleRevisionAsync_DifferentArticlesDoNotWaitAndRollbackReusesNumber()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        int firstArticleId = await SeedArticleAsync(setupDb);
        int secondArticleId = await SeedArticleAsync(setupDb);
        await SeedRevisionAsync(setupDb, firstArticleId, revisionNo: 1);
        await SeedRevisionAsync(setupDb, secondArticleId, revisionNo: 1);

        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService firstService = CreateService(firstDb);
        ArticleService secondService = CreateService(secondDb);
        await firstDb.Ado.BeginTranAsync();
        bool rolledBack = false;
        try
        {
            await InvokeSaveRevisionAsync(firstService, firstArticleId, "rolled back update");

            Task secondArticleWrite = SaveRevisionInTransactionAsync(
                secondDb,
                secondService,
                secondArticleId,
                "parallel article update");
            await secondArticleWrite.WaitAsync(TimeSpan.FromSeconds(5));

            firstDb.Ado.RollbackTran();
            rolledBack = true;
        }
        finally
        {
            if (!rolledBack)
            {
                firstDb.Ado.RollbackTran();
            }
        }

        await SaveRevisionInTransactionAsync(
            firstDb,
            firstService,
            firstArticleId,
            "replacement after rollback");

        int[] firstRevisionNumbers = await LoadRevisionNumbersAsync(setupDb, firstArticleId);
        int[] secondRevisionNumbers = await LoadRevisionNumbersAsync(setupDb, secondArticleId);
        Assert.Equal([1, 2], firstRevisionNumbers);
        Assert.Equal([1, 2], secondRevisionNumbers);
    }

    [Fact]
    public async Task SaveArticleRevisionAsync_LegacyUniqueConflictRetriesInUsableTransaction()
    {
        const long RetryGateLock = 12_201_220;
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        int articleId = await SeedArticleAsync(setupDb);
        await SeedRevisionAsync(setupDb, articleId, revisionNo: 1);
        await setupDb.Ado.ExecuteCommandAsync(
            $$"""
            CREATE OR REPLACE FUNCTION fsus_test_gate_revision_retry()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $body$
            BEGIN
                IF NEW.article_id = {{articleId}}
                   AND NEW.revision_no = 2
                   AND NEW.diff_summary = 'bounded retry' THEN
                    PERFORM pg_advisory_xact_lock({{RetryGateLock}});
                END IF;
                RETURN NEW;
            END;
            $body$;

            DROP TRIGGER IF EXISTS trg_fsus_test_gate_revision_retry ON article_revision;
            CREATE TRIGGER trg_fsus_test_gate_revision_retry
            BEFORE INSERT ON article_revision
            FOR EACH ROW EXECUTE FUNCTION fsus_test_gate_revision_retry();
            """);

        await using var blocker = new Npgsql.NpgsqlConnection(connectionString);
        await blocker.OpenAsync();
        await using (var acquire = new Npgsql.NpgsqlCommand(
            $"SELECT pg_advisory_lock({RetryGateLock});",
            blocker))
        {
            await acquire.ExecuteNonQueryAsync();
        }

        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient legacyDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb);
        Task writer = SaveRevisionInTransactionAsync(
            serviceDb,
            service,
            articleId,
            "bounded retry");
        try
        {
            await Task.Delay(TimeSpan.FromMilliseconds(300));
            Assert.False(writer.IsCompleted);
            await SeedRevisionAsync(legacyDb, articleId, revisionNo: 2);
        }
        finally
        {
            await using var release = new Npgsql.NpgsqlCommand(
                $"SELECT pg_advisory_unlock({RetryGateLock});",
                blocker);
            _ = await release.ExecuteScalarAsync();
        }
        await writer.WaitAsync(TimeSpan.FromSeconds(10));

        int[] revisionNumbers = await LoadRevisionNumbersAsync(setupDb, articleId);
        Assert.Equal([1, 2, 3], revisionNumbers);
    }

    [Fact]
    public async Task SaveArticleRevisionAsync_DeletedArticleDoesNotAllocateRevisionNumber()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(db);
        int articleId = await SeedArticleAsync(db, isDeleted: true);
        ArticleService service = CreateService(db);

        await SaveRevisionInTransactionAsync(db, service, articleId, "deleted article update", expectSuccess: false);

        int revisionCount = await db.Queryable<ArticleRevision>()
            .CountAsync(revision => revision.ArticleId == articleId);
        Assert.Equal(0, revisionCount);
    }

    [Fact]
    public async Task UpdateAsync_ConcurrentRowVersionMismatchDoesNotRewriteArticleOrTags()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedTaxonomyAsync(setupDb);
        int articleId = await SeedArticleAsync(setupDb);
        await SeedBodyAsync(setupDb, articleId, "# original");
        await SeedTagsAsync(setupDb, articleId, [1, 2]);
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb);

        await using var holder = new Npgsql.NpgsqlConnection(connectionString);
        await holder.OpenAsync();
        await using Npgsql.NpgsqlTransaction concurrentChange = await holder.BeginTransactionAsync();
        await using (var updateCommand = new Npgsql.NpgsqlCommand(
            "UPDATE article SET views = views + 1 WHERE id = @ArticleId;",
            holder,
            concurrentChange))
        {
            updateCommand.Parameters.AddWithValue("@ArticleId", articleId);
            Assert.Equal(1, await updateCommand.ExecuteNonQueryAsync());
        }

        Task<bool> updateTask = ((IArticleCoreGateway)service).UpdateAsync(new UpdateArticleCommand(
            articleId,
            new ArticleWriteRequestCoreModel(
                "Concurrent overwrite", "# changed", "changed", null, 2, [3, 4], (int)ArticleStatus.Published),
            Force: true));
        await Task.Delay(TimeSpan.FromMilliseconds(300));
        Assert.False(updateTask.IsCompleted);

        await concurrentChange.CommitAsync();
        bool updated = false;
        Exception? failure = await Record.ExceptionAsync(async () =>
        {
            updated = await updateTask.WaitAsync(TimeSpan.FromSeconds(10));
        });

        Article article = await setupDb.Queryable<Article>().InSingleAsync(articleId);
        ArticleBody body = await setupDb.Queryable<ArticleBody>().InSingleAsync(articleId);
        List<int> tagIds = await setupDb.Queryable<ArticleTag>()
            .Where(tag => tag.ArticleId == articleId)
            .OrderBy(tag => tag.TagId)
            .Select(tag => tag.TagId)
            .ToListAsync();

        // Stale writers either lose the optimistic CAS (false) or surface a revision conflict.
        Assert.True(
            failure is ArticleRevisionConflictException
                || failure?.InnerException is ArticleRevisionConflictException
                || (failure is null && !updated));

        Assert.Equal("Title", article.Title);
        Assert.Equal(1, article.CategoryId);
        Assert.Equal("# original", body.MarkdownContent);
        Assert.Equal([1, 2], tagIds);
    }

    [Fact]
    public async Task UpdateAsync_SuccessfulUpdateRewritesTagSetWithAtomicUpsert()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedTaxonomyAsync(setupDb);
        int articleId = await SeedArticleAsync(setupDb);
        await SeedBodyAsync(setupDb, articleId, "# original");
        await SeedTagsAsync(setupDb, articleId, [1, 2]);
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb);

        bool updated = await ((IArticleCoreGateway)service).UpdateAsync(new UpdateArticleCommand(
            articleId,
            new ArticleWriteRequestCoreModel(
                "Updated", "# changed", "changed", null, 2, [2, 3, 3], (int)ArticleStatus.Published),
            Force: true));

        Article article = await setupDb.Queryable<Article>().InSingleAsync(articleId);
        ArticleBody body = await setupDb.Queryable<ArticleBody>().InSingleAsync(articleId);
        List<int> tagIds = await setupDb.Queryable<ArticleTag>()
            .Where(tag => tag.ArticleId == articleId)
            .OrderBy(tag => tag.TagId)
            .Select(tag => tag.TagId)
            .ToListAsync();

        Assert.True(updated);
        Assert.Equal("Updated", article.Title);
        Assert.Equal(2, article.CategoryId);
        Assert.Equal("# changed", body.MarkdownContent);
        Assert.Equal([2, 3], tagIds);
    }

    [Fact]
    public async Task UpdateAsync_PublicArticleEstablishesFenceBeforeDatabaseMutation()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedTaxonomyAsync(setupDb);
        int articleId = await SeedArticleAsync(setupDb);
        await SeedBodyAsync(setupDb, articleId, "# before fence");
        var mutationFence = Substitute.For<IArticlePublicMutationFence>();
        mutationFence
            .BeginPublicMutationFenceAsync(articleId, Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                Article beforeCommit = await setupDb.Queryable<Article>().InSingleAsync(articleId);
                ArticleBody bodyBeforeCommit = await setupDb.Queryable<ArticleBody>().InSingleAsync(articleId);
                Assert.Equal("Title", beforeCommit.Title);
                Assert.Equal("# before fence", bodyBeforeCommit.MarkdownContent);
            });
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb, mutationFence);

        bool updated = await ((IArticleCoreGateway)service).UpdateAsync(new UpdateArticleCommand(
            articleId,
            new ArticleWriteRequestCoreModel(
                "After fence", "# after fence", "changed", null, 1, [], (int)ArticleStatus.Published),
            Force: true));

        Assert.True(updated);
        Assert.Equal("After fence", (await setupDb.Queryable<Article>().InSingleAsync(articleId)).Title);
        await mutationFence.Received(1)
            .BeginPublicMutationFenceAsync(articleId, Arg.Any<CancellationToken>());
        await mutationFence.DidNotReceive()
            .RecoverAbortedPublicMutationFenceAsync(
                articleId,
                Arg.Any<string>(),
                Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task UpdateAsync_WhenFenceFails_DoesNotChangePublishedArticle()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedTaxonomyAsync(setupDb);
        int articleId = await SeedArticleAsync(setupDb);
        await SeedBodyAsync(setupDb, articleId, "# unchanged");
        var mutationFence = Substitute.For<IArticlePublicMutationFence>();
        mutationFence
            .BeginPublicMutationFenceAsync(articleId, Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new InvalidOperationException("durable tombstone unavailable")));
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb, mutationFence);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            ((IArticleCoreGateway)service).UpdateAsync(new UpdateArticleCommand(
                articleId,
                new ArticleWriteRequestCoreModel(
                    "must not commit", "# must not commit", "changed", null, 1, [], (int)ArticleStatus.Published),
                Force: true)));

        Assert.Equal("durable tombstone unavailable", error.Message);
        Assert.Equal("Title", (await setupDb.Queryable<Article>().InSingleAsync(articleId)).Title);
        Assert.Equal("# unchanged", (await setupDb.Queryable<ArticleBody>().InSingleAsync(articleId)).MarkdownContent);
        Assert.Empty(await setupDb.Queryable<ArticleMutationOutboxEvent>().ToListAsync());
        await mutationFence.DidNotReceive()
            .RecoverAbortedPublicMutationFenceAsync(
                articleId,
                Arg.Any<string>(),
                Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task UpdateAsync_RowVersionLossAfterFence_QueuesRebuildBeforeReturningFalse()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedTaxonomyAsync(setupDb);
        int articleId = await SeedArticleAsync(setupDb);
        await SeedBodyAsync(setupDb, articleId, "# unchanged");
        var mutationFence = Substitute.For<IArticlePublicMutationFence>();
        mutationFence
            .BeginPublicMutationFenceAsync(articleId, Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                await setupDb.Ado.ExecuteCommandAsync(
                    "UPDATE article SET views = views + 1 WHERE id = @ArticleId;",
                    new SugarParameter("@ArticleId", articleId));
            });
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb, mutationFence);

        bool updated = false;
        Exception? failure = await Record.ExceptionAsync(async () =>
        {
            updated = await ((IArticleCoreGateway)service).UpdateAsync(new UpdateArticleCommand(
                articleId,
                new ArticleWriteRequestCoreModel(
                    "stale writer", "# stale writer", "changed", null, 1, [], (int)ArticleStatus.Published),
                Force: true));
        });

        Assert.True(
            failure is ArticleRevisionConflictException
                || failure?.InnerException is ArticleRevisionConflictException
                || (failure is null && !updated));

        Assert.Equal("Title", (await setupDb.Queryable<Article>().InSingleAsync(articleId)).Title);
        Assert.Equal("# unchanged", (await setupDb.Queryable<ArticleBody>().InSingleAsync(articleId)).MarkdownContent);
        await mutationFence.Received(1)
            .RecoverAbortedPublicMutationFenceAsync(
                articleId,
                "article-update-fence-aborted",
                CancellationToken.None);
    }

    [Fact]
    public async Task UpdateAsync_MetadataOnlyChangePreservesBodyUpdatedAtAndFirstPublishedAt()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedTaxonomyAsync(setupDb);
        DateTime firstPublishedAt = new(2026, 6, 1, 8, 0, 0, DateTimeKind.Utc);
        DateTime bodyUpdatedAt = new(2026, 6, 2, 9, 0, 0, DateTimeKind.Utc);
        int articleId = await SeedArticleAsync(setupDb, publishedAt: firstPublishedAt);
        await SeedBodyAsync(setupDb, articleId, "# unchanged", bodyUpdatedAt);
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb);

        bool updated = await ((IArticleCoreGateway)service).UpdateAsync(new UpdateArticleCommand(
            articleId,
            new ArticleWriteRequestCoreModel(
                "Metadata changed", "# unchanged", "new summary", null, 2, [3], (int)ArticleStatus.Published),
            Force: true));

        Article article = await setupDb.Queryable<Article>().InSingleAsync(articleId);
        ArticleBody body = await setupDb.Queryable<ArticleBody>().InSingleAsync(articleId);
        Assert.True(updated);
        Assert.Equal(bodyUpdatedAt, body.UpdatedAt);
        Assert.Equal(firstPublishedAt, article.PublishedAt);
    }

    [Fact]
    public async Task UpdateAsync_ContentChangeAdvancesBodyUpdatedAtButPreservesFirstPublishedAt()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedTaxonomyAsync(setupDb);
        DateTime firstPublishedAt = new(2026, 6, 1, 8, 0, 0, DateTimeKind.Utc);
        DateTime bodyUpdatedAt = new(2026, 6, 2, 9, 0, 0, DateTimeKind.Utc);
        int articleId = await SeedArticleAsync(setupDb, publishedAt: firstPublishedAt);
        await SeedBodyAsync(setupDb, articleId, "# original", bodyUpdatedAt);
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb);

        bool updated = await ((IArticleCoreGateway)service).UpdateAsync(new UpdateArticleCommand(
            articleId,
            new ArticleWriteRequestCoreModel(
                "Content changed", "# changed", "summary", null, 1, [], (int)ArticleStatus.Published),
            Force: true));

        Article article = await setupDb.Queryable<Article>().InSingleAsync(articleId);
        ArticleBody body = await setupDb.Queryable<ArticleBody>().InSingleAsync(articleId);
        Assert.True(updated);
        Assert.Equal("# changed", body.MarkdownContent);
        Assert.True(body.UpdatedAt > bodyUpdatedAt);
        Assert.Equal(firstPublishedAt, article.PublishedAt);
    }

    [Fact]
    public async Task UpdateAsync_MissingBodyCreatesBodyWithUpdatedAt()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedTaxonomyAsync(setupDb);
        int articleId = await SeedArticleAsync(setupDb);
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb);

        bool updated = await ((IArticleCoreGateway)service).UpdateAsync(new UpdateArticleCommand(
            articleId,
            new ArticleWriteRequestCoreModel(
                "Body created", "# created", "summary", null, 1, [], (int)ArticleStatus.Published),
            Force: true));

        ArticleBody body = await setupDb.Queryable<ArticleBody>().InSingleAsync(articleId);
        Assert.True(updated);
        Assert.Equal("# created", body.MarkdownContent);
        Assert.NotEqual(default, body.UpdatedAt);
    }

    private static async Task SaveRevisionInTransactionAsync(
        SqlSugarClient db,
        ArticleService service,
        int articleId,
        string diffSummary,
        bool expectSuccess = true)
    {
        var result = await db.Ado.UseTranAsync(async () =>
        {
            await InvokeSaveRevisionAsync(service, articleId, diffSummary);
            return true;
        });

        if (expectSuccess)
        {
            Assert.True(result.IsSuccess, result.ErrorMessage);
        }
        else
        {
            Assert.False(result.IsSuccess);
            Assert.Contains("Article revision was not created", result.ErrorMessage, StringComparison.Ordinal);
        }
    }

    public async Task InitializeAsync()
        => _ = await classDatabase.ResetAsync(fixture);

    public Task DisposeAsync() => Task.CompletedTask;

    private static async Task InvokeSaveRevisionAsync(ArticleService service, int articleId, string diffSummary)
    {
        var task = (Task?)s_saveRevisionMethod.Invoke(
            service,
            [
                articleId,
                "Title",
                "# body",
                "summary",
                null,
                1,
                Array.Empty<int>(),
                diffSummary,
                new DateTime(2026, 7, 20, 8, 0, 0, DateTimeKind.Utc),
                null
            ]);

        Assert.NotNull(task);
        await task;
    }

    private static Task StartBarrierTaskAsync(Barrier barrier, Func<Task> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for concurrent revision writers.");
                await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private static Task<T> StartBarrierTaskAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(barrier.SignalAndWait(TimeSpan.FromSeconds(30)));
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private static ArticleWriteRequestCoreModel CreateDraftRequest(string suffix)
        => new(
            $"Article {suffix}",
            $"# Body {suffix}",
            "summary",
            null,
            1,
            [1],
            (int)ArticleStatus.Draft,
            Rights: null,
            BaseRevisionId: null);

    private static async Task<int> SeedArticleAsync(
        SqlSugarClient db,
        bool isDeleted = false,
        DateTime? publishedAt = null)
    {
        DateTime createdAt = DateTime.UtcNow;
        DateTime? effectivePublishedAt = isDeleted ? null : publishedAt ?? createdAt;
        int articleId = await db.Insertable(new Article
        {
            Title = "Title",
            Summary = "summary",
            CategoryId = 1,
            Status = isDeleted ? ArticleStatus.Deleted : ArticleStatus.Published,
            IsDeleted = isDeleted,
            DeletedAt = isDeleted ? DateTime.UtcNow : null,
            CreateTime = createdAt,
            PublishedAt = effectivePublishedAt
        }).ExecuteReturnIdentityAsync();
        // Soft-deleted rows intentionally have no live publication coordinates.
        if (!isDeleted)
        {
            await SeedCurrentVersionCoordinatesAsync(db, articleId, effectivePublishedAt ?? createdAt);
        }

        return articleId;
    }

    private static async Task SeedCurrentVersionCoordinatesAsync(
        SqlSugarClient db,
        int articleId,
        DateTime publishedAt)
    {
        long revisionId = await db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 1,
            Title = "Title",
            Summary = "summary",
            CategoryId = 1,
            TagIds = "1",
            MarkdownContent = "# original",
            DiffSummary = "seed",
            CreatedByAdminPrincipalId = 1,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentityAsync();
        long rightsSnapshotId = await db.Insertable(new ArticleRightsSnapshot
        {
            ArticleId = articleId,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            ArticleRightsPolicyId = 1,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentityAsync();
        long publicationId = await db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = articleId,
            PublicationNo = 1,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            RightsSnapshotId = rightsSnapshotId,
            TransitionKind = "seed",
            PublishedAt = publishedAt,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentityAsync();
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article
            SET current_revision_id = @RevisionId,
                current_publication_id = @PublicationId
            WHERE id = @ArticleId;
            """,
            new SugarParameter("@RevisionId", revisionId),
            new SugarParameter("@PublicationId", publicationId),
            new SugarParameter("@ArticleId", articleId));
    }

    private static async Task SeedRevisionAsync(SqlSugarClient db, int articleId, int revisionNo)
    {
        bool exists = await db.Queryable<ArticleRevision>()
            .AnyAsync(revision => revision.ArticleId == articleId && revision.RevisionNo == revisionNo);
        if (exists)
        {
            return;
        }

        await db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = revisionNo,
            Title = "Original",
            Summary = "summary",
            CategoryId = 1,
            TagIds = string.Empty,
            MarkdownContent = "# original",
            DiffSummary = "seed",
            CreatedByAdminPrincipalId = 1,
            CreatedAt = DateTime.UtcNow
        }).ExecuteCommandAsync();
    }

    private static async Task<int[]> LoadRevisionNumbersAsync(SqlSugarClient db, int articleId)
        => [.. await db.Queryable<ArticleRevision>()
            .Where(revision => revision.ArticleId == articleId)
            .OrderBy(revision => revision.RevisionNo)
            .Select(revision => revision.RevisionNo)
            .ToListAsync()];

    private static async Task SeedTaxonomyAsync(SqlSugarClient db)
    {
        await db.Insertable(new[]
        {
            new Category { Id = 1, Name = "Category 1" },
            new Category { Id = 2, Name = "Category 2" }
        }).ExecuteCommandAsync();
        await db.Insertable(new[]
        {
            new Tag { Id = 1, Name = "Tag 1" },
            new Tag { Id = 2, Name = "Tag 2" },
            new Tag { Id = 3, Name = "Tag 3" },
            new Tag { Id = 4, Name = "Tag 4" }
        }).ExecuteCommandAsync();
    }

    private static async Task SeedBodyAsync(
        SqlSugarClient db,
        int articleId,
        string content,
        DateTime? updatedAt = null)
        => await db.Insertable(new ArticleBody
        {
            ArticleId = articleId,
            MarkdownContent = content,
            UpdatedAt = updatedAt ?? DateTime.UtcNow
        }).ExecuteCommandAsync();

    private static async Task SeedTagsAsync(SqlSugarClient db, int articleId, int[] tagIds)
        => await db.Insertable(tagIds.Select(tagId => new ArticleTag
        {
            ArticleId = articleId,
            TagId = tagId
        }).ToArray()).ExecuteCommandAsync();

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleTag),
            typeof(Category),
            typeof(Tag),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem),
            typeof(ArticleRightsPolicy),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleResponsibilitySnapshot),
            typeof(ArticlePublicationRecord),
            typeof(ArticleMutationOutboxEvent),
            typeof(ArticleMutationCommand));

    private static ArticleService CreateService(
        SqlSugarClient db,
        IArticlePublicMutationFence? mutationFence = null)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());

        return new ArticleService(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisConnection: redis,
            _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(),
            _stringReader: Substitute.For<ICacheStringReader>(),
            _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: Substitute.For<IDbConcurrencyGate>(),
            _runtimeKeyScope: Substitute.For<IRuntimeKeyScope>(),
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: mutationFence ?? Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue());
    }
}
