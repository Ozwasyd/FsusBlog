using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Operations;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuditDurableAdmissionIssue2040Tests
{
    [Fact]
    public async Task AcceptedBeforeWorkerStart_SurvivesFreshOwnerAndRetainsExactEncryptedDeliveryOrder()
    {
        using var first = new AuditDurableTestOwner();
        AuditRecord[] originals = [Record("first"), Record("second"), Record("third")];
        foreach (AuditRecord record in originals)
        {
            Assert.True(first.Channel.TryWrite(record));
        }
        Assert.Equal(0, first.Channel.Snapshot().QueuedCount);
        Assert.Equal(3, first.Channel.Snapshot().DurablePendingCount);
        first.Provider.Dispose(); // No worker, drain, replay or disposal flush ran.

        using var restarted = new AuditDurableTestOwner(first.Root, deleteRoot: false);
        Assert.Equal(3, restarted.Channel.Snapshot().DurablePendingCount);
        var restored = new List<AuditRecord>();
        await restarted.Journal.ReplayAsync((records, _) =>
        {
            restored.AddRange(records);
            return Task.CompletedTask;
        }, CancellationToken.None);
        Assert.Equal(3, restored.Count);
        for (int index = 0; index < originals.Length; index++)
        {
            AuditRecord record = restored[index];
            Assert.NotNull(record.DurableDeliveryId);
            AuditDurableDelivery.Validate(record);
            var row = new FsusBlog.Server.Entities.AuditLog
            {
                Action = record.Action,
                EventInfo = record.EventInfo,
                ContextPayload = record.ContextPayload
            };
            Assert.Equal(originals[index].EventInfo,
                (await restarted.Protector.TryUnprotectAsync(row, CancellationToken.None)).EventInfo);
        }
        Assert.Equal(0, restarted.Channel.Snapshot().OutstandingCount);
        Assert.Equal(3, restarted.Channel.Snapshot().CommittedCount);
    }

    [Fact]
    public async Task ProtectedRestartDelivery_PreservesBusinessPayloadAndStoragePrecision()
    {
        using var owner = new AuditDurableTestOwner();
        AuditRecord original = Record("private event 信息") with
        {
            ActorType = "user",
            ActorId = "actor",
            ActorRole = "role",
            TargetType = "policy",
            TargetId = "target",
            Outcome = AuditOutcomeCatalog.Failure,
            TraceId = "trace",
            RequestPath = "/fixture/private",
            RequestMethod = "POST",
            IpHash = "ip",
            UserAgentHash = "ua",
            SessionIdHash = "session",
            DeviceFingerprintHash = "device",
            ReasonCode = "reason",
            ContextJson = "{\"business\":\"unchanged\"}",
            ContextPayload = [0, 1, 127, 255]
        };
        Assert.True(owner.Channel.TryWrite(original));
        owner.Provider.Dispose();
        using var restarted = new AuditDurableTestOwner(owner.Root, deleteRoot: false);
        await restarted.Journal.ReplayAsync(async (records, token) =>
        {
            AuditRecord record = Assert.Single(records);
            Assert.Equal(original.Source, record.Source);
            Assert.Equal(original.Type, record.Type);
            Assert.Equal(original.Action, record.Action);
            Assert.Equal(original.Outcome, record.Outcome);
            Assert.Equal(original.Severity, record.Severity);
            Assert.Equal(original.IsHighValue, record.IsHighValue);
            Assert.Equal(original.ActorType, record.ActorType);
            Assert.Equal(original.TargetType, record.TargetType);
            Assert.Equal(original.OccurredAtUtc.Ticks - original.OccurredAtUtc.Ticks % 10,
                record.OccurredAtUtc.Ticks); // PostgreSQL microsecond storage projection, not payload truncation.
            var plaintext = await restarted.Protector.TryUnprotectAsync(new FsusBlog.Server.Entities.AuditLog
            {
                Action = record.Action,
                EventInfo = record.EventInfo,
                ContextPayload = record.ContextPayload
            }, token);
            Assert.Equal(original.ActorId, plaintext.ActorId);
            Assert.Equal(original.ActorRole, plaintext.ActorRole);
            Assert.Equal(original.TargetId, plaintext.TargetId);
            Assert.Equal(original.TraceId, plaintext.TraceId);
            Assert.Equal(original.RequestPath, plaintext.RequestPath);
            Assert.Equal(original.RequestMethod, plaintext.RequestMethod);
            Assert.Equal(original.IpHash, plaintext.IpHash);
            Assert.Equal(original.UserAgentHash, plaintext.UserAgentHash);
            Assert.Equal(original.SessionIdHash, plaintext.SessionIdHash);
            Assert.Equal(original.DeviceFingerprintHash, plaintext.DeviceFingerprintHash);
            Assert.Equal(original.ReasonCode, plaintext.ReasonCode);
            Assert.Equal(original.EventInfo, plaintext.EventInfo);
            Assert.Equal(original.ContextJson, plaintext.ContextJson);
            Assert.Equal(original.ContextPayload, plaintext.ContextPayload);
        }, CancellationToken.None);
        Assert.Equal(0, restarted.Channel.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task DequeueBlockAndCancellation_ExposeDiskPendingAndInFlightWithoutFalseDrain()
    {
        using var owner = new AuditDurableTestOwner();
        Assert.True(owner.Channel.TryWrite(Record("blocked")));
        using var cancellation = new CancellationTokenSource();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task replay = owner.Journal.ReplayAsync(async (_, token) =>
        {
            entered.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
        }, cancellation.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        AuditLogChannelSnapshot blocked = owner.Channel.Snapshot();
        Assert.Equal(0, blocked.QueuedCount);
        Assert.Equal(0, blocked.DurablePendingCount);
        Assert.Equal(1, blocked.InFlightCount);
        Assert.Equal("pending", new AuditLogReleaseDrainParticipant(owner.Channel, TimeProvider.System).Snapshot().Status);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => replay);
        AuditLogChannelSnapshot cancelled = owner.Channel.Snapshot();
        Assert.Equal(0, cancelled.InFlightCount);
        Assert.Equal(1, cancelled.DurablePendingCount);
        Assert.Equal(0, cancelled.CommittedCount);
        Assert.Equal(1, cancelled.OutstandingCount);
    }

    [Fact]
    public async Task FailedCommitRemainsPendingAndReplaysSameIdentityUntilConfirmed()
    {
        using var owner = new AuditDurableTestOwner();
        Assert.True(owner.Channel.TryWrite(Record("retry")));
        string? firstIdentity = null;
        await Assert.ThrowsAsync<IOException>(() => owner.Journal.ReplayAsync((records, _) =>
        {
            firstIdentity = Assert.Single(records).DurableDeliveryId;
            throw new IOException("fixture commit unavailable");
        }, CancellationToken.None));
        Assert.Equal(1, owner.Channel.Snapshot().DurablePendingCount);
        Assert.Equal(0, owner.Channel.Snapshot().CommittedCount);
        await owner.Journal.ReplayAsync((records, _) =>
        {
            Assert.Equal(firstIdentity, Assert.Single(records).DurableDeliveryId);
            return Task.CompletedTask;
        }, CancellationToken.None);
        Assert.Equal(0, owner.Channel.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task ReplayAndConcurrentAdmission_DoNotLoseAnAppendedOrMovedFile()
    {
        using var owner = new AuditDurableTestOwner();
        Assert.True(owner.Channel.TryWrite(Record("before")));
        var identities = new HashSet<string>(StringComparer.Ordinal);
        await owner.Journal.ReplayAsync((records, _) =>
        {
            identities.Add(Assert.Single(records).DurableDeliveryId!);
            if (identities.Count == 1)
            {
                Assert.True(owner.Channel.TryWrite(Record("during")));
            }
            return Task.CompletedTask;
        }, CancellationToken.None);
        await owner.Journal.ReplayAsync((records, _) =>
        {
            identities.Add(Assert.Single(records).DurableDeliveryId!);
            return Task.CompletedTask;
        }, CancellationToken.None);
        Assert.Equal(2, identities.Count);
        Assert.Equal(0, owner.Channel.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task LargeFallbackBatch_UsesBoundedFilesAndReplayBatches()
    {
        using var owner = new AuditDurableTestOwner();
        AuditRecord[] records = Enumerable.Range(0, 513).Select(index => Record($"record-{index}")).ToArray();
        await owner.Journal.WriteBatchAsync(records, new IOException("fixture"), CancellationToken.None);
        string[] files = Directory.GetFiles(Path.Combine(owner.Root, "audit-fallback"), "critical-audit-*.jsonl");
        Assert.Equal(3, files.Length);
        foreach (string path in files)
        {
            Assert.InRange(File.ReadLines(path).Count(), 1, 256);
        }
        int observed = 0;
        await owner.Journal.ReplayAsync((batch, _) =>
        {
            Assert.InRange(batch.Count, 1, 256);
            observed += batch.Count;
            return Task.CompletedTask;
        }, CancellationToken.None);
        Assert.Equal(records.Length, observed);
        Assert.Equal(0, owner.Channel.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task UnknownActionAndMissingProtector_NeverReportDurableAcceptance()
    {
        using var owner = new AuditDurableTestOwner();
        Assert.False(owner.Channel.TryWrite(Record("unknown") with
        {
            Action = "unknown.audit.action"
        }));
        AuditLogChannelSnapshot rejected = owner.Channel.Snapshot();
        Assert.Equal(0, rejected.DurableAcceptedCount);
        Assert.Equal(0, rejected.DurablePendingCount);
        Assert.Equal(1, rejected.TerminalFailureCount);
        Assert.Equal("terminal-failed", new AuditLogReleaseDrainParticipant(owner.Channel, TimeProvider.System).Snapshot().Status);
        var unprotected = new AuditFallbackWriter(owner.Configuration, new AuditLogRuntimeState(new AuditLogChannel()));
        await Assert.ThrowsAsync<InvalidOperationException>(() => unprotected.AdmitAsync(Record("raw"), CancellationToken.None));
    }

    [Fact]
    public async Task EmptyPublishedSource_IsTerminalEvenWhenItsRecordCountIsZero()
    {
        using var owner = new AuditDurableTestOwner();
        Assert.True(owner.Channel.TryWrite(Record("empty-source")));
        string file = Assert.Single(Directory.GetFiles(Path.Combine(owner.Root, "audit-fallback"), "critical-audit-*.jsonl"));
        await File.WriteAllTextAsync(file, string.Empty); // Test-owned corruption, not a production source edit.
        Assert.Equal(0, owner.Channel.Snapshot().DurablePendingCount);
        Assert.Equal(1, owner.Channel.Snapshot().OutstandingCount); // Terminal failure still blocks drain.
        Assert.Equal(1, owner.Channel.Snapshot().TerminalFailureCount);
        Assert.Equal("terminal-failed", new AuditLogReleaseDrainParticipant(owner.Channel, TimeProvider.System).Snapshot().Status);
        await Assert.ThrowsAsync<InvalidDataException>(() => owner.Journal.ReplayAsync(
            (_, _) => throw new Xunit.Sdk.XunitException("empty source reached store"), CancellationToken.None));
        Assert.True(File.Exists(file));
    }

    [Fact]
    public async Task CorruptDurableRecord_BlocksHealthAndPreservesThePendingSource()
    {
        using var owner = new AuditDurableTestOwner();
        Assert.True(owner.Channel.TryWrite(Record("corrupt")));
        string file = Assert.Single(Directory.GetFiles(Path.Combine(owner.Root, "audit-fallback"), "critical-audit-*.jsonl"));
        string content = await File.ReadAllTextAsync(file);
        await File.WriteAllTextAsync(file, content.Replace("retention-encrypted", "not-an-envelope", StringComparison.Ordinal));
        await Assert.ThrowsAsync<InvalidDataException>(() => owner.Journal.ReplayAsync(
            (_, _) => throw new Xunit.Sdk.XunitException("corrupt record reached store"), CancellationToken.None));
        Assert.True(File.Exists(file));
        Assert.Equal(1, owner.Channel.Snapshot().TerminalFailureCount);
        Assert.Equal("terminal-failed", new AuditLogReleaseDrainParticipant(owner.Channel, TimeProvider.System).Snapshot().Status);
    }

    internal static AuditRecord Record(string eventInfo)
        => new(AuditSourceCatalog.Security, AuditTypeCatalog.Security,
            new DateTime(2026, 10, 2, 8, 0, 0, DateTimeKind.Utc).AddTicks(17), eventInfo, null,
            Action: AuditActionCatalog.SecurityPolicyActivated, Severity: AuditSeverityCatalog.Critical,
            IsHighValue: true, ActorId: "private-fixture-actor");

    [Fact]
    public async Task RealAuditPendingAndTerminalObservation_DoesNotRewriteFixturePeerReceipts()
    {
        using var owner = new AuditDurableTestOwner();
        BoundedQueueDeliveryCatalog catalog = BoundedQueueDeliveryCatalog.Embedded;
        var audit = new AuditLogBoundedQueueDrainParticipant(catalog, owner.Channel, TimeProvider.System);
        IBoundedQueueDrainParticipant[] participants = catalog.DrainParticipants
            .Select(contract => contract.QueueId == audit.QueueId ? (IBoundedQueueDrainParticipant)audit : new FixturePeer(contract))
            .ToArray();
        var aggregator = new BoundedQueueDrainAggregator(catalog, participants, TimeProvider.System);
        BoundedQueueDrainAggregateReceipt initial = aggregator.Observe();
        Assert.True(initial.Complete);
        Dictionary<string, string> peerDigests = initial.Participants.Where(receipt => receipt.QueueId != audit.QueueId)
            .ToDictionary(receipt => receipt.QueueId, receipt => receipt.ContentDigest);

        Assert.True(owner.Channel.TryWrite(Record("aggregate-pending")));
        BoundedQueueDrainAggregateReceipt pending = aggregator.Observe();
        Assert.False(pending.Complete);
        BoundedQueueParticipantReceipt auditPending = Assert.Single(pending.Participants, receipt => receipt.QueueId == audit.QueueId);
        Assert.Equal(0, auditPending.Queued);
        Assert.Equal(1, auditPending.DurablePending);
        Assert.Equal(pending.HealthStatus, pending.ReadinessStatus);
        Assert.Equal(pending.HealthStatus, pending.QualificationStatus);
        Assert.All(pending.Participants.Where(receipt => receipt.QueueId != audit.QueueId),
            receipt => Assert.Equal(peerDigests[receipt.QueueId], receipt.ContentDigest));
        await owner.Worker.ReplayPendingOnceAsync(CancellationToken.None);
        Assert.True(aggregator.Observe().Complete);

        Assert.False(owner.Channel.TryWrite(Record("aggregate-terminal") with
        {
            Action = "unknown.audit.action"
        }));
        BoundedQueueDrainAggregateReceipt terminal = aggregator.Observe();
        Assert.False(terminal.Complete);
        Assert.Equal(1, Assert.Single(terminal.Participants, receipt => receipt.QueueId == audit.QueueId).TerminalFailures);
        Assert.All(terminal.Participants.Where(receipt => receipt.QueueId != audit.QueueId),
            receipt => Assert.Equal(peerDigests[receipt.QueueId], receipt.ContentDigest));
    }

    // Peers are unchanged receipt fixtures, not evidence that their product failure
    // windows executed. Those owners require their own independent runtime tests.
    private sealed class FixturePeer(BoundedChannelQueueContract contract) : IBoundedQueueDrainParticipant
    {
        public string QueueId => contract.QueueId;
        public string AdapterToken => contract.ParticipantAdapterToken!;

        public BoundedQueueParticipantReceipt Observe(string runId)
            => BoundedQueueParticipantReceipt.Create(QueueId, contract.DeliveryClass, runId, 0, 0,
                0, 0, 0, 0, BoundedQueueCommitPostcondition.Success,
                contract.DeliveryClass is "best-effort" or "coalescible"
                    ? new BoundedQueueDropProof(contract.DeliveryClass, "unchanged peer fixture", "fixture source")
                    : null, null, DateTimeOffset.UtcNow);
    }
}

internal sealed class AuditDurableTestOwner : IDisposable
{
    private readonly bool _deleteRoot;
    internal string Root
    {
        get;
    }
    internal IConfiguration Configuration
    {
        get;
    }
    internal ServiceProvider Provider
    {
        get;
    }
    internal AuditLogChannel Channel
    {
        get;
    }
    internal AuditFallbackWriter Journal
    {
        get;
    }
    internal AuditRetentionPayloadProtector Protector
    {
        get;
    }
    internal AuditLogWriterWorker Worker
    {
        get;
    }

    internal AuditDurableTestOwner(string? root = null, bool deleteRoot = true, IAuditLogStore? store = null)
    {
        Root = root ?? Path.Combine(Path.GetTempPath(), "fsusblog-audit-issue2040-" + Guid.NewGuid().ToString("N"));
        _deleteRoot = deleteRoot;
        Configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["FSUSBLOG_DATA_ROOT"] = Root
        }).Build();
        Protector = new AuditRetentionPayloadProtector(new LocalAuditRetentionEpochKeyStore(Configuration));
        var services = new ServiceCollection();
        services.AddSingleton<AuditLogChannel>(provider => new AuditLogChannel(new BoundedChannelOptions(1)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        }, provider.GetRequiredService<IServiceScopeFactory>(), NullLogger<AuditLogChannel>.Instance));
        services.AddSingleton<AuditLogRuntimeState>();
        services.AddSingleton<IAuditFallbackWriter>(provider => new AuditFallbackWriter(
            Configuration, provider.GetRequiredService<AuditLogRuntimeState>(), Protector));
        services.AddSingleton<IAuditLogStore>(store ?? new NoopStore());
        Provider = services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true, ValidateOnBuild = true });
        Channel = Provider.GetRequiredService<AuditLogChannel>();
        Journal = (AuditFallbackWriter)Provider.GetRequiredService<IAuditFallbackWriter>();
        Worker = new AuditLogWriterWorker(Channel, Provider.GetRequiredService<IServiceScopeFactory>(),
            Provider.GetRequiredService<AuditLogRuntimeState>(), Journal, NullLogger<AuditLogWriterWorker>.Instance);
    }

    public void Dispose()
    {
        Provider.Dispose();
        if (_deleteRoot && Directory.Exists(Root))
        {
            Directory.Delete(Root, recursive: true);
        }
    }

    private sealed class NoopStore : IAuditLogStore
    {
        public Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, CancellationToken cancellationToken)
            => Task.CompletedTask;
    }
}
