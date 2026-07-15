using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ActiveReleaseFenceDurableWitnessTests
{
    private static readonly DateTimeOffset Now = new(2026, 7, 15, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task Read_RestoresRedisAfterTotalLoss_FromDurableWitness()
    {
        ActiveReleaseFenceSnapshot durable = Snapshot(42);
        var events = new List<string>();
        var replica = new RecordingReplica(RedisActiveReleaseFenceStore.MissingSnapshot(), events);
        var witness = new RecordingWitness(durable, events);
        DurableActiveReleaseFenceStore store = CreateStore(replica, witness);

        ActiveReleaseFenceSnapshot actual = await store.ReadAsync();

        Assert.Equal(durable, actual);
        Assert.Equal(durable, replica.Snapshot);
        Assert.Contains("redis:reconcile:42", events);
    }

    [Fact]
    public async Task Read_RedisUnavailable_UsesDurableWitnessWithoutStaleReplica()
    {
        ActiveReleaseFenceSnapshot durable = Snapshot(42);
        var store = new DurableActiveReleaseFenceStore(
            new UnavailableReplica(),
            new RecordingWitness(durable, []),
            new ConfigurationBuilder().AddInMemoryCollection().Build(),
            NullLogger<DurableActiveReleaseFenceStore>.Instance);

        ActiveReleaseFenceSnapshot actual = await store.ReadAsync();

        Assert.Equal(durable, actual);
    }

    [Fact]
    public async Task Read_BootstrapsDurableWitness_FromLegacyRedisFence()
    {
        ActiveReleaseFenceSnapshot legacy = Snapshot(41);
        var events = new List<string>();
        var replica = new RecordingReplica(legacy, events);
        var witness = new RecordingWitness(RedisActiveReleaseFenceStore.MissingSnapshot(), events);
        DurableActiveReleaseFenceStore store = CreateStore(replica, witness);

        ActiveReleaseFenceSnapshot actual = await store.ReadAsync();

        Assert.Equal(legacy, actual);
        Assert.Equal(legacy, witness.Snapshot);
        Assert.Contains("sql:reconcile:41", events);
    }

    [Fact]
    public async Task Read_SameGenerationDifferentIdentity_FailsClosed()
    {
        var replica = new RecordingReplica(Snapshot(42) with { ReleaseId = "other-release" }, []);
        var witness = new RecordingWitness(Snapshot(42), []);
        DurableActiveReleaseFenceStore store = CreateStore(replica, witness);

        ActiveReleaseFenceStoreException error = await Assert.ThrowsAsync<ActiveReleaseFenceStoreException>(
            () => store.ReadAsync());

        Assert.Equal("active_release_fence_witness_diverged", error.ErrorCode);
    }

    [Fact]
    public void Merge_SameIdentityRevokedStatus_DominatesActive()
    {
        ActiveReleaseFenceSnapshot active = Snapshot(42);
        ActiveReleaseFenceSnapshot revoked = active with
        {
            Status = ActiveReleaseFenceStatuses.Revoked,
            RevokedAtUtc = Now.AddMinutes(1)
        };

        ActiveReleaseFenceSnapshot merged = ActiveReleaseFenceTransitions.Merge(active, revoked);

        Assert.Equal(ActiveReleaseFenceStatuses.Revoked, merged.Status);
        Assert.Equal(revoked.RevokedAtUtc, merged.RevokedAtUtc);
    }

    [Fact]
    public void Merge_InvalidWitnessSnapshot_FailsClosed()
    {
        ActiveReleaseFenceSnapshot invalid = Snapshot(42) with { Generation = 0 };

        ActiveReleaseFenceStoreException error = Assert.Throws<ActiveReleaseFenceStoreException>(
            () => ActiveReleaseFenceTransitions.Merge(Snapshot(41), invalid));

        Assert.Equal("active_release_fence_witness_invalid", error.ErrorCode);
    }

    [Fact]
    public async Task Acquire_CommitsSqlBeforeRedisMirror()
    {
        var events = new List<string>();
        ActiveReleaseFenceSnapshot current = Snapshot(41);
        var replica = new RecordingReplica(current, events);
        var witness = new RecordingWitness(current, events);
        DurableActiveReleaseFenceStore store = CreateStore(replica, witness);
        var request = new ActiveReleaseFenceAcquireRequest(
            "release-42",
            "green",
            42,
            "sha256:bbbb",
            current.ReleaseId,
            current.Slot,
            current.Generation);

        ActiveReleaseFenceOperationResult result = await store.AcquireAsync(request, Now);

        Assert.True(result.Accepted);
        int sqlWrite = events.IndexOf("sql:acquire:42");
        int redisWrite = events.IndexOf("redis:reconcile:42");
        Assert.True(sqlWrite >= 0 && redisWrite > sqlWrite, string.Join(',', events));
    }

    [Fact]
    public async Task MutationPause_IsReloadable_AndDoesNotDisableReads()
    {
        IConfigurationRoot configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ActiveReleaseFence:MutationEnabled"] = "false"
            })
            .Build();
        ActiveReleaseFenceSnapshot current = Snapshot(41);
        var replica = new RecordingReplica(current, []);
        var witness = new RecordingWitness(current, []);
        DurableActiveReleaseFenceStore store = CreateStore(replica, witness, configuration);
        var request = new ActiveReleaseFenceRevokeRequest(current.ReleaseId, current.Slot, current.Generation);

        ActiveReleaseFenceOperationResult paused = await store.RevokeAsync(request, Now);
        ActiveReleaseFenceSnapshot readable = await store.ReadAsync();
        configuration["ActiveReleaseFence:MutationEnabled"] = "true";
        ActiveReleaseFenceOperationResult resumed = await store.RevokeAsync(request, Now);

        Assert.False(paused.Accepted);
        Assert.Equal("active_release_fence_mutation_paused", paused.ErrorCode);
        Assert.Equal(current, readable);
        Assert.True(resumed.Accepted);
    }

    [Fact]
    public void ProductionValidation_RejectsSyntheticLocalFenceOptIn()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ActiveReleaseFence:AllowSyntheticLocalFence"] = "true"
            })
            .Build();

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true);

        Assert.Contains(
            "ActiveReleaseFence:AllowSyntheticLocalFence must be false outside Development.",
            errors);
    }

    [Fact]
    public void Registration_UsesDurableCompositeAndSqlWitness()
    {
        var services = new ServiceCollection();

        services.AddActiveReleaseFencing();

        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(IActiveReleaseFenceStore)
            && descriptor.ImplementationType == typeof(DurableActiveReleaseFenceStore));
        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(IActiveReleaseFenceDurableWitness)
            && descriptor.ImplementationType == typeof(SqlActiveReleaseFenceWitness));
    }

    [Fact]
    public void Migration_IsAdditiveOnlineExpandWithSingletonConstraints()
    {
        const string id = "20260715-post-active-release-fence-durable-witness";
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static item => item.MigrationId == id);
        OnlineSchemaMigrationMetadata metadata = new OnlineSchemaMigrationCatalog().GetMetadata()[id];
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.True(descriptor.Transactional);
        Assert.Contains("sys_deployment_fence", fingerprint, StringComparison.Ordinal);
        Assert.Contains("CHECK (id = 1)", fingerprint, StringComparison.Ordinal);
        Assert.Contains("CHECK (generation > 0)", fingerprint, StringComparison.Ordinal);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadata.Phase);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
    }

    [Fact]
    public void RuntimeShape_ExposesReconcileMetricsAndExplicitSyntheticOptIn()
    {
        string fence = RuntimeMetadataInspection.DescribeType(typeof(ActiveReleaseFence));
        string metrics = BackendTestPaths.ReadAllTextFromRoot(
            "src/backend/Infrastructure/Operations/ActiveReleaseFence.cs");

        Assert.Contains("ActiveReleaseFence:AllowSyntheticLocalFence", fence, StringComparison.Ordinal);
        Assert.Contains("IsDevelopment", fence, StringComparison.Ordinal);
        Assert.Contains("fsus.active_release_fence.witness_reconcile", metrics, StringComparison.Ordinal);
        Assert.Contains("fsus.active_release_fence.witness_generation_gap", metrics, StringComparison.Ordinal);
        Assert.Contains("pg_advisory_xact_lock", BackendTestPaths.ReadAllTextFromRoot(
            "src/backend/Infrastructure/Operations/ActiveReleaseFenceWitness.cs"), StringComparison.Ordinal);
    }

    private static DurableActiveReleaseFenceStore CreateStore(
        RecordingReplica replica,
        RecordingWitness witness,
        IConfiguration? configuration = null)
        => new(
            replica,
            witness,
            configuration ?? new ConfigurationBuilder().AddInMemoryCollection().Build(),
            NullLogger<DurableActiveReleaseFenceStore>.Instance);

    private static ActiveReleaseFenceSnapshot Snapshot(long generation)
        => new(
            true,
            ActiveReleaseFenceStatuses.Active,
            $"release-{generation}",
            generation % 2 == 0 ? "green" : "blue",
            generation,
            generation % 2 == 0 ? "sha256:bbbb" : "sha256:aaaa",
            Now.AddMinutes(generation),
            null);

    private sealed class RecordingReplica(ActiveReleaseFenceSnapshot snapshot, List<string> events)
        : IActiveReleaseFenceReplicaStore
    {
        public ActiveReleaseFenceSnapshot Snapshot { get; private set; } = snapshot;

        public Task<ActiveReleaseFenceSnapshot> ReadAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(Snapshot);

        public Task<ActiveReleaseFenceOperationResult> AcquireAsync(
            ActiveReleaseFenceAcquireRequest request,
            DateTimeOffset now,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<ActiveReleaseFenceOperationResult> RevokeAsync(
            ActiveReleaseFenceRevokeRequest request,
            DateTimeOffset now,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task ReconcileAsync(
            ActiveReleaseFenceSnapshot next,
            DateTimeOffset now,
            CancellationToken cancellationToken = default)
        {
            Snapshot = ActiveReleaseFenceTransitions.Merge(Snapshot, next);
            events.Add($"redis:reconcile:{next.Generation}");
            return Task.CompletedTask;
        }
    }

    private sealed class UnavailableReplica : IActiveReleaseFenceReplicaStore
    {
        public Task<ActiveReleaseFenceSnapshot> ReadAsync(CancellationToken cancellationToken = default)
            => Task.FromException<ActiveReleaseFenceSnapshot>(
                new InvalidOperationException("redis partition"));

        public Task<ActiveReleaseFenceOperationResult> AcquireAsync(
            ActiveReleaseFenceAcquireRequest request,
            DateTimeOffset now,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<ActiveReleaseFenceOperationResult> RevokeAsync(
            ActiveReleaseFenceRevokeRequest request,
            DateTimeOffset now,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task ReconcileAsync(
            ActiveReleaseFenceSnapshot snapshot,
            DateTimeOffset now,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }

    private sealed class RecordingWitness(ActiveReleaseFenceSnapshot snapshot, List<string> events)
        : IActiveReleaseFenceDurableWitness
    {
        public ActiveReleaseFenceSnapshot Snapshot { get; private set; } = snapshot;

        public Task<ActiveReleaseFenceSnapshot> ReadAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(Snapshot);

        public Task<ActiveReleaseFenceOperationResult> AcquireAsync(
            ActiveReleaseFenceAcquireRequest request,
            DateTimeOffset now,
            CancellationToken cancellationToken = default)
        {
            ActiveReleaseFenceOperationResult result = ActiveReleaseFenceTransitions.Acquire(Snapshot, request, now);
            if (result.Accepted && !request.DryRun)
            {
                Snapshot = result.Snapshot;
                events.Add($"sql:acquire:{request.Generation}");
            }
            return Task.FromResult(result);
        }

        public Task<ActiveReleaseFenceOperationResult> RevokeAsync(
            ActiveReleaseFenceRevokeRequest request,
            DateTimeOffset now,
            CancellationToken cancellationToken = default)
        {
            ActiveReleaseFenceOperationResult result = ActiveReleaseFenceTransitions.Revoke(Snapshot, request, now);
            if (result.Accepted && !request.DryRun)
            {
                Snapshot = result.Snapshot;
                events.Add($"sql:revoke:{request.Generation}");
            }
            return Task.FromResult(result);
        }

        public Task ReconcileAsync(
            ActiveReleaseFenceSnapshot next,
            DateTimeOffset now,
            CancellationToken cancellationToken = default)
        {
            Snapshot = ActiveReleaseFenceTransitions.Merge(Snapshot, next);
            events.Add($"sql:reconcile:{next.Generation}");
            return Task.CompletedTask;
        }
    }
}
