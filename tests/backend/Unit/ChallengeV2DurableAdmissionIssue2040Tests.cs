using System.Text.Json.Nodes;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ChallengeV2DurableAdmissionIssue2040Tests
{
    [Fact]
    public async Task SameUnpreparedRequestCreatesTwoEventsButAnExistingEventRetryIsTheSameAdmission()
    {
        using var owner = new ChallengeV2Issue2040Owner();
        var raw = new SecurityChallengeAttemptRequest("same-original", SecurityChallengeAttemptOutcomes.Failed,
            "private-reason", ChallengeV2Issue2040Owner.Hash, null, null, null, null);
        ChallengeV2AuditEvent first = ChallengeV2AuditEvent.FromAttempt(raw, ChallengeV2EventKind.Failure, "kind", "auth.login");
        ChallengeV2AuditEvent second = ChallengeV2AuditEvent.FromAttempt(raw, ChallengeV2EventKind.Failure, "kind", "auth.login");
        Assert.Null(raw.AttemptId);
        Assert.Null(raw.AttemptedAtUtc);
        Assert.Null(ChallengeV2DurableDelivery.TryGet(raw));
        Assert.NotSame(first.Attempt, second.Attempt);
        Assert.NotEqual(first.Attempt.AttemptId, second.Attempt.AttemptId);
        ChallengeV2PreparedAttempt firstPrepared = ChallengeV2DurableDelivery.GetRequired(first.Attempt);
        ChallengeV2PreparedAttempt secondPrepared = ChallengeV2DurableDelivery.GetRequired(second.Attempt);
        Assert.Equal(firstPrepared.CreatedAtUtc, first.Attempt.AttemptedAtUtc);
        Assert.Equal(secondPrepared.CreatedAtUtc, second.Attempt.AttemptedAtUtc);
        Assert.True(secondPrepared.CreatedAtUtc >= firstPrepared.CreatedAtUtc);
        await owner.Queue.WriteAsync(first);
        await owner.Queue.WriteAsync(second);
        await owner.Queue.WriteAsync(first);
        Assert.Equal(2, Directory.GetFiles(owner.Root, "*.json", SearchOption.AllDirectories).Length);
        Assert.Equal(2, Directory.GetFiles(Path.Combine(owner.Root, "audit-retention", "epoch-keys"), "dek-*.bin").Length);
        Assert.Equal(2, owner.Queue.Snapshot().DurableAcceptedCount);
        Assert.Equal(2, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(firstPrepared, ChallengeV2DurableDelivery.GetRequired(owner.Recording!.Attempts[0]));
        Assert.Equal(secondPrepared, ChallengeV2DurableDelivery.GetRequired(owner.Recording.Attempts[1]));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CapacityOne_ReturnedAdmissionIsProtectedBeforeAnySqlAndOverflowCannotDrop(bool high)
    {
        using var owner = new ChallengeV2Issue2040Owner(capacity: 1);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("first", high));
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("second", high));
        ChallengeV2LaneSnapshot lane = owner.Queue.LaneSnapshot(high);
        Assert.Equal(1, lane.QueuedCount);
        Assert.Equal(1, lane.DurablePendingCount);
        Assert.Equal(2, lane.DurableAcceptedCount);
        Assert.Equal(1, lane.RejectedCount);
        Assert.Empty(owner.Recording!.Attempts);
        Assert.Equal(2, Directory.GetFiles(owner.Root, "*.json", SearchOption.AllDirectories).Length);
        foreach (string path in Directory.GetFiles(owner.Root, "*.json", SearchOption.AllDirectories))
        {
            string bytes = await File.ReadAllTextAsync(path);
            Assert.DoesNotContain("private-reason", bytes);
            Assert.DoesNotContain("first", bytes);
            Assert.DoesNotContain(ChallengeV2Issue2040Owner.Hash, bytes);
            if (!OperatingSystem.IsWindows())
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
            }
        }
        Assert.Equal(2, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(["first", "second"], owner.Recording.Attempts.Select(item => item.ChallengeId));
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
        Assert.Equal(0, owner.Queue.Snapshot().DroppedLowValueCount + owner.Queue.Snapshot().DroppedHighValueCount);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ClosedOrPreCancelled_ReturnsOnlyProtectedPendingNotSqlOrDrop(bool high, bool closed)
    {
        using var owner = new ChallengeV2Issue2040Owner();
        using var cancellation = new CancellationTokenSource();
        if (closed)
        {
            owner.Queue.Complete();
        }
        else
        {
            cancellation.Cancel();
        }
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("required", high), cancellation.Token);
        Assert.Empty(owner.Recording!.Attempts);
        ChallengeV2LaneSnapshot lane = owner.Queue.LaneSnapshot(high);
        Assert.Equal(0, lane.QueuedCount);
        Assert.Equal(1, lane.DurablePendingCount);
        Assert.Equal(1, lane.DurableAcceptedCount);
        Assert.Equal(1, lane.RejectedCount);
        Assert.False(Observe(owner, high).Complete);
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.True(Observe(owner, high).Complete);
    }

    [Fact]
    public async Task IdenticalLegitimateEventsHaveIndependentIdentitiesAndOneCapturedTimeEach()
    {
        using var owner = new ChallengeV2Issue2040Owner();
        ChallengeV2AuditEvent first = ChallengeV2Issue2040Owner.Event("identical", false, attemptedAt: null);
        ChallengeV2AuditEvent second = ChallengeV2Issue2040Owner.Event("identical", false, attemptedAt: null);
        Assert.NotEqual(first.Attempt.AttemptId, second.Attempt.AttemptId);
        ChallengeV2PreparedAttempt prepared = ChallengeV2DurableDelivery.GetRequired(first.Attempt);
        Assert.Equal(prepared.CreatedAtUtc, prepared.Request.AttemptedAtUtc);
        await owner.Queue.WriteAsync(first);
        await owner.Queue.WriteAsync(first);
        await owner.Queue.WriteAsync(second);
        Assert.Equal(2, owner.Queue.Snapshot().DurableAcceptedCount);
        Assert.Equal(2, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(2, owner.Recording!.Attempts.Count);
        Assert.Equal(prepared, ChallengeV2DurableDelivery.GetRequired(owner.Recording.Attempts[0]));
        // A committed identity reuses its protected witness, not a new clock.
        await owner.Queue.WriteAsync(first);
        Assert.Equal(0, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(2, owner.Recording.Attempts.Count);
    }

    [Fact]
    public async Task ExplicitIdentityRetryReusesPublishedPrivateClockAndRejectsChangedPayload()
    {
        using var owner = new ChallengeV2Issue2040Owner();
        ChallengeV2AuditEvent first = ChallengeV2Issue2040Owner.Event("explicit", false, attemptedAt: null);
        await owner.Queue.WriteAsync(first);
        var retry = ChallengeV2AuditEvent.FromAttempt(first.Attempt with
        {
            AttemptedAtUtc = null
        },
            first.EventKind, first.ChallengeKind, first.Action);
        await owner.Queue.WriteAsync(retry);
        Assert.Equal(1, owner.Queue.Snapshot().DurableAcceptedCount);
        var altered = retry with
        {
            Attempt = retry.Attempt with
            {
                TraceId = "altered"
            }
        };
        await Assert.ThrowsAsync<InvalidDataException>(async () => await owner.Queue.WriteAsync(altered));
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(first.Attempt.AttemptedAtUtc, Assert.Single(owner.Recording!.Attempts).AttemptedAtUtc);
        Assert.Equal(0, owner.Queue.LaneSnapshot(false).TerminalFailureCount);
        Assert.True(Observe(owner, false).Complete);
    }

    [Fact]
    public async Task PriorityAndPerLaneFifoIncludeEarlierJournalOnlyOverflow()
    {
        using var owner = new ChallengeV2Issue2040Owner(capacity: 1);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("normal-1", false));
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("normal-2", false));
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("high-1", true));
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("high-2", true));
        Assert.Equal(4, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(["high-1", "high-2", "normal-1", "normal-2"], owner.Recording!.Attempts.Select(item => item.ChallengeId));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DequeueBlockedWriterCancellationReturnsOnceAndRetainsExactPreparedPayload(bool high)
    {
        using var owner = new ChallengeV2Issue2040Owner();
        ChallengeV2AuditEvent expected = ChallengeV2Issue2040Owner.Event("blocked", high);
        await owner.Queue.WriteAsync(expected);
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? delivery));
        Assert.Equal(1, owner.Queue.LaneSnapshot(high).InFlightCount);
        Assert.False(Observe(owner, high).Complete);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        owner.Recording!.OnWrite = async (_, token) =>
        {
            entered.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
        };
        using var cancellation = new CancellationTokenSource();
        Task write = owner.Worker.PersistSafelyAsync([delivery!], cancellation.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => write);
        Assert.False(owner.Queue.TryRequeue(delivery!));
        ChallengeV2LaneSnapshot returned = owner.Queue.LaneSnapshot(high);
        Assert.Equal(1, returned.RequeuedCount);
        Assert.Equal(0, returned.InFlightCount);
        Assert.Equal(1, returned.DurablePendingCount);
        Assert.Equal(0, returned.TerminalFailureCount);
        owner.Recording.OnWrite = null;
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(expected.Attempt, Assert.Single(owner.Recording.Attempts));
        Assert.True(Observe(owner, high).Complete);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PersistentFailureBlocksOnlyItsLaneAndRecoveryClearsHealthReadinessQualification(bool high)
    {
        using var owner = new ChallengeV2Issue2040Owner();
        ChallengeV2LaneSnapshot otherBefore = owner.Queue.LaneSnapshot(!high);
        owner.Recording!.FailuresRemaining = 1;
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("do-not-log-this", high));
        Assert.Equal(0, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(otherBefore, owner.Queue.LaneSnapshot(!high));
        ChallengeV2LaneSnapshot failed = owner.Queue.LaneSnapshot(high);
        Assert.Equal(1, failed.DurablePendingCount);
        Assert.Equal(1, failed.TerminalFailureCount);
        BoundedQueueDrainAggregateReceipt receipt = Observe(owner, high);
        Assert.False(receipt.Complete);
        Assert.Equal("failed", receipt.HealthStatus);
        Assert.Equal("failed", receipt.ReadinessStatus);
        Assert.Equal("failed", receipt.QualificationStatus);
        Assert.Contains($"{QueueId(high)}:item={failed.LastItemReference};reason={failed.LastFailureReason}", receipt.Blockers);
        Assert.DoesNotContain(receipt.Blockers, item => item.Contains(owner.Root, StringComparison.Ordinal)
            || item.Contains("do-not-log-this", StringComparison.Ordinal)
            || item.Contains("private-reason", StringComparison.Ordinal)
            || item.Contains("Owned challenge store is unavailable", StringComparison.Ordinal));
        Assert.True(Observe(owner, !high).Complete);
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        BoundedQueueDrainAggregateReceipt recovered = Observe(owner, high);
        Assert.True(recovered.Complete);
        Assert.Empty(recovered.Blockers);
        Assert.Equal("ok", recovered.HealthStatus);
        Assert.Equal("ok", recovered.ReadinessStatus);
        Assert.Equal("ok", recovered.QualificationStatus);
        Assert.Null(owner.Queue.LaneSnapshot(high).LastFailureReason);
    }

    [Fact]
    public async Task PublicationFailureNeverReturnsRamOnlyAcceptanceAndCanRecover()
    {
        using var owner = new ChallengeV2Issue2040Owner();
        string lane = Path.Combine(owner.Root, "challenge-v2-fallback", "normal");
        Directory.Move(lane, lane + ".owned-backup");
        await File.WriteAllTextAsync(lane, "Owned test prevents admission publication.");
        ChallengeV2AuditEvent failed = ChallengeV2Issue2040Owner.Event("not-admitted", false);
        await Assert.ThrowsAnyAsync<IOException>(async () => await owner.Queue.WriteAsync(failed));
        Assert.Empty(owner.Recording!.Attempts);
        File.Delete(lane);
        Directory.Move(lane + ".owned-backup", lane);
        Assert.Equal(0, owner.Queue.Snapshot().DurableAcceptedCount);
        Assert.Equal(1, owner.Queue.LaneSnapshot(false).TerminalFailureCount);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("recovered", false));
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, owner.Queue.LaneSnapshot(false).TerminalFailureCount);
        Assert.Equal("failed", Observe(owner, false).HealthStatus);
        await owner.Queue.WriteAsync(failed);
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.True(Observe(owner, false).Complete);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TwoAdmissionFailuresRequireTheirOwnRecoveryNotAnotherSuccessfulSource(bool high)
    {
        using var owner = new ChallengeV2Issue2040Owner();
        ChallengeV2LaneSnapshot other = owner.Queue.LaneSnapshot(!high);
        ChallengeV2AuditEvent first = ChallengeV2Issue2040Owner.Event("admission-A", high);
        ChallengeV2AuditEvent second = ChallengeV2Issue2040Owner.Event("admission-B", high);
        string lane = Path.Combine(owner.Root, "challenge-v2-fallback", high ? "high-value" : "normal");
        Directory.Move(lane, lane + ".owned-backup");
        await File.WriteAllTextAsync(lane, "Owned real publication fault.");
        await Assert.ThrowsAnyAsync<IOException>(async () => await owner.Queue.WriteAsync(first));
        await Assert.ThrowsAnyAsync<IOException>(async () => await owner.Queue.WriteAsync(second));
        File.Delete(lane);
        Directory.Move(lane + ".owned-backup", lane);
        Assert.Equal(2, owner.Queue.LaneSnapshot(high).TerminalFailureCount);
        Assert.Equal(2, owner.Queue.LaneSnapshot(high).HistoricalFailureCount);
        await owner.Queue.WriteAsync(first);
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, owner.Queue.LaneSnapshot(high).TerminalFailureCount);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("admission-C", high));
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        ChallengeV2LaneSnapshot remaining = owner.Queue.LaneSnapshot(high);
        Assert.Equal(1, remaining.TerminalFailureCount);
        Assert.Equal(ChallengeV2DurableDelivery.Reference(second.Attempt.AttemptId!), remaining.LastItemReference);
        Assert.Equal("failed", Observe(owner, high).HealthStatus);
        Assert.Equal("failed", Observe(owner, high).ReadinessStatus);
        Assert.Equal("failed", Observe(owner, high).QualificationStatus);
        Assert.Equal(other, owner.Queue.LaneSnapshot(!high));
        await owner.Queue.WriteAsync(second);
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.True(Observe(owner, high).Complete);
        Assert.Equal(other, owner.Queue.LaneSnapshot(!high));
        Assert.Equal(2, owner.Queue.LaneSnapshot(high).HistoricalFailureCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TwoUnwritableFailureMarkersStayOwnedAcrossOtherCommitsAndPartialRecovery(bool high)
    {
        using var owner = new ChallengeV2Issue2040Owner();
        ChallengeV2LaneSnapshot other = owner.Queue.LaneSnapshot(!high);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("marker-A", high));
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("marker-B", high));
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? first));
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? second));
        string[] pending = Directory.GetFiles(owner.Root, "*.json", SearchOption.AllDirectories);
        string firstMarker = Assert.Single(pending, path => path.Contains(ChallengeV2DurableDelivery.Reference(first!.Attempt.AttemptId!), StringComparison.Ordinal)) + ".failed";
        string secondMarker = Assert.Single(pending, path => path.Contains(ChallengeV2DurableDelivery.Reference(second!.Attempt.AttemptId!), StringComparison.Ordinal)) + ".failed";
        Directory.CreateDirectory(firstMarker);
        Directory.CreateDirectory(secondMarker);
        owner.Recording!.FailuresRemaining = 2;
        Assert.Equal(0, await owner.Worker.PersistSafelyAsync([first!], CancellationToken.None));
        Assert.Equal(0, await owner.Worker.PersistSafelyAsync([second!], CancellationToken.None));
        Assert.Equal(2, owner.Queue.LaneSnapshot(high).TerminalFailureCount);
        Assert.Equal(2, owner.Queue.LaneSnapshot(high).HistoricalFailureCount);
        Directory.Delete(firstMarker);
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? retryFirst));
        Assert.Equal(first!.Attempt.AttemptId, retryFirst!.Attempt.AttemptId);
        Assert.Equal(1, await owner.Worker.PersistSafelyAsync([retryFirst], CancellationToken.None));
        Assert.Equal(1, owner.Queue.LaneSnapshot(high).TerminalFailureCount);
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? heldSecond));
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("marker-C", high));
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? third));
        Assert.Equal(1, await owner.Worker.PersistSafelyAsync([third!], CancellationToken.None));
        Assert.True(owner.Queue.TryRequeue(heldSecond!));
        ChallengeV2LaneSnapshot remaining = owner.Queue.LaneSnapshot(high);
        Assert.Equal(1, remaining.TerminalFailureCount);
        Assert.Equal(ChallengeV2DurableDelivery.Reference(second!.Attempt.AttemptId!), remaining.LastItemReference);
        Assert.Equal("failed", Observe(owner, high).HealthStatus);
        Assert.Equal("failed", Observe(owner, high).ReadinessStatus);
        Assert.Equal("failed", Observe(owner, high).QualificationStatus);
        Assert.Equal(other, owner.Queue.LaneSnapshot(!high));
        Directory.Delete(secondMarker);
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.True(Observe(owner, high).Complete);
        Assert.Equal(other, owner.Queue.LaneSnapshot(!high));
        Assert.Equal(2, owner.Queue.LaneSnapshot(high).HistoricalFailureCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailureReferenceBudgetExhaustionCannotBeHealedByKnownSuccessfulAdmissions(bool high)
    {
        using var owner = new ChallengeV2Issue2040Owner();
        ChallengeV2LaneSnapshot other = owner.Queue.LaneSnapshot(!high);
        string lane = Path.Combine(owner.Root, "challenge-v2-fallback", high ? "high-value" : "normal");
        Directory.Move(lane, lane + ".owned-backup");
        await File.WriteAllTextAsync(lane, "Owned real publication fault.");
        var failures = new List<ChallengeV2AuditEvent>();
        for (int index = 0; index < 65; index++)
        {
            ChallengeV2AuditEvent source = ChallengeV2Issue2040Owner.Event($"unpublished-{index}", high);
            failures.Add(source);
            await Assert.ThrowsAnyAsync<IOException>(async () => await owner.Queue.WriteAsync(source));
        }
        File.Delete(lane);
        Directory.Move(lane + ".owned-backup", lane);
        foreach (ChallengeV2AuditEvent source in failures)
        {
            await owner.Queue.WriteAsync(source);
        }
        while (await owner.Worker.FlushOnceAsync(CancellationToken.None) > 0)
        {
        }
        ChallengeV2LaneSnapshot snapshot = owner.Queue.LaneSnapshot(high);
        Assert.Equal(65, snapshot.HistoricalFailureCount);
        Assert.Equal(65, snapshot.CommittedCount);
        Assert.Equal(0, snapshot.DurablePendingCount);
        Assert.True(snapshot.TerminalFailureCount > 0);
        Assert.Null(snapshot.LastItemReference);
        Assert.Equal(QueueId(high) + ":current-failure-unknown", snapshot.LastFailureReason);
        Assert.Equal("failed", Observe(owner, high).HealthStatus);
        Assert.Equal("failed", Observe(owner, high).ReadinessStatus);
        Assert.Equal("failed", Observe(owner, high).QualificationStatus);
        Assert.Equal(other, owner.Queue.LaneSnapshot(!high));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PublicRepeatedTryReadCannotGrowLaneLeasesPastFixedBudget(bool high)
    {
        using var owner = new ChallengeV2Issue2040Owner();
        ChallengeV2LaneSnapshot other = owner.Queue.LaneSnapshot(!high);
        for (int index = 0; index < 65; index++)
        {
            await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event($"lease-{index}", high));
        }
        var leases = new List<ChallengeV2AuditEvent>();
        for (int index = 0; index < 64; index++)
        {
            Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? delivery));
            leases.Add(delivery!);
        }
        Assert.False(owner.Queue.TryRead(out _));
        Assert.Equal(64, owner.Queue.LaneSnapshot(high).InFlightCount);
        Assert.Equal(1, owner.Queue.LaneSnapshot(high).DurablePendingCount);
        Assert.Equal(65, Directory.GetFiles(owner.Root, "*.json", SearchOption.AllDirectories).Length);
        Assert.Equal(other, owner.Queue.LaneSnapshot(!high));
        Assert.True(owner.Queue.TryRequeue(leases[0]));
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? returned));
        Assert.Equal(leases[0].Attempt.AttemptId, returned!.Attempt.AttemptId);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        Task<bool> available = owner.Queue.WaitToReadAsync(cancellation.Token).AsTask();
        Assert.False(available.IsCompleted);
        Assert.Equal(1, await owner.Worker.PersistSafelyAsync([returned], CancellationToken.None));
        Assert.True(await available);
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? last));
        Assert.Equal("lease-64", last!.Attempt.ChallengeId);
        Assert.Equal(64, await owner.Worker.PersistSafelyAsync(leases.Skip(1).Append(last).ToArray(), CancellationToken.None));
        Assert.True(Observe(owner, high).Complete);
        Assert.Equal(other, owner.Queue.LaneSnapshot(!high));
    }

    [Fact]
    public async Task HighLeaseBudgetCannotLetNormalOvertakeAnUnleasedHighJournalSource()
    {
        using var owner = new ChallengeV2Issue2040Owner(highCapacity: 64);
        for (int index = 0; index < 65; index++)
        {
            await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event($"priority-high-{index}", true));
        }
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("priority-normal", false));
        for (int index = 0; index < 64; index++)
        {
            Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? delivery));
            Assert.True(delivery!.IsHighValue);
            Assert.Equal($"priority-high-{index}", delivery.Attempt.ChallengeId);
        }
        ChallengeV2LaneSnapshot normalBefore = owner.Queue.LaneSnapshot(false);
        Assert.Equal(1, normalBefore.QueuedCount);
        Assert.Equal(64, owner.Queue.LaneSnapshot(true).InFlightCount);
        Assert.Equal(1, owner.Queue.LaneSnapshot(true).DurablePendingCount);
        Assert.Equal(66, Directory.GetFiles(owner.Root, "*.json", SearchOption.AllDirectories).Length);
        Assert.False(owner.Queue.TryRead(out ChallengeV2AuditEvent? blocked));
        Assert.Null(blocked);
        Assert.Equal(normalBefore, owner.Queue.LaneSnapshot(false));
        Assert.Equal(66, Directory.GetFiles(owner.Root, "*.json", SearchOption.AllDirectories).Length);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PriorityWaitBlocksAtHighLeaseBudgetAndMatchingCommitOrRequeueWakesIt(bool requeue)
    {
        using var owner = new ChallengeV2Issue2040Owner(highCapacity: 64);
        for (int index = 0; index < 65; index++)
        {
            await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event($"priority-high-{index}", true));
        }
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("priority-normal", false));
        var leases = new List<ChallengeV2AuditEvent>();
        for (int index = 0; index < 64; index++)
        {
            Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? delivery));
            Assert.True(delivery!.IsHighValue);
            leases.Add(delivery);
        }
        ChallengeV2LaneSnapshot normalBefore = owner.Queue.LaneSnapshot(false);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        Task<bool> ready = owner.Queue.WaitToReadAsync(cancellation.Token).AsTask();
        Assert.False(ready.IsCompleted);
        Assert.Equal(normalBefore, owner.Queue.LaneSnapshot(false));
        if (requeue)
        {
            Assert.True(owner.Queue.TryRequeue(leases[0]));
        }
        else
        {
            Assert.Equal(1, await owner.Worker.PersistSafelyAsync([leases[0]], CancellationToken.None));
        }
        Assert.True(await ready);
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? next));
        Assert.True(next!.IsHighValue);
        Assert.Equal(requeue ? "priority-high-0" : "priority-high-64", next.Attempt.ChallengeId);
        Assert.Equal(normalBefore, owner.Queue.LaneSnapshot(false));
        Assert.Equal(64, owner.Queue.LaneSnapshot(true).InFlightCount);
        if (requeue)
        {
            Assert.False(owner.Queue.TryRead(out _));
            Assert.Equal(64, await owner.Worker.PersistSafelyAsync(leases.Skip(1).Prepend(next).ToArray(), CancellationToken.None));
            Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? finalHigh));
            Assert.True(finalHigh!.IsHighValue);
            Assert.Equal("priority-high-64", finalHigh.Attempt.ChallengeId);
            Assert.Equal(1, await owner.Worker.PersistSafelyAsync([finalHigh], CancellationToken.None));
        }
        else
        {
            Assert.Equal(64, await owner.Worker.PersistSafelyAsync(leases.Skip(1).Append(next).ToArray(), CancellationToken.None));
        }
        Assert.Equal(normalBefore, owner.Queue.LaneSnapshot(false));
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? normal));
        Assert.False(normal!.IsHighValue);
        Assert.Equal("priority-normal", normal.Attempt.ChallengeId);
        Assert.Equal(1, await owner.Worker.PersistSafelyAsync([normal], CancellationToken.None));
        Assert.Equal(Enumerable.Range(0, 65).Select(index => $"priority-high-{index}").Append("priority-normal"),
            owner.Recording!.Attempts.Select(attempt => attempt.ChallengeId));
        Assert.True(Observe(owner, true).Complete);
        Assert.True(Observe(owner, false).Complete);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ColdRecoveryUsesJournalGuidBothClocksAndDoesNotReadTheOtherLane(bool high)
    {
        var original = new ChallengeV2Issue2040Owner(deleteRoot: false);
        string root = original.Root;
        ChallengeV2AuditEvent expected = ChallengeV2Issue2040Owner.Event("cold", high);
        ChallengeV2PreparedAttempt prepared = ChallengeV2DurableDelivery.GetRequired(expected.Attempt);
        await original.Queue.WriteAsync(expected);
        original.Dispose();
        using var recovered = new ChallengeV2Issue2040Owner(root: root);
        Assert.Equal(1, recovered.Queue.LaneSnapshot(high).DurablePendingCount);
        Assert.Equal(0, recovered.Queue.LaneSnapshot(!high).DurablePendingCount);
        Assert.Equal(1, await recovered.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(prepared, ChallengeV2DurableDelivery.GetRequired(Assert.Single(recovered.Recording!.Attempts)));
    }

    [Fact]
    public async Task CorruptCiphertextCannotBeDiscardedOrClassifiedDrained()
    {
        using var owner = new ChallengeV2Issue2040Owner();
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("corrupt", false));
        string path = Assert.Single(Directory.GetFiles(owner.Root, "*.json", SearchOption.AllDirectories));
        byte[] original = await File.ReadAllBytesAsync(path);
        JsonNode envelope = JsonNode.Parse(original)!;
        byte[] ciphertext = Convert.FromBase64String(envelope["Ciphertext"]!.GetValue<string>());
        ciphertext[0] ^= 1;
        envelope["Ciphertext"] = Convert.ToBase64String(ciphertext);
        await File.WriteAllTextAsync(path, envelope.ToJsonString());
        Assert.ThrowsAny<System.Security.Cryptography.CryptographicException>(() => owner.Queue.TryRead(out _));
        Assert.True(File.Exists(path));
        Assert.False(Observe(owner, false).Complete);
        Assert.Empty(owner.Recording!.Attempts);
        await File.WriteAllBytesAsync(path, original);
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.True(Observe(owner, false).Complete);
    }

    [Fact]
    public async Task MissingPendingKeyCannotBeReportedRecoveredOrDrained()
    {
        using var owner = new ChallengeV2Issue2040Owner();
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("missing-key", true));
        string key = Assert.Single(Directory.GetFiles(Path.Combine(owner.Root, "audit-retention", "epoch-keys"), "dek-*.bin"));
        File.Move(key, key + ".owned-backup");
        Assert.Throws<InvalidDataException>(() => owner.Queue.TryRead(out _));
        Assert.Single(Directory.GetFiles(owner.Root, "*.json", SearchOption.AllDirectories));
        Assert.Empty(owner.Recording!.Attempts);
        Assert.False(Observe(owner, true).Complete);
        File.Move(key + ".owned-backup", key);
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.True(Observe(owner, true).Complete);
    }

    internal static BoundedQueueDrainAggregateReceipt Observe(ChallengeV2Issue2040Owner owner, bool high)
    {
        var catalog = new ChallengeOnlyCatalog(high);
        IBoundedQueueDrainParticipant participant = high
            ? new ChallengeAuditHighValueBoundedQueueDrainParticipant(catalog, owner.Queue, TimeProvider.System)
            : new ChallengeAuditNormalBoundedQueueDrainParticipant(catalog, owner.Queue, TimeProvider.System);
        return new BoundedQueueDrainAggregator(catalog, [participant], TimeProvider.System).Observe();
    }

    private static string QueueId(bool high) => high ? "challenge-audit-high-value" : "challenge-audit-normal";

    private sealed class ChallengeOnlyCatalog(bool high) : IBoundedQueueDrainCatalog
    {
        private readonly BoundedQueueDeliveryCatalog _embedded = BoundedQueueDeliveryCatalog.Embedded;
        public string Digest => _embedded.Digest;
        public IReadOnlyList<BoundedChannelQueueContract> Queues => DrainParticipants;
        public IReadOnlyList<BoundedChannelQueueContract> DrainParticipants
            => _embedded.DrainParticipants.Where(item => item.QueueId == QueueId(high)).ToArray();
    }
}

