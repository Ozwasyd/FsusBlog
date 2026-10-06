using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Security;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityRiskDurableAdmissionIssue2040Tests
{
    [Theory]
    [InlineData("full")]
    [InlineData("closed")]
    [InlineData("cancelled")]
    public async Task RequiredAdmission_IsDurableWithoutRequestSql(string mode)
    {
        using var owner = new SecurityRiskIssue2040Owner();
        int expected = 1;
        using var cancelled = new CancellationTokenSource();
        if (mode == "full")
        {
            Assert.True(await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
            expected++;
        }
        else if (mode == "closed")
        {
            owner.Queue.Complete();
        }
        else
        {
            cancelled.Cancel();
        }
        Assert.True(await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write(), cancelled.Token));
        Assert.Equal(0, owner.Store.Calls);
        Assert.Equal(expected, owner.Queue.Snapshot().OutstandingCount);
        Assert.Equal(expected, Directory.GetFiles(Path.Combine(owner.Root, "security-risk-fallback"), "security-risk-*.json").Length);
        Assert.Equal(0, owner.Queue.Snapshot().ShedCount);
        Assert.Equal(0, owner.Queue.Snapshot().SyncFallbackCount);
    }

    [Fact]
    public async Task AcceptedWithoutWorker_SurvivesColdOwnerWithExactPayloadAndOrder()
    {
        using var first = new SecurityRiskIssue2040Owner();
        SecurityRiskEventWrite[] writes = [SecurityRiskIssue2040Owner.Write(), SecurityRiskIssue2040Owner.Write()];
        foreach (SecurityRiskEventWrite write in writes)
        {
            Assert.True(await first.Queue.EnqueueAsync(write));
        }
        first.Queue.Dispose();
        first.Provider.Dispose();
        using var restarted = new SecurityRiskIssue2040Owner(first.Root, deleteRoot: false);
        Assert.Equal(2, restarted.Queue.Snapshot().DurablePendingCount);
        Assert.Equal(2, await restarted.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(writes, restarted.Store.Writes);
        Assert.Equal(0, restarted.Queue.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task WorkerCancellation_DisposesOnceAndRetainsOnePendingItem()
    {
        using var owner = new SecurityRiskIssue2040Owner();
        Assert.True(await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
        using var cancellation = new CancellationTokenSource();
        owner.Store.Block = true;
        Task flush = owner.Worker.FlushOnceAsync(cancellation.Token);
        await owner.Store.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, owner.Queue.Snapshot().InFlightCount);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => flush);
        SecurityRiskEventWriteQueueSnapshot snapshot = owner.Queue.Snapshot();
        Assert.Equal(0, snapshot.InFlightCount);
        Assert.Equal(0, snapshot.TerminalFailureCount);
        Assert.Equal(1, snapshot.OutstandingCount);
        owner.Store.Block = false;
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task DirectQueueAdmission_RemovesRawPathAndUserAgentBeforePersistence()
    {
        using var owner = new SecurityRiskIssue2040Owner();
        SecurityRiskEventWrite write = SecurityRiskIssue2040Owner.Write() with
        {
            Path = "/private/raw-path?secret=do-not-retain",
            UserAgent = "private raw user agent"
        };
        Assert.True(await owner.Queue.EnqueueAsync(write));
        Assert.True(owner.Queue.TryRead(out SecurityRiskEventWrite admitted));
        Assert.Null(admitted.Path);
        Assert.Null(admitted.UserAgent);
        Assert.Equal(write.Id, admitted.Id);
        Assert.Equal(write.OccurredAtUtc, admitted.OccurredAtUtc);
        Assert.Equal(write.ExpiresAtUtc, admitted.ExpiresAtUtc);
        Assert.Equal(write.PseudonymEpoch, admitted.PseudonymEpoch);
    }

    [Fact]
    public async Task ProtectedBytesAndPerEventKey_ArePrivateAndDeletedOnlyAfterCommit()
    {
        if (OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("Private Unix file evidence is required.");
        }
        using var owner = new SecurityRiskIssue2040Owner();
        SecurityRiskEventWrite write = SecurityRiskIssue2040Owner.Write();
        Assert.True(await owner.Queue.EnqueueAsync(write));
        string path = Assert.Single(Directory.GetFiles(Path.Combine(owner.Root, "security-risk-fallback"), "security-risk-*.json"));
        string bytes = await File.ReadAllTextAsync(path);
        Assert.DoesNotContain(write.Detail!, bytes, StringComparison.Ordinal);
        Assert.DoesNotContain(write.TraceId!, bytes, StringComparison.Ordinal);
        Assert.DoesNotContain(write.SubjectHash!, bytes, StringComparison.Ordinal);
        Assert.DoesNotContain("PseudonymEpoch", bytes, StringComparison.Ordinal);
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
        string keyRoot = Path.Combine(owner.Root, "audit-retention", "epoch-keys");
        string key = Assert.Single(Directory.GetFiles(keyRoot, "dek-*.bin"));
        Assert.Equal(32, new FileInfo(key).Length);
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(key));
        Assert.True(owner.Queue.TryRead(out SecurityRiskEventWrite delivery));
        Assert.True(File.Exists(key));
        Assert.True(File.Exists(path));
        await owner.Worker.PersistSafelyAsync([delivery], CancellationToken.None);
        Assert.False(File.Exists(key));
        Assert.False(File.Exists(path));
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task RealJournalFailure_IsCurrentTerminalAndRecoversWithoutErasingHistory()
    {
        using var owner = new SecurityRiskIssue2040Owner();
        Assert.True(await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
        owner.Store.Fail = true;
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        SecurityRiskEventWriteQueueSnapshot failed = owner.Queue.Snapshot();
        Assert.Equal(0, failed.InFlightCount);
        Assert.Equal(1, failed.TerminalFailureCount);
        Assert.Equal(1, failed.OutstandingCount); // Retained failed file is not counted again as pending.
        string root = Path.Combine(owner.Root, "security-risk-fallback");
        Assert.Single(Directory.GetFiles(root, "security-risk-*.json"));
        Assert.Single(Directory.GetFiles(root, "security-risk-*.json.failed"));
        var participant = new SecurityRiskEventBoundedQueueDrainParticipant(BoundedQueueDeliveryCatalog.Embedded,
            owner.Queue, TimeProvider.System);
        BoundedQueueParticipantReceipt rejected = participant.Observe("security-risk-unit-2040");
        Assert.Equal(BoundedQueueCommitPostcondition.Failed, rejected.CommitPostcondition);
        Assert.Contains(rejected.Blockers, item => item.StartsWith("item=", StringComparison.Ordinal)
            && item.EndsWith("reason=security-risk:replay-failed", StringComparison.Ordinal));
        Assert.All(rejected.Blockers, item => Assert.DoesNotContain("private trace", item, StringComparison.Ordinal));
        owner.Store.Fail = false;
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(0, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
        Assert.Equal(1, owner.Queue.Snapshot().CommittedCount);
        Assert.Empty(Directory.GetFiles(root, "security-risk-*"));
        Assert.Empty(participant.Observe("security-risk-unit-2040").Blockers);
    }

    [Fact]
    public async Task MissingKeyAndCorruptCiphertext_NeverReachTheStoreOrLoseTheSource()
    {
        foreach (bool missingKey in new[] { false, true })
        {
            using var owner = new SecurityRiskIssue2040Owner();
            Assert.True(await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
            string file = Assert.Single(Directory.GetFiles(Path.Combine(owner.Root, "security-risk-fallback"), "security-risk-*.json"));
            if (missingKey)
            {
                File.Delete(Assert.Single(Directory.GetFiles(Path.Combine(owner.Root, "audit-retention", "epoch-keys"), "dek-*.bin")));
            }
            else
            {
                await File.WriteAllTextAsync(file, "{}");
            }
            await Assert.ThrowsAnyAsync<Exception>(() => owner.Worker.FlushOnceAsync(CancellationToken.None));
            Assert.Equal(0, owner.Store.Calls);
            Assert.True(File.Exists(file));
            Assert.Equal(1, owner.Queue.Snapshot().TerminalFailureCount);
            Assert.Equal(1, owner.Queue.Snapshot().OutstandingCount);
        }
    }

    [Fact]
    public void MissingExplicitRoot_NeverCreatesAmbientJournalOrOpensSql()
    {
        using var queue = new SecurityRiskEventWriteQueue(Options.Create(new SecurityRiskEventWriterOptions()),
            NullLogger<SecurityRiskEventWriteQueue>.Instance);
        Assert.False(queue.TryWrite(SecurityRiskIssue2040Owner.Write()));
        Assert.Equal(1, queue.Snapshot().TerminalFailureCount);
        Assert.Equal(0, queue.Snapshot().DurableAcceptedCount);
        Assert.Equal(0, queue.Snapshot().SyncFallbackCount);
        Assert.Equal("security-risk:admission-failed", queue.Snapshot().LastFailureReason);
    }

    [Fact]
    public async Task UnsafeJournalPermissionOrSymlink_IsRejectedWithoutRepairingForeignPaths()
    {
        if (OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("Private Unix file evidence is required.");
        }
        using var owner = new SecurityRiskIssue2040Owner();
        Assert.True(await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
        string root = Path.Combine(owner.Root, "security-risk-fallback");
        File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.OtherRead);
        Assert.False(await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
        Assert.Equal(1, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(0, owner.Store.Calls);
        Assert.True(File.GetUnixFileMode(root).HasFlag(UnixFileMode.OtherRead));
        File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        string path = Assert.Single(Directory.GetFiles(root, "security-risk-*.json"));
        string target = Path.Combine(owner.Root, "private-test-target");
        File.Move(path, target);
        File.CreateSymbolicLink(path, target);
        await Assert.ThrowsAsync<InvalidDataException>(() => owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.True(File.Exists(target));
        Assert.Equal(0, owner.Store.Calls);
    }

    [Fact]
    public async Task InFlightLeaseBudget_IsBoundedIndependentlyOfDurableBacklog()
    {
        using var owner = new SecurityRiskIssue2040Owner();
        for (int index = 0; index < 17; index++)
        {
            Assert.True(await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
        }
        var leased = new List<SecurityRiskEventWrite>();
        while (owner.Queue.TryRead(out SecurityRiskEventWrite write))
        {
            leased.Add(write);
        }
        Assert.Equal(8, leased.Count);
        Assert.Equal(8, owner.Queue.Snapshot().InFlightCount);
        Assert.Equal(9, owner.Queue.Snapshot().DurablePendingCount);
        Assert.Equal(17, owner.Queue.Snapshot().OutstandingCount);
        await owner.Worker.PersistSafelyAsync(leased, CancellationToken.None);
        Assert.Equal(9, owner.Queue.Snapshot().OutstandingCount);
        Assert.Equal(8, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
        Assert.Equal(17, owner.Store.Writes.Count);
    }

    [Fact]
    public async Task SameIdIsImmutable_EqualContentDistinctIdsHaveIndependentKeysAndSources()
    {
        using var owner = new SecurityRiskIssue2040Owner();
        SecurityRiskEventWrite first = SecurityRiskIssue2040Owner.Write();
        Assert.True(await owner.Queue.EnqueueAsync(first));
        Assert.True(await owner.Queue.EnqueueAsync(first));
        Assert.Equal(1, owner.Queue.Snapshot().DurableAcceptedCount);
        Assert.True(await owner.Queue.EnqueueAsync(first with
        {
            Id = Guid.NewGuid().ToString("N")
        }));
        Assert.Equal(2, owner.Queue.Snapshot().DurableAcceptedCount);
        Assert.Equal(2, Directory.GetFiles(Path.Combine(owner.Root, "audit-retention", "epoch-keys"), "dek-*.bin").Length);
        Assert.False(await owner.Queue.EnqueueAsync(first with
        {
            Detail = "conflicting immutable payload"
        }));
        Assert.Equal(1, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(2, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(2, owner.Store.Writes.Count);
        Assert.DoesNotContain(owner.Store.Writes, item => item.Detail == "conflicting immutable payload");
        // The rejected unretained conflict remains an explicit current blocker;
        // committing unrelated protected events cannot disguise it as old history.
        Assert.Equal(1, owner.Queue.Snapshot().OutstandingCount);
        Assert.Equal(SecurityRiskDurableDelivery.Reference(first.Id), owner.Queue.Snapshot().LastItemReference);
        Assert.Equal("security-risk:admission-failed", owner.Queue.Snapshot().LastFailureReason);
    }

    [Fact]
    public async Task AckKeyDeletionFailure_IsRetainedAndCleanupDoesNotDeliverSqlAgain()
    {
        SecurityRiskIssue2040KeyFault? fault = null;
        using var owner = new SecurityRiskIssue2040Owner(keyFactory: inner => fault = new(inner));
        Assert.True(await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
        fault!.FailDestroy = true;
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, owner.Store.Calls);
        Assert.Equal(1, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(1, owner.Queue.Snapshot().OutstandingCount);
        string root = Path.Combine(owner.Root, "security-risk-fallback");
        Assert.Single(Directory.GetFiles(root, "*.json.ack"));
        Assert.Single(Directory.GetFiles(root, "*.json.ack.failed"));
        Assert.Single(Directory.GetFiles(Path.Combine(owner.Root, "audit-retention", "epoch-keys"), "dek-*.bin"));
        fault.FailDestroy = false;
        Assert.Equal(0, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, owner.Store.Calls);
        Assert.Equal(1, owner.Queue.Snapshot().CommittedCount);
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
        Assert.Empty(Directory.GetFiles(root, "security-risk-*"));
        Assert.Empty(Directory.GetFiles(Path.Combine(owner.Root, "audit-retention", "epoch-keys")));
    }

    [Fact]
    public async Task InterruptedKeyCreationAndCleanup_KeepDiscoverableReservationForColdOwner()
    {
        SecurityRiskIssue2040KeyFault? fault = null;
        using var first = new SecurityRiskIssue2040Owner(keyFactory: inner => fault = new(inner));
        fault!.FailCreateAfterPublication = true;
        fault.FailDestroy = true;
        Assert.False(await first.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
        string root = Path.Combine(first.Root, "security-risk-fallback");
        Assert.Single(Directory.GetFiles(root, "*.json.tmp"));
        Assert.Single(Directory.GetFiles(Path.Combine(first.Root, "audit-retention", "epoch-keys"), "dek-*.bin"));
        Assert.Equal(1, first.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(0, first.Store.Calls);
        first.Queue.Dispose();
        using var cold = new SecurityRiskIssue2040Owner(first.Root, deleteRoot: false);
        Assert.Equal(0, cold.Queue.Snapshot().OutstandingCount);
        Assert.Empty(Directory.GetFiles(root, "security-risk-*"));
        Assert.Empty(Directory.GetFiles(Path.Combine(first.Root, "audit-retention", "epoch-keys")));
        Assert.Equal(0, cold.Store.Calls);
    }

    [Fact]
    public async Task ConcurrentOwnerOfSameRoot_FailsBeforeChangingProtectedSourceOrKey()
    {
        using var first = new SecurityRiskIssue2040Owner();
        SecurityRiskEventWrite write = SecurityRiskIssue2040Owner.Write();
        Assert.True(await first.Queue.EnqueueAsync(write));
        string source = Assert.Single(Directory.GetFiles(Path.Combine(first.Root, "security-risk-fallback"), "security-risk-*.json"));
        string key = Assert.Single(Directory.GetFiles(Path.Combine(first.Root, "audit-retention", "epoch-keys"), "dek-*.bin"));
        byte[] sourceBefore = await File.ReadAllBytesAsync(source);
        byte[] keyBefore = await File.ReadAllBytesAsync(key);
        using var competing = new SecurityRiskIssue2040Owner(first.Root, deleteRoot: false);
        Assert.False(await competing.Queue.EnqueueAsync(write));
        Assert.Equal(1, competing.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(0, competing.Store.Calls);
        Assert.Equal(sourceBefore, await File.ReadAllBytesAsync(source));
        Assert.Equal(keyBefore, await File.ReadAllBytesAsync(key));
        Assert.Equal(1, await first.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(0, first.Queue.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task ActualLocalAdmissionFailure_ExposesOpaqueBlockerWithoutLoggingPayloadOrException()
    {
        var logger = new SecurityRiskIssue2040Logger<SecurityRiskEventWriteQueue>();
        SecurityRiskIssue2040KeyFault? fault = null;
        using var owner = new SecurityRiskIssue2040Owner(keyFactory: inner => fault = new(inner), queueLogger: logger);
        fault!.FailCreateAfterPublication = true;
        SecurityRiskEventWrite write = SecurityRiskIssue2040Owner.Write() with
        {
            Path = "/private/never-retain",
            UserAgent = "private raw user-agent"
        };
        Assert.False(await owner.Queue.EnqueueAsync(write));
        SecurityRiskEventWriteQueueSnapshot snapshot = owner.Queue.Snapshot();
        Assert.Equal(0, snapshot.DurableAcceptedCount);
        Assert.Equal(1, snapshot.TerminalFailureCount);
        Assert.Equal(1, snapshot.OutstandingCount);
        Assert.Equal(0, owner.Store.Calls);
        var participant = new SecurityRiskEventBoundedQueueDrainParticipant(BoundedQueueDeliveryCatalog.Embedded,
            owner.Queue, TimeProvider.System);
        string[] blockers = participant.Observe("security-risk-unit-2040").Blockers.ToArray();
        Assert.Equal(3, blockers.Length);
        Assert.Contains("commitPostcondition=failed", blockers);
        Assert.Contains("terminalFailures=1", blockers);
        string blocker = Assert.Single(blockers, item => item.StartsWith("item=", StringComparison.Ordinal));
        Assert.Equal($"item={SecurityRiskDurableDelivery.Reference(write.Id)};reason=security-risk:admission-failed", blocker);
        string message = Assert.Single(logger.Messages);
        Assert.Equal($"security-risk-delivery-failed Item={SecurityRiskDurableDelivery.Reference(write.Id)} Reason=security-risk:admission-failed", message);
        Assert.All(logger.Exceptions, Assert.Null);
        foreach (string sensitive in new[] { write.Id, write.Detail!, write.TraceId!, write.Path!, write.UserAgent!,
            write.SubjectHash!, owner.Root, "private key fault" })
        {
            Assert.DoesNotContain(sensitive, message, StringComparison.Ordinal);
            Assert.DoesNotContain(sensitive, blocker, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task FailureMarkerPublicationFailure_DoesNotDoubleCountRetainedSourceAndClearsAfterExactReplay()
    {
        using var owner = new SecurityRiskIssue2040Owner();
        Assert.True(await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
        string source = Assert.Single(Directory.GetFiles(Path.Combine(owner.Root, "security-risk-fallback"), "security-risk-*.json"));
        string blockedMarker = source + ".failed";
        Directory.CreateDirectory(blockedMarker); // Exact task-owned collision, not a permission waiver.
        owner.Store.Fail = true;
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(0, owner.Queue.Snapshot().DurablePendingCount);
        Assert.Equal(1, owner.Queue.Snapshot().OutstandingCount);
        Assert.True(File.Exists(source));
        Directory.Delete(blockedMarker);
        owner.Store.Fail = false;
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, owner.Queue.Snapshot().CommittedCount);
        Assert.Equal(0, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task RejectedLocalAdmission_ClearsOnlyAfterSameNormalizedPayloadObtainsDurableDisposition()
    {
        SecurityRiskIssue2040KeyFault? fault = null;
        using var owner = new SecurityRiskIssue2040Owner(keyFactory: inner => fault = new(inner));
        SecurityRiskEventWrite first = SecurityRiskIssue2040Owner.Write();
        SecurityRiskEventWrite second = SecurityRiskIssue2040Owner.Write();
        fault!.FailCreateAfterPublication = true;
        Assert.False(await owner.Queue.EnqueueAsync(first));
        Assert.False(await owner.Queue.EnqueueAsync(second));
        Assert.False(await owner.Queue.EnqueueAsync(second));
        Assert.Equal(2, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(3, owner.Queue.Snapshot().RejectedCount); // History is not current failure count.
        fault.FailCreateAfterPublication = false;
        Assert.True(await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
        Assert.Equal(2, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.True(await owner.Queue.EnqueueAsync(first));
        Assert.Equal(1, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(SecurityRiskDurableDelivery.Reference(second.Id), owner.Queue.Snapshot().LastItemReference);
        Assert.True(await owner.Queue.EnqueueAsync(second));
        Assert.Equal(0, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Null(owner.Queue.Snapshot().LastFailureReason);
        Assert.Equal(3, owner.Queue.Snapshot().RejectedCount);
        Assert.Equal(3, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task TwoIndependentMarkerFailures_KeepSeparateDispositionsUntilEachExactReplay()
    {
        using var owner = new SecurityRiskIssue2040Owner();
        SecurityRiskEventWrite first = SecurityRiskIssue2040Owner.Write();
        SecurityRiskEventWrite second = SecurityRiskIssue2040Owner.Write();
        Assert.True(await owner.Queue.EnqueueAsync(first));
        Assert.True(await owner.Queue.EnqueueAsync(second));
        string root = Path.Combine(owner.Root, "security-risk-fallback");
        string[] sources = Directory.GetFiles(root, "security-risk-*.json").Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(2, sources.Length);
        Directory.CreateDirectory(sources[0] + ".failed");
        Directory.CreateDirectory(sources[1] + ".failed");
        owner.Store.Fail = true;
        Assert.Equal(2, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(2, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(0, owner.Queue.Snapshot().DurablePendingCount);
        Assert.Equal(2, owner.Queue.Snapshot().OutstandingCount);
        Directory.Delete(sources[0] + ".failed");
        owner.Store.Fail = false;
        owner.Store.FailId = second.Id;
        Assert.True(owner.Queue.TryRead(out SecurityRiskEventWrite firstRetry));
        Assert.Equal(first.Id, firstRetry.Id);
        await owner.Worker.PersistSafelyAsync([firstRetry], CancellationToken.None);
        Assert.Equal(1, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(1, owner.Queue.Snapshot().OutstandingCount);
        Assert.Equal(SecurityRiskDurableDelivery.Reference(second.Id), owner.Queue.Snapshot().LastItemReference);
        SecurityRiskEventWrite unrelated = SecurityRiskIssue2040Owner.Write();
        Assert.True(await owner.Queue.EnqueueAsync(unrelated));
        Assert.Equal(2, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(1, owner.Queue.Snapshot().OutstandingCount);
        Assert.Equal(SecurityRiskDurableDelivery.Reference(second.Id), owner.Queue.Snapshot().LastItemReference);
        Assert.Equal(new[] { first, unrelated }, owner.Store.Writes);
        Assert.True(File.Exists(sources[1]));
        Directory.Delete(sources[1] + ".failed");
        owner.Store.FailId = null;
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(0, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
        Assert.Equal(new[] { first, unrelated, second }, owner.Store.Writes);
    }

    [Fact]
    public async Task MarkerFailureBudgetOverflow_IsOpaqueFailClosedAndNeverClaimsExactWholeQueueCount()
    {
        using var owner = new SecurityRiskIssue2040Owner();
        for (int index = 0; index < 9; index++)
        {
            Assert.True(await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write()));
        }
        string root = Path.Combine(owner.Root, "security-risk-fallback");
        string[] sources = Directory.GetFiles(root, "security-risk-*.json").Order(StringComparer.Ordinal).ToArray();
        foreach (string source in sources)
        {
            Directory.CreateDirectory(source + ".failed");
        }
        owner.Store.Fail = true;
        Assert.Equal(8, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(8, owner.Queue.Snapshot().TerminalFailureCount);
        // An actual task-owned source visibility fault keeps an unresolved known
        // identity while allowing the next source to consume the bounded budget.
        string held = Path.Combine(owner.Root, "marker-budget-source.bytes");
        File.Move(sources[0], held);
        Assert.Equal(8, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.True(owner.Queue.Snapshot().TerminalFailureCount > 0);
        Assert.Equal("security-risk:replay-failure-budget-exhausted", owner.Queue.Snapshot().LastFailureReason);
        Assert.Null(owner.Queue.Snapshot().LastItemReference);
        var participant = new SecurityRiskEventBoundedQueueDrainParticipant(BoundedQueueDeliveryCatalog.Embedded,
            owner.Queue, TimeProvider.System);
        Assert.Contains("item=unknown;reason=security-risk:replay-failure-budget-exhausted",
            participant.Observe("security-risk-unit-2040").Blockers);
        File.Move(held, sources[0]);
        foreach (string source in sources)
        {
            Directory.Delete(source + ".failed");
        }
        owner.Store.Fail = false;
        Assert.Equal(8, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(9, owner.Store.Writes.Count);
        // Count is a failure guard, not a certification that the unrepresented
        // loss had an exact disposition. No auto-waiver when known files disappear.
        Assert.True(owner.Queue.Snapshot().TerminalFailureCount > 0);
        Assert.Equal("security-risk:replay-failure-budget-exhausted", owner.Queue.Snapshot().LastFailureReason);
        Assert.Null(owner.Queue.Snapshot().LastItemReference);
    }
}

internal sealed class SecurityRiskIssue2040Owner : IDisposable
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
    internal SecurityRiskEventWriteQueue Queue
    {
        get;
    }
    internal SecurityRiskEventWriterWorker Worker
    {
        get;
    }
    internal SecurityRiskIssue2040Store Store
    {
        get;
    }

    internal SecurityRiskIssue2040Owner(string? root = null, bool deleteRoot = true, ISecurityRiskEventStore? store = null,
        Func<IAuditRetentionEpochKeyStore, IAuditRetentionEpochKeyStore>? keyFactory = null,
        ILogger<SecurityRiskEventWriteQueue>? queueLogger = null)
    {
        Root = root ?? Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath(),
            "fsusblog-security-risk-issue2040-" + Guid.NewGuid().ToString("N"));
        _deleteRoot = deleteRoot;
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["FSUSBLOG_DATA_ROOT"] = Root
        }).Build();
        Store = new SecurityRiskIssue2040Store();
        IAuditRetentionEpochKeyStore keys = new LocalAuditRetentionEpochKeyStore(configuration);
        Provider = new ServiceCollection().AddSingleton(configuration)
            .AddSingleton(keyFactory?.Invoke(keys) ?? keys)
            .AddSingleton<ISecurityRiskEventStore>(store ?? Store).BuildServiceProvider();
        var options = Options.Create(new SecurityRiskEventWriterOptions { Capacity = 1, BatchSize = 8, FlushWindowMs = 1 });
        Queue = new SecurityRiskEventWriteQueue(options, queueLogger ?? NullLogger<SecurityRiskEventWriteQueue>.Instance,
            Provider.GetRequiredService<IServiceScopeFactory>());
        Worker = new SecurityRiskEventWriterWorker(Queue, Provider.GetRequiredService<IServiceScopeFactory>(), options,
            NullLogger<SecurityRiskEventWriterWorker>.Instance);
    }

    internal static SecurityRiskEventWrite Write()
    {
        DateTimeOffset occurred = DateTimeOffset.Parse("2026-10-02T12:34:56.1234567+00:00");
        return new(Guid.NewGuid().ToString("N"), occurred, "shield", "PublicReadBlocked", "public.read", 5, 17,
            600, occurred.AddMinutes(10), new string('a', 64), "public.hot-read.html", new string('b', 64),
            new string('c', 64), null, "GET", null, "bounded detail", "private trace", 7);
    }

    public void Dispose()
    {
        Worker.Dispose();
        Queue.Dispose();
        Provider.Dispose();
        if (_deleteRoot && Directory.Exists(Root))
        {
            Directory.Delete(Root, recursive: true);
        }
    }
}

internal sealed class SecurityRiskIssue2040Logger<T> : ILogger<T>
{
    internal List<string> Messages { get; } = [];
    internal List<Exception?> Exceptions { get; } = [];
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        Messages.Add(formatter(state, exception));
        Exceptions.Add(exception);
    }
}

// Fault injection wraps the actual private-file key owner; journal bytes and
// permission/lifecycle assertions remain real filesystem observations, not SQL evidence.
internal sealed class SecurityRiskIssue2040KeyFault(IAuditRetentionEpochKeyStore inner) : IAuditRetentionEpochKeyStore
{
    internal bool FailDestroy
    {
        get; set;
    }
    internal bool FailCreateAfterPublication
    {
        get; set;
    }

    public async ValueTask<byte[]> CreateAsync(string keyDomain, string epochId, CancellationToken cancellationToken)
    {
        byte[] key = await inner.CreateAsync(keyDomain, epochId, cancellationToken);
        if (FailCreateAfterPublication)
        {
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(key);
            throw new IOException("private key fault must not reach logs");
        }
        return key;
    }

    public ValueTask<byte[]?> TryReadAsync(string keyDomain, string epochId, CancellationToken cancellationToken)
        => inner.TryReadAsync(keyDomain, epochId, cancellationToken);

    public ValueTask<bool> DestroyAsync(string keyDomain, string epochId, CancellationToken cancellationToken)
        => FailDestroy ? ValueTask.FromException<bool>(new IOException("private key fault must not reach logs"))
            : inner.DestroyAsync(keyDomain, epochId, cancellationToken);
}

internal sealed class SecurityRiskIssue2040Store : ISecurityRiskEventStore
{
    private int _calls;
    internal int Calls => _calls;
    internal bool Block
    {
        get; set;
    }
    internal bool Fail
    {
        get; set;
    }
    internal string? FailId
    {
        get; set;
    }
    internal List<SecurityRiskEventWrite> Writes { get; } = [];
    internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
        => AppendBatchAsync([write], cancellationToken);

    public async Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken = default)
    {
        _calls++;
        Entered.TrySetResult();
        if (Fail || writes.Any(write => write.Id == FailId))
        {
            throw new IOException("private store failure must not be logged");
        }
        if (Block)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }
        Writes.AddRange(writes);
    }

    public Task<IReadOnlyList<SecurityRiskEventRecord>> QueryAsync(SecurityRiskEventQuery query, CancellationToken cancellationToken = default)
        => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);

    public Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(SecurityRiskScoreQuery query,
        DateTimeOffset now, int limit, CancellationToken cancellationToken = default)
        => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);
}
