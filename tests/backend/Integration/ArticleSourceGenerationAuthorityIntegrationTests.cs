using System.Data;

using Microsoft.Extensions.Configuration;

using Npgsql;

using SqlSugar;

using FsusBlog.Contracts.Articles;
using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleSourceGenerationAuthorityIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTime s_now = new(2026, 10, 9, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task UninitializedReaders_AndLockAcquisition_PerformZeroWrites()
    {
        using SqlSugarClient db = await DatabaseAsync();
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Null(await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, 1));
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        db.Ado.CommitTran();
        Assert.Equal(0, await CountAsync(db, "article_source_generation"));
        Assert.Equal(0, await CountAsync(db, "article_source_sequence"));
        Assert.Equal(0, await CountAsync(db, "article_source_mutation"));
    }

    [Fact]
    public async Task MissingSchema_ReadsUnavailableWithoutCreatingTables()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Null(await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, 1));
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public';"));
    }

    [Fact]
    public async Task OriginalCreate_EnrolledInsideBorrowedTransaction_PersistsAcrossNewClient()
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran();
        object transaction = db.Ado.Transaction;
        ArticleCreateMutationAuthority.Result created = await CreateAsync(db);
        ArticleSourceCursor cursor = await ArticleSourceGenerationAuthority.RecordMutationAsync(db, created.Outbox.EventId);
        Assert.Same(transaction, db.Ado.Transaction);
        Assert.Equal(new ArticleSourceCursor(created.ArticleId, 1, 1), cursor);
        db.Ado.CommitTran();
        using SqlSugarClient restarted = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(restarted));
        Assert.Equal(cursor, await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(restarted, created.ArticleId));
        Assert.Equal(1, await CountAsync(restarted, "article_source_mutation"));
        Assert.Equal(1, await CountAsync(restarted, "article_mutation_outbox"));
    }

    [Fact]
    public async Task GroupEvents_StayInvisibleUntilCommit_AndPreserveEveryStep()
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        db.Ado.BeginTran();
        ArticleCreateMutationAuthority.Result first = await CreateAsync(db);
        ArticleSourceCursor one = await ArticleSourceGenerationAuthority.RecordMutationAsync(db, first.Outbox.EventId);
        ArticleMutationOutboxEvent next = await InsertCurrentAsync(db, first.ArticleId);
        ArticleSourceCursor two = await ArticleSourceGenerationAuthority.RecordMutationAsync(db, next.EventId);
        ArticleCreateMutationAuthority.Result second = await CreateAsync(db);
        ArticleSourceCursor three = await ArticleSourceGenerationAuthority.RecordMutationAsync(db, second.Outbox.EventId);
        Assert.Equal(new ArticleSourceCursor(first.ArticleId, 1, 1), one);
        Assert.Equal(new ArticleSourceCursor(first.ArticleId, 2, 2), two);
        Assert.Equal(new ArticleSourceCursor(second.ArticleId, 3, 1), three);
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        Assert.Null(await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(observer, first.ArticleId));
        Assert.Equal(0, await CountAsync(observer, "article_source_mutation"));
        Assert.Equal(0, await CountAsync(observer, "article_mutation_outbox"));
        db.Ado.CommitTran();
        Assert.Equal(3, await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        Assert.Equal(new ArticleSourceCursor(first.ArticleId, 3, 2),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(observer, first.ArticleId));
        Assert.Equal(3, await CountAsync(observer, "article_source_mutation"));
    }

    [Fact]
    public async Task DuplicateEvent_ReturnsOriginalCursor_EvenAfterLaterEventsAndDeliveryChanges()
    {
        using SqlSugarClient db = await DatabaseAsync();
        ArticleCreateMutationAuthority.Result created = await SeedAsync(db);
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleMutationOutboxEvent next = await InsertCurrentAsync(db, created.ArticleId);
        await ArticleSourceGenerationAuthority.RecordMutationAsync(db, next.EventId);
        await db.Ado.ExecuteCommandAsync("UPDATE article_mutation_outbox SET status = 'completed', retry_count = 7;");
        Assert.Equal(new ArticleSourceCursor(created.ArticleId, 1, 1),
            await ArticleSourceGenerationAuthority.RecordMutationAsync(db, created.Outbox.EventId));
        db.Ado.CommitTran();
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(2, await CountAsync(db, "article_source_mutation"));
    }

    [Fact]
    public async Task DuplicateEvent_AlteredRawPayload_FailsClosedWithoutAdvancing()
    {
        using SqlSugarClient db = await DatabaseAsync();
        ArticleCreateMutationAuthority.Result created = await SeedAsync(db);
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        await db.Ado.ExecuteCommandAsync("UPDATE article_mutation_outbox SET payload_json = payload_json || ' '; ");
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ArticleSourceGenerationAuthority.RecordMutationAsync(db, created.Outbox.EventId));
        Assert.Equal("article_source_event_facts_changed", error.Message);
        db.Ado.RollbackTran();
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(1, await CountAsync(db, "article_source_mutation"));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("unknown-type")]
    [InlineData("schema")]
    [InlineData("owner")]
    [InlineData("coordinate")]
    [InlineData("foreign-revision")]
    public async Task InvalidPersistedEvent_IsRejectedWithNoEnrollment(string fault)
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran();
        ArticleCreateMutationAuthority.Result created = await CreateAsync(db);
        ArticleMutationOutboxEvent item = created.Outbox;
        switch (fault)
        {
            case "missing":
                item.EventId = Guid.NewGuid().ToString("N");
                break;
            case "unknown-type":
                await db.Ado.ExecuteCommandAsync("UPDATE article_mutation_outbox SET event_type = 'unknown';");
                break;
            case "schema":
                await db.Ado.ExecuteCommandAsync("UPDATE article_mutation_outbox SET schema_version = 99;");
                break;
            case "owner":
                await db.Ado.ExecuteCommandAsync("UPDATE article_mutation_outbox SET aggregate_type = 'comment';");
                break;
            case "coordinate":
                await db.Ado.ExecuteCommandAsync("UPDATE article_mutation_outbox SET revision_no = revision_no + 1;");
                break;
            case "foreign-revision":
                await db.Ado.ExecuteCommandAsync("UPDATE article_revision SET article_id = article_id + 1000;");
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(fault));
        }
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => ArticleSourceGenerationAuthority.RecordMutationAsync(db, item.EventId));
        Assert.Equal(0, await CountAsync(db, "article_source_mutation"));
        db.Ado.RollbackTran();
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(0, await CountAsync(db, "article_mutation_outbox"));
    }

    [Fact]
    public async Task NoTransaction_NoLock_AndExpiredTransaction_AreRejected()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db));
        db.Ado.BeginTran();
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => ArticleSourceGenerationAuthority.RecordMutationAsync(db, Guid.NewGuid().ToString("N")));
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        db.Ado.CommitTran();
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => ArticleSourceGenerationAuthority.RecordMutationAsync(db, Guid.NewGuid().ToString("N")));
        db.Ado.BeginTran();
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => ArticleSourceGenerationAuthority.RecordMutationAsync(db, Guid.NewGuid().ToString("N")));
        db.Ado.RollbackTran();
    }

    [Fact]
    public async Task LostLockAfterSavepointRollback_IsRejected()
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran();
        await db.Ado.ExecuteCommandAsync("SAVEPOINT before_lock;");
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        await db.Ado.ExecuteCommandAsync("ROLLBACK TO SAVEPOINT before_lock;");
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ArticleSourceGenerationAuthority.RecordMutationAsync(db, Guid.NewGuid().ToString("N")));
        Assert.Equal("article_source_mutation_lock_lost", error.Message);
        db.Ado.RollbackTran();
    }

    [Fact]
    public async Task Rollback_RemovesArticleEventCountersAndJournal_AndRetryAllocatesFirstStep()
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran();
        ArticleCreateMutationAuthority.Result first = await CreateAsync(db);
        await ArticleSourceGenerationAuthority.RecordMutationAsync(db, first.Outbox.EventId);
        db.Ado.RollbackTran();
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(0, await CountAsync(db, "article"));
        Assert.Equal(0, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(0, await CountAsync(db, "article_source_mutation"));
        ArticleCreateMutationAuthority.Result retried = await SeedAsync(db);
        Assert.Equal(new ArticleSourceCursor(retried.ArticleId, 1, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, retried.ArticleId));
    }

    [Fact]
    public async Task CanceledEnrollment_RollsBackWholeOwnerTransaction()
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran();
        ArticleCreateMutationAuthority.Result created = await CreateAsync(db);
        using var canceled = new CancellationTokenSource();
        canceled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => ArticleSourceGenerationAuthority.RecordMutationAsync(db, created.Outbox.EventId, canceled.Token));
        db.Ado.RollbackTran();
        Assert.Equal(0, await CountAsync(db, "article_mutation_outbox"));
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        await SeedAsync(db);
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ConcurrentTransactions_SerializeCommitOrder_ForSameAndDifferentArticles(bool sameArticle)
    {
        using SqlSugarClient db = await DatabaseAsync();
        ArticleCreateMutationAuthority.Result first = await SeedAsync(db);
        ArticleCreateMutationAuthority.Result second = sameArticle ? first : await SeedAsync(db);
        long baseline = sameArticle ? 1 : 2;
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleMutationOutboxEvent one = await InsertCurrentAsync(db, first.ArticleId);
        ArticleSourceCursor earlier = await ArticleSourceGenerationAuthority.RecordMutationAsync(db, one.EventId);
        writer.Ado.BeginTran();
        int pid = ((NpgsqlConnection)writer.Ado.Connection).ProcessID;
        Task lockWait = ArticleSourceGenerationAuthority.AcquireMutationLockAsync(writer);
        await WaitForAdvisoryWaitAsync(db.CurrentConnectionConfig.ConnectionString, pid);
        Assert.False(lockWait.IsCompleted);
        db.Ado.CommitTran();
        await lockWait.WaitAsync(TimeSpan.FromSeconds(10));
        ArticleMutationOutboxEvent two = await InsertCurrentAsync(writer, second.ArticleId);
        ArticleSourceCursor later = await ArticleSourceGenerationAuthority.RecordMutationAsync(writer, two.EventId);
        writer.Ado.CommitTran();
        Assert.Equal(baseline + 1, earlier.SourceGeneration);
        Assert.Equal(baseline + 2, later.SourceGeneration);
        Assert.Equal(sameArticle ? 3 : 2, later.SourceSequence);
        Assert.Equal(baseline + 2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
    }

    [Fact]
    public async Task CancellationWhileWaitingForFamilyLock_AllowsRollbackAndRetry()
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        writer.Ado.BeginTran();
        int pid = ((NpgsqlConnection)writer.Ado.Connection).ProcessID;
        using var canceled = new CancellationTokenSource();
        Task lockWait = ArticleSourceGenerationAuthority.AcquireMutationLockAsync(writer, canceled.Token);
        await WaitForAdvisoryWaitAsync(db.CurrentConnectionConfig.ConnectionString, pid);
        canceled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => lockWait);
        writer.Ado.RollbackTran();
        db.Ado.RollbackTran();
        await SeedAsync(writer);
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
    }

    [Fact]
    public async Task ConnectionInterruption_RollsBackPendingEnrollment_AndFreshClientRetries()
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran();
        ArticleCreateMutationAuthority.Result first = await CreateAsync(db);
        await ArticleSourceGenerationAuthority.RecordMutationAsync(db, first.Outbox.EventId);
        int pid = ((NpgsqlConnection)db.Ado.Connection).ProcessID;
        using SqlSugarClient interrupter = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await interrupter.Ado.GetScalarAsync("SELECT pg_terminate_backend(@Pid);", new SugarParameter("@Pid", pid));
        await Assert.ThrowsAnyAsync<Exception>(() => ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        // The server terminated and rolled back the native transaction. SqlSugar retains
        // its disposed handle; assert that refusal, then release only this failed client handle.
        Assert.Throws<ObjectDisposedException>(() => db.Ado.RollbackTran());
        db.Ado.Transaction = null;
        using SqlSugarClient restarted = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(restarted));
        Assert.Equal(0, await CountAsync(restarted, "article_mutation_outbox"));
        await SeedAsync(restarted);
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(restarted));
    }

    [Theory]
    [InlineData("family")]
    [InlineData("article")]
    public async Task Int64Overflow_FailsWithoutAdvancingOrEnrollment(string counter)
    {
        using SqlSugarClient db = await DatabaseAsync();
        ArticleCreateMutationAuthority.Result created = await SeedAsync(db);
        await db.Ado.ExecuteCommandAsync("UPDATE article_source_generation SET source_generation = 9223372036854775807;");
        if (counter == "article")
        {
            await db.Ado.ExecuteCommandAsync("UPDATE article_source_sequence SET source_sequence = 9223372036854775807;");
        }
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleMutationOutboxEvent next = await InsertCurrentAsync(db, created.ArticleId);
        await Assert.ThrowsAsync<OverflowException>(
            () => ArticleSourceGenerationAuthority.RecordMutationAsync(db, next.EventId));
        Assert.Equal(1, await CountAsync(db, "article_source_mutation"));
        db.Ado.RollbackTran();
        Assert.Equal(long.MaxValue, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(1, await CountAsync(db, "article_mutation_outbox"));
    }

    [Theory]
    [InlineData("family")]
    [InlineData("sequence")]
    [InlineData("journal")]
    public async Task IllegalPersistedCounters_FailClosed(string counter)
    {
        using SqlSugarClient db = await DatabaseAsync();
        ArticleCreateMutationAuthority.Result created = await SeedAsync(db);
        string sql = counter switch
        {
            "family" => "UPDATE article_source_generation SET source_generation = -1;",
            "sequence" => "UPDATE article_source_sequence SET source_sequence = -1;",
            "journal" => "UPDATE article_source_mutation SET source_generation = -1;",
            _ => throw new ArgumentOutOfRangeException(nameof(counter))
        };
        await db.Ado.ExecuteCommandAsync(sql);
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => ArticleSourceGenerationAuthority.RecordMutationAsync(db, created.Outbox.EventId));
        db.Ado.RollbackTran();
    }

    [Fact]
    public async Task OriginalLifecycleWriters_EnrollAllStepsInOneOwnerTransaction()
    {
        using SqlSugarClient db = await DatabaseAsync();
        long adminId = await AdminAsync(db);
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleLifecycleTransitionWriter.Result current = await LifecycleCreateAsync(db, adminId);
        long initialRevision = current.Version.RevisionId;
        int articleId = current.ArticleId;
        long step = 0;
        async Task EnrollAsync(ArticleLifecycleTransitionWriter.Result result)
        {
            step++;
            Assert.Equal(new ArticleSourceCursor(articleId, step, step),
                await ArticleSourceGenerationAuthority.RecordMutationAsync(db, result.Outbox.EventId));
        }
        await EnrollAsync(current);
        current = await LifecycleUpdateAsync(db, current, adminId, ArticleStatus.Draft);
        await EnrollAsync(current);
        current = await LifecycleUpdateAsync(db, current, adminId, ArticleStatus.Published);
        await EnrollAsync(current);
        long? publicationBeforeSchedule = current.Version.PublicationId;
        current = await LifecycleUpdateAsync(db, current, adminId, ArticleStatus.Scheduled);
        await EnrollAsync(current);
        Assert.Equal(publicationBeforeSchedule, current.Version.PublicationId);
        current = await ArticleLifecycleTransitionWriter.PublishScheduledAsync(db, Configuration(),
            new ArticleLifecycleTransitionWriter.ScheduledPublishRequest(
                articleId, current.Version.RevisionId, s_now.AddMinutes(1), adminId, "source-clock"));
        await EnrollAsync(current);
        Assert.NotEqual(publicationBeforeSchedule, current.Version.PublicationId);
        current = await LifecycleUpdateAsync(db, current, adminId, ArticleStatus.Archived);
        await EnrollAsync(current);
        current = await ArticleLifecycleTransitionWriter.DeleteAsync(db, Configuration(),
            new ArticleLifecycleTransitionWriter.DeleteRequest(
                articleId, current.Version.RevisionId, s_now.AddMinutes(2), adminId, "source-clock"));
        await EnrollAsync(current);
        current = await ArticleLifecycleTransitionWriter.RestoreAsync(db, Configuration(),
            new ArticleLifecycleTransitionWriter.RestoreRequest(
                articleId, current.Version.RevisionId, s_now.AddMinutes(3), adminId, "source-clock"));
        await EnrollAsync(current);
        current = await ArticleLifecycleTransitionWriter.RollbackAsync(db, Configuration(),
            new ArticleLifecycleTransitionWriter.RollbackRequest(
                articleId, current.Version.RevisionId, initialRevision, s_now.AddMinutes(4),
                adminId, "original source rollback", "source-clock"));
        await EnrollAsync(current);
        Assert.Equal(9, step);
        db.Ado.CommitTran();
        Assert.Equal(new ArticleSourceCursor(articleId, 9, 9),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, articleId));
        Assert.Equal(current.Version.RevisionId,
            await db.Ado.GetLongAsync("SELECT current_revision_id FROM article WHERE id = @Id;", new SugarParameter[] { new("@Id", articleId) }));
        Assert.Equal(9, await CountAsync(db, "article_source_mutation"));
        Assert.Equal(9, await CountAsync(db, "article_mutation_outbox"));
    }

    [Fact]
    public async Task HistoricalAndReorderedEvents_InvalidateWithoutChangingCurrentPointers()
    {
        using SqlSugarClient db = await DatabaseAsync();
        long adminId = await AdminAsync(db);
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleLifecycleTransitionWriter.Result initial = await LifecycleCreateAsync(db, adminId);
        ArticleLifecycleTransitionWriter.Result current = await LifecycleUpdateAsync(db, initial, adminId, ArticleStatus.Draft);
        await ArticleSourceGenerationAuthority.RecordMutationAsync(db, current.Outbox.EventId);
        Assert.Equal(new ArticleSourceCursor(initial.ArticleId, 2, 2),
            await ArticleSourceGenerationAuthority.RecordMutationAsync(db, initial.Outbox.EventId));
        ArticleMutationOutboxEvent historical = await ArticleMutationOutboxProducer.CreateForVersionAsync(
            db, initial.ArticleId, ArticleMutationEventTypes.Updated, initial.Version, s_now.AddMinutes(1));
        await db.Insertable(historical).ExecuteCommandAsync();
        Assert.Equal("historical", ArticleMutationOutboxEnvelopeCodec.Read(historical).Scope.After?.Visibility);
        Assert.Equal(new ArticleSourceCursor(initial.ArticleId, 3, 3),
            await ArticleSourceGenerationAuthority.RecordMutationAsync(db, historical.EventId));
        db.Ado.CommitTran();
        Assert.Equal(current.Version.RevisionId,
            await db.Ado.GetLongAsync("SELECT current_revision_id FROM article WHERE id = @Id;", new SugarParameter[] { new("@Id", initial.ArticleId) }));
        Assert.Equal(3, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
    }

    [Fact]
    public async Task OriginalLifecycleRejectedRevision_ProducesNoClockStepOrEvent()
    {
        using SqlSugarClient db = await DatabaseAsync();
        long adminId = await AdminAsync(db);
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleLifecycleTransitionWriter.Result initial = await LifecycleCreateAsync(db, adminId);
        await ArticleSourceGenerationAuthority.RecordMutationAsync(db, initial.Outbox.EventId);
        db.Ado.CommitTran();
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        await Assert.ThrowsAsync<ArticleRevisionConflictException>(() => ArticleLifecycleTransitionWriter.UpdateAsync(db, Configuration(),
            RevisionRequest(initial, adminId, ArticleStatus.Draft) with
            {
                ExpectedRevisionId = initial.Version.RevisionId + 1000
            }));
        db.Ado.RollbackTran();
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(1, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(1, await CountAsync(db, "article_revision"));
    }

    [Fact]
    public async Task MismatchedConnection_UnsupportedIsolationAndProvider_AreRejected()
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient foreign = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        db.Ado.BeginTran();
        foreign.Ado.Transaction = db.Ado.Transaction;
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticleSourceGenerationAuthority.AcquireMutationLockAsync(foreign));
        foreign.Ado.Transaction = null;
        db.Ado.RollbackTran();
        db.Ado.BeginTran(IsolationLevel.RepeatableRead);
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db));
        db.Ado.RollbackTran();
        using var unsupported = new SqlSugarClient(new ConnectionConfig
        {
            DbType = SqlSugar.DbType.Sqlite,
            ConnectionString = "Data Source=:memory:",
            InitKeyType = InitKeyType.Attribute
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticleSourceGenerationAuthority.ReadGenerationAsync(unsupported));
    }

    [Fact]
    public async Task OriginalBlankCreateAbsentSnapshotFacts_ArePreservedOnHistoricalEnrollment()
    {
        using SqlSugarClient db = await DatabaseAsync();
        PostgresSqlSugarTestClient.InitTables(db, typeof(ArticleDraft));
        foreach (SchemaMigrationStep step in ArticleCreateAuthorityMigrationDefinitions.BuildMigration().Steps)
        {
            await step.ExecuteAsync(db, default);
        }
        long adminId = await AdminAsync(db);
        var command = new ArticleCreateCommand(new ArticleTemplateActor(adminId, [AdminPermissions.ArticleWrite]),
            Guid.NewGuid(), ArticleCreateMode.Blank);
        var persistence = new PostgresArticleCreatePersistence(db, Configuration());
        ArticleCreateReceipt receipt = await persistence.ExecuteAsync(command,
            new ArticleCreatePayload(string.Empty, null, 0, [], string.Empty, [],
                ArticleTemplateExpansionPlanner.ComputeSha256([]), null, null),
            ArticleCreateStore.ComputeRequestDigest(command));
        // This owner has not yet integrated the synchronous hook. Replaying its real persisted
        // event here is historical invalidation, not evidence of source freshness at create commit.
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        ArticleSourceCursor cursor = await ArticleSourceGenerationAuthority.RecordMutationAsync(db, receipt.OutboxEventId);
        db.Ado.CommitTran();
        Assert.Equal(new ArticleSourceCursor(receipt.ArticleId, 1, 1), cursor);
        ArticleMutationOutboxEvent persisted = await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(item => item.EventId == receipt.OutboxEventId).SingleAsync();
        Assert.Null(persisted.RightsSnapshotId);
        Assert.Null(persisted.ResponsibilitySnapshotId);
        Assert.Null(persisted.ArticlePublicationId);
        Assert.Equal(0, await CountAsync(db, "article_rights_snapshot"));
    }

    private static IConfiguration Configuration()
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Audit:TamperEvidenceKey"] = "source-generation-test-signing-key-0123456789"
        }).Build();

    private static Task<long> AdminAsync(SqlSugarClient db)
        => db.Insertable(new AdminPrincipal
        {
            Handle = "source-generation-admin",
            DisplayName = "Source generation test",
            Status = AdminPrincipalStatus.Active,
            Permissions = string.Join('\n', AdminPermissions.ArticleWrite, AdminPermissions.ArticlePublish),
            CreatedAtUtc = s_now
        }).ExecuteReturnBigIdentityAsync();

    private static Task<ArticleLifecycleTransitionWriter.Result> LifecycleCreateAsync(SqlSugarClient db, long adminId)
        => ArticleLifecycleTransitionWriter.CreateAsync(db, Configuration(),
            new ArticleLifecycleTransitionWriter.CreateRequest(
                "source lifecycle", "# Original lifecycle source", "summary", null, 1, [],
                ArticleStatus.Draft, null, s_now, adminId, null, Responsibility(), "source-clock"));

    private static Task<ArticleLifecycleTransitionWriter.Result> LifecycleUpdateAsync(SqlSugarClient db,
        ArticleLifecycleTransitionWriter.Result current, long adminId, ArticleStatus target)
        => ArticleLifecycleTransitionWriter.UpdateAsync(db, Configuration(), RevisionRequest(current, adminId, target));

    private static ArticleLifecycleTransitionWriter.RevisionRequest RevisionRequest(
        ArticleLifecycleTransitionWriter.Result current, long adminId, ArticleStatus target)
        => new(current.ArticleId, current.Version.RevisionId, "source lifecycle update", "# Updated lifecycle source",
            "summary", null, 1, [], target, target == ArticleStatus.Scheduled ? s_now.AddMinutes(1) : null,
            s_now, adminId, null, Responsibility(), target switch
            {
                ArticleStatus.Published => ArticlePublicationTransitionKinds.ImmediatePublish,
                ArticleStatus.Scheduled => ArticlePublicationTransitionKinds.Schedule,
                ArticleStatus.Archived => ArticlePublicationTransitionKinds.Archive,
                _ => ArticlePublicationTransitionKinds.SaveDraft
            }, "source-clock");

    private static ArticleResponsibilityDraft Responsibility()
        => new(true, [new ArticleResponsiblePerson("Source clock test author", null)], null, [],
            "source-generation", "source-generation-test", null, null, null, null, null,
            true, false, false, false, 0);

    private async Task<SqlSugarClient> DatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db,
            typeof(Article), typeof(ArticleBody), typeof(ArticleTag), typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock), typeof(ArticleRightsPolicy), typeof(ArticleRightsSnapshot),
            typeof(ArticleResponsibilitySnapshot), typeof(ArticlePublicationRecord), typeof(ArticleMutationOutboxEvent),
            typeof(ArticleMutationCommand), typeof(AdminPrincipal), typeof(AuditLog),
            typeof(ContentAsset), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem),
            typeof(ArticleSourceGeneration), typeof(ArticleSourceSequence),
            typeof(ArticleSourceMutation));
        return db;
    }

    private static async Task<ArticleCreateMutationAuthority.Result> SeedAsync(SqlSugarClient db)
    {
        ArticleCreateMutationAuthority.Result? created = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            created = await CreateAsync(db);
            await ArticleSourceGenerationAuthority.RecordMutationAsync(db, created.Outbox.EventId);
        });
        Assert.True(transaction.IsSuccess, transaction.ErrorException?.ToString());
        return created!;
    }

    private static async Task<ArticleCreateMutationAuthority.Result> CreateAsync(SqlSugarClient db)
    {
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        return await ArticleCreateMutationAuthority.ExecuteAsync(db,
            new ArticleCreateMutationAuthority.Request(
                "source clock test", "# Original source", "summary", null, 1, [], ArticleStatus.Draft,
                null, null, null, null, null, s_now,
                ArticleProductionNormalizers.NormalizeArticleRights(null), 1, "initial source",
                ArticleMutationEventTypes.Created, ArticlePublicationTransitionKinds.SaveDraft,
                new ArticleMutationScopeSnapshot(1, [], "draft")));
    }

    private static async Task<ArticleMutationOutboxEvent> InsertCurrentAsync(SqlSugarClient db, int articleId)
    {
        ArticleMutationOutboxEvent item = await ArticleMutationOutboxProducer.CreateCurrentAsync(
            db, articleId, ArticleMutationEventTypes.Updated, s_now);
        await db.Insertable(item).ExecuteCommandAsync();
        return item;
    }

    private static Task<int> CountAsync(SqlSugarClient db, string table)
        => db.Ado.GetIntAsync($"SELECT COUNT(*) FROM {table};");

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
