using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Operations;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminAuditDurableAdmissionIssue2040Tests
{
    [Fact]
    public async Task ReturnedAdmission_HasDurableAcceptanceBeforeAnyWorkerRuns()
    {
        using var owner = new AdminAuditIssue2040Owner();
        await owner.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("admitted-before-worker"));
        Assert.Equal(1, owner.Channel.Snapshot().QueuedCount);
        Assert.Empty(owner.RecordingStore!.Records);
        Assert.Equal(1, owner.Channel.Snapshot().DurableAcceptedCount);
    }

    [Fact]
    public async Task CapacityOne_FullReplaysBothIndependentEventsInAdmissionOrder()
    {
        using var owner = new AdminAuditIssue2040Owner(capacity: 1);
        await owner.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("first"));
        Assert.Equal(1, owner.Channel.QueuedCount);
        await owner.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("second"));
        Assert.Equal(["first", "second"], owner.RecordingStore!.Records.Select(record => record.Action));
        Assert.Equal(2, owner.Channel.Snapshot().DurableAcceptedCount);
        Assert.Equal(1, owner.Channel.Snapshot().RejectedCount);
        Assert.Equal(2, owner.Channel.Snapshot().CommittedCount);
        Assert.Equal(0, owner.Channel.Snapshot().OutstandingCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ClosedOrCancelled_StillHasOneDurableAdmissionAndExactCommit(bool closed)
    {
        using var owner = new AdminAuditIssue2040Owner(capacity: 1);
        using var cancellation = new CancellationTokenSource();
        if (closed)
        {
            owner.Channel.Complete();
        }
        else
        {
            cancellation.Cancel();
        }
        AdminAuditLog expected = AdminAuditIssue2040Owner.Record("required-after-rejection");
        await owner.Channel.EnqueueAsync(expected, cancellation.Token);
        AdminAuditIssue2040Owner.AssertFullPayload(expected, Assert.Single(owner.RecordingStore!.Records));
        Assert.Equal(1, owner.Channel.Snapshot().DurableAcceptedCount);
        Assert.Equal(1, owner.Channel.Snapshot().RejectedCount);
        Assert.Equal(0, owner.Channel.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task CallerMutation_CannotChangeTheDurablyAdmittedPayload()
    {
        using var owner = new AdminAuditIssue2040Owner();
        AdminAuditLog source = AdminAuditIssue2040Owner.Record("immutable");
        AdminAuditLog expected = AdminAuditIssue2040Owner.Copy(source);
        await owner.Channel.EnqueueAsync(source);
        source.MetadataJson = "{\"mutated\":true}";
        Assert.True(owner.Channel.TryRead(out AdminAuditLog? delivery));
        AdminAuditIssue2040Owner.AssertFullPayload(expected, delivery);
        await owner.Worker.FlushPendingAsync([delivery], CancellationToken.None);
        AdminAuditIssue2040Owner.AssertFullPayload(expected, Assert.Single(owner.RecordingStore!.Records));
    }

    [Fact]
    public async Task AdmissionPublicationFailure_IsObservableAndNeverReturnsRamOnlySuccess()
    {
        using var owner = new AdminAuditIssue2040Owner();
        string journal = Path.Combine(owner.Root, "admin-audit-fallback");
        Directory.Move(journal, journal + ".owned-backup");
        await File.WriteAllTextAsync(journal, "Owned test blocks journal publication.");
        await Assert.ThrowsAnyAsync<IOException>(async () =>
            await owner.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("failed-publication")));
        Assert.Empty(owner.RecordingStore!.Records);
        Assert.Equal(0, owner.Channel.Snapshot().QueuedCount);
        Assert.Equal(0, owner.Channel.Snapshot().DurableAcceptedCount);
        Assert.True(owner.Channel.Snapshot().TerminalFailureCount > 0);
        Assert.NotNull(owner.Channel.Snapshot().LastItemReference);
        Assert.StartsWith("admin-audit:", owner.Channel.Snapshot().LastFailureReason);
        Assert.False(ObserveAdmin(owner).Complete);
    }

    [Fact]
    public async Task DequeueBlockThenWriterCancellation_RetainsSameIdentityUntilRetry()
    {
        using var owner = new AdminAuditIssue2040Owner(capacity: 1);
        await owner.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("blocked"));
        Assert.True(owner.Channel.TryRead(out AdminAuditLog? delivery));
        Guid identity = AdminAuditDurableDelivery.GetRequired(delivery).Entry.DeliveryId;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        owner.RecordingStore!.OnWrite = async (_, token) =>
        {
            entered.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
        };
        using var cancellation = new CancellationTokenSource();
        Task write = owner.Worker.FlushPendingAsync([delivery], cancellation.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, owner.Channel.Snapshot().QueuedCount);
        Assert.Equal(1, owner.Channel.Snapshot().InFlightCount);
        Assert.False(ObserveAdmin(owner).Complete);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => write);
        Assert.Equal(0, owner.Channel.Snapshot().InFlightCount);
        Assert.Equal(1, owner.Channel.Snapshot().DurablePendingCount);
        Assert.Equal(0, owner.Channel.Snapshot().TerminalFailureCount);
        owner.RecordingStore.OnWrite = (batch, _) =>
        {
            Assert.Equal(identity, AdminAuditDurableDelivery.GetRequired(Assert.Single(batch)).Entry.DeliveryId);
            return Task.CompletedTask;
        };
        await owner.Worker.FlushPendingAsync([delivery], CancellationToken.None);
        Assert.Equal(0, owner.Channel.Snapshot().OutstandingCount);
        Assert.Single(owner.RecordingStore.Records);
    }

    [Fact]
    public async Task WorkerException_RetriesSameAdmissionWithoutDoubleCounting()
    {
        using var owner = new AdminAuditIssue2040Owner();
        owner.RecordingStore!.FailuresRemaining = 1;
        await owner.Worker.FlushPendingAsync([AdminAuditIssue2040Owner.Record("worker-retry")], CancellationToken.None);
        Assert.Equal(2, owner.RecordingStore.Attempts);
        Assert.Equal(1, owner.Channel.Snapshot().DurableAcceptedCount);
        Assert.Equal(1, owner.Channel.Snapshot().CommittedCount);
        Assert.Equal(0, owner.Channel.Snapshot().TerminalFailureCount);
        Assert.Single(owner.RecordingStore.Records);
    }

    [Fact]
    public async Task PersistentReplayFailure_BlocksRealAdminParticipantHealthAndQualification()
    {
        using var owner = new AdminAuditIssue2040Owner();
        owner.RecordingStore!.FailuresRemaining = 2;
        await Assert.ThrowsAsync<IOException>(() => owner.Worker.FlushPendingAsync(
            [AdminAuditIssue2040Owner.Record("persistent-failure")], CancellationToken.None));
        AdminAuditLogChannelSnapshot failed = owner.Channel.Snapshot();
        Assert.Equal(1, failed.DurablePendingCount);
        Assert.Equal(1, failed.TerminalFailureCount);
        Assert.NotNull(failed.LastItemReference);
        Assert.NotNull(failed.LastFailureReason);
        Assert.Contains("admin-audit:replay-failed", failed.LastFailureReason);
        BoundedQueueDrainAggregateReceipt receipt = ObserveAdmin(owner);
        Assert.False(receipt.Complete);
        Assert.Equal("failed", receipt.HealthStatus);
        Assert.Equal("failed", receipt.ReadinessStatus);
        Assert.Equal("failed", receipt.QualificationStatus);
        Assert.Contains($"admin-audit:item={failed.LastItemReference};reason={failed.LastFailureReason}", receipt.Blockers);
        Assert.DoesNotContain(receipt.Blockers, blocker => blocker.Contains(owner.Root, StringComparison.Ordinal)
            || blocker.Contains("persistent-failure", StringComparison.Ordinal)
            || blocker.Contains("payload 信息", StringComparison.Ordinal)
            || blocker.Contains("Owned recording store is unavailable.", StringComparison.Ordinal));
        await owner.Channel.ReplayAsync(CancellationToken.None);
        BoundedQueueDrainAggregateReceipt recovered = ObserveAdmin(owner);
        Assert.True(recovered.Complete);
        Assert.Empty(recovered.Blockers);
        Assert.Equal("ok", recovered.HealthStatus);
        Assert.Equal("ok", recovered.ReadinessStatus);
        Assert.Equal("ok", recovered.QualificationStatus);
        Assert.Single(owner.RecordingStore.Records);

        // A real cancelled admission leaves a historical classification after its
        // direct durable fallback commits. History is not a terminal blocker.
        await owner.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("recovered-history"), new CancellationToken(true));
        AdminAuditLogChannelSnapshot history = owner.Channel.Snapshot();
        Assert.Equal(0, history.TerminalFailureCount);
        Assert.NotNull(history.LastFailureReason);
        Assert.Equal(0, history.OutstandingCount);
        BoundedQueueDrainAggregateReceipt afterHistory = ObserveAdmin(owner);
        Assert.True(afterHistory.Complete);
        Assert.Empty(afterHistory.Blockers);
        Assert.Equal("ok", afterHistory.HealthStatus);
        Assert.Equal("ok", afterHistory.ReadinessStatus);
        Assert.Equal("ok", afterHistory.QualificationStatus);
    }

    [Fact]
    public async Task CorruptProtectedJournal_IsNotDiscardedOrReportedAsDrained()
    {
        using var owner = new AdminAuditIssue2040Owner();
        await owner.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("corrupt"));
        string path = Assert.Single(Directory.GetFiles(Path.Combine(owner.Root, "admin-audit-fallback"), "*.json"));
        byte[] original = await File.ReadAllBytesAsync(path);
        Assert.DoesNotContain("payload 信息", System.Text.Encoding.UTF8.GetString(original));
        var envelope = JsonSerializer.Deserialize<AdminAuditJournalEnvelope>(original)!;
        envelope.Ciphertext[0] ^= 1;
        await File.WriteAllBytesAsync(path, JsonSerializer.SerializeToUtf8Bytes(envelope));
        await Assert.ThrowsAnyAsync<CryptographicException>(() => owner.Channel.ReplayAsync(CancellationToken.None));
        Assert.True(File.Exists(path));
        Assert.Empty(owner.RecordingStore!.Records);
        Assert.Equal(1, owner.Channel.Snapshot().TerminalFailureCount);
        Assert.False(ObserveAdmin(owner).Complete);
        await File.WriteAllBytesAsync(path, original);
        await owner.Channel.ReplayAsync(CancellationToken.None);
        Assert.True(ObserveAdmin(owner).Complete);
    }

    [Fact]
    public async Task SameDataRoot_AdminReplayDoesNotConsumeAuditQueueJournalOrKeys()
    {
        using var admin = new AdminAuditIssue2040Owner();
        using var audit = new AuditDurableTestOwner(admin.Root, deleteRoot: false);
        Assert.True(audit.Channel.TryWrite(AuditDurableAdmissionIssue2040Tests.Record("other-owner")));
        await admin.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("admin-owner"));
        await admin.Channel.ReplayAsync(CancellationToken.None);
        Assert.Single(admin.RecordingStore!.Records);
        Assert.Equal(0, admin.Channel.Snapshot().OutstandingCount);
        Assert.Equal(1, audit.Channel.Snapshot().DurablePendingCount);
        await audit.Journal.ReplayAsync(async (records, token) =>
        {
            var restored = await audit.Protector.TryUnprotectAsync(new AuditLog
            {
                Action = Assert.Single(records).Action,
                ContextPayload = Assert.Single(records).ContextPayload,
                EventInfo = Assert.Single(records).EventInfo
            }, token);
            Assert.NotNull(restored);
        }, CancellationToken.None);
        Assert.Equal(0, audit.Channel.Snapshot().OutstandingCount);
    }

    internal static BoundedQueueDrainAggregateReceipt ObserveAdmin(AdminAuditIssue2040Owner owner)
    {
        var catalog = new AdminOnlyCatalog();
        return new BoundedQueueDrainAggregator(catalog,
            [new AdminAuditBoundedQueueDrainParticipant(catalog, owner.Channel, TimeProvider.System)], TimeProvider.System).Observe();
    }

    private sealed class AdminOnlyCatalog : IBoundedQueueDrainCatalog
    {
        private readonly BoundedQueueDeliveryCatalog _embedded = BoundedQueueDeliveryCatalog.Embedded;
        public string Digest => _embedded.Digest;
        public IReadOnlyList<BoundedChannelQueueContract> Queues => DrainParticipants;
        public IReadOnlyList<BoundedChannelQueueContract> DrainParticipants
            => _embedded.DrainParticipants.Where(contract => contract.QueueId == "admin-audit").ToArray();
    }
}

