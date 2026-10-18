using System.Data;
using System.Reflection;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleSourceMutationHooksIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTime s_now = new(2026, 10, 18, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task OriginalCreate_EnlistsActualEventWithoutCallerEnrollment_AndDoesNotPublishBeforeCommit()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await InstallLockOrderGuardAsync(db);
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        db.Ado.BeginTran(IsolationLevel.ReadCommitted);
        object original = db.Ado.Transaction;
        ArticleCreateMutationAuthority.Result created = await CreateAsync(db);
        Assert.Same(original, db.Ado.Transaction);
        Assert.Equal(new ArticleSourceCursor(created.ArticleId, 1, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, created.ArticleId));
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        Assert.Equal(0, await observer.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        db.Ado.CommitTran();
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        await AssertEveryEventEnrolledAsync(observer, 1);
    }

    [Fact]
    public async Task EnrollmentFailure_RollsBackOriginalCreateAndEveryEarlierEventInTheOwnerGroup()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await CreateAsync(db);
            await db.Ado.ExecuteCommandAsync("""
                CREATE FUNCTION fail_source_enrollment() RETURNS trigger AS $$
                BEGIN RAISE EXCEPTION 'forced enrollment failure'; END;
                $$ LANGUAGE plpgsql;
                CREATE TRIGGER fail_source_enrollment BEFORE INSERT ON article_source_mutation
                    FOR EACH ROW EXECUTE FUNCTION fail_source_enrollment();
                """);
            await CreateAsync(db);
        });
        Assert.False(transaction.IsSuccess);
        Assert.Contains("forced enrollment failure", transaction.ErrorException!.ToString());
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(0, await db.Queryable<Article>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleRevision>().CountAsync());
        await AssertEveryEventEnrolledAsync(db, 0);
    }

    [Fact]
    public async Task ActualContendingCreates_WaitForFamilyBeforeArticleLocks_AndAllocateInCommitOrder()
    {
        using SqlSugarClient first = await DatabaseAsync();
        await InstallLockOrderGuardAsync(first);
        using SqlSugarClient second = PostgresSqlSugarTestClient.Create(first.CurrentConnectionConfig.ConnectionString);
        first.Ado.BeginTran(IsolationLevel.ReadCommitted);
        ArticleCreateMutationAuthority.Result one = await CreateAsync(first);
        second.Ado.BeginTran(IsolationLevel.ReadCommitted);
        int pid = ((NpgsqlConnection)second.Ado.Connection).ProcessID;
        Task<ArticleCreateMutationAuthority.Result> waiting = CreateAsync(second);
        try
        {
            await AssertWaitingBeforeArticleLocksAsync(first.CurrentConnectionConfig.ConnectionString, pid);
            first.Ado.CommitTran();
            ArticleCreateMutationAuthority.Result two = await waiting;
            second.Ado.CommitTran();
            Assert.Equal(1, (await second.Queryable<ArticleSourceMutation>()
                .Where(row => row.EventId == one.Outbox.EventId).SingleAsync()).SourceGeneration);
            Assert.Equal(2, (await second.Queryable<ArticleSourceMutation>()
                .Where(row => row.EventId == two.Outbox.EventId).SingleAsync()).SourceGeneration);
            Assert.Equal(new ArticleSourceCursor(one.ArticleId, 2, 1),
                await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(second, one.ArticleId));
            Assert.Equal(new ArticleSourceCursor(two.ArticleId, 2, 1),
                await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(second, two.ArticleId));
            await AssertEveryEventEnrolledAsync(second, 2);
        }
        finally
        {
            if (first.Ado.Transaction is not null) first.Ado.RollbackTran();
            if (second.Ado.Transaction is not null) second.Ado.RollbackTran();
        }
    }

    [Fact]
    public async Task ActualCreate_CancellationDuringEnrollment_RollsBackArticleEventAndClockTogether()
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient blocker = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION pause_source_hook() RETURNS trigger AS $$
            BEGIN PERFORM pg_advisory_xact_lock(1179866444, 2); RETURN NEW; END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER pause_source_hook BEFORE INSERT ON article_source_mutation
                FOR EACH ROW EXECUTE FUNCTION pause_source_hook();
            """);
        blocker.Ado.BeginTran();
        await blocker.Ado.ExecuteCommandAsync("SELECT pg_advisory_xact_lock(1179866444, 2);");
        db.Ado.BeginTran();
        using var canceled = new CancellationTokenSource();
        Task<ArticleCreateMutationAuthority.Result> mutation = CreateAsync(db, canceled.Token);
        try
        {
            await WaitForAdvisoryWaitAsync(db.CurrentConnectionConfig.ConnectionString,
                ((NpgsqlConnection)db.Ado.Connection).ProcessID);
            Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(blocker));
            canceled.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => mutation);
            db.Ado.RollbackTran();
            blocker.Ado.RollbackTran();
            using SqlSugarClient restarted = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
            Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(restarted));
            Assert.Equal(0, await restarted.Queryable<Article>().CountAsync());
            Assert.Equal(0, await restarted.Queryable<ArticleBody>().CountAsync());
            await AssertEveryEventEnrolledAsync(restarted, 0);
        }
        finally
        {
            canceled.Cancel();
            if (db.Ado.Transaction is not null) db.Ado.RollbackTran();
            if (blocker.Ado.Transaction is not null) blocker.Ado.RollbackTran();
        }
    }

    [Fact]
    public async Task LifecycleGroup_AllNineOriginalTransitionsEnrollWithoutManualRecording()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await InstallLockOrderGuardAsync(db);
        long admin = await db.Insertable(new AdminPrincipal
        {
            Handle = "source-hooks-admin", DisplayName = "Source hooks test",
            Status = AdminPrincipalStatus.Active,
            Permissions = string.Join('\n', AdminPermissions.ArticleWrite, AdminPermissions.ArticlePublish),
            CreatedAtUtc = s_now
        }).ExecuteReturnBigIdentityAsync();
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            ArticleLifecycleTransitionWriter.Result current = await ArticleLifecycleTransitionWriter.CreateAsync(
                db, Configuration(), new ArticleLifecycleTransitionWriter.CreateRequest(
                    "source hooks", "# source", "summary", null, 1, [], ArticleStatus.Draft, null,
                    s_now, admin, null, Responsibility(), "source-hooks"));
            long initial = current.Version.RevisionId;
            foreach (ArticleStatus target in new[] { ArticleStatus.Draft, ArticleStatus.Published, ArticleStatus.Scheduled })
                current = await UpdateAsync(db, current, admin, target);
            current = await ArticleLifecycleTransitionWriter.PublishScheduledAsync(db, Configuration(),
                new(current.ArticleId, current.Version.RevisionId, s_now.AddMinutes(1), admin, "source-hooks"));
            current = await UpdateAsync(db, current, admin, ArticleStatus.Archived);
            current = await ArticleLifecycleTransitionWriter.DeleteAsync(db, Configuration(),
                new(current.ArticleId, current.Version.RevisionId, s_now.AddMinutes(2), admin, "source-hooks"));
            current = await ArticleLifecycleTransitionWriter.RestoreAsync(db, Configuration(),
                new(current.ArticleId, current.Version.RevisionId, s_now.AddMinutes(3), admin, "source-hooks"));
            await ArticleLifecycleTransitionWriter.RollbackAsync(db, Configuration(),
                new(current.ArticleId, current.Version.RevisionId, initial, s_now.AddMinutes(4), admin,
                    "original source rollback", "source-hooks"));
        });
        Assert.True(transaction.IsSuccess, transaction.ErrorException?.ToString());
        await AssertEveryEventEnrolledAsync(db, 9);
        Assert.Equal(9, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(9, (await db.Queryable<ArticleSourceSequence>().SingleAsync()).SourceSequence);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OriginalDdl_IsIdempotentAndTransactional_AndEnforcesSingletonCountersAndUniqueness(bool codeFirst)
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        db.Ado.BeginTran();
        await ApplySourceDdlAsync(db);
        db.Ado.RollbackTran();
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public';"));
        if (codeFirst)
            PostgresSqlSugarTestClient.InitTables(db,
                typeof(ArticleSourceGeneration), typeof(ArticleSourceSequence), typeof(ArticleSourceMutation));
        await ApplySourceDdlAsync(db);
        await ApplySourceDdlAsync(db);
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        foreach (string sql in new[]
        {
            "INSERT INTO article_source_generation VALUES (2, 1);",
            "INSERT INTO article_source_generation VALUES (1, 0);",
            "INSERT INTO article_source_sequence VALUES (0, 1);",
            "INSERT INTO article_source_sequence VALUES (1, 0);",
            "INSERT INTO article_source_mutation VALUES ('bad', 1, 1, 2, '{}');"
        })
        {
            PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => db.Ado.ExecuteCommandAsync(sql));
            Assert.Equal(PostgresErrorCodes.CheckViolation, error.SqlState);
        }
        await db.Ado.ExecuteCommandAsync("INSERT INTO article_source_mutation VALUES ('one', 1, 1, 1, '{}');");
        foreach (string sql in new[]
        {
            "INSERT INTO article_source_mutation VALUES ('one', 2, 2, 1, '{}');",
            "INSERT INTO article_source_mutation VALUES ('two', 2, 1, 1, '{}');",
            "INSERT INTO article_source_mutation VALUES ('two', 1, 2, 1, '{}');"
        })
        {
            PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => db.Ado.ExecuteCommandAsync(sql));
            Assert.Equal(PostgresErrorCodes.UniqueViolation, error.SqlState);
        }
    }

    [Fact]
    public async Task ImportedHistory_OriginalBypassMustPreserveCurrentCoordinatesAndEnrollItsOwnEvent()
    {
        using SqlSugarClient db = await DatabaseAsync();
        ArticleCreateMutationAuthority.Result? created = null;
        var seed = await db.Ado.UseTranAsync(async () => created = await CreateAsync(db));
        Assert.True(seed.IsSuccess, seed.ErrorException?.ToString());
        var service = new AuthoringContentTransferService(db, Substitute.For<IArticleCoreService>(),
            Configuration(), Substitute.For<IAuthoringPrepublishPolicy>(), Substitute.For<IAuthoringAuditWriter>(),
            NullLogger<AuthoringContentTransferService>.Instance);
        var metadata = new ContentExportMetadataResponse(created!.ArticleId, 1, [], ArticleStatus.Draft,
            null, null, 1, [new(2, "imported history", "# imported", null, null, 1, [], "import", s_now)]);
        MethodInfo restore = typeof(AuthoringContentTransferService).GetMethod("RestoreImportedRevisionsAsync",
            BindingFlags.Instance | BindingFlags.NonPublic)!;
        try
        {
            await (Task<int>)restore.Invoke(service, [created.ArticleId, metadata, CancellationToken.None])!;
        }
        catch
        {
            using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
            Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
            await AssertEveryEventEnrolledAsync(observer, 1);
            Assert.Equal(1, await observer.Queryable<ArticleRevision>()
                .Where(row => row.Id == created.Revision.Id).CountAsync());
            throw;
        }
        // A real PG counterexample: restoring history currently deletes the immutable current
        // revision without producing an outbox event. This obligation must remain red until
        // the original import owner supplies valid retained coordinates and an actual event.
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        await AssertEveryEventEnrolledAsync(db, 2);
        Assert.Equal(1, await db.Queryable<ArticleRevision>().Where(row => row.Id == created.Revision.Id).CountAsync());
    }

    [Theory]
    [InlineData(IsolationLevel.RepeatableRead)]
    [InlineData(IsolationLevel.Serializable)]
    public async Task OriginalMigrationIsolation_IsAcceptedByItsOwnerButRefusedBySourceAuthority(IsolationLevel isolation)
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran(isolation);
        try
        {
            ArticlePreservationStorageWriter.RequireSession((NpgsqlConnection)db.Ado.Connection,
                (NpgsqlTransaction)db.Ado.Transaction);
            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
                () => ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db));
            Assert.Equal("article_source_transaction_isolation_unsupported", error.Message);
        }
        finally
        {
            db.Ado.RollbackTran();
        }
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
    }

    private static async Task ApplySourceDdlAsync(SqlSugarClient db)
    {
        foreach (SchemaMigrationStep step in ArticleSourceGenerationMigrationDefinitions.BuildMigration().Steps)
            await step.ExecuteAsync(db, CancellationToken.None);
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

    private static Task<ArticleCreateMutationAuthority.Result> CreateAsync(SqlSugarClient db,
        CancellationToken cancellationToken = default)
        => ArticleCreateMutationAuthority.ExecuteAsync(db, new(
            "source hook test", "# source", "summary", null, 1, [], ArticleStatus.Draft,
            null, null, null, null, null, s_now, ArticleProductionNormalizers.NormalizeArticleRights(null),
            1, "initial source", ArticleMutationEventTypes.Created, ArticlePublicationTransitionKinds.SaveDraft,
            new ArticleMutationScopeSnapshot(1, [], "draft")), cancellationToken);

    private static Task<ArticleLifecycleTransitionWriter.Result> UpdateAsync(SqlSugarClient db,
        ArticleLifecycleTransitionWriter.Result current, long admin, ArticleStatus target)
        => ArticleLifecycleTransitionWriter.UpdateAsync(db, Configuration(), new(
            current.ArticleId, current.Version.RevisionId, "source hook update", "# updated", "summary", null,
            1, [], target, target == ArticleStatus.Scheduled ? s_now.AddMinutes(1) : null, s_now,
            admin, null, Responsibility(), target switch
            {
                ArticleStatus.Published => ArticlePublicationTransitionKinds.ImmediatePublish,
                ArticleStatus.Scheduled => ArticlePublicationTransitionKinds.Schedule,
                ArticleStatus.Archived => ArticlePublicationTransitionKinds.Archive,
                _ => ArticlePublicationTransitionKinds.SaveDraft
            }, "source-hooks"));

    private static ArticleResponsibilityDraft Responsibility()
        => new(true, [new ArticleResponsiblePerson("Source hooks author", null)], null, [], "source-hooks",
            "source-hooks-test", null, null, null, null, null, true, false, false, false, 0);

    private static IConfiguration Configuration()
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Audit:TamperEvidenceKey"] = "source-hooks-test-signing-key-0123456789"
        }).Build();

    private static async Task AssertEveryEventEnrolledAsync(ISqlSugarClient db, int expected)
    {
        Assert.Equal(expected, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        Assert.Equal(expected, await db.Queryable<ArticleSourceMutation>().CountAsync());
        Assert.Equal(0, await db.Ado.GetIntAsync("""
            SELECT COUNT(*) FROM article_mutation_outbox event
            FULL JOIN article_source_mutation journal ON journal.event_id = event.event_id
            WHERE event.event_id IS NULL OR journal.event_id IS NULL
                OR journal.article_id <> event.aggregate_id;
            """));
    }

    private static Task<int> InstallLockOrderGuardAsync(ISqlSugarClient db)
        => db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION require_source_family_lock() RETURNS trigger AS $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid()
                    AND locktype = 'advisory' AND granted AND mode = 'ExclusiveLock'
                    AND classid = 1179866444::oid AND objid = 1::oid AND objsubid = 2) THEN
                    RAISE EXCEPTION 'article mutation preceded source family lock';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER require_source_family_lock BEFORE INSERT OR UPDATE ON article
                FOR EACH ROW EXECUTE FUNCTION require_source_family_lock();
            """);

    private static async Task AssertWaitingBeforeArticleLocksAsync(string connectionString, int pid)
    {
        await WaitForAdvisoryWaitAsync(connectionString, pid);
        await using var monitor = new NpgsqlConnection(connectionString);
        await monitor.OpenAsync();
        await using var command = new NpgsqlCommand("""
            SELECT COUNT(*) FROM pg_locks WHERE pid = @Pid AND granted
                AND (relation = 'article'::regclass OR locktype = 'advisory');
            """, monitor);
        command.Parameters.AddWithValue("Pid", pid);
        Assert.Equal(0L, (long)(await command.ExecuteScalarAsync())!);
    }

    private static async Task WaitForAdvisoryWaitAsync(string connectionString, int pid)
    {
        await using var monitor = new NpgsqlConnection(connectionString);
        await monitor.OpenAsync();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var command = new NpgsqlCommand("""
            SELECT EXISTS (SELECT 1 FROM pg_locks
                WHERE pid = @Pid AND locktype = 'advisory' AND NOT granted);
            """, monitor);
        command.Parameters.AddWithValue("Pid", pid);
        while (!(bool)(await command.ExecuteScalarAsync(deadline.Token))!)
        {
            await Task.Yield();
            deadline.Token.ThrowIfCancellationRequested();
        }
    }
}
