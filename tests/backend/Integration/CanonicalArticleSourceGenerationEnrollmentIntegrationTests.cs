using System.Data;

using Microsoft.Extensions.Configuration;

using Npgsql;

using SqlSugar;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Integration;

/// <summary>
/// Ordinary original-project controls for automatic enrollment in the actual canonical writers.
/// Caller-owned transactions acquire their family lock at entry; tests never manually enroll events.
/// Full fixture receipts, Vault groups, scheduler and public runtime qualification remain separate.
/// </summary>
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class CanonicalArticleSourceGenerationEnrollmentIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static DateTime Now => TestTemporalContext.FromEnvironment().BusinessEpochUtc.UtcDateTime;

    [Fact]
    public async Task BlankCreateEnrollsOriginalEventAndReplayDoesNotAdvance()
    {
        using SqlSugarClient db = await DatabaseAsync();
        long adminId = await AdminAsync(db);
        var command = new ArticleCreateCommand(new ArticleTemplateActor(adminId, [AdminPermissions.ArticleWrite]),
            Guid.NewGuid(), ArticleCreateMode.Blank);
        var payload = new ArticleCreatePayload(string.Empty, null, 0, [], string.Empty, [],
            ArticleTemplateExpansionPlanner.ComputeSha256([]), null, null);
        string digest = ArticleCreateStore.ComputeRequestDigest(command);
        var persistence = new PostgresArticleCreatePersistence(db, Configuration());
        ArticleCreateReceipt created = await persistence.ExecuteAsync(command, payload, digest);
        Assert.Equal(new ArticleSourceCursor(created.ArticleId, 1, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, created.ArticleId));
        ArticleSourceMutation journal = await db.Queryable<ArticleSourceMutation>()
            .Where(row => row.EventId == created.OutboxEventId).SingleAsync();
        Assert.Equal(created.ArticleId, journal.ArticleId);
        ArticleMutationOutboxEvent original = await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(row => row.EventId == created.OutboxEventId).SingleAsync();
        Assert.Null(original.RightsSnapshotId);
        Assert.Null(original.ResponsibilitySnapshotId);
        Assert.Null(original.ArticlePublicationId);

        ArticleCreateReceipt replay = await persistence.ExecuteAsync(command, payload, digest);
        Assert.Equal(created.ReceiptId, replay.ReceiptId);
        Assert.Equal(created.OutboxEventId, replay.OutboxEventId);
        Assert.Equal(1, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        Assert.Equal(1, await db.Queryable<ArticleSourceMutation>().CountAsync());
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        using SqlSugarClient restarted = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(new ArticleSourceCursor(created.ArticleId, 1, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(restarted, created.ArticleId));
    }

    [Fact]
    public async Task OriginalCreateAutomaticallyEnrollsInsideCallerTransactionAndReconnectIsExact()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await db.Ado.BeginTranAsync();
        IDbTransaction transaction = db.Ado.Transaction;
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleCreateMutationAuthority.Result created = await CreateAsync(db);
        Assert.Same(transaction, db.Ado.Transaction);
        Assert.Same(db.Ado.Connection, transaction.Connection);
        Assert.Equal(new ArticleSourceCursor(created.ArticleId, 1, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, created.ArticleId));
        Assert.Equal(created.Outbox.EventId, Assert.Single(await db.Queryable<ArticleSourceMutation>().ToListAsync()).EventId);
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        Assert.Equal(0, await observer.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        await db.Ado.CommitTranAsync();
        Assert.Equal(new ArticleSourceCursor(created.ArticleId, 1, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(observer, created.ArticleId));
    }

    [Fact]
    public async Task OriginalLifecycleAutomaticallyEnrollsEveryActualEventWithoutManualRecording()
    {
        using SqlSugarClient db = await DatabaseAsync();
        long adminId = await AdminAsync(db);
        await db.Ado.BeginTranAsync();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleLifecycleTransitionWriter.Result current = await LifecycleCreateAsync(db, adminId);
        long initialRevision = current.Version.RevisionId;
        int articleId = current.ArticleId;
        long step = 0;
        async Task VerifyStepAsync(ArticleLifecycleTransitionWriter.Result result)
        {
            step++;
            Assert.Equal(new ArticleSourceCursor(articleId, step, step),
                await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, articleId));
            ArticleSourceMutation journal = await db.Queryable<ArticleSourceMutation>()
                .Where(row => row.EventId == result.Outbox.EventId).SingleAsync();
            Assert.Equal(step, journal.SourceGeneration);
            Assert.Equal(step, journal.SourceSequence);
        }
        await VerifyStepAsync(current);
        current = await LifecycleUpdateAsync(db, current, adminId, ArticleStatus.Draft);
        await VerifyStepAsync(current);
        current = await LifecycleUpdateAsync(db, current, adminId, ArticleStatus.Published);
        await VerifyStepAsync(current);
        long? published = current.Version.PublicationId;
        current = await LifecycleUpdateAsync(db, current, adminId, ArticleStatus.Scheduled);
        await VerifyStepAsync(current);
        Assert.Equal(published, current.Version.PublicationId);
        current = await ArticleLifecycleTransitionWriter.PublishScheduledAsync(db, Configuration(),
            new ArticleLifecycleTransitionWriter.ScheduledPublishRequest(articleId, current.Version.RevisionId,
                Now.AddMinutes(1), adminId, "source-enrollment"));
        await VerifyStepAsync(current);
        Assert.NotEqual(published, current.Version.PublicationId);
        current = await LifecycleUpdateAsync(db, current, adminId, ArticleStatus.Archived);
        await VerifyStepAsync(current);
        current = await ArticleLifecycleTransitionWriter.DeleteAsync(db, Configuration(),
            new ArticleLifecycleTransitionWriter.DeleteRequest(articleId, current.Version.RevisionId,
                Now.AddMinutes(2), adminId, "source-enrollment"));
        Assert.Null(current.Version.ResponsibilityVersion);
        await VerifyStepAsync(current);
        current = await ArticleLifecycleTransitionWriter.RestoreAsync(db, Configuration(),
            new ArticleLifecycleTransitionWriter.RestoreRequest(articleId, current.Version.RevisionId,
                Now.AddMinutes(3), adminId, "source-enrollment"));
        await VerifyStepAsync(current);
        current = await ArticleLifecycleTransitionWriter.RollbackAsync(db, Configuration(),
            new ArticleLifecycleTransitionWriter.RollbackRequest(articleId, current.Version.RevisionId,
                initialRevision, Now.AddMinutes(4), adminId, "original source rollback", "source-enrollment"));
        await VerifyStepAsync(current);
        Assert.Equal(9, step);
        await db.Ado.CommitTranAsync();
        Assert.Equal(9, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        Assert.Equal(9, await db.Queryable<ArticleSourceMutation>().CountAsync());
        Assert.Equal(new ArticleSourceCursor(articleId, 9, 9),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, articleId));
        Assert.Equal(current.Version.RevisionId, (await db.Queryable<Article>().InSingleAsync(articleId)).CurrentRevisionId);
    }

    [Fact]
    public async Task OwnerRollbackRemovesOriginalEventAndEnrollmentAndRetryAllocatesFirstStep()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await db.Ado.BeginTranAsync();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleCreateMutationAuthority.Result rolledBack = await CreateAsync(db);
        Assert.Equal(new ArticleSourceCursor(rolledBack.ArticleId, 1, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, rolledBack.ArticleId));
        await db.Ado.RollbackTranAsync();
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(0, await db.Queryable<Article>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleSourceSequence>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleSourceMutation>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleRelationSourceCoordinate>().CountAsync());
        await db.Ado.BeginTranAsync();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleCreateMutationAuthority.Result retried = await CreateAsync(db);
        await db.Ado.CommitTranAsync();
        Assert.Equal(new ArticleSourceCursor(retried.ArticleId, 1, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, retried.ArticleId));
        Assert.NotEqual(rolledBack.Outbox.EventId, retried.Outbox.EventId);
    }

    [Fact]
    public async Task MissingFamilyLockRefusesBeforeOriginalArticleWrites()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await db.Ado.BeginTranAsync();
        InvalidOperationException refused = await Assert.ThrowsAsync<InvalidOperationException>(() => CreateAsync(db));
        Assert.Equal("article_source_mutation_lock_lost", refused.Message);
        Assert.Equal(0, await db.Queryable<Article>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        await db.Ado.RollbackTranAsync();
        await db.Ado.BeginTranAsync();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleCreateMutationAuthority.Result created = await CreateAsync(db);
        await db.Ado.CommitTranAsync();
        Assert.Equal(new ArticleSourceCursor(created.ArticleId, 1, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, created.ArticleId));
    }

    [Fact]
    public async Task CancellationDuringAutomaticJournalInsertRollsBackOriginalOwnerTransaction()
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient blocker = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION source_generation_test_pause() RETURNS trigger AS $$
            BEGIN
                PERFORM pg_advisory_xact_lock(1179866444, 2);
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER source_generation_test_pause BEFORE INSERT ON article_source_mutation
                FOR EACH ROW EXECUTE FUNCTION source_generation_test_pause();
            """);
        await blocker.Ado.BeginTranAsync();
        await blocker.Ado.ExecuteCommandAsync("SELECT pg_advisory_xact_lock(1179866444, 2);");
        await db.Ado.BeginTranAsync();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        using var canceled = new CancellationTokenSource();
        Task<ArticleCreateMutationAuthority.Result> writing = CreateAsync(db, canceled.Token);
        await WaitForAdvisoryWaitAsync(db.CurrentConnectionConfig.ConnectionString,
            ((NpgsqlConnection)db.Ado.Connection).ProcessID);
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(blocker));
        canceled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => writing);
        await db.Ado.RollbackTranAsync();
        await blocker.Ado.RollbackTranAsync();
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(0, await db.Queryable<Article>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleSourceMutation>().CountAsync());
        await db.Ado.ExecuteCommandAsync("DROP TRIGGER source_generation_test_pause ON article_source_mutation;");
        await db.Ado.BeginTranAsync();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleCreateMutationAuthority.Result retried = await CreateAsync(db);
        await db.Ado.CommitTranAsync();
        Assert.Equal(new ArticleSourceCursor(retried.ArticleId, 1, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, retried.ArticleId));
    }

    private async Task<SqlSugarClient> DatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        try
        {
            PostgresSqlSugarTestClient.InitTables(db,
                typeof(Article), typeof(ArticleBody), typeof(ArticleTag), typeof(ArticleRevision),
                typeof(ArticleRevisionContentBlock), typeof(ArticleDraft), typeof(ArticleRightsPolicy),
                typeof(ArticleRightsSnapshot), typeof(ArticleResponsibilitySnapshot), typeof(ArticlePublicationRecord),
                typeof(ArticleMutationOutboxEvent), typeof(ArticleMutationCommand), typeof(AdminPrincipal), typeof(AuditLog),
                typeof(ContentAsset), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem),
                typeof(ArticleSourceGeneration), typeof(ArticleSourceSequence), typeof(ArticleSourceMutation));
            await fixture.ExecuteAsync(db.CurrentConnectionConfig.ConnectionString,
                ArticleRelationSourceCoordinateMigrationDefinitions.Sql);
            foreach (SchemaMigrationStep step in ArticleCreateAuthorityMigrationDefinitions.BuildMigration().Steps)
            {
                await step.ExecuteAsync(db, default);
            }
            return db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    private static IConfiguration Configuration()
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Audit:TamperEvidenceKey"] = "original-writer-source-enrollment-test-key-0123456789"
        }).Build();

    private static Task<long> AdminAsync(SqlSugarClient db)
        => db.Insertable(new AdminPrincipal
        {
            Handle = "original-source-enrollment-admin",
            DisplayName = "Original source enrollment test",
            Status = AdminPrincipalStatus.Active,
            Permissions = string.Join('\n', AdminPermissions.ArticleWrite, AdminPermissions.ArticlePublish),
            CreatedAtUtc = Now
        }).ExecuteReturnBigIdentityAsync();

    private static Task<ArticleCreateMutationAuthority.Result> CreateAsync(SqlSugarClient db, CancellationToken cancellationToken = default)
        => ArticleCreateMutationAuthority.ExecuteAsync(db,
            new ArticleCreateMutationAuthority.Request("original source enrollment", "# Exact source\r\n内容😀  \r\n",
                "summary", null, 1, [], ArticleStatus.Draft, null, null, null, null, null, Now,
                ArticleProductionNormalizers.NormalizeArticleRights(null), 1, "original source enrollment",
                ArticleMutationEventTypes.Created, ArticlePublicationTransitionKinds.SaveDraft,
                new ArticleMutationScopeSnapshot(1, [], "draft")), cancellationToken);

    private static Task<ArticleLifecycleTransitionWriter.Result> LifecycleCreateAsync(SqlSugarClient db, long adminId)
        => ArticleLifecycleTransitionWriter.CreateAsync(db, Configuration(),
            new ArticleLifecycleTransitionWriter.CreateRequest("original lifecycle", "# Original lifecycle source",
                "summary", null, 1, [], ArticleStatus.Draft, null, Now, adminId, null, Responsibility(), "source-enrollment"));

    private static Task<ArticleLifecycleTransitionWriter.Result> LifecycleUpdateAsync(SqlSugarClient db,
        ArticleLifecycleTransitionWriter.Result current, long adminId, ArticleStatus target)
        => ArticleLifecycleTransitionWriter.UpdateAsync(db, Configuration(),
            new ArticleLifecycleTransitionWriter.RevisionRequest(current.ArticleId, current.Version.RevisionId,
                "original lifecycle update", "# Updated source", "summary", null, 1, [], target,
                target == ArticleStatus.Scheduled ? Now.AddMinutes(1) : null, Now, adminId, null, Responsibility(),
                target switch
                {
                    ArticleStatus.Published => ArticlePublicationTransitionKinds.ImmediatePublish,
                    ArticleStatus.Scheduled => ArticlePublicationTransitionKinds.Schedule,
                    ArticleStatus.Archived => ArticlePublicationTransitionKinds.Archive,
                    _ => ArticlePublicationTransitionKinds.SaveDraft
                }, "source-enrollment"));

    private static ArticleResponsibilityDraft Responsibility()
        => new(true, [new ArticleResponsiblePerson("Original enrollment author", null)], null, [],
            "source-generation", "original-writer-test", null, null, null, null, null,
            true, false, false, false, 0);

    private static async Task WaitForAdvisoryWaitAsync(string connectionString, int pid)
    {
        await using var monitor = new NpgsqlConnection(connectionString);
        await monitor.OpenAsync();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using NpgsqlCommand command = new(
            "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = @Pid AND locktype = 'advisory' AND NOT granted);", monitor);
        command.Parameters.AddWithValue("Pid", pid);
        while (!(bool)(await command.ExecuteScalarAsync(deadline.Token))!)
        {
            await Task.Yield();
            deadline.Token.ThrowIfCancellationRequested();
        }
    }
}
