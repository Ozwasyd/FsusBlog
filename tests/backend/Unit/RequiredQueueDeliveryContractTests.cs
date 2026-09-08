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
        var fallback = new RecordingAuditFallbackWriter();
        using ServiceProvider provider = CreateAuditServices(fallback);
        var channel = new AuditLogChannel(
            new BoundedChannelOptions(1)
            {
                SingleReader = true,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.Wait
            },
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<AuditLogChannel>.Instance);

        Assert.True(channel.TryWrite(LowValue("queued")));
        Assert.False(channel.TryWrite(LowValue("overflow")));
        AuditLogChannelSnapshot full = channel.Snapshot();
        Assert.Equal(1, full.QueuedCount);
        Assert.Equal(1, full.DurableAcceptedCount);
        Assert.Equal("durable-accepted", full.LastDisposition);
        Assert.Equal(["overflow"], fallback.Records.Select(static item => item.EventInfo).ToArray());

        channel.Complete();
        Assert.False(channel.TryWrite(LowValue("closed")));
        AuditLogChannelSnapshot closed = channel.Snapshot();
        Assert.Equal(2, closed.DurableAcceptedCount);
        Assert.Equal(0, closed.TerminalFailureCount);
        Assert.Equal(["overflow", "closed"], fallback.Records.Select(static item => item.EventInfo).ToArray());
    }

    [Fact]
    public async Task AuditLog_DequeueKeepsInFlightUntilCommitOrFallback()
    {
        var store = new RecordingAuditLogStore();
        var fallback = new RecordingAuditFallbackWriter();
        using ServiceProvider provider = CreateAuditServices(fallback, store);
        var channel = new AuditLogChannel(provider.GetRequiredService<IServiceScopeFactory>(), NullLogger<AuditLogChannel>.Instance);
        var worker = new AuditLogWriterWorker(
            channel,
            provider.GetRequiredService<IServiceScopeFactory>(),
            new AuditLogRuntimeState(channel),
            fallback,
            NullLogger<AuditLogWriterWorker>.Instance);
        Assert.True(channel.TryWrite(LowValue("in-flight")));
        AuditRecord record = await channel.ReadAsync(CancellationToken.None);
        AuditLogChannelSnapshot inFlight = channel.Snapshot();
        Assert.Equal(0, inFlight.QueuedCount);
        Assert.Equal(1, inFlight.InFlightCount);
        Assert.Equal("in-flight", inFlight.LastDisposition);

        await worker.WriteBatchOnceAsync([record], CancellationToken.None);
        AuditLogChannelSnapshot committed = channel.Snapshot();
        Assert.Equal(0, committed.OutstandingCount);
        Assert.Equal(1, committed.CommittedCount);
        Assert.Equal("committed", committed.LastDisposition);
    }

    [Fact]
    public async Task AuditLog_WorkerFailureReplaysThroughDurableFallbackAndHealth()
    {
        var fallback = new RecordingAuditFallbackWriter();
        using ServiceProvider provider = CreateAuditServices(fallback, new ThrowingAuditLogStore());
        var channel = new AuditLogChannel(provider.GetRequiredService<IServiceScopeFactory>(), NullLogger<AuditLogChannel>.Instance);
        var worker = new AuditLogWriterWorker(
            channel,
            provider.GetRequiredService<IServiceScopeFactory>(),
            new AuditLogRuntimeState(channel),
            fallback,
            NullLogger<AuditLogWriterWorker>.Instance);
        Assert.True(channel.TryWrite(LowValue("persist-fail")));
        AuditRecord record = await channel.ReadAsync(CancellationToken.None);
        await worker.PersistSafelyAsync([record], CancellationToken.None);

        AuditLogChannelSnapshot snapshot = channel.Snapshot();
        Assert.Equal(0, snapshot.OutstandingCount);
        Assert.Equal(1, snapshot.DurableAcceptedCount);
        Assert.Equal("durable-accepted", snapshot.LastDisposition);
        Assert.Equal("persist-fail", Assert.Single(fallback.Records).EventInfo);
        Assert.Equal("drained", new AuditLogReleaseDrainParticipant(channel, TimeProvider.System).Snapshot().Status);
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
        using ServiceProvider provider = CreateAuditServices(new ThrowingAuditFallbackWriter());
        var channel = new AuditLogChannel(
            new BoundedChannelOptions(1)
            {
                SingleReader = true,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.Wait
            },
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<AuditLogChannel>.Instance);
        Assert.True(channel.TryWrite(LowValue("first")));
        Assert.False(channel.TryWrite(LowValue("terminal")));
        AuditLogChannelSnapshot snapshot = channel.Snapshot();
        Assert.Equal(1, snapshot.TerminalFailureCount);
        Assert.Equal("terminal-failed", snapshot.LastDisposition);
        Assert.Contains("fallback-failed", snapshot.LastFailureReason, StringComparison.Ordinal);
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
        using ServiceProvider provider = new ServiceCollection().AddSingleton<ISecurityRiskEventStore>(store).BuildServiceProvider();
        var queue = new SecurityRiskEventWriteQueue(
            Options.Create(new SecurityRiskEventWriterOptions { Capacity = 1, BatchSize = 1, FlushWindowMs = 10 }),
            NullLogger<SecurityRiskEventWriteQueue>.Instance,
            provider.GetRequiredService<IServiceScopeFactory>());
        SecurityRiskEventWrite first = CreateRisk("risk-1");
        SecurityRiskEventWrite overflow = CreateRisk("risk-2");
        Assert.True(queue.TryWrite(first));
        Assert.False(queue.TryWrite(overflow));
        Assert.Equal("risk-2", Assert.Single(store.Writes).Id);
        Assert.Equal(1, queue.Snapshot().DurableAcceptedCount);

        store.FailDuplicates = true;
        await store.AppendAsync(overflow, CancellationToken.None);
        Assert.Single(store.Writes);

        queue.Complete();
        Assert.False(queue.TryWrite(CreateRisk("risk-closed")));
        Assert.Equal(2, store.Writes.Count);
        Assert.Equal("durable-accepted", queue.Snapshot().LastDisposition);
    }

    [Fact]
    public async Task SecurityRisk_QueuedZeroInFlightAndWorkerExceptionHaveExactDisposition()
    {
        var store = new ThrowingRiskStore();
        using ServiceProvider provider = new ServiceCollection().AddSingleton<ISecurityRiskEventStore>(store).BuildServiceProvider();
        var queue = new SecurityRiskEventWriteQueue(
            Options.Create(new SecurityRiskEventWriterOptions { Capacity = 4, BatchSize = 2, FlushWindowMs = 10 }),
            NullLogger<SecurityRiskEventWriteQueue>.Instance,
            provider.GetRequiredService<IServiceScopeFactory>());
        var worker = new SecurityRiskEventWriterWorker(
            queue,
            provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new SecurityRiskEventWriterOptions { BatchSize = 2, FlushWindowMs = 10 }),
            NullLogger<SecurityRiskEventWriterWorker>.Instance);
        Assert.True(queue.TryWrite(CreateRisk("in-flight")));
        Assert.True(queue.TryRead(out SecurityRiskEventWrite write));
        Assert.Equal(0, queue.Snapshot().QueuedCount);
        Assert.Equal(1, queue.Snapshot().InFlightCount);

        await worker.PersistSafelyAsync([write], CancellationToken.None);
        SecurityRiskEventWriteQueueSnapshot snapshot = queue.Snapshot();
        Assert.Equal(1, snapshot.TerminalFailureCount);
        Assert.Equal("terminal-failed", snapshot.LastDisposition);
        ReleaseDrainParticipantSnapshot drain = new SecurityRiskReleaseDrainParticipant(queue, TimeProvider.System).Snapshot();
        Assert.Equal("security_risk_terminal_failure", drain.ErrorCode);
        Assert.Equal(0, snapshot.InFlightCount);
    }

    [Fact]
    public async Task ChallengeV2_OverflowUsesDurableAttemptIdentityInsteadOfWarningDrop()
    {
        var persistence = new RecordingChallengePersistence();
        using ServiceProvider provider = new ServiceCollection()
            .AddSingleton<ISecurityChallengePersistenceService>(persistence)
            .BuildServiceProvider();
        var queue = new ChallengeV2AuditEventQueue(
            Options.Create(new ChallengeV2EventWriterOptions { Capacity = 1, HighValueCapacity = 1, BatchSize = 8, FlushWindowMs = 10 }),
            NullLogger<ChallengeV2AuditEventQueue>.Instance,
            provider.GetRequiredService<IServiceScopeFactory>());

        await queue.WriteAsync(CreateChallenge("queued", SecurityChallengeAttemptOutcomes.Verified), CancellationToken.None);
        await queue.WriteAsync(CreateChallenge("overflow", SecurityChallengeAttemptOutcomes.Verified), CancellationToken.None);
        ChallengeV2AuditEventQueueSnapshot snapshot = queue.Snapshot();
        Assert.Equal(1, snapshot.NormalQueuedCount);
        Assert.Equal(0, snapshot.DroppedLowValueCount);
        Assert.Equal(1, snapshot.DurableAcceptedCount);
        Assert.Equal("overflow", Assert.Single(persistence.Attempts).ChallengeId);

        await persistence.RecordAttemptAsync(persistence.Attempts[0], CancellationToken.None);
        Assert.Single(persistence.Attempts);
    }

    [Fact]
    public async Task ChallengeV2_HighValueWorkerFailureRequeuesOrGoesTerminal()
    {
        var persistence = new ThrowingChallengePersistence();
        using ServiceProvider provider = new ServiceCollection()
            .AddSingleton<ISecurityChallengePersistenceService>(persistence)
            .BuildServiceProvider();
        var queue = new ChallengeV2AuditEventQueue(
            Options.Create(new ChallengeV2EventWriterOptions { Capacity = 1, HighValueCapacity = 1, BatchSize = 1, FlushWindowMs = 10 }),
            NullLogger<ChallengeV2AuditEventQueue>.Instance,
            provider.GetRequiredService<IServiceScopeFactory>());
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
        var risk = new SecurityRiskEventWriteQueue(
            Options.Create(new SecurityRiskEventWriterOptions { Capacity = 1 }),
            NullLogger<SecurityRiskEventWriteQueue>.Instance);
        Assert.True(audit.TryWrite(LowValue("audit-only")));
        Assert.True(risk.TryWrite(CreateRisk("risk-only")));
        Assert.Equal(1, audit.Snapshot().QueuedCount);
        Assert.Equal(0, audit.Snapshot().TerminalFailureCount);
        Assert.Equal(1, risk.Snapshot().QueuedCount);
        Assert.NotEqual(audit.Snapshot().LastItemReference, risk.Snapshot().LastItemReference);
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
            if (Attempts.Any(item => item.AttemptId == request.AttemptId && request.AttemptId is not null))
            {
                return Task.FromResult(ToAttempt(request));
            }

            Attempts.Add(request);
            return Task.FromResult(ToAttempt(request));
        }

        public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        private static SecurityChallengeAttempt ToAttempt(SecurityChallengeAttemptRequest request)
            => new()
            {
                AttemptId = request.AttemptId ?? Guid.NewGuid().ToString("N"),
                ChallengeId = request.ChallengeId,
                Outcome = request.Outcome,
                Reason = request.Reason,
                PayloadHash = request.PayloadHash,
                ClientIpHash = request.ClientIpHash,
                DeviceFpHash = request.DeviceFpHash,
                TraceId = request.TraceId,
                Traceparent = request.Traceparent,
                AttemptedAtUtc = request.AttemptedAtUtc ?? DateTime.UtcNow
            };
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
