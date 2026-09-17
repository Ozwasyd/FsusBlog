using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class MessageMutationOutboxIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task Worker_RetriesAfterFailureAndCompletesAfterRestartWithStableDeliveryKey()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(MessageMutationOutbox));
        MessageMutationOutbox queued = await InsertDeliveryAsync(db, MessageMutationOutboxStatus.Pending, null);
        IMessageMutationOutboxDelivery delivery = Substitute.For<IMessageMutationOutboxDelivery>();
        int attempts = 0;
        delivery.DeliverAsync(Arg.Any<MessageMutationOutbox>(), Arg.Any<CancellationToken>())
            .Returns(_ => Interlocked.Increment(ref attempts) == 1
                ? Task.FromException(new InvalidOperationException("injected notification failure"))
                : Task.CompletedTask);

        var firstRuntime = new MessageMutationOutboxRuntimeState();
        await using (ServiceProvider provider = BuildServices(db, delivery))
        {
            MessageMutationOutboxWorker firstWorker = CreateWorker(provider, firstRuntime);
            Assert.Equal(0, await firstWorker.ProcessPendingAsync(CancellationToken.None));
        }

        MessageMutationOutbox failed = Assert.IsType<MessageMutationOutbox>(
            await db.Queryable<MessageMutationOutbox>().InSingleAsync(queued.Id));
        Assert.Equal(MessageMutationOutboxStatus.Pending, failed.Status);
        Assert.Equal(1, failed.AttemptCount);
        Assert.Contains("injected notification failure", failed.LastError, StringComparison.Ordinal);
        MessageMutationOutboxRuntimeSnapshot failedSnapshot = firstRuntime.CreateSnapshot();
        Assert.Equal(1, failedSnapshot.BacklogCount);
        Assert.Equal(1, failedSnapshot.FailedCount);
        Assert.Equal(0, failedSnapshot.PoisonCount);
        Assert.Contains("injected notification failure", failedSnapshot.LastError, StringComparison.Ordinal);
        await db.Updateable<MessageMutationOutbox>()
            .SetColumns(item => item.NextAttemptAt == DateTime.UtcNow.AddSeconds(-1))
            .Where(item => item.Id == queued.Id)
            .ExecuteCommandAsync();

        var restartedRuntime = new MessageMutationOutboxRuntimeState();
        await using (ServiceProvider provider = BuildServices(db, delivery))
        {
            MessageMutationOutboxWorker restartedWorker = CreateWorker(provider, restartedRuntime);
            Assert.Equal(1, await restartedWorker.ProcessPendingAsync(CancellationToken.None));
        }

        MessageMutationOutbox processed = Assert.IsType<MessageMutationOutbox>(
            await db.Queryable<MessageMutationOutbox>().InSingleAsync(queued.Id));
        Assert.Equal(MessageMutationOutboxStatus.Processed, processed.Status);
        Assert.NotNull(processed.ProcessedAt);
        Assert.Equal(2, attempts);
        await delivery.Received(2).DeliverAsync(
            Arg.Is<MessageMutationOutbox>(item => item.DeliveryKey == queued.DeliveryKey),
            Arg.Any<CancellationToken>());
        Assert.Equal(1, restartedRuntime.CreateSnapshot().ProcessedCount);
    }

    [Fact]
    public async Task Worker_PoisonsDeliveryAtRetryThresholdAndReportsFailureBacklog()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(MessageMutationOutbox));
        MessageMutationOutbox queued = await InsertDeliveryAsync(db, MessageMutationOutboxStatus.Pending, null);
        await db.Updateable<MessageMutationOutbox>()
            .SetColumns(item => item.AttemptCount == 9)
            .Where(item => item.Id == queued.Id)
            .ExecuteCommandAsync();
        IMessageMutationOutboxDelivery delivery = Substitute.For<IMessageMutationOutboxDelivery>();
        delivery.DeliverAsync(Arg.Any<MessageMutationOutbox>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new InvalidOperationException("permanent notification failure")));
        var runtime = new MessageMutationOutboxRuntimeState();
        await using ServiceProvider provider = BuildServices(db, delivery);
        MessageMutationOutboxWorker worker = CreateWorker(provider, runtime);

        Assert.Equal(0, await worker.ProcessPendingAsync(CancellationToken.None));

        MessageMutationOutbox poison = Assert.IsType<MessageMutationOutbox>(
            await db.Queryable<MessageMutationOutbox>().InSingleAsync(queued.Id));
        Assert.Equal(MessageMutationOutboxStatus.Poison, poison.Status);
        Assert.Equal(10, poison.AttemptCount);
        Assert.Contains("permanent notification failure", poison.LastError, StringComparison.Ordinal);
        MessageMutationOutboxRuntimeSnapshot snapshot = runtime.CreateSnapshot();
        Assert.Equal(0, snapshot.BacklogCount);
        Assert.Equal(1, snapshot.FailedCount);
        Assert.Equal(1, snapshot.PoisonCount);
    }

    [Fact]
    public async Task Worker_ReclaimsExpiredClaimButLeavesLiveClaimOwned()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(MessageMutationOutbox));
        MessageMutationOutbox expired = await InsertDeliveryAsync(
            db,
            MessageMutationOutboxStatus.Processing,
            DateTime.UtcNow.AddMinutes(-1));
        MessageMutationOutbox live = await InsertDeliveryAsync(
            db,
            MessageMutationOutboxStatus.Processing,
            DateTime.UtcNow.AddMinutes(5));
        IMessageMutationOutboxDelivery delivery = Substitute.For<IMessageMutationOutboxDelivery>();
        var runtime = new MessageMutationOutboxRuntimeState();
        await using ServiceProvider provider = BuildServices(db, delivery);
        MessageMutationOutboxWorker worker = CreateWorker(provider, runtime);

        Assert.Equal(1, await worker.ProcessPendingAsync(CancellationToken.None));

        Assert.Equal(
            MessageMutationOutboxStatus.Processed,
            (await db.Queryable<MessageMutationOutbox>().InSingleAsync(expired.Id))!.Status);
        Assert.Equal(
            MessageMutationOutboxStatus.Processing,
            (await db.Queryable<MessageMutationOutbox>().InSingleAsync(live.Id))!.Status);
        await delivery.Received(1).DeliverAsync(
            Arg.Is<MessageMutationOutbox>(item => item.Id == expired.Id),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Worker_DisabledGateLeavesCommittedDeliveryPendingForLaterReplay()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(MessageMutationOutbox));
        MessageMutationOutbox queued = await InsertDeliveryAsync(db, MessageMutationOutboxStatus.Pending, null);
        IMessageMutationOutboxDelivery delivery = Substitute.For<IMessageMutationOutboxDelivery>();
        await using ServiceProvider provider = BuildServices(db, delivery);
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["MessageMutationOutbox:Enabled"] = "false"
            })
            .Build();
        MessageMutationOutboxWorker worker = CreateWorker(
            provider,
            new MessageMutationOutboxRuntimeState(),
            configuration);

        Assert.Equal(0, await worker.ProcessPendingAsync(CancellationToken.None));

        Assert.Equal(
            MessageMutationOutboxStatus.Pending,
            (await db.Queryable<MessageMutationOutbox>().InSingleAsync(queued.Id))!.Status);
        await delivery.DidNotReceiveWithAnyArgs().DeliverAsync(default!, default);
    }

    private static async Task<MessageMutationOutbox> InsertDeliveryAsync(
        ISqlSugarClient db,
        string status,
        DateTime? leaseExpiresAt)
    {
        string key = $"test-message-delivery:{Guid.NewGuid():N}";
        var delivery = new MessageMutationOutbox
        {
            DeliveryKey = key,
            EventKind = MessageMutationOutboxEventKinds.ReadUpdated,
            AudienceKind = MessageMutationOutboxAudiences.Account,
            TargetAccountId = 42,
            ConversationId = 700,
            ReadThroughMessageId = 701,
            Status = status,
            NextAttemptAt = DateTime.UtcNow.AddSeconds(-1),
            ClaimToken = status == MessageMutationOutboxStatus.Processing ? "old-claim" : null,
            ClaimedBy = status == MessageMutationOutboxStatus.Processing ? "old-worker" : null,
            ClaimedAt = status == MessageMutationOutboxStatus.Processing ? DateTime.UtcNow.AddMinutes(-2) : null,
            LeaseExpiresAt = leaseExpiresAt,
            CreatedAt = DateTime.UtcNow
        };
        delivery.Id = await db.Insertable(delivery).ExecuteReturnBigIdentityAsync();
        return delivery;
    }

    private static ServiceProvider BuildServices(ISqlSugarClient db, IMessageMutationOutboxDelivery delivery)
        => new ServiceCollection()
            .AddSingleton(db)
            .AddSingleton(delivery)
            .BuildServiceProvider();

    private static MessageMutationOutboxWorker CreateWorker(
        ServiceProvider provider,
        MessageMutationOutboxRuntimeState runtimeState,
        IConfiguration? configuration = null)
        => new(
            provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(),
            TimeProvider.System,
            runtimeState,
            configuration ?? new ConfigurationBuilder().Build(),
            NullLogger<MessageMutationOutboxWorker>.Instance);
}
