using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Operations;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ScheduledPublishWorkerTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task PublishDueArticlesAsync_CommitsPublishedStateAndOutboxWithoutSideEffectServices()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int dueArticleId = InsertScheduledArticle(db, "due", DateTime.UtcNow.AddMinutes(-5));
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
        Assert.Equal(dueArticleId, outbox.AggregateId);
        Assert.Equal("article", outbox.AggregateType);
        Assert.Equal("scheduled-published", outbox.EventType);
        Assert.Equal("pending", outbox.Status);
        Assert.Equal(0, outbox.RetryCount);
        Assert.Contains($"\"articleId\":{dueArticleId}", outbox.PayloadJson, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PublishDueArticlesAsync_ClaimsDueRowsWithLockingBatchAndLeavesFutureRowsScheduled()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int firstDueId = InsertScheduledArticle(db, "first", DateTime.UtcNow.AddMinutes(-10));
        int secondDueId = InsertScheduledArticle(db, "second", DateTime.UtcNow.AddMinutes(-5));
        int futureId = InsertScheduledArticle(db, "future", DateTime.UtcNow.AddHours(1));
        var executedSql = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => executedSql.Add(sql);
        using ServiceProvider provider = CreateWorkerProvider(db);
        var logger = new CapturingLogger<ScheduledPublishWorker>();
        var worker = CreateWorker(provider, logger);

        int published = await worker.PublishDueArticlesAsync(CancellationToken.None);

        Assert.True(published == 2, string.Join(Environment.NewLine, logger.Messages));
        List<Article> articles = await db.Queryable<Article>().OrderBy(static article => article.Id).ToListAsync();
        List<ArticleMutationOutboxEvent> outbox = await db.Queryable<ArticleMutationOutboxEvent>()
            .OrderBy(static item => item.AggregateId)
            .ToListAsync();
        string claimSql = Assert.Single(executedSql, static sql =>
            sql.Contains("UPDATE article", StringComparison.OrdinalIgnoreCase));
        Assert.Contains("FOR UPDATE SKIP LOCKED", claimSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("RETURNING id", claimSql, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(2, published);
        Assert.Equal([firstDueId, secondDueId], outbox.Select(static item => item.AggregateId).ToArray());
        Assert.All(outbox, static item => Assert.Equal("scheduled-published", item.EventType));
        Assert.Equal(ArticleStatus.Published, articles.Single(article => article.Id == firstDueId).Status);
        Assert.Equal(ArticleStatus.Published, articles.Single(article => article.Id == secondDueId).Status);
        Assert.Equal(ArticleStatus.Scheduled, articles.Single(article => article.Id == futureId).Status);
        Assert.NotNull(articles.Single(article => article.Id == futureId).ScheduledPublishAt);
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
            TimeProvider.System,
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
        PostgresSqlSugarTestClient.InitTables(db, typeof(Article), typeof(ArticleMutationOutboxEvent));
        return db;
    }

    private static int InsertScheduledArticle(SqlSugarClient db, string title, DateTime scheduledAt)
        => db.Insertable(new Article
        {
            Title = title,
            CategoryId = 1,
            Status = ArticleStatus.Scheduled,
            ScheduledPublishAt = scheduledAt,
            PublishedAt = null,
            CreateTime = scheduledAt.AddHours(-1),
            IsDeleted = false
        }).ExecuteReturnIdentity();

    private static ServiceProvider CreateWorkerProvider(ISqlSugarClient db)
        => new ServiceCollection()
            .AddSingleton(db)
            .AddSingleton<ISqlSugarClient>(db)
            .AddSingleton<IDbConcurrencyGate, ImmediateDbConcurrencyGate>()
            .BuildServiceProvider();

    private static ScheduledPublishWorker CreateWorker(
        ServiceProvider provider,
        ILogger<ScheduledPublishWorker>? logger = null)
        => new(
            provider.GetRequiredService<IServiceScopeFactory>(),
            logger ?? NullLogger<ScheduledPublishWorker>.Instance,
            TimeProvider.System,
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

    private sealed class TestBackgroundWorkerLease : IBackgroundWorkerLease
    {
        public Task<bool> TryRunAsLeaderAsync(
            string workerName,
            Func<CancellationToken, Task> action,
            CancellationToken cancellationToken = default)
            => Task.FromResult(true);
    }
}
