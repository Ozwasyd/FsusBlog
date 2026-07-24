using System.Text.Json;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.StateControl;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DistributedStateControlTests
{
    [Fact]
    public async Task Lease_EnforcesOwnershipRenewReleaseAndContention()
    {
        DateTimeOffset now = new(2026, 7, 24, 2, 0, 0, TimeSpan.Zero);
        var clock = new ManualTimeProvider(now);
        var leases = new InMemoryDistributedStateControlStore(clock);
        var key = new LeaseKey("search", "indexer");

        LeaseAcquireResult acquired = await leases.TryAcquireAsync(
            key,
            new NodeId("node-a"),
            TimeSpan.FromSeconds(30),
            CancellationToken.None);
        LeaseAcquireResult contended = await leases.TryAcquireAsync(
            key,
            new NodeId("node-b"),
            TimeSpan.FromSeconds(30),
            CancellationToken.None);

        Assert.True(acquired.Acquired);
        Assert.NotNull(acquired.Lease);
        Assert.False(contended.Acquired);
        Assert.Null(contended.Lease);
        Assert.Equal(acquired.Lease.OwnerNodeId, contended.Contention!.OwnerNodeId);
        Assert.Equal(acquired.Lease.FencingToken, contended.Contention.FencingToken);
        Assert.False(await leases.RenewAsync(
            acquired.Lease!.LeaseId,
            new FencingToken(acquired.Lease.FencingToken.Value + 1),
            TimeSpan.FromSeconds(30),
            CancellationToken.None));
        Assert.True(await leases.RenewAsync(
            acquired.Lease.LeaseId,
            acquired.Lease.FencingToken,
            TimeSpan.FromSeconds(30),
            CancellationToken.None));
        Assert.False(await leases.ReleaseAsync(
            acquired.Lease.LeaseId,
            new FencingToken(acquired.Lease.FencingToken.Value + 1),
            CancellationToken.None));
        Assert.True(await leases.ReleaseAsync(
            acquired.Lease.LeaseId,
            acquired.Lease.FencingToken,
            CancellationToken.None));
    }

    [Fact]
    public async Task ExpiredLease_AllowsTakeoverAndRejectsStaleWriter()
    {
        DateTimeOffset now = new(2026, 7, 24, 2, 0, 0, TimeSpan.Zero);
        var clock = new ManualTimeProvider(now);
        var state = new InMemoryDistributedStateControlStore(clock);
        var key = new LeaseKey("search", "partition-07");

        DistributedLease oldLease = Assert.IsType<DistributedLease>((await state.TryAcquireAsync(
            key,
            new NodeId("node-a"),
            TimeSpan.FromSeconds(30),
            CancellationToken.None)).Lease);
        clock.Advance(TimeSpan.FromSeconds(31));
        DistributedLease newLease = Assert.IsType<DistributedLease>((await state.TryAcquireAsync(
            key,
            new NodeId("node-b"),
            TimeSpan.FromSeconds(30),
            CancellationToken.None)).Lease);

        Assert.True(newLease.FencingToken.Value > oldLease.FencingToken.Value);
        Assert.False(await state.IsCurrentWriterAsync(
            oldLease,
            CancellationToken.None));
        Assert.True(await state.IsCurrentWriterAsync(
            newLease,
            CancellationToken.None));
    }

    [Fact]
    public async Task IdempotentTask_CheckpointsAndReturnsCompletedReplay()
    {
        DateTimeOffset now = new(2026, 7, 24, 2, 0, 0, TimeSpan.Zero);
        var state = new InMemoryDistributedStateControlStore(new ManualTimeProvider(now));
        DistributedLease lease = await AcquireAsync(state, "node-a");
        var key = new IdempotencyKey("search-rebuild", "all", "2026-07");
        var policy = new TaskFailurePolicy(3, TimeSpan.FromSeconds(10), false);

        TaskStartResult started = await state.TryBeginAsync(
            key,
            lease,
            policy,
            CancellationToken.None);
        TaskStartResult duplicate = await state.TryBeginAsync(
            key,
            lease,
            policy,
            CancellationToken.None);
        DistributedTaskCheckpoint checkpoint = await state.SaveCheckpointAsync(
            started.Execution!,
            0,
            """{"lastArticleId":10240,"processedCount":8200}""",
            CancellationToken.None);
        await Assert.ThrowsAsync<CheckpointVersionConflictException>(() => state.SaveCheckpointAsync(
            started.Execution!,
            0,
            """{"lastArticleId":20480}""",
            CancellationToken.None).AsTask());
        await state.CompleteAsync(
            started.Execution!,
            "sha256:result-01",
            CancellationToken.None);
        TaskStartResult replay = await state.TryBeginAsync(
            key,
            lease,
            policy,
            CancellationToken.None);

        Assert.Equal(TaskStartDisposition.Acquired, started.Disposition);
        Assert.Equal(TaskStartDisposition.AlreadyRunning, duplicate.Disposition);
        Assert.Equal(1, checkpoint.Version);
        Assert.Equal(TaskStartDisposition.CompletedReplay, replay.Disposition);
        Assert.Equal("sha256:result-01", replay.Record!.ResultDigest);
        Assert.Equal(checkpoint, replay.Record.Checkpoint);
    }

    [Fact]
    public async Task LeaseTakeover_ResumesCheckpointAndOldExecutionCannotCommit()
    {
        DateTimeOffset now = new(2026, 7, 24, 2, 0, 0, TimeSpan.Zero);
        var clock = new ManualTimeProvider(now);
        var state = new InMemoryDistributedStateControlStore(clock);
        DistributedLease oldLease = await AcquireAsync(state, "node-a");
        var key = new IdempotencyKey("media-batch", "bucket-2", "op-88");
        var policy = new TaskFailurePolicy(3, TimeSpan.Zero, false);
        TaskStartResult first = await state.TryBeginAsync(
            key,
            oldLease,
            policy,
            CancellationToken.None);
        _ = await state.SaveCheckpointAsync(
            first.Execution!,
            0,
            """{"offset":512}""",
            CancellationToken.None);

        clock.Advance(TimeSpan.FromSeconds(31));
        DistributedLease newLease = await AcquireAsync(state, "node-b");
        TaskStartResult resumed = await state.TryBeginAsync(
            key,
            newLease,
            policy,
            CancellationToken.None);

        Assert.Equal(TaskStartDisposition.Acquired, resumed.Disposition);
        Assert.Equal(2, resumed.Execution!.Attempt);
        Assert.Equal("""{"offset":512}""", resumed.Execution.Checkpoint!.Payload);
        await Assert.ThrowsAsync<StaleFencingTokenException>(() => state.CompleteAsync(
            first.Execution!,
            "sha256:stale",
            CancellationToken.None).AsTask());
        await state.CompleteAsync(
            resumed.Execution,
            "sha256:fresh",
            CancellationToken.None);
    }

    [Fact]
    public async Task FailurePolicy_RetriesThenDeadLettersWithCompensation()
    {
        DateTimeOffset now = new(2026, 7, 24, 2, 0, 0, TimeSpan.Zero);
        var clock = new ManualTimeProvider(now);
        var state = new InMemoryDistributedStateControlStore(clock);
        DistributedLease lease = await AcquireAsync(state, "node-a");
        var key = new IdempotencyKey("notification-send", "user-10", "message-44");
        var policy = new TaskFailurePolicy(2, TimeSpan.FromSeconds(5), true);
        TaskStartResult first = await state.TryBeginAsync(
            key,
            lease,
            policy,
            CancellationToken.None);

        DistributedTaskRecord retry = await state.FailAsync(
            first.Execution!,
            "smtp-timeout",
            CancellationToken.None);
        TaskStartResult tooEarly = await state.TryBeginAsync(
            key,
            lease,
            policy,
            CancellationToken.None);
        clock.Advance(TimeSpan.FromSeconds(5));
        TaskStartResult second = await state.TryBeginAsync(
            key,
            lease,
            policy,
            CancellationToken.None);
        DistributedTaskRecord terminal = await state.FailAsync(
            second.Execution!,
            "smtp-rejected",
            CancellationToken.None);

        Assert.Equal(DistributedTaskStatus.RetryScheduled, retry.Status);
        Assert.Equal(TaskStartDisposition.RetryNotDue, tooEarly.Disposition);
        Assert.Equal(DistributedTaskStatus.CompensationRequired, terminal.Status);
        Assert.Equal(2, terminal.Attempt);
        Assert.Equal("smtp-rejected", terminal.LastError);
    }

    [Fact]
    public async Task FailurePolicy_WithoutCompensationMovesToDeadLetter()
    {
        DateTimeOffset now = new(2026, 7, 24, 2, 0, 0, TimeSpan.Zero);
        var state = new InMemoryDistributedStateControlStore(new ManualTimeProvider(now));
        DistributedLease lease = await AcquireAsync(state, "node-a");
        TaskStartResult started = await state.TryBeginAsync(
            new IdempotencyKey("search-index", "article-10", "revision-4"),
            lease,
            new TaskFailurePolicy(1, TimeSpan.Zero, false),
            CancellationToken.None);

        DistributedTaskRecord terminal = await state.FailAsync(
            started.Execution!,
            "index-write-rejected",
            CancellationToken.None);

        Assert.Equal(DistributedTaskStatus.DeadLettered, terminal.Status);
        Assert.Null(terminal.NextAttemptAt);
    }

    [Fact]
    public async Task IdempotencyKey_CannotMoveAcrossSingleWriterPartitions()
    {
        DateTimeOffset now = new(2026, 7, 24, 2, 0, 0, TimeSpan.Zero);
        var state = new InMemoryDistributedStateControlStore(new ManualTimeProvider(now));
        DistributedLease partitionOne = Assert.IsType<DistributedLease>((await state.TryAcquireAsync(
            new LeaseKey("media", "partition-1"),
            new NodeId("node-a"),
            TimeSpan.FromSeconds(30),
            CancellationToken.None)).Lease);
        DistributedLease partitionTwo = Assert.IsType<DistributedLease>((await state.TryAcquireAsync(
            new LeaseKey("media", "partition-2"),
            new NodeId("node-a"),
            TimeSpan.FromSeconds(30),
            CancellationToken.None)).Lease);
        var key = new IdempotencyKey("media-batch", "object-1", "operation-1");
        TaskStartResult first = await state.TryBeginAsync(
            key,
            partitionOne,
            new TaskFailurePolicy(3, TimeSpan.Zero, false),
            CancellationToken.None);

        await Assert.ThrowsAsync<InvalidOperationException>(() => state.TryBeginAsync(
            key,
            partitionTwo,
            new TaskFailurePolicy(3, TimeSpan.Zero, false),
            CancellationToken.None).AsTask());
        Assert.Equal(new LeaseKey("media", "partition-1"), first.Record!.LeaseKey);
    }

    [Fact]
    public void StorageIdentities_AreUnambiguousAndCheckpointPayloadIsBounded()
    {
        var firstTask = new IdempotencyKey("a:b", "c", "d");
        var secondTask = new IdempotencyKey("a", "b:c", "d");
        var firstLease = new LeaseKey("a:b", "c");
        var secondLease = new LeaseKey("a", "b:c");

        Assert.NotEqual(firstTask.StorageIdentity, secondTask.StorageIdentity);
        Assert.NotEqual(firstLease.StorageIdentity, secondLease.StorageIdentity);
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            DistributedStateControlGuards.CheckpointPayload(new string('x', 64 * 1024 + 1)));
    }

    [Fact]
    public void Registration_UsesProcessStoreForSingleAndRedisStoreForClusterModes()
    {
        var singleServices = new ServiceCollection();
        singleServices.AddLogging();
        singleServices.AddFsusDistributedStateControl(Configuration(("RuntimeMode:Mode", "single")));
        Assert.Contains(singleServices, descriptor =>
            descriptor.ServiceType == typeof(IDistributedStateControlStore)
            && descriptor.ImplementationType == typeof(InMemoryDistributedStateControlStore));
        using ServiceProvider singleProvider = singleServices.BuildServiceProvider();
        Assert.Same(
            singleProvider.GetRequiredService<IDistributedStateControlStore>(),
            singleProvider.GetRequiredService<ILeaseManager>());
        Assert.Same(
            singleProvider.GetRequiredService<IDistributedStateControlStore>(),
            singleProvider.GetRequiredService<IDistributedTaskStateStore>());

        var adaptiveServices = new ServiceCollection();
        adaptiveServices.AddLogging();
        adaptiveServices.AddFsusDistributedStateControl(Configuration(
            ("RuntimeMode:Mode", "adaptive"),
            ("Runtime:Cluster:Capabilities:0", "search.indexer")));
        Assert.Contains(adaptiveServices, descriptor =>
            descriptor.ServiceType == typeof(IDistributedStateControlStore)
            && descriptor.ImplementationType == typeof(RedisDistributedStateControlStore));
    }

    [Fact]
    public void DurableTaskRecord_RoundTripsWithoutLosingFenceOrCheckpoint()
    {
        DateTimeOffset now = new(2026, 7, 24, 2, 0, 0, TimeSpan.Zero);
        var expected = new DistributedTaskRecord(
            new IdempotencyKey("search-rebuild", "all", "2026-07"),
            new LeaseKey("search", "indexer"),
            DistributedTaskStatus.Running,
            2,
            new TaskFailurePolicy(3, TimeSpan.FromSeconds(5), false),
            new LeaseId(Guid.Parse("5810baed-49ee-4d83-a70b-291d71cf5873")),
            new FencingToken(19),
            new NodeId("node-b"),
            new DistributedTaskCheckpoint(4, """{"offset":2048}""", now),
            null,
            "previous-timeout",
            null,
            now);
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);

        string payload = JsonSerializer.Serialize(expected, options);
        DistributedTaskRecord actual = Assert.IsType<DistributedTaskRecord>(
            JsonSerializer.Deserialize<DistributedTaskRecord>(payload, options));

        Assert.Equal(expected, actual);
    }

    private static async Task<DistributedLease> AcquireAsync(
        ILeaseManager manager,
        string nodeId)
        => Assert.IsType<DistributedLease>((await manager.TryAcquireAsync(
            new LeaseKey("test", "partition"),
            new NodeId(nodeId),
            TimeSpan.FromSeconds(30),
            CancellationToken.None)).Lease);

    private static IConfiguration Configuration(params (string Key, string Value)[] values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values.ToDictionary(
                static entry => entry.Key,
                static entry => (string?)entry.Value,
                StringComparer.Ordinal))
            .Build();

    private sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;

        public void Advance(TimeSpan duration) => utcNow += duration;
    }
}
