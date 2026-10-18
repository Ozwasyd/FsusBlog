using System.Text.Json;
using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ProductionQueueDiagnosticProjectionTests
{
    [Fact]
    public async Task ActualOwnerProjection_PreservesFourDistinctSnapshotCountersAndDispositions()
    {
        var audit = new AuditLogChannel(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.Wait });
        audit.MarkCommitted(7);
        audit.MarkDurableAccepted(9);
        audit.MarkRequeued(5);
        using var admin = new AdminAuditIssue2040Owner();
        await admin.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("diagnostic-owner"));
        Assert.True(admin.Channel.TryRead(out AdminAuditLog? adminItem));
        Assert.True(admin.Channel.TryRequeue(adminItem!));
        Assert.True(admin.Channel.TryRead(out adminItem));
        await admin.Worker.FlushPendingAsync([adminItem!], CancellationToken.None);
        using var risk = new SecurityRiskIssue2040Owner();
        for (int index = 0; index < 3; index++)
        {
            Assert.True(await risk.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
        }
        Assert.True(risk.Queue.TryRead(out SecurityRiskEventWrite riskItem));
        Assert.True(risk.Queue.TryRequeue(riskItem));
        await risk.Worker.FlushOnceAsync(CancellationToken.None);
        using var challenge = new ChallengeV2Issue2040Owner(capacity: 1);
        for (int index = 0; index < 4; index++)
        {
            await challenge.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event($"diagnostic-{index}", index % 2 == 0));
        }
        Assert.True(challenge.Queue.TryRead(out ChallengeV2AuditEvent? challengeItem));
        Assert.True(challenge.Queue.TryRequeue(challengeItem!));
        await challenge.Worker.FlushOnceAsync(CancellationToken.None);
        using ServiceProvider provider = new ServiceCollection()
            .AddSingleton(audit)
            .AddSingleton(admin.Channel)
            .AddSingleton(risk.Queue)
            .AddSingleton(challenge.Queue)
            .BuildServiceProvider();

        IReadOnlyDictionary<string, RequiredQueueOwnerDiagnosticSnapshot> actual = ProductionReadinessProbe.CaptureRequiredQueueOwnerDiagnostics(provider);

        Assert.Equal(4, actual.Count);
        AuditLogChannelSnapshot auditSnapshot = audit.Snapshot();
        AssertDiagnostic(actual["audit-log"], auditSnapshot.CommittedCount, auditSnapshot.DurableAcceptedCount, auditSnapshot.RequeuedCount, auditSnapshot.Sequence, auditSnapshot.LastDisposition);
        AdminAuditLogChannelSnapshot adminSnapshot = admin.Channel.Snapshot();
        AssertDiagnostic(actual["admin-audit-log"], adminSnapshot.CommittedCount, adminSnapshot.DurableAcceptedCount, adminSnapshot.RequeuedCount, adminSnapshot.Sequence, adminSnapshot.LastDisposition);
        SecurityRiskEventWriteQueueSnapshot riskSnapshot = risk.Queue.Snapshot();
        AssertDiagnostic(actual["security-risk-event"], riskSnapshot.CommittedCount, riskSnapshot.DurableAcceptedCount, riskSnapshot.RequeuedCount, riskSnapshot.Sequence, riskSnapshot.LastDisposition);
        ChallengeV2AuditEventQueueSnapshot challengeSnapshot = challenge.Queue.Snapshot();
        AssertDiagnostic(actual["challenge-v2-event"], challengeSnapshot.CommittedCount, challengeSnapshot.DurableAcceptedCount, challengeSnapshot.RequeuedCount, challengeSnapshot.Sequence, challengeSnapshot.LastDisposition);
        Assert.Equal(7, actual["audit-log"].Committed);
        Assert.True(actual["admin-audit-log"].Committed > 0);
        Assert.True(actual["security-risk-event"].Committed > 0);
        Assert.True(actual["challenge-v2-event"].Committed > 0);
        Assert.Equal(4, actual.Values.Select(static item => item.DurableAccepted).Distinct().Count());
        Assert.All(actual.Values, static item => Assert.Null(item.LastItemReference));
    }

    [Fact]
    public void ActualAuthority_MissingAggregatorStaysFailedWithAvailableOwnerDiagnostics()
    {
        var audit = new AuditLogChannel(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.Wait });
        audit.MarkCommitted(2);
        using ServiceProvider provider = new ServiceCollection().AddSingleton(audit).BuildServiceProvider();

        (RequiredQueueHealthSnapshot required, BoundedQueueDrainHealthCheck drain) = CreateProbe(provider).CaptureBoundedQueueAuthority();

        Assert.Equal("failed", required.Status);
        Assert.Equal("failed", required.QualificationStatus);
        Assert.Equal("failed", drain.Status);
        Assert.False(drain.Complete);
        Assert.Contains("observer-unavailable", required.Blockers);
        Assert.Empty(required.Queues);
        Assert.Single(required.OwnerDiagnostics);
        Assert.Equal(2, required.OwnerDiagnostics["audit-log"].Committed);
        Assert.DoesNotContain("admin-audit-log", required.OwnerDiagnostics.Keys);
        Assert.DoesNotContain("security-risk-event", required.OwnerDiagnostics.Keys);
        Assert.DoesNotContain("challenge-v2-event", required.OwnerDiagnostics.Keys);
    }

    [Fact]
    public async Task ActualAuthority_ChallengeLanesShareOnlyOneOwnerDiagnosticAndRetireFlatPlaceholders()
    {
        using var challenge = new ChallengeV2Issue2040Owner(capacity: 1);
        await challenge.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("normal-diagnostic", false));
        await challenge.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("high-diagnostic", true));
        var catalog = new ChallengeDiagnosticCatalog();
        IBoundedQueueDrainParticipant[] participants =
        [
            new ChallengeAuditHighValueBoundedQueueDrainParticipant(catalog, challenge.Queue, TimeProvider.System),
            new ChallengeAuditNormalBoundedQueueDrainParticipant(catalog, challenge.Queue, TimeProvider.System)
        ];
        var aggregator = new BoundedQueueDrainAggregator(catalog, participants, TimeProvider.System);
        using ServiceProvider provider = new ServiceCollection()
            .AddSingleton(challenge.Queue)
            .AddSingleton(aggregator)
            .BuildServiceProvider();
        BoundedQueueDrainAggregateReceipt expected = aggregator.Observe();

        (RequiredQueueHealthSnapshot required, BoundedQueueDrainHealthCheck drain) = CreateProbe(provider).CaptureBoundedQueueAuthority();

        Assert.Equal(expected.RunId, required.RunId);
        Assert.Equal(expected.ContentDigest, required.ContentDigest);
        Assert.Equal(expected.QualificationStatus, required.QualificationStatus);
        Assert.Equal(expected.HealthStatus, required.Status);
        Assert.Equal(expected.Blockers, required.Blockers);
        Assert.Equal(required.RunId, drain.RunId);
        Assert.Equal(required.ContentDigest, drain.ContentDigest);
        Assert.Equal(2, required.Queues.Count);
        RequiredQueueOwnerDiagnosticSnapshot diagnostic = Assert.Single(required.OwnerDiagnostics).Value;
        Assert.Equal("challenge-v2-event", diagnostic.OwnerId);
        Assert.Equal(2, diagnostic.DurableAccepted);
        Assert.False(diagnostic.QualificationEligible);
        Assert.All(required.Queues.Values, static entry =>
        {
            Assert.Null(entry.Committed);
            Assert.Null(entry.DurableAccepted);
            Assert.Null(entry.Requeued);
            Assert.Null(entry.LastDisposition);
            Assert.Null(entry.LastItemReference);
            Assert.Equal("Success", entry.CommitPostcondition);
        });
        Assert.False(drain.Complete);
        Assert.NotEqual("ok", required.Status);
    }

    [Fact]
    public async Task ActualAuthority_UnavailableJournalDiagnosticsPreserveStructuredAggregateFailure()
    {
        using var challenge = new ChallengeV2Issue2040Owner(capacity: 1);
        await challenge.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("owned-journal-fault", false));
        string lane = Path.Combine(challenge.Root, "challenge-v2-fallback", "normal");
        Directory.Move(lane, lane + ".owned-backup");
        try
        {
            await File.WriteAllTextAsync(lane, "Owned test makes diagnostic journal unavailable.");
            Assert.ThrowsAny<IOException>(() => challenge.Queue.Snapshot());
            var audit = new AuditLogChannel(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.Wait });
            audit.MarkCommitted(4);
            var catalog = new ChallengeDiagnosticCatalog();
            IBoundedQueueDrainParticipant[] participants =
            [
                new ChallengeAuditHighValueBoundedQueueDrainParticipant(catalog, challenge.Queue, TimeProvider.System),
                new ChallengeAuditNormalBoundedQueueDrainParticipant(catalog, challenge.Queue, TimeProvider.System)
            ];
            var aggregator = new BoundedQueueDrainAggregator(catalog, participants, TimeProvider.System);
            using ServiceProvider provider = new ServiceCollection().AddSingleton(audit)
                .AddSingleton(challenge.Queue).AddSingleton(aggregator).BuildServiceProvider();
            BoundedQueueDrainAggregateReceipt expected = aggregator.Observe();

            var (required, drain) = CreateProbe(provider).CaptureBoundedQueueAuthority();

            Assert.Equal("failed", required.Status);
            Assert.Equal(expected.RunId, required.RunId);
            Assert.Equal(expected.ContentDigest, required.ContentDigest);
            Assert.Equal(expected.QualificationStatus, required.QualificationStatus);
            Assert.Equal(expected.Blockers, required.Blockers);
            Assert.NotEmpty(required.Blockers);
            Assert.Equal(required.ContentDigest, drain.ContentDigest);
            Assert.False(drain.Complete);
            Assert.Single(required.OwnerDiagnostics);
            Assert.Equal(4, required.OwnerDiagnostics["audit-log"].Committed);
            Assert.DoesNotContain("challenge-v2-event", required.OwnerDiagnostics.Keys);

            using ServiceProvider missingAggregator = new ServiceCollection().AddSingleton(audit)
                .AddSingleton(challenge.Queue).BuildServiceProvider();
            var (missing, missingDrain) = CreateProbe(missingAggregator).CaptureBoundedQueueAuthority();
            Assert.Contains("observer-unavailable", missing.Blockers);
            Assert.False(missingDrain.Complete);
            Assert.Single(missing.OwnerDiagnostics);
        }
        finally
        {
            File.Delete(lane);
            Directory.Move(lane + ".owned-backup", lane);
        }
    }

    [Fact]
    public void ActualOwnerProjection_UnavailableServiceResolutionIsOmitted()
    {
        var audit = new AuditLogChannel(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.Wait });
        using ServiceProvider provider = new ServiceCollection().AddSingleton(audit)
            .AddSingleton<ChallengeV2AuditEventQueue>(static _ => throw new InvalidOperationException("owned-resolution-fault"))
            .BuildServiceProvider();

        var (required, drain) = CreateProbe(provider).CaptureBoundedQueueAuthority();

        Assert.Single(required.OwnerDiagnostics);
        Assert.Contains("audit-log", required.OwnerDiagnostics.Keys);
        Assert.DoesNotContain("challenge-v2-event", required.OwnerDiagnostics.Keys);
        Assert.Contains("observer-unavailable", required.Blockers);
        Assert.False(drain.Complete);
    }

    [Fact]
    public void ActualOwnerAndAuditReportProjections_OmitRetainedIdentityAndPreserveAccounting()
    {
        const string PrivateItem = "private event/principal/target/challenge material";
        var audit = new AuditLogChannel(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.Wait });
        audit.MarkCommitted(3);
        audit.Complete(new InvalidOperationException(PrivateItem));
        AuditLogRuntimeSnapshot original = new AuditLogRuntimeState(audit).Snapshot();
        Assert.Equal(PrivateItem, original.LastItemReference);
        using ServiceProvider provider = new ServiceCollection().AddSingleton(audit).BuildServiceProvider();

        AuditLogRuntimeSnapshot projected = ProductionReadinessProbe.ProjectAuditLogDiagnostics(original)!;
        IReadOnlyDictionary<string, RequiredQueueOwnerDiagnosticSnapshot> diagnostics = ProductionReadinessProbe.CaptureRequiredQueueOwnerDiagnostics(provider);

        Assert.Null(projected.LastItemReference);
        Assert.Equal(original with
        {
            LastItemReference = null
        }, projected);
        Assert.Equal(PrivateItem, original.LastItemReference);
        Assert.Equal("closed", diagnostics["audit-log"].LastDisposition);
        Assert.DoesNotContain(PrivateItem, JsonSerializer.Serialize(projected), StringComparison.Ordinal);
        Assert.DoesNotContain(PrivateItem, JsonSerializer.Serialize(diagnostics), StringComparison.Ordinal);
        Assert.Null(ProductionReadinessProbe.ProjectAuditLogDiagnostics(null));
    }

    [Fact]
    public void PublicReadyProjection_NeverSerializesOwnerDiagnostics()
    {
        var audit = new AuditLogChannel(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.Wait });
        audit.MarkCommitted(3);
        using ServiceProvider provider = new ServiceCollection().AddSingleton(audit).BuildServiceProvider();
        var (required, _) = CreateProbe(provider).CaptureBoundedQueueAuthority();
        var runtime = new RuntimeHealthSnapshot("degraded", null, null, 1, null, null, null, null)
        {
            RequiredQueues = required
        };
        var report = new ProductionHealthReport("degraded", DateTimeOffset.UtcNow, new Dictionary<string, object?> { ["runtime"] = runtime });

        IReadOnlyDictionary<string, object?> result = ProductionReadinessPublicReport.Create(report);

        Assert.Equal(["checkedAt", "status"], result.Keys.OrderBy(static key => key, StringComparer.Ordinal).ToArray());
        Assert.DoesNotContain("OwnerDiagnostics", JsonSerializer.Serialize(result), StringComparison.Ordinal);
        Assert.DoesNotContain("audit-log", JsonSerializer.Serialize(result), StringComparison.Ordinal);
    }

    private static ProductionReadinessProbe CreateProbe(IServiceProvider provider)
        => new(null!, null!, provider, null!, null!, NullLogger<ProductionReadinessProbe>.Instance);

    private static void AssertDiagnostic(RequiredQueueOwnerDiagnosticSnapshot actual, long committed, long durableAccepted, long requeued, long sequence, string? lastDisposition)
    {
        Assert.Equal(committed, actual.Committed);
        Assert.Equal(durableAccepted, actual.DurableAccepted);
        Assert.Equal(requeued, actual.Requeued);
        Assert.Equal(sequence, actual.Sequence);
        Assert.Equal(lastDisposition, actual.LastDisposition);
        Assert.Equal("OwnerSnapshot", actual.EvidenceKind);
        Assert.False(actual.QualificationEligible);
    }

    private sealed class ChallengeDiagnosticCatalog : IBoundedQueueDrainCatalog
    {
        public string Digest => "sha256:diagnostic-catalog";

        public IReadOnlyList<BoundedChannelQueueContract> Queues
        {
            get;
        } =
        [
            new("challenge-audit-high-value", "required", true, nameof(ChallengeAuditHighValueBoundedQueueDrainParticipant), "required"),
            new("challenge-audit-normal", "required", true, nameof(ChallengeAuditNormalBoundedQueueDrainParticipant), "required")
        ];

        public IReadOnlyList<BoundedChannelQueueContract> DrainParticipants => Queues;
    }
}
