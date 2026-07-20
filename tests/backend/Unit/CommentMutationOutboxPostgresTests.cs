using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CommentMutationOutboxPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task AuthoritativeMutationAndOutbox_RollBackTogetherAtCrashBoundary()
    {
        string connectionString = await CreateDatabaseAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        var writer = new CommentMutationOutboxWriter(db);

        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await db.Insertable(CreateComment(501)).ExecuteCommandAsync();
            await writer.EnqueueAsync(CreateEvent(501));
            throw new InvalidOperationException("simulated-crash-before-commit");
        });

        Assert.False(transaction.IsSuccess);
        Assert.Equal(0, db.Queryable<Comment>().Count());
        Assert.Equal(0, db.Queryable<CommentMutationOutboxEvent>().Count());
    }

    [Fact]
    public async Task CommittedMutation_PersistsMinimalRecoverableEventAcrossRestart()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient firstProcess = PostgresSqlSugarTestClient.Create(connectionString))
        {
            var writer = new CommentMutationOutboxWriter(firstProcess);
            var transaction = await firstProcess.Ado.UseTranAsync(async () =>
            {
                await firstProcess.Insertable(CreateComment(502)).ExecuteCommandAsync();
                CommentMutationOutboxEvent item = CreateEvent(502);
                item.PayloadJson = "{\"content\":\"must-not-persist\",\"anonymousProof\":\"secret\"}";
                await writer.EnqueueAsync(item);
            });
            Assert.True(transaction.IsSuccess);
        }

        using SqlSugarClient restartedProcess = PostgresSqlSugarTestClient.Create(connectionString);
        CommentMutationOutboxEvent persisted = Assert.Single(restartedProcess.Queryable<CommentMutationOutboxEvent>().ToList());
        Assert.Equal(CommentMutationOutboxStatus.Pending, persisted.Status);
        Assert.Equal("{}", persisted.PayloadJson);
        Assert.Equal(502, persisted.CommentId);
        Assert.False(string.IsNullOrWhiteSpace(persisted.EventId));
    }

    [Fact]
    public async Task DeliveryCheckpoint_RejectsDuplicateEventConsumerPair()
    {
        string connectionString = await CreateDatabaseAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        await db.Insertable(CreateComment(503)).ExecuteCommandAsync();
        var writer = new CommentMutationOutboxWriter(db);
        await writer.EnqueueAsync(CreateEvent(503));
        long outboxId = db.Queryable<CommentMutationOutboxEvent>().Single().Id;
        var checkpoint = new CommentMutationOutboxDelivery
        {
            OutboxEventId = outboxId,
            ConsumerName = "site-notification",
            Status = CommentMutationOutboxDeliveryStatus.Completed
        };

        await db.Insertable(checkpoint).ExecuteCommandAsync();
        await Assert.ThrowsAnyAsync<Exception>(() => db.Insertable(new CommentMutationOutboxDelivery
        {
            OutboxEventId = outboxId,
            ConsumerName = checkpoint.ConsumerName,
            Status = CommentMutationOutboxDeliveryStatus.Completed
        }).ExecuteCommandAsync());
    }

    [Fact]
    public async Task Worker_ReclaimsExpiredLeaseRetriesTemporaryFailureAndSkipsCompletedConsumerOnDuplicate()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setupDb.Insertable(CreateComment(504)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(504);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            item.Status = CommentMutationOutboxStatus.Processing;
            item.ClaimToken = "crashed-process";
            item.LeaseExpiresAt = DateTime.UtcNow.AddMinutes(-1);
            await setupDb.Insertable(item).ExecuteCommandAsync();
        }

        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        int attempts = 0;
        invalidations.InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                attempts++;
                return attempts == 1
                    ? Task.FromException(new TimeoutException("temporary-cache-outage"))
                    : Task.CompletedTask;
            });
        var services = new ServiceCollection();
        services.AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connectionString));
        services.AddSingleton(invalidations);
        services.AddSingleton(Substitute.For<ICommentNotificationService>());
        using ServiceProvider provider = services.BuildServiceProvider();
        var state = new CommentMutationOutboxRuntimeState();
        var worker = new CommentMutationOutboxWorker(
            provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(),
            state,
            TimeProvider.System,
            new ConfigurationBuilder().Build(),
            NullLogger<CommentMutationOutboxWorker>.Instance);

        Assert.Equal(0, await worker.ProcessPendingAsync(CancellationToken.None));
        using (SqlSugarClient afterFailure = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CommentMutationOutboxEvent failed = afterFailure.Queryable<CommentMutationOutboxEvent>().Single();
            Assert.Equal(CommentMutationOutboxStatus.Failed, failed.Status);
            Assert.Equal(1, failed.AttemptCount);
            Assert.Contains("TimeoutException", failed.LastError, StringComparison.Ordinal);
            afterFailure.Ado.ExecuteCommand(
                "UPDATE comment_mutation_outbox SET next_attempt_at = @Now WHERE id = @Id;",
                new SugarParameter("@Now", DateTime.UtcNow.AddMinutes(-1)),
                new SugarParameter("@Id", failed.Id));
        }

        Assert.Equal(1, await worker.ProcessPendingAsync(CancellationToken.None));
        using (SqlSugarClient duplicate = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CommentMutationOutboxEvent processed = duplicate.Queryable<CommentMutationOutboxEvent>().Single();
            Assert.Equal(CommentMutationOutboxStatus.Processed, processed.Status);
            List<CommentMutationOutboxDelivery> checkpoints = duplicate.Queryable<CommentMutationOutboxDelivery>().ToList();
            Assert.Equal(3, checkpoints.Count);
            CommentMutationOutboxDelivery checkpoint = Assert.Single(
                checkpoints,
                static item => item.ConsumerName == "cache-version");
            Assert.Equal(CommentMutationOutboxDeliveryStatus.Completed, checkpoint.Status);
            Assert.Equal(2, checkpoint.AttemptCount);
            duplicate.Ado.ExecuteCommand(
                "UPDATE comment_mutation_outbox SET status = 'pending', next_attempt_at = @Now, processed_at_utc = NULL WHERE id = @Id;",
                new SugarParameter("@Now", DateTime.UtcNow.AddMinutes(-1)),
                new SugarParameter("@Id", processed.Id));
        }

        Assert.Equal(1, await worker.ProcessPendingAsync(CancellationToken.None));
        Assert.Equal(2, attempts);
        await invalidations.Received(2).InvalidateCommentMutationAsync(
            Arg.Any<CommentCacheInvalidationScope?>(),
            Arg.Any<CancellationToken>());
        Assert.Equal(2, state.CreateSnapshot().ProcessedCount);
    }

    private async Task<string> CreateDatabaseAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Comment),
            typeof(CommentMutationOutboxEvent),
            typeof(CommentMutationOutboxDelivery));
        return connectionString;
    }

    private static Comment CreateComment(long id)
        => new()
        {
            Id = id,
            ArticleId = 42,
            Content = "authoritative-comment-content",
            CreateTime = DateTime.UtcNow,
            AuthorMode = "public",
            PublicHandle = "writer",
            ModerationStatus = CommentModerationStatus.Approved
        };

    private static CommentMutationOutboxEvent CreateEvent(long commentId)
        => new()
        {
            EventType = CommentMutationEventTypes.Created,
            CommentId = commentId,
            ArticleId = 42,
            RootId = commentId,
            AccountId = 7,
            NextStatus = CommentModerationStatus.Approved,
            OccurredAtUtc = DateTime.UtcNow
        };
}
