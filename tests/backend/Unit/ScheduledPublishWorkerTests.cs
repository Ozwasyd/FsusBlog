using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ScheduledPublishWorkerTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTimeOffset s_now = new(2026, 7, 19, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task PublishDueArticlesAsync_HoldsFamilyBeforeExecutingArticleRowClaim()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        InsertScheduledArticle(db, "source lock order", s_now.UtcDateTime.AddMinutes(-1));
        bool claimObserved = false;
        db.Aop.OnLogExecuting = (sql, _) =>
        {
            if (!sql.Contains("FOR UPDATE OF article SKIP LOCKED", StringComparison.OrdinalIgnoreCase))
                return;
            using var command = new NpgsqlCommand("""
                SELECT EXISTS (SELECT 1 FROM pg_locks
                    WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted
                        AND classid = 1179866444::oid AND objid = 1::oid AND objsubid = 2);
                """, (NpgsqlConnection)db.Ado.Connection, (NpgsqlTransaction)db.Ado.Transaction);
            Assert.True((bool)command.ExecuteScalar()!);
            claimObserved = true;
        };
        using ServiceProvider provider = CreateWorkerProvider(db);
        ScheduledPublishWorker worker = CreateWorker(provider);

        Assert.Equal(1, await worker.PublishDueArticlesAsync(CancellationToken.None));
        Assert.True(claimObserved);
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
    }

    [Fact]
    public async Task PublishDueArticlesAsync_CommitsPublishedStateAndOutboxWithoutSideEffectServices()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int dueArticleId = InsertScheduledArticle(db, "due", s_now.UtcDateTime.AddMinutes(-5));
        using ServiceProvider provider = CreateWorkerProvider(db);
        var logger = new CapturingLogger<ScheduledPublishWorker>();
        var worker = CreateWorker(provider, logger);

        int published = await worker.PublishDueArticlesAsync(CancellationToken.None);

        Assert.True(published == 1, string.Join(Environment.NewLine, logger.Messages));
        Article article = await db.Queryable<Article>().InSingleAsync(dueArticleId);
        ArticleMutationOutboxEvent outbox = Assert.Single(
            await db.Queryable<ArticleMutationOutboxEvent>().ToListAsync());
        Assert.Equal(1, published);
        Assert.Equal(ArticleStatus.Published, article.Status);
        Assert.Null(article.ScheduledPublishAt);
        Assert.NotNull(article.PublishedAt);
        ArticlePublicationRecord publication = Assert.Single(
            await db.Queryable<ArticlePublicationRecord>().ToListAsync());
        Assert.Equal(publication.Id, article.CurrentPublicationId);
        Assert.Equal(1, publication.PublicationNo);
        Assert.Equal("scheduled-publish", publication.TransitionKind);
        Assert.Equal(dueArticleId, outbox.AggregateId);
        Assert.Equal("article", outbox.AggregateType);
        Assert.Equal("scheduled-published", outbox.EventType);
        Assert.Equal("pending", outbox.Status);
        Assert.Equal(0, outbox.RetryCount);
        Assert.Equal(publication.ArticleRevisionId, outbox.ArticleRevisionId);
        Assert.Equal(publication.Id, outbox.ArticlePublicationId);
        Assert.Equal(publication.PublicationNo, outbox.PublicationNo);
        Assert.Contains($"\"articleId\":{dueArticleId}", outbox.PayloadJson, StringComparison.Ordinal);
        Assert.Contains("\"schemaVersion\":2", outbox.PayloadJson, StringComparison.Ordinal);
        Assert.Contains($"\"releaseId\":{publication.Id}", outbox.PayloadJson, StringComparison.Ordinal);

        Assert.Equal(0, await worker.PublishDueArticlesAsync(CancellationToken.None));
        Assert.Single(await db.Queryable<ArticleMutationOutboxEvent>().ToListAsync());
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(outbox.EventId, (await db.Queryable<ArticleSourceMutation>().SingleAsync()).EventId);
    }

    [Fact]
    public async Task PublishDueArticlesAsync_ClaimsDueRowsWithLockingBatchAndLeavesFutureRowsScheduled()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int[] dueIds = Enumerable.Range(0, 105)
            .Select(index => InsertScheduledArticle(
                db,
                $"due-{index:D3}",
                s_now.UtcDateTime.AddMinutes(-200 + index)))
            .ToArray();
        int futureId = InsertScheduledArticle(db, "future", s_now.UtcDateTime.AddHours(1));
        QueryPlanEvidence plan = await CaptureDueQueryPlanEvidenceAsync(db);
        var executedSql = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => executedSql.Add(sql);
        using ServiceProvider provider = CreateWorkerProvider(db);
        using SqlSugarClient concurrentDb = PostgresSqlSugarTestClient.Create(
            db.CurrentConnectionConfig.ConnectionString);
        using ServiceProvider concurrentProvider = CreateWorkerProvider(concurrentDb);
        var logger = new CapturingLogger<ScheduledPublishWorker>();
        var worker = CreateWorker(provider, logger);
        var concurrentWorker = CreateWorker(concurrentProvider);

        int[] firstPass = await Task.WhenAll(
            worker.PublishDueArticlesAsync(CancellationToken.None),
            concurrentWorker.PublishDueArticlesAsync(CancellationToken.None));
        int published = firstPass.Sum();
        int drained = await worker.PublishDueArticlesAsync(CancellationToken.None);

        Assert.InRange(published, 100, 105);
        Assert.Equal(105, published + drained);
        Assert.Equal(105, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(105, await db.Queryable<ArticleSourceMutation>().CountAsync());
        Assert.Equal(0, await db.Ado.GetIntAsync("""
            SELECT COUNT(*) FROM article_mutation_outbox event
            FULL JOIN article_source_mutation journal ON journal.event_id = event.event_id
            WHERE event.event_id IS NULL OR journal.event_id IS NULL;
            """));
        List<Article> dueArticles = await db.Queryable<Article>()
            .Where(article => dueIds.Contains(article.Id))
            .OrderBy(static article => article.Id)
            .ToListAsync();
        Article futureArticle = await db.Queryable<Article>().InSingleAsync(futureId);
        List<ArticleMutationOutboxEvent> outbox = await db.Queryable<ArticleMutationOutboxEvent>()
            .OrderBy(static item => item.AggregateId)
            .ToListAsync();
        string claimSql = executedSql.First(static sql =>
            sql.Contains("FOR UPDATE OF article SKIP LOCKED", StringComparison.OrdinalIgnoreCase));
        string candidateSql = executedSql.First(static sql =>
            sql.Contains("FROM due_articles", StringComparison.OrdinalIgnoreCase)
            && !sql.Contains("FOR UPDATE", StringComparison.OrdinalIgnoreCase));
        Assert.Contains("FOR UPDATE OF article SKIP LOCKED", claimSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("JOIN article_revision", claimSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("pending_publication_at", claimSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(ScheduledPublishQuery.ScheduledPredicateSql, claimSql, StringComparison.Ordinal);
        Assert.Contains(ScheduledPublishQuery.PendingPublicationPredicateSql, claimSql, StringComparison.Ordinal);
        Assert.Contains(ScheduledPublishQuery.ScheduledPredicateSql, candidateSql, StringComparison.Ordinal);
        Assert.Contains(ScheduledPublishQuery.PendingPublicationPredicateSql, candidateSql, StringComparison.Ordinal);
        Assert.Contains("ORDER BY due.due_at, article.id", claimSql, StringComparison.Ordinal);
        Assert.Contains($"ORDER BY {ScheduledPublishQuery.DueOrderSql}", candidateSql, StringComparison.Ordinal);
        Assert.DoesNotContain("idx_article_scheduled_publish_due_v2", plan.BaselinePlan, StringComparison.Ordinal);
        Assert.Contains("idx_article_scheduled_publish_due_v2", plan.IndexedPlan, StringComparison.Ordinal);
        Assert.True(
            plan.IndexedExecutionMilliseconds < plan.BaselineExecutionMilliseconds,
            $"Expected indexed due scan ({plan.IndexedExecutionMilliseconds:F3} ms) to beat baseline ({plan.BaselineExecutionMilliseconds:F3} ms).");
        Assert.True(plan.IndexBytes > 0);
        Assert.True(plan.IndexBytes < plan.ArticleBytes);
        Assert.False(plan.IndexExistsAfterRollback);
        Assert.Equal(dueIds.Order().ToArray(), outbox.Select(static item => item.AggregateId).Order().ToArray());
        Assert.Equal(outbox.Count, outbox.Select(static item => item.EventId).Distinct(StringComparer.Ordinal).Count());
        Assert.All(outbox, static item => Assert.Equal("scheduled-published", item.EventType));
        Assert.All(dueArticles, static article => Assert.Equal(ArticleStatus.Published, article.Status));
        Assert.Equal(ArticleStatus.Scheduled, futureArticle.Status);
        Assert.NotNull(futureArticle.ScheduledPublishAt);
    }

    [Fact]
    public async Task PublishDueArticlesAsync_DuePublishedRevision_SwitchesFromOldPublicationAtomically()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        DateTime dueAt = s_now.UtcDateTime.AddMinutes(-5);
        int articleId = InsertScheduledArticle(db, "published edit", dueAt);
        Article article = await db.Queryable<Article>().InSingleAsync(articleId);
        ArticleRightsSnapshot rights = await db.Queryable<ArticleRightsSnapshot>()
            .Where(snapshot => snapshot.ArticleId == articleId)
            .SingleAsync();
        long originalPublicationId = db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = articleId,
            PublicationNo = 1,
            ArticleRevisionId = article.CurrentRevisionId!.Value,
            RevisionNo = 1,
            RightsSnapshotId = rights.Id,
            TransitionKind = "immediate-publish",
            PublishedAt = dueAt.AddDays(-1),
            CreatedAt = dueAt.AddDays(-1)
        }).ExecuteReturnBigIdentity();
        db.Updateable<Article>()
            .SetColumns(current => new Article
            {
                Status = ArticleStatus.Published,
                ScheduledPublishAt = null,
                PendingPublicationAt = dueAt,
                CurrentPublicationId = originalPublicationId,
                PublishedAt = dueAt.AddDays(-1)
            })
            .Where(current => current.Id == articleId)
            .ExecuteCommand();
        using ServiceProvider provider = CreateWorkerProvider(db);
        var worker = CreateWorker(provider);

        int published = await worker.PublishDueArticlesAsync(CancellationToken.None);

        Article after = await db.Queryable<Article>().InSingleAsync(articleId);
        List<ArticlePublicationRecord> publications = await db.Queryable<ArticlePublicationRecord>()
            .Where(record => record.ArticleId == articleId)
            .OrderBy(record => record.PublicationNo)
            .ToListAsync();
        Assert.Equal(1, published);
        Assert.Equal([1, 2], publications.Select(static record => record.PublicationNo).ToArray());
        Assert.Equal(publications[1].Id, after.CurrentPublicationId);
        Assert.Null(after.PendingPublicationAt);
        Assert.Equal(ArticleStatus.Published, after.Status);
    }

    [Fact]
    public async Task PublishDueArticlesAsync_EstablishesDurableFenceBeforePublishingRow()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int dueArticleId = InsertScheduledArticle(db, "fenced", s_now.UtcDateTime.AddMinutes(-5));
        var mutationFence = Substitute.For<IArticlePublicMutationFence>();
        mutationFence
            .BeginPublicMutationFenceAsync(null, Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                Article beforeCommit = await db.Queryable<Article>().InSingleAsync(dueArticleId);
                Assert.Equal(ArticleStatus.Scheduled, beforeCommit.Status);
            });
        using ServiceProvider provider = CreateWorkerProvider(db, mutationFence);
        var worker = CreateWorker(provider);

        int published = await worker.PublishDueArticlesAsync(CancellationToken.None);

        Assert.Equal(1, published);
        Assert.Equal(ArticleStatus.Published, (await db.Queryable<Article>().InSingleAsync(dueArticleId)).Status);
        await mutationFence.Received(1)
            .BeginPublicMutationFenceAsync(null, Arg.Any<CancellationToken>());
        await mutationFence.Received(1)
            .CommitPublicMutationFenceAsync(
                null,
                "scheduled-published",
                CancellationToken.None);
        await mutationFence.DidNotReceive()
            .RecoverAbortedPublicMutationFenceAsync(
                null,
                Arg.Any<string>(),
                Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task PublishDueArticlesAsync_WhenFenceFails_LeavesRowScheduledAndWritesNoOutbox()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int dueArticleId = InsertScheduledArticle(db, "fence failure", s_now.UtcDateTime.AddMinutes(-5));
        var mutationFence = Substitute.For<IArticlePublicMutationFence>();
        mutationFence
            .BeginPublicMutationFenceAsync(null, Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new InvalidOperationException("revocation unavailable")));
        using ServiceProvider provider = CreateWorkerProvider(db, mutationFence);
        var worker = CreateWorker(provider);

        int published = await worker.PublishDueArticlesAsync(CancellationToken.None);

        Assert.Equal(0, published);
        Assert.Equal(ArticleStatus.Scheduled, (await db.Queryable<Article>().InSingleAsync(dueArticleId)).Status);
        Assert.Empty(await db.Queryable<ArticleMutationOutboxEvent>().ToListAsync());
        await mutationFence.DidNotReceive()
            .RecoverAbortedPublicMutationFenceAsync(
                null,
                Arg.Any<string>(),
                Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task PublishDueArticlesAsync_WhenScopeCreationFails_ReportsDegradedRuntimeState()
    {
        var scopeFactory = Substitute.For<IServiceScopeFactory>();
        scopeFactory.CreateScope().Returns(_ => throw new InvalidOperationException("scope unavailable"));
        var runtimeState = new ScheduledPublishRuntimeState();
        var worker = new ScheduledPublishWorker(
            scopeFactory,
            NullLogger<ScheduledPublishWorker>.Instance,
            new StaticTimeProvider(s_now),
            runtimeState,
            new TestBackgroundWorkerLease(),
            Substitute.For<IActiveReleaseTransactionalCommitGuard>());

        int published = await worker.PublishDueArticlesAsync(CancellationToken.None);

        ScheduledPublishRuntimeSnapshot snapshot = runtimeState.CreateSnapshot();
        Assert.Equal(0, published);
        Assert.Equal("degraded", snapshot.Status);
        Assert.Equal(1, snapshot.LastFailedCount);
        Assert.Equal(nameof(InvalidOperationException), snapshot.LastError);
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleResponsibilitySnapshot),
            typeof(ArticlePublicationRecord),
            typeof(ArticleMutationOutboxEvent));
        return db;
    }

    private static int InsertScheduledArticle(SqlSugarClient db, string title, DateTime scheduledAt)
    {
        int articleId = db.Insertable(new Article
        {
            Title = title,
            CategoryId = 1,
            Status = ArticleStatus.Scheduled,
            ScheduledPublishAt = scheduledAt,
            PublishedAt = null,
            CreateTime = scheduledAt.AddHours(-1),
            IsDeleted = false
        }).ExecuteReturnIdentity();
        long revisionId = db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 1,
            Title = title,
            CategoryId = 1,
            MarkdownContent = title,
            DiffSummary = "scheduled publish test",
            CreatedAt = scheduledAt.AddHours(-1)
        }).ExecuteReturnBigIdentity();
        db.Updateable<Article>()
            .SetColumns(article => article.CurrentRevisionId == revisionId)
            .Where(article => article.Id == articleId)
            .ExecuteCommand();
        db.Insertable(new ArticleRightsSnapshot
        {
            ArticleId = articleId,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            ArticleRightsPolicyId = 1,
            CreatedAt = scheduledAt.AddHours(-1)
        }).ExecuteCommand();
        return articleId;
    }

    private static async Task<QueryPlanEvidence> CaptureDueQueryPlanEvidenceAsync(SqlSugarClient db)
    {
        string connectionString = db.CurrentConnectionConfig.ConnectionString;
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article (title, categoryid, views, createtime, metadata_updated_at, status, isdeleted)
            SELECT 'published-plan-' || value, 1, 0, @Now, @Now, @PublishedStatus, false
            FROM generate_series(1, 50000) AS value;

            INSERT INTO article (title, categoryid, views, createtime, metadata_updated_at, status, scheduled_publish_at, isdeleted)
            SELECT 'future-plan-' || value, 1, 0, @Now, @Now, @ScheduledStatus, @FutureAt, false
            FROM generate_series(1, 20000) AS value;

            INSERT INTO article (title, categoryid, views, createtime, metadata_updated_at, status, scheduled_publish_at, isdeleted)
            SELECT 'deleted-plan-' || value, 1, 0, @Now, @Now, @ScheduledStatus, @DueAt, true
            FROM generate_series(1, 1000) AS value;

            CREATE INDEX IF NOT EXISTS idx_article_pending_publication_due
            ON article(pending_publication_at, id)
            WHERE isdeleted = false AND pending_publication_at IS NOT NULL;

            ANALYZE article;
            """,
            new SugarParameter("@Now", s_now.UtcDateTime.AddDays(-30)),
            new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
            new SugarParameter("@ScheduledStatus", (int)ArticleStatus.Scheduled),
            new SugarParameter("@FutureAt", s_now.UtcDateTime.AddDays(1)),
            new SugarParameter("@DueAt", s_now.UtcDateTime.AddDays(-1)));

        QueryPlanMeasurement baseline = await MeasureDueQueryAsync(connectionString);
        ISchemaMigrationDescriptor migration = ScheduledPublishIndexMigrationDefinitions.BuildMigration();
        Assert.False(migration.Transactional);
        Assert.Contains("CREATE INDEX CONCURRENTLY", ScheduledPublishIndexMigrationDefinitions.CreateIndexSql, StringComparison.Ordinal);
        Assert.Contains("DROP INDEX CONCURRENTLY", ScheduledPublishIndexMigrationDefinitions.RollbackIndexSql, StringComparison.Ordinal);
        await migration.Steps.Single().ExecuteAsync(db, CancellationToken.None);
        await db.Ado.ExecuteCommandAsync("ANALYZE article;");

        QueryPlanMeasurement indexed = await MeasureDueQueryAsync(connectionString);
        long indexBytes = await QueryInt64Async(
            connectionString,
            $"SELECT pg_relation_size('{ScheduledPublishIndexMigrationDefinitions.IndexName}');");
        long articleBytes = await QueryInt64Async(connectionString, "SELECT pg_relation_size('article');");

        await db.Ado.ExecuteCommandAsync(ScheduledPublishIndexMigrationDefinitions.RollbackIndexSql);
        bool indexExistsAfterRollback = await QueryInt64Async(
            connectionString,
            $"SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = '{ScheduledPublishIndexMigrationDefinitions.IndexName}';") > 0;

        return new QueryPlanEvidence(
            baseline.Plan,
            indexed.Plan,
            baseline.ExecutionMilliseconds,
            indexed.ExecutionMilliseconds,
            indexBytes,
            articleBytes,
            indexExistsAfterRollback);
    }

    private static async Task<QueryPlanMeasurement> MeasureDueQueryAsync(string connectionString)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using (var session = new NpgsqlCommand("SET jit = off;", connection))
        {
            await session.ExecuteNonQueryAsync();
        }

        await using var command = new NpgsqlCommand(
            $"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {ScheduledPublishQuery.LoadDueArticleIdsSql}",
            connection);
        command.Parameters.AddWithValue("ScheduledStatus", (int)ArticleStatus.Scheduled);
        command.Parameters.AddWithValue("PublishedStatus", (int)ArticleStatus.Published);
        command.Parameters.AddWithValue("Now", s_now.UtcDateTime);
        command.Parameters.AddWithValue("BatchSize", 100);
        var measurements = new List<(string Plan, double ExecutionMilliseconds)>(5);
        for (int iteration = 0; iteration < 5; iteration++)
        {
            object? raw = await command.ExecuteScalarAsync();
            string plan = Convert.ToString(raw, System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty;
            using System.Text.Json.JsonDocument document = System.Text.Json.JsonDocument.Parse(plan);
            measurements.Add((
                plan,
                document.RootElement[0].GetProperty("Execution Time").GetDouble()));
        }

        (string selectedPlan, double executionMilliseconds) = measurements
            .OrderBy(static measurement => measurement.ExecutionMilliseconds)
            .ElementAt(measurements.Count / 2);
        return new QueryPlanMeasurement(selectedPlan, executionMilliseconds);
    }

    private static async Task<long> QueryInt64Async(string connectionString, string sql)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        object? value = await command.ExecuteScalarAsync();
        return Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture);
    }

    private static ServiceProvider CreateWorkerProvider(
        ISqlSugarClient db,
        IArticlePublicMutationFence? mutationFence = null)
        => new ServiceCollection()
            .AddSingleton(db)
            .AddSingleton<ISqlSugarClient>(db)
            .AddSingleton<IDbConcurrencyGate, ImmediateDbConcurrencyGate>()
            .AddSingleton(mutationFence ?? Substitute.For<IArticlePublicMutationFence>())
            .BuildServiceProvider();

    private static ScheduledPublishWorker CreateWorker(
        ServiceProvider provider,
        ILogger<ScheduledPublishWorker>? logger = null)
        => new(
            provider.GetRequiredService<IServiceScopeFactory>(),
            logger ?? NullLogger<ScheduledPublishWorker>.Instance,
            new StaticTimeProvider(s_now),
            new ScheduledPublishRuntimeState(),
            new TestBackgroundWorkerLease(),
            Substitute.For<IActiveReleaseTransactionalCommitGuard>());

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
            => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            Messages.Add(formatter(state, exception));
            if (exception is not null)
            {
                Messages.Add(exception.ToString());
            }
        }
    }

    private sealed class StaticTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class ImmediateDbConcurrencyGate : IDbConcurrencyGate
    {
        public Task<T> ExecuteAsync<T>(
            string operation,
            Func<CancellationToken, Task<T>> action,
            Func<CancellationToken, Task<T>> onTimeout,
            CancellationToken cancellationToken = default)
            => action(cancellationToken);

        public DbConcurrencyGateSnapshot GetSnapshot() => new(1, 0, 0);
    }

    private sealed record QueryPlanMeasurement(string Plan, double ExecutionMilliseconds);

    private sealed record QueryPlanEvidence(
        string BaselinePlan,
        string IndexedPlan,
        double BaselineExecutionMilliseconds,
        double IndexedExecutionMilliseconds,
        long IndexBytes,
        long ArticleBytes,
        bool IndexExistsAfterRollback);

    private sealed class TestBackgroundWorkerLease : IBackgroundWorkerLease
    {
        public Task<bool> TryRunAsLeaderAsync(
            string workerName,
            Func<CancellationToken, Task> action,
            CancellationToken cancellationToken = default)
            => Task.FromResult(true);
    }
}