internal sealed class AdminAuditIssue2040Owner : IDisposable
{
    private readonly bool _deleteRoot;

    internal string Root
    {
        get;
    }

    internal ServiceProvider Provider
    {
        get;
    }

    internal AdminAuditLogChannel Channel => Provider.GetRequiredService<AdminAuditLogChannel>();

    internal AdminAuditLogWriterWorker Worker
    {
        get;
    }

    internal AdminAuditIssue2040RecordingStore? RecordingStore
    {
        get;
    }

    internal AdminAuditIssue2040Owner(
        string? root = null, Func<ISqlSugarClient>? database = null, bool deleteRoot = true,
        int capacity = AdminAuditLogChannel.DefaultCapacity)
    {
        Root = root ?? Path.Combine(Path.GetTempPath(), $"fsusblog-admin-audit-issue2040-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Root);
        _deleteRoot = deleteRoot;
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["FSUSBLOG_DATA_ROOT"] = Root
        }).Build();
        var services = new ServiceCollection().AddLogging()
            .AddSingleton(configuration)
            .AddSingleton<IAuditRetentionEpochKeyStore, LocalAuditRetentionEpochKeyStore>();
        if (capacity == AdminAuditLogChannel.DefaultCapacity)
        {
            services.AddSingleton<AdminAuditLogChannel>();
        }
        else
        {
            services.AddSingleton(provider => new AdminAuditLogChannel(new BoundedChannelOptions(capacity)
            {
                FullMode = BoundedChannelFullMode.Wait,
                SingleReader = true,
                SingleWriter = false
            }, provider.GetRequiredService<IServiceScopeFactory>(),
                provider.GetRequiredService<ILogger<AdminAuditLogChannel>>(), configuration,
                provider.GetRequiredService<IAuditRetentionEpochKeyStore>()));
        }
        services.AddSingleton<IAdminAuditLogChannel>(provider => provider.GetRequiredService<AdminAuditLogChannel>());
        if (database is null)
        {
            RecordingStore = new AdminAuditIssue2040RecordingStore();
            services.AddSingleton<IAdminAuditLogStore>(RecordingStore);
        }
        else
        {
            services.AddScoped<ISqlSugarClient>(_ => database());
            services.AddScoped<IAdminAuditLogStore, AdminAuditLogStore>();
        }
        Provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateScopes = true,
            ValidateOnBuild = true
        });
        Worker = ActivatorUtilities.CreateInstance<AdminAuditLogWriterWorker>(Provider);
    }

    internal static AdminAuditLog Record(string action) => new()
    {
        AdminPrincipalId = 42,
        AdminSessionId = "session-2040",
        Action = action,
        Outcome = "failure",
        TargetType = "policy",
        TargetId = "target-2040",
        IpHash = "ip-2040",
        UserAgentHash = "ua-2040",
        IsHighImpact = true,
        MetadataJson = "{\"full\":\"payload 信息\",\"order\":[2,1]}",
        OccurredAtUtc = new DateTime(2026, 10, 2, 7, 0, 0, DateTimeKind.Utc)
    };

    internal static AdminAuditLog Copy(AdminAuditLog record)
        => JsonSerializer.Deserialize<AdminAuditLog>(JsonSerializer.Serialize(record))!;

    internal static void AssertFullPayload(AdminAuditLog expected, AdminAuditLog actual)
    {
        Assert.Equal(expected.AdminPrincipalId, actual.AdminPrincipalId);
        Assert.Equal(expected.AdminSessionId, actual.AdminSessionId);
        Assert.Equal(expected.Action, actual.Action);
        Assert.Equal(expected.Outcome, actual.Outcome);
        Assert.Equal(expected.TargetType, actual.TargetType);
        Assert.Equal(expected.TargetId, actual.TargetId);
        Assert.Equal(expected.IpHash, actual.IpHash);
        Assert.Equal(expected.UserAgentHash, actual.UserAgentHash);
        Assert.Equal(expected.IsHighImpact, actual.IsHighImpact);
        Assert.Equal(expected.MetadataJson, actual.MetadataJson);
        Assert.Equal(expected.OccurredAtUtc, actual.OccurredAtUtc);
    }

    public void Dispose()
    {
        Worker.Dispose();
        Provider.Dispose();
        if (_deleteRoot && Directory.Exists(Root))
        {
            Directory.Delete(Root, recursive: true);
        }
    }
}

internal sealed class AdminAuditIssue2040RecordingStore : IAdminAuditLogStore
{
    internal Func<IReadOnlyList<AdminAuditLog>, CancellationToken, Task>? OnWrite
    {
        get; set;
    }
    internal int FailuresRemaining
    {
        get; set;
    }
    internal int Attempts
    {
        get; private set;
    }
    internal List<AdminAuditLog> Records
    {
        get;
    } = [];

    public async Task WriteBatchAsync(IReadOnlyList<AdminAuditLog> audits, CancellationToken cancellationToken)
    {
        Attempts++;
        cancellationToken.ThrowIfCancellationRequested();
        if (FailuresRemaining > 0)
        {
            FailuresRemaining--;
            throw new IOException("Owned recording store is unavailable.");
        }
        if (OnWrite is not null)
        {
            await OnWrite(audits, cancellationToken);
        }
        Records.AddRange(audits.Select(AdminAuditIssue2040Owner.Copy));
    }
}