/// <summary>Owned real file/key fixture; its recording service is unit evidence, not PostgreSQL proof.</summary>
internal sealed class ChallengeV2Issue2040Owner : IDisposable
{
    internal const string Hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private readonly bool _deleteRoot;
    internal string Root
    {
        get;
    }
    internal ServiceProvider Provider
    {
        get;
    }
    internal ChallengeV2AuditEventQueue Queue => Provider.GetRequiredService<ChallengeV2AuditEventQueue>();
    internal ChallengeV2AuditEventWriterWorker Worker
    {
        get;
    }
    internal ChallengeV2Issue2040RecordingPersistence? Recording
    {
        get;
    }

    internal ChallengeV2Issue2040Owner(string? root = null, Func<ISqlSugarClient>? database = null,
        bool deleteRoot = true, int capacity = 8, ISecurityChallengePersistenceService? persistence = null,
        ILogger<ChallengeV2AuditEventQueue>? logger = null, int? highCapacity = null)
    {
        Root = root ?? Path.Combine(TemporaryRoot, $"fsusblog-challenge-issue2040-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Root);
        _deleteRoot = deleteRoot;
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["FSUSBLOG_DATA_ROOT"] = Root
        }).Build();
        var services = new ServiceCollection().AddLogging().AddSingleton(configuration)
            .AddSingleton<IAuditRetentionEpochKeyStore, LocalAuditRetentionEpochKeyStore>();
        services.AddSingleton(sp => new ChallengeV2FallbackWriter(configuration, sp.GetRequiredService<IAuditRetentionEpochKeyStore>()));
        services.AddSingleton(sp => new ChallengeV2AuditEventQueue(
            Options.Create(new ChallengeV2EventWriterOptions { Capacity = capacity, HighValueCapacity = highCapacity ?? capacity }),
            logger ?? sp.GetRequiredService<ILogger<ChallengeV2AuditEventQueue>>(), sp.GetRequiredService<ChallengeV2FallbackWriter>()));
        if (database is not null)
        {
            services.AddScoped<ISqlSugarClient>(_ => database());
            services.AddScoped<ISecurityChallengePersistenceService, SecurityChallengePersistenceService>();
        }
        else
        {
            Recording = persistence is null ? new ChallengeV2Issue2040RecordingPersistence() : null;
            services.AddSingleton<ISecurityChallengePersistenceService>(persistence ?? Recording!);
        }
        Provider = services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true, ValidateOnBuild = true });
        Worker = new ChallengeV2AuditEventWriterWorker(Queue, Provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new ChallengeV2EventWriterOptions { BatchSize = 8, FlushWindowMs = 10 }),
            Provider.GetRequiredService<ILogger<ChallengeV2AuditEventWriterWorker>>());
    }

    internal static ChallengeV2AuditEvent Event(string challengeId, bool high, DateTime? attemptedAt = null)
        => ChallengeV2AuditEvent.FromAttempt(new(challengeId,
            high ? SecurityChallengeAttemptOutcomes.Replayed : SecurityChallengeAttemptOutcomes.Failed,
            "private-reason", Hash, Hash, Hash, "private-trace", "private-traceparent", attemptedAt),
            high ? ChallengeV2EventKind.Replay : ChallengeV2EventKind.Failure, "perception_micro_interaction_v2", "auth.login");

    internal static string TemporaryRoot => OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath();

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

internal sealed class ChallengeV2Issue2040RecordingPersistence : ISecurityChallengePersistenceService
{
    internal int FailuresRemaining
    {
        get; set;
    }
    internal Func<SecurityChallengeAttemptRequest, CancellationToken, Task>? OnWrite
    {
        get; set;
    }
    internal List<SecurityChallengeAttemptRequest> Attempts { get; } = [];

    public async Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (FailuresRemaining > 0)
        {
            FailuresRemaining--;
            throw new IOException("Owned challenge store is unavailable.");
        }
        if (OnWrite is not null)
        {
            await OnWrite(request, cancellationToken);
        }
        if (!Attempts.Any(item => item.AttemptId == request.AttemptId))
        {
            Attempts.Add(request);
        }
        return ChallengeV2DurableDelivery.GetRequired(request).ToEntity();
    }

    public Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default)
        => throw new NotSupportedException();
    public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
        => throw new NotSupportedException();
    public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
        => throw new NotSupportedException();
}
