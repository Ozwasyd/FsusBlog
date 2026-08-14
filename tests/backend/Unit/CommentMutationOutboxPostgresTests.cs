using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Governance;

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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "transactional-rollback-boundary")]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
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
            CreateSlowExecutionLeaseConfiguration(),
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

    [Fact]
    public async Task Worker_ClaimsEachBatchEventWithIndependentOwnerBoundLease()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(505)).ExecuteCommandAsync();
            await setup.Insertable(CreateComment(506)).ExecuteCommandAsync();
            CommentMutationOutboxEvent first = CreateEvent(505);
            CommentMutationOutboxEvent second = CreateEvent(506);
            first.EventType = CommentMutationEventTypes.VisibilityChanged;
            second.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(new[] { first, second }).ExecuteCommandAsync();
        }

        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        invalidations.InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                entered.TrySetResult();
                await release.Task;
            });
        var services = new ServiceCollection();
        services.AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connectionString));
        services.AddSingleton(invalidations);
        services.AddSingleton(Substitute.For<ICommentNotificationService>());
        using ServiceProvider provider = services.BuildServiceProvider();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CommentMutationOutbox:ClaimLeaseSeconds"] = "30",
            ["CommentMutationOutbox:HeartbeatSeconds"] = "1"
        }).Build();
        var state = new CommentMutationOutboxRuntimeState();
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), state, TimeProvider.System,
            configuration, NullLogger<CommentMutationOutboxWorker>.Instance);

        Task<int> processing = worker.ProcessPendingAsync(CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        List<CommentMutationOutboxEvent> events = verify.Queryable<CommentMutationOutboxEvent>().OrderBy(item => item.Id).ToList();
        Assert.Equal(2, events.Count);
        Assert.All(events, item =>
        {
            Assert.Equal(CommentMutationOutboxStatus.Processing, item.Status);
            Assert.False(string.IsNullOrWhiteSpace(item.ClaimToken));
            Assert.False(string.IsNullOrWhiteSpace(item.ClaimedBy));
            Assert.Equal(1, item.LeaseGeneration);
            Assert.NotNull(item.LastHeartbeatAt);
        });
        Assert.NotEqual(events[0].ClaimToken, events[1].ClaimToken);
        release.TrySetResult();
        Assert.Equal(2, await processing);
    }

    [Fact]
    public async Task Worker_OverProductionLease_RenewsEveryBatchEventBeforeItStartsProcessing()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(507)).ExecuteCommandAsync();
            await setup.Insertable(CreateComment(508)).ExecuteCommandAsync();
            CommentMutationOutboxEvent first = CreateEvent(507);
            CommentMutationOutboxEvent second = CreateEvent(508);
            first.EventType = CommentMutationEventTypes.VisibilityChanged;
            second.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(new[] { first, second }).ExecuteCommandAsync();
        }

        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        invalidations.InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                entered.TrySetResult();
                await release.Task;
            });
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var state = new CommentMutationOutboxRuntimeState();
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), state, TimeProvider.System,
            new ConfigurationBuilder().Build(), NullLogger<CommentMutationOutboxWorker>.Instance);

        Task<int> processing = worker.ProcessPendingAsync(CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await Task.Delay(TimeSpan.FromSeconds(65));
        using (SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CommentMutationOutboxEvent second = verify.Queryable<CommentMutationOutboxEvent>()
                .Single(item => item.CommentId == 508);
            Assert.Equal(CommentMutationOutboxStatus.Processing, second.Status);
            Assert.True(second.LeaseExpiresAt > DateTime.UtcNow.AddSeconds(30));
            Assert.True(second.LastHeartbeatAt > second.ClaimedAt);
        }
        CommentMutationOutboxRuntimeSnapshot inFlight = state.CreateSnapshot();
        Assert.Equal(2, inFlight.OwnedCount);
        Assert.True(inFlight.RenewedCount >= 2);
        Assert.True(inFlight.OldestLeaseAgeSeconds >= 50);

        release.TrySetResult();
        Assert.Equal(2, await processing);
    }

    [Fact]
    public async Task Worker_OwnershipChecksBeforeFirstHeartbeatDoNotRenewLeaseMetrics()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(516)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(516);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
        }

        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        invalidations.InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                entered.TrySetResult();
                await release.Task;
            });
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CommentMutationOutbox:ClaimLeaseSeconds"] = "30",
            ["CommentMutationOutbox:HeartbeatSeconds"] = "9"
        }).Build();
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var state = new CommentMutationOutboxRuntimeState();
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), state, TimeProvider.System, configuration,
            NullLogger<CommentMutationOutboxWorker>.Instance);

        Task<int> processing = worker.ProcessPendingAsync(CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await Task.Delay(TimeSpan.FromMilliseconds(500));

        CommentMutationOutboxRuntimeSnapshot snapshot = state.CreateSnapshot();
        Assert.Equal(0, snapshot.RenewedCount);
        using (SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CommentMutationOutboxEvent claim = verify.Queryable<CommentMutationOutboxEvent>().Single();
            Assert.Equal(claim.ClaimedAt, claim.LastHeartbeatAt);
        }

        release.TrySetResult();
        Assert.Equal(1, await processing);
    }

    [Fact]
    public async Task Worker_ClaimLostAfterConsumer_DoesNotRunNextConsumerOrOverwriteNewOwner()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(509)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(509);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
        }

        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        invalidations.InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                entered.TrySetResult();
                await release.Task;
            });
        ICommentNotificationService notifications = Substitute.For<ICommentNotificationService>();
        var services = new ServiceCollection();
        services.AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connectionString));
        services.AddSingleton(invalidations);
        services.AddSingleton(notifications);
        using ServiceProvider provider = services.BuildServiceProvider();
        var state = new CommentMutationOutboxRuntimeState();
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), state, TimeProvider.System,
            new ConfigurationBuilder().Build(), NullLogger<CommentMutationOutboxWorker>.Instance);

        Task<int> processing = worker.ProcessPendingAsync(CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        using (SqlSugarClient takeover = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CommentMutationOutboxEvent claimed = takeover.Queryable<CommentMutationOutboxEvent>().Single();
            takeover.Ado.ExecuteCommand(
                "UPDATE comment_mutation_outbox SET claim_token = 'new-owner-token', claimed_by = 'new-owner', lease_generation = lease_generation + 1 WHERE id = @Id;",
                new SugarParameter("@Id", claimed.Id));
        }

        release.TrySetResult();
        Assert.Equal(0, await processing);
        await notifications.DidNotReceiveWithAnyArgs().PublishAddedAsync(default!, default, default!);
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        CommentMutationOutboxEvent after = verify.Queryable<CommentMutationOutboxEvent>().Single();
        Assert.Equal(CommentMutationOutboxStatus.Processing, after.Status);
        Assert.Equal("new-owner-token", after.ClaimToken);
        Assert.Equal("new-owner", after.ClaimedBy);
        CommentMutationOutboxDelivery delivery = verify.Queryable<CommentMutationOutboxDelivery>().Single();
        Assert.Equal(CommentMutationOutboxDeliveryStatus.Processing, delivery.Status);
        Assert.NotEqual("new-owner-token", delivery.OwnerClaimToken);
        Assert.Equal(1, state.CreateSnapshot().LostCount);
    }

    [Fact]
    public async Task Worker_HeartbeatZeroRowStopsSideEffectsBeforeLeaseSafetyMarginExpires()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(511)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(511);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
        }

        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        invalidations.InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                entered.TrySetResult();
                await release.Task;
            });
        ICommentNotificationService notifications = Substitute.For<ICommentNotificationService>();
        var services = new ServiceCollection();
        services.AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connectionString));
        services.AddSingleton(invalidations);
        services.AddSingleton(notifications);
        using ServiceProvider provider = services.BuildServiceProvider();
        var state = new CommentMutationOutboxRuntimeState();
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CommentMutationOutbox:ClaimLeaseSeconds"] = "30",
            ["CommentMutationOutbox:HeartbeatSeconds"] = "1"
        }).Build();
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(), Substitute.For<IBackgroundWorkerLease>(),
            state, TimeProvider.System, configuration, NullLogger<CommentMutationOutboxWorker>.Instance);

        Task<int> processing = worker.ProcessPendingAsync(CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        using (SqlSugarClient disconnect = PostgresSqlSugarTestClient.Create(connectionString))
        {
            disconnect.Ado.ExecuteCommand("UPDATE comment_mutation_outbox SET claim_token = 'reclaimed-before-expiry' WHERE status = 'processing';");
        }
        await Task.Delay(TimeSpan.FromSeconds(2));
        Assert.Equal(1, state.CreateSnapshot().LostCount);
        release.TrySetResult();
        Assert.Equal(0, await processing);
        await notifications.DidNotReceiveWithAnyArgs().PublishAddedAsync(default!, default, default);
    }

    [Fact]
    public async Task Worker_HeartbeatDatabaseExceptionStopsSideEffectsBeforeLeaseSafetyMarginExpires()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(512)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(512);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
        }

        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        invalidations.InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                entered.TrySetResult();
                await release.Task;
            });
        ICommentNotificationService notifications = Substitute.For<ICommentNotificationService>();
        var services = new ServiceCollection();
        services.AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connectionString));
        services.AddSingleton(invalidations);
        services.AddSingleton(notifications);
        using ServiceProvider provider = services.BuildServiceProvider();
        var state = new CommentMutationOutboxRuntimeState();
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CommentMutationOutbox:ClaimLeaseSeconds"] = "30",
            ["CommentMutationOutbox:HeartbeatSeconds"] = "1"
        }).Build();
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(), Substitute.For<IBackgroundWorkerLease>(),
            state, TimeProvider.System, configuration, NullLogger<CommentMutationOutboxWorker>.Instance,
            heartbeatFaultInjector: () => new InvalidOperationException("simulated-heartbeat-db-disconnect"));

        Task<int> processing = worker.ProcessPendingAsync(CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await Task.Delay(TimeSpan.FromSeconds(2));
        Assert.Equal(1, state.CreateSnapshot().LostCount);
        release.TrySetResult();
        Assert.Equal(0, await processing);
        await notifications.DidNotReceiveWithAnyArgs().PublishAddedAsync(default!, default, default);
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        Assert.Equal(CommentMutationOutboxStatus.Processing, verify.Queryable<CommentMutationOutboxEvent>().Single().Status);
    }

    [Fact]
    public async Task Worker_AtomicallyReservesExpiredDeliveryBeforeCacheVersionSideEffect()
    {
        string connectionString = await CreateDatabaseAsync();
        CommentMutationOutboxEvent item;
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(517)).ExecuteCommandAsync();
            item = CreateEvent(517);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
            long outboxId = setup.Queryable<CommentMutationOutboxEvent>().Single().Id;
            await setup.Insertable(new CommentMutationOutboxDelivery
            {
                OutboxEventId = outboxId,
                ConsumerName = "cache-version",
                Status = CommentMutationOutboxDeliveryStatus.Processing,
                AttemptCount = 1,
                OwnerClaimToken = "stale-owner",
                OwnerWorkerId = "stale-worker",
                LeaseGeneration = 1,
                StartedAt = DateTime.UtcNow.AddMinutes(-2),
                LeaseExpiresAt = DateTime.UtcNow.AddMinutes(-1)
            }).ExecuteCommandAsync();
        }

        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), new CommentMutationOutboxRuntimeState(), TimeProvider.System,
            CreateSlowExecutionLeaseConfiguration(), NullLogger<CommentMutationOutboxWorker>.Instance);

        Assert.Equal(1, await worker.ProcessPendingAsync(CancellationToken.None));
        await invalidations.Received(1).InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>());
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        CommentMutationOutboxDelivery delivery = verify.Queryable<CommentMutationOutboxDelivery>()
            .Single(row => row.ConsumerName == "cache-version");
        Assert.Equal(CommentMutationOutboxDeliveryStatus.Completed, delivery.Status);
        Assert.Equal(2, delivery.AttemptCount);
        Assert.False(string.IsNullOrWhiteSpace(delivery.ResultDigest));
        Assert.NotEqual("stale-owner", delivery.OwnerClaimToken);
    }

    [Fact]
    public async Task Worker_ActiveForeignDeliveryReservationFailsClosedWithoutCacheSideEffect()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(521)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(521);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
            long outboxId = setup.Queryable<CommentMutationOutboxEvent>().Single().Id;
            await setup.Insertable(new CommentMutationOutboxDelivery
            {
                OutboxEventId = outboxId,
                ConsumerName = "cache-version",
                Status = CommentMutationOutboxDeliveryStatus.Processing,
                AttemptCount = 1,
                OwnerClaimToken = "active-owner",
                OwnerWorkerId = "active-worker",
                LeaseGeneration = 99,
                StartedAt = DateTime.UtcNow,
                LeaseExpiresAt = DateTime.UtcNow.AddMinutes(5)
            }).ExecuteCommandAsync();
        }

        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), new CommentMutationOutboxRuntimeState(), TimeProvider.System,
            new ConfigurationBuilder().Build(), NullLogger<CommentMutationOutboxWorker>.Instance);

        Assert.Equal(0, await worker.ProcessPendingAsync(CancellationToken.None));
        await invalidations.DidNotReceiveWithAnyArgs().InvalidateCommentMutationAsync(default, default);
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        CommentMutationOutboxDelivery delivery = verify.Queryable<CommentMutationOutboxDelivery>()
            .Single(row => row.ConsumerName == "cache-version");
        Assert.Equal(CommentMutationOutboxDeliveryStatus.Processing, delivery.Status);
        Assert.Equal("active-owner", delivery.OwnerClaimToken);
        Assert.Equal("active-worker", delivery.OwnerWorkerId);
        Assert.Equal(99, delivery.LeaseGeneration);
    }

    [Fact]
    public async Task Worker_TwoConcurrentWorkersExecuteSameConsumerSideEffectExactlyOnce()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(520)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(520);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
        }

        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var first = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), new CommentMutationOutboxRuntimeState(), TimeProvider.System,
            new ConfigurationBuilder().Build(), NullLogger<CommentMutationOutboxWorker>.Instance);
        var second = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), new CommentMutationOutboxRuntimeState(), TimeProvider.System,
            new ConfigurationBuilder().Build(), NullLogger<CommentMutationOutboxWorker>.Instance);

        int[] processed = await Task.WhenAll(
            first.ProcessPendingAsync(CancellationToken.None),
            second.ProcessPendingAsync(CancellationToken.None));

        Assert.Equal(1, processed.Sum());
        await invalidations.Received(1).InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>());
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        CommentMutationOutboxDelivery delivery = verify.Queryable<CommentMutationOutboxDelivery>()
            .Single(row => row.ConsumerName == "cache-version");
        Assert.Equal(CommentMutationOutboxDeliveryStatus.Completed, delivery.Status);
        Assert.Equal(1, delivery.AttemptCount);
    }

    [Fact]
    public async Task Worker_CompletedDeliveryWithoutMatchingDigestDoesNotExecuteOrProcessEvent()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(518)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(518);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
            long outboxId = setup.Queryable<CommentMutationOutboxEvent>().Single().Id;
            await setup.Insertable(new CommentMutationOutboxDelivery
            {
                OutboxEventId = outboxId,
                ConsumerName = "cache-version",
                Status = CommentMutationOutboxDeliveryStatus.Completed,
                ResultDigest = null
            }).ExecuteCommandAsync();
        }

        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), new CommentMutationOutboxRuntimeState(), TimeProvider.System,
            CreateSlowExecutionLeaseConfiguration(), NullLogger<CommentMutationOutboxWorker>.Instance);

        Assert.Equal(0, await worker.ProcessPendingAsync(CancellationToken.None));
        await invalidations.DidNotReceiveWithAnyArgs().InvalidateCommentMutationAsync(default, default);
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        Assert.Equal(CommentMutationOutboxStatus.Failed, verify.Queryable<CommentMutationOutboxEvent>().Single().Status);
    }

    [Fact]
    public async Task Worker_TerminalDeliveryFailurePreventsEventCompletion()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(519)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(519);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
            long outboxId = setup.Queryable<CommentMutationOutboxEvent>().Single().Id;
            await setup.Insertable(new CommentMutationOutboxDelivery
            {
                OutboxEventId = outboxId,
                ConsumerName = "cache-version",
                Status = CommentMutationOutboxDeliveryStatus.TerminalFailed,
                AttemptCount = 1,
                LastFailureKind = "contract"
            }).ExecuteCommandAsync();
        }

        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), new CommentMutationOutboxRuntimeState(), TimeProvider.System,
            new ConfigurationBuilder().Build(), NullLogger<CommentMutationOutboxWorker>.Instance);

        Assert.Equal(0, await worker.ProcessPendingAsync(CancellationToken.None));
        await invalidations.DidNotReceiveWithAnyArgs().InvalidateCommentMutationAsync(default, default);
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        Assert.Equal(CommentMutationOutboxStatus.Failed, verify.Queryable<CommentMutationOutboxEvent>().Single().Status);
    }

    [Fact]
    public async Task Worker_CancellationStopsHeartbeatAndOldTokenCannotReleaseNewClaim()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(510)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(510);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
        }

        var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int calls = 0;
        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        invalidations.InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                if (Interlocked.Increment(ref calls) == 1)
                {
                    firstEntered.TrySetResult();
                    await releaseFirst.Task;
                }
            });
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CommentMutationOutbox:ClaimLeaseSeconds"] = "30",
            ["CommentMutationOutbox:HeartbeatSeconds"] = "1"
        }).Build();
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var firstWorker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), new CommentMutationOutboxRuntimeState(), TimeProvider.System,
            configuration, NullLogger<CommentMutationOutboxWorker>.Instance);
        using var cancellation = new CancellationTokenSource();
        Task<int> first = firstWorker.ProcessPendingAsync(cancellation.Token);
        await firstEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await Task.Delay(TimeSpan.FromMilliseconds(1500));
        DateTime? heartbeatBeforeCancel;
        using (SqlSugarClient snapshot = PostgresSqlSugarTestClient.Create(connectionString))
        {
            heartbeatBeforeCancel = snapshot.Queryable<CommentMutationOutboxEvent>().Single().LastHeartbeatAt;
        }
        Assert.NotNull(heartbeatBeforeCancel);
        cancellation.Cancel();
        await Task.Delay(TimeSpan.FromSeconds(2));
        using (SqlSugarClient afterCancel = PostgresSqlSugarTestClient.Create(connectionString))
        {
            Assert.Equal(heartbeatBeforeCancel, afterCancel.Queryable<CommentMutationOutboxEvent>().Single().LastHeartbeatAt);
        }

        using (SqlSugarClient expire = PostgresSqlSugarTestClient.Create(connectionString))
        {
            expire.Ado.ExecuteCommand(
                "UPDATE comment_mutation_outbox SET lease_expires_at = @Expired WHERE status = 'processing';",
                new SugarParameter("@Expired", DateTime.UtcNow.AddSeconds(-1)));
        }

        var secondWorker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), new CommentMutationOutboxRuntimeState(), TimeProvider.System,
            configuration, NullLogger<CommentMutationOutboxWorker>.Instance);
        Assert.Equal(1, await secondWorker.ProcessPendingAsync(CancellationToken.None));
        releaseFirst.TrySetResult();
        Assert.Equal(0, await first);

        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        CommentMutationOutboxEvent after = verify.Queryable<CommentMutationOutboxEvent>().Single();
        Assert.Equal(CommentMutationOutboxStatus.Processed, after.Status);
        Assert.Null(after.ClaimToken);
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task Worker_MarkFailedClaimLossPreservesReplacementOwnerAndIsNotCountedAsFailed()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(513)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(513);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
        }

        var beforeMarkFailed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var continueMarkFailed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        invalidations.InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new InvalidOperationException("consumer-failure")));
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var state = new CommentMutationOutboxRuntimeState();
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), state, TimeProvider.System,
            new ConfigurationBuilder().Build(), NullLogger<CommentMutationOutboxWorker>.Instance,
            beforeMarkFailed: async _ =>
            {
                beforeMarkFailed.TrySetResult();
                await continueMarkFailed.Task;
            });

        Task<int> processing = worker.ProcessPendingAsync(CancellationToken.None);
        await beforeMarkFailed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        using (SqlSugarClient takeover = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CommentMutationOutboxEvent claim = takeover.Queryable<CommentMutationOutboxEvent>().Single();
            takeover.Ado.ExecuteCommand(
                "UPDATE comment_mutation_outbox SET claim_token = 'replacement-token', claimed_by = 'replacement-worker', lease_generation = lease_generation + 1 WHERE id = @Id;",
                new SugarParameter("@Id", claim.Id));
        }
        continueMarkFailed.TrySetResult();

        Assert.Equal(0, await processing);
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        CommentMutationOutboxEvent after = verify.Queryable<CommentMutationOutboxEvent>().Single();
        Assert.Equal(CommentMutationOutboxStatus.Processing, after.Status);
        Assert.Equal("replacement-token", after.ClaimToken);
        Assert.Equal("replacement-worker", after.ClaimedBy);
        Assert.Equal(1, state.CreateSnapshot().LostCount);
        Assert.Equal(0, state.CreateSnapshot().FailedCount);
    }

    [Fact]
    public async Task Worker_MarkProcessedClaimLossPreservesReplacementOwnerAndDoesNotIncrementProcessed()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(515)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(515);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
        }

        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        var state = new CommentMutationOutboxRuntimeState();
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), state, TimeProvider.System,
            new ConfigurationBuilder().Build(), NullLogger<CommentMutationOutboxWorker>.Instance,
            beforeMarkProcessed: item =>
            {
                using SqlSugarClient takeover = PostgresSqlSugarTestClient.Create(connectionString);
                takeover.Ado.ExecuteCommand(
                    "UPDATE comment_mutation_outbox SET claim_token = 'replacement-token', claimed_by = 'replacement-worker', lease_generation = lease_generation + 1 WHERE id = @Id;",
                    new SugarParameter("@Id", item.Id));
                return Task.CompletedTask;
            });

        Assert.Equal(0, await worker.ProcessPendingAsync(CancellationToken.None));
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        CommentMutationOutboxEvent after = verify.Queryable<CommentMutationOutboxEvent>().Single();
        Assert.Equal(CommentMutationOutboxStatus.Processing, after.Status);
        Assert.Equal("replacement-token", after.ClaimToken);
        Assert.Equal("replacement-worker", after.ClaimedBy);
        Assert.Equal(0, state.CreateSnapshot().ProcessedCount);
        Assert.Equal(0, state.CreateSnapshot().FailedCount);
        Assert.Equal(1, state.CreateSnapshot().LostCount);
    }

    [Fact]
    public async Task Worker_MarkProcessedRejectsMissingRequiredConsumerReceiptWithoutIncrementingMetric()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(516)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(516);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
        }

        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        var state = new CommentMutationOutboxRuntimeState();
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), state, TimeProvider.System,
            new ConfigurationBuilder().Build(), NullLogger<CommentMutationOutboxWorker>.Instance,
            beforeMarkProcessed: item =>
            {
                using SqlSugarClient tamper = PostgresSqlSugarTestClient.Create(connectionString);
                tamper.Ado.ExecuteCommand(
                    "DELETE FROM comment_mutation_outbox_delivery WHERE outbox_event_id = @OutboxId AND consumer_name = 'audit-projection';",
                    new SugarParameter("@OutboxId", item.Id));
                return Task.CompletedTask;
            });

        Assert.Equal(0, await worker.ProcessPendingAsync(CancellationToken.None));
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        Assert.Equal(CommentMutationOutboxStatus.Processing, verify.Queryable<CommentMutationOutboxEvent>().Single().Status);
        Assert.Equal(2, verify.Queryable<CommentMutationOutboxDelivery>().Count());
        Assert.Equal(0, state.CreateSnapshot().ProcessedCount);
        Assert.Equal(1, state.CreateSnapshot().LostCount);
    }

    [Fact]
    public async Task Worker_MarkProcessedRejectsNonEmptyTamperedRequiredConsumerDigestWithoutIncrementingMetrics()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(522)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(522);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
        }

        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        var state = new CommentMutationOutboxRuntimeState();
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), state, TimeProvider.System,
            new ConfigurationBuilder().Build(), NullLogger<CommentMutationOutboxWorker>.Instance,
            beforeMarkProcessed: item =>
            {
                using SqlSugarClient tamper = PostgresSqlSugarTestClient.Create(connectionString);
                Assert.Equal(1, tamper.Ado.ExecuteCommand(
                    """
                    UPDATE comment_mutation_outbox_delivery
                    SET result_digest = 'non-empty-tampered-digest'
                    WHERE outbox_event_id = @OutboxId AND consumer_name = 'cache-version';
                    """,
                    new SugarParameter("@OutboxId", item.Id)));
                return Task.CompletedTask;
            });

        Assert.Equal(0, await worker.ProcessPendingAsync(CancellationToken.None));
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        Assert.Equal(CommentMutationOutboxStatus.Processing, verify.Queryable<CommentMutationOutboxEvent>().Single().Status);
        CommentMutationOutboxDelivery tampered = verify.Queryable<CommentMutationOutboxDelivery>()
            .Single(delivery => delivery.ConsumerName == "cache-version");
        Assert.Equal(CommentMutationOutboxDeliveryStatus.Completed, tampered.Status);
        Assert.Equal("non-empty-tampered-digest", tampered.ResultDigest);
        Assert.Equal(0, state.CreateSnapshot().ProcessedCount);
        Assert.Equal(0, state.CreateSnapshot().FailedCount);
        Assert.Equal(1, state.CreateSnapshot().LostCount);
    }

    [Fact]
    public async Task Worker_CancellationReleaseClaimLossPreservesReplacementOwnerExactlyOnce()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(514)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(514);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
        }

        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var beforeRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var continueRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        invalidations.InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>())
            .Returns(async call =>
            {
                entered.TrySetResult();
                await Task.Delay(
                    Timeout.InfiniteTimeSpan,
                    call.ArgAt<CancellationToken>(1));
            });
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var state = new CommentMutationOutboxRuntimeState();
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), state, TimeProvider.System,
            new ConfigurationBuilder().Build(), NullLogger<CommentMutationOutboxWorker>.Instance,
            beforeReleaseClaim: async _ =>
            {
                beforeRelease.TrySetResult();
                await continueRelease.Task;
            });
        using var cancellation = new CancellationTokenSource();

        Task<int> processing = worker.ProcessPendingAsync(cancellation.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        cancellation.Cancel();
        await beforeRelease.Task.WaitAsync(TimeSpan.FromSeconds(10));
        using (SqlSugarClient takeover = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CommentMutationOutboxEvent claim = takeover.Queryable<CommentMutationOutboxEvent>().Single();
            takeover.Ado.ExecuteCommand(
                "UPDATE comment_mutation_outbox SET claim_token = 'replacement-token', claimed_by = 'replacement-worker', lease_generation = lease_generation + 1 WHERE id = @Id;",
                new SugarParameter("@Id", claim.Id));
        }
        continueRelease.TrySetResult();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => processing);
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        CommentMutationOutboxEvent after = verify.Queryable<CommentMutationOutboxEvent>().Single();
        Assert.Equal(CommentMutationOutboxStatus.Processing, after.Status);
        Assert.Equal("replacement-token", after.ClaimToken);
        Assert.Equal("replacement-worker", after.ClaimedBy);
        Assert.Equal(1, state.CreateSnapshot().LostCount);
    }

    [Fact]
    public async Task Worker_HeartbeatAndConsumerClaimLossAreRecordedOnceWithoutRenewalRaces()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            await setup.Insertable(CreateComment(515)).ExecuteCommandAsync();
            CommentMutationOutboxEvent item = CreateEvent(515);
            item.EventType = CommentMutationEventTypes.VisibilityChanged;
            await setup.Insertable(item).ExecuteCommandAsync();
        }

        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        invalidations.InvalidateCommentMutationAsync(Arg.Any<CommentCacheInvalidationScope?>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                entered.TrySetResult();
                await release.Task;
            });
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CommentMutationOutbox:ClaimLeaseSeconds"] = "30",
            ["CommentMutationOutbox:HeartbeatSeconds"] = "1"
        }).Build();
        using ServiceProvider provider = BuildWorkerServices(connectionString, invalidations);
        var state = new CommentMutationOutboxRuntimeState();
        var worker = new CommentMutationOutboxWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(), state, TimeProvider.System, configuration,
            NullLogger<CommentMutationOutboxWorker>.Instance);

        Task<int> processing = worker.ProcessPendingAsync(CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        DateTime renewalDeadline = DateTime.UtcNow.AddSeconds(10);
        while (state.CreateSnapshot().RenewedCount < 2 && DateTime.UtcNow < renewalDeadline)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(100));
        }
        Assert.True(state.CreateSnapshot().RenewedCount >= 2);
        using (SqlSugarClient takeover = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CommentMutationOutboxEvent claim = takeover.Queryable<CommentMutationOutboxEvent>().Single();
            takeover.Ado.ExecuteCommand(
                "UPDATE comment_mutation_outbox SET claim_token = 'replacement-token', claimed_by = 'replacement-worker', lease_generation = lease_generation + 1 WHERE id = @Id;",
                new SugarParameter("@Id", claim.Id));
        }
        release.TrySetResult();

        Assert.Equal(0, await processing);
        CommentMutationOutboxRuntimeSnapshot snapshot = state.CreateSnapshot();
        Assert.Equal(1, snapshot.LostCount);
        Assert.True(snapshot.RenewedCount >= 2);
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        CommentMutationOutboxEvent after = verify.Queryable<CommentMutationOutboxEvent>().Single();
        Assert.Equal("replacement-token", after.ClaimToken);
        Assert.Equal(CommentMutationOutboxStatus.Processing, after.Status);
    }

    private static ServiceProvider BuildWorkerServices(string connectionString, ICacheInvalidationDispatcher invalidations)
    {
        var services = new ServiceCollection();
        services.AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connectionString));
        services.AddSingleton(invalidations);
        services.AddSingleton(Substitute.For<ICommentNotificationService>());
        return services.BuildServiceProvider();
    }

    private static IConfiguration CreateSlowExecutionLeaseConfiguration()
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CommentMutationOutbox:ClaimLeaseSeconds"] = "300"
        }).Build();

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
