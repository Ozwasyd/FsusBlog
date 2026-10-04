using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RequiredQueueDeliveryContractTests
{
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    public void AuditLog_QueueFullClosedAndCancelLeaveDurableOrTerminalDisposition()
    {
        using var owner = new AuditDurableTestOwner();
        AuditLogChannel channel = owner.Channel;

        Assert.True(channel.TryWrite(LowValue("queued")));
        Assert.True(channel.TryWrite(LowValue("overflow")));
        AuditLogChannelSnapshot full = channel.Snapshot();
        Assert.Equal(0, full.QueuedCount);
        Assert.Equal(2, full.DurableAcceptedCount);
        Assert.Equal(2, full.DurablePendingCount);
        Assert.Equal("durable-pending", full.LastDisposition);

        channel.Complete();
        Assert.False(channel.TryWrite(LowValue("closed")));
        AuditLogChannelSnapshot closed = channel.Snapshot();
        Assert.Equal(3, closed.DurableAcceptedCount);
        Assert.Equal(3, closed.DurablePendingCount);
        Assert.Equal(0, closed.TerminalFailureCount);
        Assert.Equal(1, closed.RejectedCount);
        Assert.Equal("closed:durable-accepted", closed.LastFailureReason);
        Assert.Equal(owner.Journal.Snapshot().LastItemReference, closed.LastItemReference);
        Assert.Equal("pending", new AuditLogReleaseDrainParticipant(channel, TimeProvider.System).Snapshot().Status);
        Assert.Equal(3, Directory.GetFiles(Path.Combine(owner.Root, "audit-fallback"), "critical-audit-*.jsonl").Length);
    }

    [Fact]
    public async Task AuditLog_DequeueKeepsInFlightUntilCommitOrFallback()
    {
        using var owner = new AuditDurableTestOwner(store: new RecordingAuditLogStore());
        AuditLogChannel channel = owner.Channel;
        Assert.True(channel.TryWrite(LowValue("in-flight")));
        await owner.Journal.ReplayAsync(async (records, token) =>
        {
            AuditLogChannelSnapshot inFlight = channel.Snapshot();
            Assert.Equal(0, inFlight.QueuedCount);
            Assert.Equal(1, inFlight.InFlightCount);
            Assert.Equal("in-flight", inFlight.LastDisposition);
            await owner.Worker.WriteBatchOnceAsync(records, token);
        }, CancellationToken.None);
        AuditLogChannelSnapshot committed = channel.Snapshot();
        Assert.Equal(0, committed.OutstandingCount);
        Assert.Equal(1, committed.CommittedCount);
        Assert.Equal("committed", committed.LastDisposition);
    }

    [Fact]
    public async Task AuditLog_WorkerFailureReplaysThroughDurableFallbackAndHealth()
    {
        using var owner = new AuditDurableTestOwner(store: new ThrowingAuditLogStore());
        AuditLogChannel channel = owner.Channel;
        Assert.True(channel.TryWrite(LowValue("persist-fail")));
        await Assert.ThrowsAsync<InvalidOperationException>(() => owner.Worker.ReplayPendingOnceAsync(CancellationToken.None));

        AuditLogChannelSnapshot snapshot = channel.Snapshot();
        Assert.Equal(1, snapshot.OutstandingCount);
        Assert.Equal(1, snapshot.DurableAcceptedCount);
        Assert.Equal("durable-pending", snapshot.LastDisposition);
        Assert.Equal(1, snapshot.DurablePendingCount);
        Assert.Equal(0, snapshot.CommittedCount);
        Assert.Equal("pending", new AuditLogReleaseDrainParticipant(channel, TimeProvider.System).Snapshot().Status);
        using var restarted = new AuditDurableTestOwner(owner.Root, deleteRoot: false, store: new RecordingAuditLogStore());
        await restarted.Worker.ReplayPendingOnceAsync(CancellationToken.None);
        Assert.Equal("drained", new AuditLogReleaseDrainParticipant(restarted.Channel, TimeProvider.System).Snapshot().Status);
    }

    [Fact]
    public async Task AuditLog_FallbackReplayRestoresExactRecordsAfterRestart()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-audit-replay-" + Guid.NewGuid().ToString("N"));
        try
        {
            var channel = new AuditLogChannel();
            var runtimeState = new AuditLogRuntimeState(channel);
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["FSUSBLOG_DATA_ROOT"] = root
                })
                .Build();
            var writer = new AuditFallbackWriter(configuration, runtimeState);
            AuditRecord original = new(
                AuditSourceCatalog.Security,
                AuditTypeCatalog.Security,
                new DateTime(2026, 9, 6, 12, 0, 0, DateTimeKind.Utc),
                "replay-identity",
                null,
                Action: AuditActionCatalog.SecurityPolicyActivated,
                Outcome: AuditOutcomeCatalog.Failure,
                Severity: AuditSeverityCatalog.Critical,
                RecordHash: "hash-replay-1");
            await writer.WriteBatchAsync([original], new InvalidOperationException("store unavailable"), CancellationToken.None);

            var restored = new List<AuditRecord>();
            await writer.ReplayAsync((records, _) =>
            {
                restored.AddRange(records);
                return Task.CompletedTask;
            }, CancellationToken.None);

            AuditRecord replayed = Assert.Single(restored);
            Assert.Equal(original.RecordHash, replayed.RecordHash);
            Assert.Equal(original.EventInfo, replayed.EventInfo);
            Assert.Equal(original.Action, replayed.Action);
            Assert.Empty(Directory.GetFiles(Path.Combine(root, "audit-fallback"), "critical-audit-*.jsonl"));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public void AuditLog_UnknownDispositionAndTerminalFailureBlockHealth()
    {
        using var owner = new AuditDurableTestOwner();
        AuditLogChannel channel = owner.Channel;
        Assert.True(channel.TryWrite(LowValue("first")));
        string? previousAcceptedReference = owner.Journal.Snapshot().LastItemReference;
        Assert.False(channel.TryWrite(LowValue("terminal") with
        {
            Action = "unknown.audit.action"
        }));
        AuditLogChannelSnapshot snapshot = channel.Snapshot();
        Assert.Equal(1, snapshot.TerminalFailureCount);
        Assert.Equal("terminal-failed", snapshot.LastDisposition);
        Assert.Contains("admission-failed", snapshot.LastFailureReason, StringComparison.Ordinal);
        Assert.NotNull(snapshot.LastItemReference);
        Assert.NotEqual(previousAcceptedReference, snapshot.LastItemReference);
        ReleaseDrainParticipantSnapshot drain = new AuditLogReleaseDrainParticipant(channel, TimeProvider.System).Snapshot();
        Assert.Equal("terminal-failed", drain.Status);
        Assert.Equal("audit_log_terminal_failure", drain.ErrorCode);
        Assert.Contains(drain.Blockers!, static item => item.StartsWith("terminal-failed=", StringComparison.Ordinal));
        var health = new RequiredQueueHealthSnapshot(
            snapshot.TerminalFailureCount > 0 ? "failed" : "ok",
            new Dictionary<string, RequiredQueueHealthEntry>(StringComparer.Ordinal)
            {
                ["audit-log"] = new(
                    "audit-log",
                    snapshot.QueuedCount,
                    snapshot.InFlightCount,
                    snapshot.DurablePendingCount,
                    snapshot.CommittedCount,
                    snapshot.DurableAcceptedCount,
                    snapshot.RequeuedCount,
                    snapshot.TerminalFailureCount,
                    snapshot.LastDisposition,
                    snapshot.LastItemReference,
                    snapshot.LastFailureReason)
            });
        Assert.Equal("failed", health.Status);
    }

    [Fact]
    public async Task AdminAudit_OverflowCancelAndWorkerFailureUseDurableFallback()
    {
        var store = new FakeAdminAuditLogStore();
        using ServiceProvider provider = new ServiceCollection().AddSingleton<IAdminAuditLogStore>(store).BuildServiceProvider();
        var channel = new AdminAuditLogChannel(
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<AdminAuditLogChannel>.Instance);
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();
        await channel.EnqueueAsync(CreateAdminAudit("admin.cancel.fallback"), cancelled.Token);
        Assert.Single(store.Batches);
        Assert.Equal(1, channel.Snapshot().DurableAcceptedCount);

        var worker = new AdminAuditLogWriterWorker(
            channel,
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<AdminAuditLogWriterWorker>.Instance);
        store.FailNextWrite = true;
        await worker.FlushPendingAsync([CreateAdminAudit("admin.worker.fallback")], CancellationToken.None);
        Assert.Equal(2, store.Batches.Count);
        Assert.Equal(2, channel.Snapshot().DurableAcceptedCount);
        Assert.Equal(0, channel.Snapshot().TerminalFailureCount);
    }

    [Fact]
    public async Task SecurityRisk_OverflowWritesDurableFallbackAndDuplicateIdempotency()
    {
        var store = new RecordingRiskStore();
        using var owner = new SecurityRiskRequiredContractOwner(store,
            new SecurityRiskEventWriterOptions { Capacity = 1, BatchSize = 1, FlushWindowMs = 10 });
        SecurityRiskEventWriteQueue queue = owner.Queue;
        SecurityRiskEventWrite first = CreateRisk("risk-1");
        SecurityRiskEventWrite overflow = CreateRisk("risk-2");
        Assert.True(queue.TryWrite(first));
        Assert.True(queue.TryWrite(overflow));
        Assert.Empty(store.Writes); // Admission never calls a SQL/store operation.
        Assert.Equal(2, queue.Snapshot().DurableAcceptedCount);
        Assert.Equal(1, queue.Snapshot().QueuedCount);
        Assert.Equal(1, queue.Snapshot().DurablePendingCount);
        Assert.Equal(2, queue.Snapshot().OutstandingCount);
        Assert.Equal(0, queue.Snapshot().SyncFallbackCount);
        Assert.Equal(0, queue.Snapshot().ShedCount);
        queue.Complete();
        SecurityRiskEventWrite closed = CreateRisk("risk-closed");
        Assert.True(queue.TryWrite(closed));
        Assert.True(queue.TryWrite(overflow)); // Exact pending Id/payload does not publish a second source.
        Assert.Empty(store.Writes);
        Assert.Equal(3, queue.Snapshot().DurableAcceptedCount);
        Assert.Equal(2, queue.Snapshot().DurablePendingCount);
        Assert.Equal(3, queue.Snapshot().OutstandingCount);
        Assert.Equal("durable-pending", queue.Snapshot().LastDisposition);
        Assert.Equal(0, queue.Snapshot().SyncFallbackCount);
        Assert.Equal(0, queue.Snapshot().DroppedCount);
        Assert.Equal(3, Directory.GetFiles(owner.JournalRoot, "security-risk-*.json").Length);
        Assert.Equal("pending", new SecurityRiskReleaseDrainParticipant(queue, TimeProvider.System).Snapshot().Status);

        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        SecurityRiskRequiredContractOwner.AssertFullDelivery(first, Assert.Single(store.Writes));
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        SecurityRiskRequiredContractOwner.AssertFullDelivery(overflow, store.Writes[1]);
        Assert.Equal(2, store.Writes.Count);
        store.FailDuplicates = true;
        await store.AppendAsync(overflow, CancellationToken.None);
        Assert.Equal(2, store.Writes.Count);
        SecurityRiskRequiredContractOwner.AssertFullDelivery(overflow, store.Writes[1]);
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(3, store.Writes.Count);
        SecurityRiskRequiredContractOwner.AssertFullDelivery(closed, store.Writes[2]);
        Assert.Equal(0, queue.Snapshot().OutstandingCount);
        Assert.Equal(3, queue.Snapshot().CommittedCount);
        Assert.Equal("committed", queue.Snapshot().LastDisposition);
        Assert.Empty(Directory.GetFiles(owner.JournalRoot, "security-risk-*.json"));
        Assert.Empty(Directory.GetFiles(Path.Combine(owner.Root, "audit-retention", "epoch-keys")));
        Assert.Equal("drained", new SecurityRiskReleaseDrainParticipant(queue, TimeProvider.System).Snapshot().Status);
    }

    [Fact]
    public async Task SecurityRisk_QueuedZeroInFlightAndWorkerExceptionHaveExactDisposition()
    {
        var store = new ThrowingRiskStore();
        using var owner = new SecurityRiskRequiredContractOwner(store,
            new SecurityRiskEventWriterOptions { Capacity = 4, BatchSize = 2, FlushWindowMs = 10 });
        SecurityRiskEventWriteQueue queue = owner.Queue;
        SecurityRiskEventWrite original = CreateRisk("in-flight");
        Assert.True(queue.TryWrite(original));
        Assert.True(queue.TryRead(out SecurityRiskEventWrite write));
        SecurityRiskRequiredContractOwner.AssertFullDelivery(original, write);
        Assert.Equal(0, queue.Snapshot().QueuedCount);
        Assert.Equal(1, queue.Snapshot().InFlightCount);
        Assert.Equal(1, queue.Snapshot().OutstandingCount);
        Assert.Single(Directory.GetFiles(owner.JournalRoot, "security-risk-*.json"));

        await owner.Worker.PersistSafelyAsync([write], CancellationToken.None);
        SecurityRiskEventWriteQueueSnapshot snapshot = queue.Snapshot();
        Assert.Equal(1, snapshot.TerminalFailureCount);
        Assert.Equal("terminal-failed", snapshot.LastDisposition);
        ReleaseDrainParticipantSnapshot drain = new SecurityRiskReleaseDrainParticipant(queue, TimeProvider.System).Snapshot();
        Assert.Equal("security_risk_terminal_failure", drain.ErrorCode);
        Assert.Equal(0, snapshot.InFlightCount);
        Assert.Equal(0, snapshot.DurablePendingCount);
        Assert.Equal(1, snapshot.OutstandingCount);
        Assert.Equal(0, snapshot.CommittedCount);
        Assert.Equal(0, snapshot.SyncFallbackCount);
        Assert.Equal(0, snapshot.DroppedCount);
        Assert.Equal("terminal-failed", drain.Status);
        Assert.Contains("terminal-failed=1", drain.Blockers!);
        Assert.Single(Directory.GetFiles(owner.JournalRoot, "security-risk-*.json"));
        Assert.Single(Directory.GetFiles(owner.JournalRoot, "security-risk-*.json.failed"));
    }

    [Fact]
    public async Task ChallengeV2_OverflowUsesDurableAttemptIdentityInsteadOfWarningDrop()
    {
        var persistence = new RecordingChallengePersistence();
        using var owner = new ChallengeV2Issue2040Owner(capacity: 1, persistence: persistence);
        ChallengeV2AuditEventQueue queue = owner.Queue;

        await queue.WriteAsync(CreateChallenge("queued", SecurityChallengeAttemptOutcomes.Verified), CancellationToken.None);
        await queue.WriteAsync(CreateChallenge("overflow", SecurityChallengeAttemptOutcomes.Verified), CancellationToken.None);
        ChallengeV2AuditEventQueueSnapshot snapshot = queue.Snapshot();
        Assert.Equal(1, snapshot.NormalQueuedCount);
        Assert.Equal(0, snapshot.DroppedLowValueCount);
        Assert.Equal(2, snapshot.DurableAcceptedCount);
        Assert.Equal(1, snapshot.DurablePendingCount);
        Assert.Empty(persistence.Attempts);
        Assert.Equal(2, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(["queued", "overflow"], persistence.Attempts.Select(item => item.ChallengeId));

        await persistence.RecordAttemptAsync(persistence.Attempts[1], CancellationToken.None);
        Assert.Equal(2, persistence.Attempts.Count);
        Assert.Equal(0, queue.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task ChallengeV2_HighValueWorkerFailureRequeuesOrGoesTerminal()
    {
        var persistence = new ThrowingChallengePersistence();
        using var owner = new ChallengeV2Issue2040Owner(capacity: 1, persistence: persistence);
        ServiceProvider provider = owner.Provider;
        ChallengeV2AuditEventQueue queue = owner.Queue;
        var worker = new ChallengeV2AuditEventWriterWorker(
            queue,
            provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new ChallengeV2EventWriterOptions { BatchSize = 1, FlushWindowMs = 10 }),
            NullLogger<ChallengeV2AuditEventWriterWorker>.Instance);
        await queue.WriteAsync(CreateChallenge("replay-1", SecurityChallengeAttemptOutcomes.Replayed, "perception_replayed"), CancellationToken.None);
        Assert.True(queue.TryRead(out ChallengeV2AuditEvent? item));
        Assert.Equal(1, queue.Snapshot().InFlightCount);
        await worker.PersistSafelyAsync([item!], CancellationToken.None);
        ChallengeV2AuditEventQueueSnapshot snapshot = queue.Snapshot();
        Assert.True(snapshot.RequeuedCount + snapshot.TerminalFailureCount >= 1);
        Assert.True(snapshot.LastDisposition is "requeued" or "terminal-failed");
        ReleaseDrainParticipantSnapshot drain = new ChallengeAuditReleaseDrainParticipant(queue, TimeProvider.System).Snapshot();
        Assert.True(drain.PendingCount > 0);
    }

    [Fact]
    public void RequiredQueues_AreIsolatedByOwnerSnapshots()
    {
        var audit = new AuditLogChannel(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.Wait });
        var store = new RecordingRiskStore();
        using var owner = new SecurityRiskRequiredContractOwner(store,
            new SecurityRiskEventWriterOptions { Capacity = 1 });
        SecurityRiskEventWriteQueue risk = owner.Queue;
        Assert.True(audit.TryWrite(LowValue("audit-only")));
        Assert.True(risk.TryWrite(CreateRisk("risk-only")));
        Assert.Equal(1, audit.Snapshot().QueuedCount);
        Assert.Equal(0, audit.Snapshot().TerminalFailureCount);
        Assert.Equal(1, risk.Snapshot().QueuedCount);
        Assert.NotEqual(audit.Snapshot().LastItemReference, risk.Snapshot().LastItemReference);
        Assert.Empty(store.Writes);
        Assert.Single(Directory.GetFiles(owner.JournalRoot, "security-risk-*.json"));
    }

    private static ServiceProvider CreateAuditServices(
        IAuditFallbackWriter fallback,
        IAuditLogStore? store = null)
        => new ServiceCollection()
            .AddSingleton(fallback)
            .AddSingleton(store ?? new RecordingAuditLogStore())
            .BuildServiceProvider();

    private static AuditRecord LowValue(string eventInfo)
        => new("request", "business", DateTime.UtcNow, eventInfo, null);

    private static AdminAuditLog CreateAdminAudit(string action)
        => new()
        {
            AdminPrincipalId = 1,
            AdminSessionId = "session-1",
            Action = action,
            Outcome = "success",
            IsHighImpact = true,
            MetadataJson = "{}",
            OccurredAtUtc = DateTime.UtcNow
        };

    private static SecurityRiskEventWrite CreateRisk(string id)
        => new(
            id,
            DateTimeOffset.UtcNow,
            SecurityRiskSources.RiskControl,
            nameof(SecurityRiskReason.SecurityChallengeRejected),
            RiskActionNames.AuthLogin,
            1,
            1,
            60,
            DateTimeOffset.UtcNow.AddMinutes(1),
            null,
            "auth:login",
            null,
            null,
            "/api/binary/security/challenge",
            "POST",
            "unit-test",
            "detail",
            "trace-test");

    private static ChallengeV2AuditEvent CreateChallenge(string challengeId, string outcome, string? reason = null)
        => ChallengeV2AuditEvent.FromAttempt(
            new SecurityChallengeAttemptRequest(
                challengeId,
                outcome,
                reason,
                HashB,
                HashA,
                HashA,
                "trace-test",
                Traceparent,
                DateTime.UtcNow),
            ChallengeV2EventKind.FromAttempt(outcome, reason, "auth.login"),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionMicroInteractionV2),
            "auth.login");

    private sealed class RecordingAuditFallbackWriter : IAuditFallbackWriter
    {
        public List<AuditRecord> Records { get; } = [];

        public Task WriteAsync(AuditRecord record, Exception reason, CancellationToken cancellationToken)
        {
            Records.Add(record);
            return Task.CompletedTask;
        }

        public Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, Exception reason, CancellationToken cancellationToken)
        {
            Records.AddRange(records);
            return Task.CompletedTask;
        }
    }

    private sealed class ThrowingAuditFallbackWriter : IAuditFallbackWriter
    {
        public Task WriteAsync(AuditRecord record, Exception reason, CancellationToken cancellationToken)
            => throw new IOException("fallback unavailable");

        public Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, Exception reason, CancellationToken cancellationToken)
            => throw new IOException("fallback unavailable");
    }

    private sealed class RecordingAuditLogStore : IAuditLogStore
    {
        public List<AuditRecord> Records { get; } = [];

        public Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, CancellationToken cancellationToken)
        {
            Records.AddRange(records);
            return Task.CompletedTask;
        }
    }

    private sealed class ThrowingAuditLogStore : IAuditLogStore
    {
        public Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, CancellationToken cancellationToken)
            => throw new InvalidOperationException("audit store unavailable");
    }

    private sealed class FakeAdminAuditLogStore : IAdminAuditLogStore
    {
        public List<AdminAuditLog[]> Batches { get; } = new();

        public bool FailNextWrite
        {
            get; set;
        }

        public Task WriteBatchAsync(IReadOnlyList<AdminAuditLog> audits, CancellationToken cancellationToken)
        {
            if (FailNextWrite)
            {
                FailNextWrite = false;
                throw new InvalidOperationException("synthetic batch failure");
            }

            Batches.Add(audits.ToArray());
            return Task.CompletedTask;
        }
    }

    // This private fixture owns the SecurityRisk contract cases. Its
    // recording store proves journal/worker behavior, not PostgreSQL qualification.
    private sealed class SecurityRiskRequiredContractOwner : IDisposable
    {
        private readonly ServiceProvider _provider;
        internal string Root
        {
            get;
        }
        internal string JournalRoot => Path.Combine(Root, "security-risk-fallback");
        internal SecurityRiskEventWriteQueue Queue
        {
            get;
        }
        internal SecurityRiskEventWriterWorker Worker
        {
            get;
        }

        internal SecurityRiskRequiredContractOwner(ISecurityRiskEventStore store, SecurityRiskEventWriterOptions options)
        {
            if (OperatingSystem.IsWindows())
            {
                throw new PlatformNotSupportedException("Private Unix root evidence is required.");
            }
            Root = Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath(),
                "fsusblog-required-risk-2040-" + Guid.NewGuid().ToString("N"));
            UnixFileMode mode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
            Directory.CreateDirectory(Root, mode);
            Assert.Equal(mode, File.GetUnixFileMode(Root));
            IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["FSUSBLOG_DATA_ROOT"] = Root
            }).Build();
            _provider = new ServiceCollection().AddSingleton(configuration)
                .AddSingleton<IAuditRetentionEpochKeyStore>(new LocalAuditRetentionEpochKeyStore(configuration))
                .AddSingleton(store).BuildServiceProvider();
            IOptions<SecurityRiskEventWriterOptions> configured = Options.Create(options);
            Queue = new SecurityRiskEventWriteQueue(configured, NullLogger<SecurityRiskEventWriteQueue>.Instance,
                _provider.GetRequiredService<IServiceScopeFactory>());
            Worker = new SecurityRiskEventWriterWorker(Queue, _provider.GetRequiredService<IServiceScopeFactory>(), configured,
                NullLogger<SecurityRiskEventWriterWorker>.Instance);
        }

        internal static void AssertFullDelivery(SecurityRiskEventWrite expected, SecurityRiskEventWrite actual)
        {
            Assert.Equal(expected.Id, actual.Id);
            Assert.Equal(expected.OccurredAtUtc, actual.OccurredAtUtc);
            Assert.Equal(expected.Source, actual.Source);
            Assert.Equal(expected.Reason, actual.Reason);
            Assert.Equal(expected.Action, actual.Action);
            Assert.Equal(expected.ScoreDelta, actual.ScoreDelta);
            Assert.Equal(expected.TotalScore, actual.TotalScore);
            Assert.Equal(expected.TtlSeconds, actual.TtlSeconds);
            Assert.Equal(expected.ExpiresAtUtc, actual.ExpiresAtUtc);
            Assert.Equal(expected.SubjectHash, actual.SubjectHash);
            Assert.Equal(expected.RouteKey, actual.RouteKey);
            Assert.Equal(expected.ClientIpHash, actual.ClientIpHash);
            Assert.Equal(expected.DeviceFpHash, actual.DeviceFpHash);
            Assert.Null(actual.Path);
            Assert.Equal(expected.Method, actual.Method);
            Assert.Null(actual.UserAgent);
            Assert.Equal(expected.Detail, actual.Detail);
            Assert.Equal(expected.TraceId, actual.TraceId);
            Assert.Equal(expected.PseudonymEpoch, actual.PseudonymEpoch);
        }

        public void Dispose()
        {
            Worker.Dispose();
            Queue.Dispose();
            _provider.Dispose();
            if (Directory.Exists(Root))
            {
                Directory.Delete(Root, recursive: true);
            }
        }
    }

    private sealed class RecordingRiskStore : ISecurityRiskEventStore
    {
        public List<SecurityRiskEventWrite> Writes { get; } = new();

        public bool FailDuplicates
        {
            get; set;
        }

        public Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
        {
            if (FailDuplicates && Writes.Any(item => item.Id == write.Id))
            {
                return Task.CompletedTask;
            }

            Writes.Add(write);
            return Task.CompletedTask;
        }

        public Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken = default)
        {
            foreach (SecurityRiskEventWrite write in writes)
            {
                Writes.Add(write);
            }

            return Task.CompletedTask;
        }

        public Task<IReadOnlyList<SecurityRiskEventRecord>> QueryAsync(SecurityRiskEventQuery query, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);

        public Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(
            SecurityRiskScoreQuery query,
            DateTimeOffset now,
            int limit,
            CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);
    }

    private sealed class ThrowingRiskStore : ISecurityRiskEventStore
    {
        public Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("risk store unavailable");

        public Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("risk store unavailable");

        public Task<IReadOnlyList<SecurityRiskEventRecord>> QueryAsync(SecurityRiskEventQuery query, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);

        public Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(
            SecurityRiskScoreQuery query,
            DateTimeOffset now,
            int limit,
            CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);
    }

    private sealed class RecordingChallengePersistence : ISecurityChallengePersistenceService
    {
        public List<SecurityChallengeAttemptRequest> Attempts { get; } = [];

        public Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default)
        {
            SecurityChallengeAttemptRequest? existing = Attempts.FirstOrDefault(item => item.AttemptId == request.AttemptId);
            if (existing is not null)
            {
                SecurityChallengeAttempt stored = ToAttempt(existing);
                if (!ChallengeV2DurableDelivery.MatchesStored(ChallengeV2DurableDelivery.GetRequired(request), stored))
                {
                    throw new InvalidOperationException("security_challenge_attempt_idempotency_conflict");
                }
                return Task.FromResult(stored);
            }

            Attempts.Add(request);
            return Task.FromResult(ToAttempt(request));
        }

        public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        private static SecurityChallengeAttempt ToAttempt(SecurityChallengeAttemptRequest request)
            => ChallengeV2DurableDelivery.GetRequired(request).ToEntity();
    }

    private sealed class ThrowingChallengePersistence : ISecurityChallengePersistenceService
    {
        public Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("challenge store unavailable");

        public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(false);
    }
}
