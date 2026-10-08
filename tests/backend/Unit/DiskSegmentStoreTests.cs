using System.Buffers.Binary;
using System.Runtime.Versioning;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Disk;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

[SupportedOSPlatform("linux")]
public sealed class DiskSegmentStoreTests
{
    [Fact]
    public void MultiRecordPublicationUsesExactInitializedLengthsAndIndependentRepresentations()
    {
        using var fixture = new Fixture();
        MemoryContentIdentity first = Identity();
        MemoryContentIdentity second = first with
        {
            Representation = new(Guid.NewGuid())
        };
        var records = new DiskSegmentWriteRecord[]
        {
            new(first, new ShortReadStream([1, 2, 3, 99, 99]), 3),
            new(second, new ShortReadStream([4, 5]), 2)
        };
        var published = fixture.Store.Publish(records, DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.True(published.Succeeded);
        Assert.Equal(2, published.Value!.Entries.Count);
        MemoryAllocationObservation allocation = Assert.Single(fixture.Coordinator.Allocations());
        MemoryAllocationDescriptor descriptor = Assert.IsType<MemoryAllocationDescriptor>(allocation.Descriptor);
        Assert.Equal(new AllocationId(published.Value.SegmentId), descriptor.Allocation);
        Assert.Equal(fixture.Budget.DiskDomain, descriptor.Domain);
        Assert.Equal(64 + 2 * 96 + 5, descriptor.Layout.LogicalBytes);
        Assert.Equal(32768, descriptor.Layout.CapacityBytes);
        Assert.Equal(1, descriptor.Layout.AlignmentBytes);
        Assert.Single(fixture.Root.EnumerateNames(16));
        using DiskSegmentLease lease = fixture.Store.Acquire(published.Value.SegmentId, first).Value!;
        using var copy = new MemoryStream();
        Assert.True(lease.CopyTo(copy).Succeeded);
        Assert.Equal(new byte[] { 1, 2, 3 }, copy.ToArray());
        Assert.Equal(32768, fixture.DiskUsed);
        Assert.Equal(MemoryFailure.StaleLocation,
            fixture.Store.Acquire(published.Value.SegmentId, first with
            {
                Generation = new(2)
            }).Failure);
    }

    [Fact]
    public void EofCancellationAndDuplicateIdentityPublishNoPartialSegmentOrLeakedReservation()
    {
        using var fixture = new Fixture();
        Assert.Equal(MemoryFailure.Corruption, fixture.Store.Publish(
            [new(Identity(), new ShortReadStream([1]), 5)],
            DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.Equal(MemoryFailure.Cancelled, fixture.Store.Publish(
            [new(Identity(), new MemoryStream([1]), 1)],
            DiskSpillClassification.PublicImmutableReconstructible, true, cancellation.Token).Failure);
        MemoryContentIdentity identity = Identity();
        Assert.Equal(MemoryFailure.Corruption, fixture.Store.Publish(
            [new(identity, new MemoryStream([1]), 1), new(identity, new MemoryStream([2]), 1)],
            DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void EligibilityAndDataOwnerDenialOverrideCallerClassification()
    {
        using var fixture = new Fixture();
        var records = new DiskSegmentWriteRecord[] { new(Identity(), new MemoryStream([1]), 1) };
        Assert.Equal(MemoryFailure.OwnershipViolation,
            fixture.Store.Publish(records, DiskSpillClassification.Credentials, true).Failure);
        Assert.Equal(MemoryFailure.OwnershipViolation,
            fixture.Store.Publish(records, DiskSpillClassification.PublicImmutableReconstructible, false).Failure);
        Assert.Equal(MemoryFailure.OwnershipViolation, fixture.Store.Recover(false, _ => true).Failure);
        Assert.Empty(fixture.Root.EnumerateNames(16));
    }

    [Theory]
    [InlineData(16)] // total segment length
    [InlineData(24)] // record count
    [InlineData(28)] // segment completion
    [InlineData(104)] // payload length
    [InlineData(112)] // payload offset
    [InlineData(120)] // SHA-256
    [InlineData(152)] // record completion
    [InlineData(160)] // payload byte
    public void RecoveryIndependentlyRejectsCorruptLengthsOffsetsIntegrityAndCompletion(int offset)
    {
        using var fixture = new Fixture();
        string name = fixture.WriteRaw([1, 2, 3, 4]);
        string path = Path.Combine(fixture.Path, name);
        using (var file = new FileStream(path, FileMode.Open, FileAccess.ReadWrite))
        {
            file.Position = offset;
            int original = file.ReadByte();
            file.Position = offset;
            file.WriteByte((byte)(original ^ 0x80));
        }
        var recovered = fixture.Store.Recover(true, _ => true);
        Assert.True(recovered.Succeeded);
        Assert.Equal(0, recovered.Value!.Reused);
        Assert.Equal(1, recovered.Value.Discarded);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void RecoveryRejectsIncompleteStagingAndUnindexedTailAndPreservesUnsupportedVersion()
    {
        using var fixture = new Fixture();
        string stage = fixture.Root.NewName("stage");
        using (FileStream file = fixture.Root.CreateFile(stage))
        {
            file.Write([1, 2, 3]);
        }
        string tail = fixture.WriteRaw([5]);
        using (var file = new FileStream(Path.Combine(fixture.Path, tail), FileMode.Append))
        {
            file.WriteByte(99);
        }
        string unsupported = fixture.WriteRaw([6]);
        using (var file = new FileStream(Path.Combine(fixture.Path, unsupported), FileMode.Open, FileAccess.Write))
        {
            file.Position = 8;
            Span<byte> version = stackalloc byte[4];
            BinaryPrimitives.WriteUInt32LittleEndian(version, 2);
            file.Write(version);
        }
        var recovered = fixture.Store.Recover(true, _ => true);
        Assert.True(recovered.Succeeded);
        Assert.Equal(2, recovered.Value!.Discarded);
        Assert.Equal(new[] { unsupported }, fixture.Root.EnumerateNames(16).ToArray());
    }

    [Fact]
    public void RecoveryStopsAtHostBudgetWithoutMaterializingAllPayloads()
    {
        using var fixture = new Fixture(hostCap: 8500);
        for (int index = 0; index < 5; index++)
        {
            fixture.WriteRaw(new byte[1000]);
        }
        var recovered = fixture.Store.Recover(true, _ => true);
        Assert.Equal(MemoryFailure.BudgetRejected, recovered.Failure);
        Assert.Equal(1, fixture.Coordinator.Snapshot().Allocations);
        Assert.Equal(fixture.Limits.IndexBytes(fixture.Limits.MaxRecordsPerSegment),
            fixture.Coordinator.Snapshot().Used["host"]);
        Assert.InRange(fixture.Coordinator.Snapshot().Used["host"], 1, 8500);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.Equal(5, fixture.Root.EnumerateNames(16).Count());
    }

    [Fact]
    public void CompactionRetainsOldFileAndDiskChargeUntilFinalReaderEnds()
    {
        using var fixture = new Fixture();
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication old = fixture.Publish(identity, [1, 2, 3, 4]);
        DiskSegmentLease reader = fixture.Store.Acquire(old.SegmentId, identity).Value!;
        long before = fixture.DiskUsed;
        var compacted = fixture.Store.Compact(old.SegmentId, true);
        Assert.True(compacted.Succeeded);
        Assert.Equal(before * 2, fixture.DiskUsed);
        Assert.Equal(2, fixture.Root.EnumerateNames(16).Count());
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Store.Acquire(old.SegmentId, identity).Failure);
        using var target = new MemoryStream();
        Assert.True(reader.CopyTo(target).Succeeded);
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, target.ToArray());
        reader.Dispose();
        reader.Dispose();
        Assert.Single(fixture.Root.EnumerateNames(16));
        Assert.Equal(before, fixture.DiskUsed);
        using DiskSegmentLease current = fixture.Store.Acquire(compacted.Value!.SegmentId, identity).Value!;
        Assert.True(current.CopyTo(new MemoryStream()).Succeeded);
    }

    [Fact]
    public void CompactionRequiresSimultaneousDestinationAdmissionAndPreservesSourceOnRejection()
    {
        using var fixture = new Fixture(diskCap: 50000);
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication source = fixture.Publish(identity, [1, 2, 3, 4]);
        long before = fixture.DiskUsed;
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Compact(source.SegmentId, true).Failure);
        Assert.Single(fixture.Root.EnumerateNames(16));
        Assert.Equal(before, fixture.DiskUsed);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        using DiskSegmentLease reader = fixture.Store.Acquire(source.SegmentId, identity).Value!;
        Assert.True(reader.CopyTo(new MemoryStream()).Succeeded);
    }

    [Fact]
    public void DrainedWaitsForDisableEvenWhenEmptyAndLeavesCallerOwnedRootUsable()
    {
        using var fixture = new Fixture();
        Task drained = fixture.Store.Drained;
        Assert.False(drained.IsCompleted);
        fixture.Store.RetryCleanup();
        Assert.False(drained.IsCompleted);
        fixture.Store.Disable();
        Assert.True(drained.IsCompletedSuccessfully);
        fixture.Store.Disable();
        fixture.Store.Dispose();
        Assert.Same(drained, fixture.Store.Drained);
        Assert.True(drained.IsCompletedSuccessfully);
        fixture.Root.Validate();
        string name = fixture.Root.NewName("stage");
        using (FileStream file = fixture.Root.CreateFile(name))
        {
            file.WriteByte(7);
        }
        using (FileStream file = fixture.Root.OpenRead(name))
        {
            Assert.Equal(7, file.ReadByte());
        }
        fixture.Root.Delete(name);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public async Task CanceledDrainedWaiterCannotReleaseLiveReaderOrCompleteSharedDrain()
    {
        using var fixture = new Fixture();
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication published = fixture.Publish(identity, [1, 2, 3]);
        using DiskSegmentLease reader = fixture.Store.Acquire(published.SegmentId, identity).Value!;
        Task drained = fixture.Store.Drained;
        fixture.Store.Disable();
        Assert.False(drained.IsCompleted);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => drained.WaitAsync(cancellation.Token));
        Assert.Same(drained, fixture.Store.Drained);
        Assert.False(drained.IsCompleted);
        Assert.Single(fixture.Root.EnumerateNames(16));
        Assert.Equal(32768, fixture.DiskUsed);
        Assert.Equal(1, fixture.InodesUsed);
        using var target = new MemoryStream();
        Assert.True(reader.CopyTo(target).Succeeded);
        Assert.Equal(new byte[] { 1, 2, 3 }, target.ToArray());
        Assert.False(drained.IsCompleted);
        reader.Dispose();
        await drained.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(drained.IsCompletedSuccessfully);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        fixture.Root.Validate();
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public void DisableDuringRecoveryScanOrProbeAdmissionWaitsForTransientOperationDrain(int disableAtObservation)
    {
        Fixture? fixture = null;
        int observations = 0;
        using (fixture = new Fixture(duringAdmission: () =>
        {
            if (++observations == disableAtObservation)
            {
                Fixture active = fixture ?? throw new InvalidOperationException("Fixture must exist before admission.");
                active.Store.Disable();
                Assert.False(active.Store.Drained.IsCompleted);
                active.Store.RetryCleanup();
                Assert.False(active.Store.Drained.IsCompleted);
            }
        }))
        {
            string name = fixture.WriteRaw([1, 2, 3]);
            DiskFileFootprint original = fixture.Root.ObserveFileFootprint(name);
            int approvals = 0;
            var result = fixture.Store.Recover(true, entry =>
            {
                approvals++;
                return true;
            });
            Assert.Equal(disableAtObservation, observations);
            Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
            Assert.Equal(0, approvals);
            Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
            Assert.Equal(name, Assert.Single(fixture.Root.EnumerateNames(16)));
            Assert.Equal(original.Inode, fixture.Root.ObserveFileFootprint(name).Inode);
            Assert.Empty(fixture.Coordinator.Allocations());
            Assert.DoesNotContain(fixture.Coordinator.EventWindow().Events, entry => entry.Kind == "existing-registered");
            Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
            Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
            Assert.False(fixture.Coordinator.Snapshot().Faulted);
            fixture.Root.Validate();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DisableDuringReadOrInventoryAdmissionWaitsForWholeOperationDrain(bool acquireReader)
    {
        Fixture? fixture = null;
        bool armed = false;
        int disables = 0;
        using (fixture = new Fixture(duringAdmission: () =>
        {
            if (armed)
            {
                armed = false;
                disables++;
                Fixture active = fixture ?? throw new InvalidOperationException("Fixture must exist before admission.");
                active.Store.Disable();
                Assert.False(active.Store.Drained.IsCompleted);
                active.Store.RetryCleanup();
                Assert.False(active.Store.Drained.IsCompleted);
            }
        }))
        {
            MemoryContentIdentity identity = Identity();
            DiskSegmentPublication publication = fixture.Publish(identity, [1, 2, 3]);
            armed = true;
            MemoryFailure? failure = acquireReader
                ? fixture.Store.Acquire(publication.SegmentId, identity).Failure
                : fixture.Store.ObserveInventory().Failure;
            Assert.Equal(MemoryFailure.TierUnavailable, failure);
            Assert.Equal(1, disables);
            Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
            Assert.Empty(fixture.Root.EnumerateNames(16));
            Assert.Empty(fixture.Coordinator.Allocations());
            Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
            Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
            Assert.False(fixture.Coordinator.Snapshot().Faulted);
            fixture.Root.Validate();
        }
    }

    [Fact]
    public void DisableDuringCompactionWaitsForExistingSourceLeaseAndWholeCompactionOperation()
    {
        using var fixture = new Fixture();
        MemoryContentIdentity first = Identity();
        MemoryContentIdentity second = Identity();
        using var firstPayload = new MemoryStream([1, 2]);
        using var secondPayload = new MemoryStream([3, 4]);
        var publication = fixture.Store.Publish([new(first, firstPayload, firstPayload.Length),
            new(second, secondPayload, secondPayload.Length)],
            DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.True(publication.Succeeded);
        Guid segmentId = publication.Value!.SegmentId;
        int predicates = 0;
        var result = fixture.Store.Compact(segmentId, entry =>
        {
            if (++predicates == 2)
            {
                Assert.Equal(1, fixture.Coordinator.Snapshot().Reservations);
                fixture.Store.Disable();
                Assert.False(fixture.Store.Drained.IsCompleted);
                fixture.Store.RetryCleanup();
                Assert.False(fixture.Store.Drained.IsCompleted);
                Assert.Single(fixture.Root.EnumerateNames(16));
                Assert.Equal(32768, fixture.DiskUsed);
                Assert.Equal(1, fixture.InodesUsed);
            }
            return true;
        }, true);
        Assert.Equal(2, predicates);
        Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
        Assert.Null(result.Value);
        Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.Empty(fixture.Coordinator.Allocations());
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        Assert.False(fixture.Coordinator.Snapshot().Faulted);
        fixture.Root.Validate();
    }

    [Fact]
    public void DisableBlocksNewOperationsAndDrainsExistingReaderBeforeDeletion()
    {
        using var fixture = new Fixture();
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication published = fixture.Publish(identity, [7]);
        DiskSegmentLease reader = fixture.Store.Acquire(published.SegmentId, identity).Value!;
        Assert.False(fixture.Store.Drained.IsCompleted);
        fixture.Store.Disable();
        Assert.False(fixture.Store.Drained.IsCompleted);
        Assert.Single(fixture.Root.EnumerateNames(16));
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Store.Acquire(published.SegmentId, identity).Failure);
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Store.Recover(true, _ => true).Failure);
        Assert.True(reader.CopyTo(new MemoryStream()).Succeeded);
        Assert.False(fixture.Store.Drained.IsCompleted);
        reader.Dispose();
        Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
        fixture.Root.Validate();
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.Equal(MemoryFailure.StaleLocation, reader.CopyTo(new MemoryStream()).Failure);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void UnexpectedIoFailureAfterInitialWritePreservesUnrelatedFilesAndCleansOwnedCandidate()
    {
        using var fixture = new Fixture();
        string unrelated = Path.Combine(fixture.Path, "authority-sentinel");
        File.WriteAllText(unrelated, "unchanged");
        var result = fixture.Store.Publish([new(Identity(), new FailingStream(), 4)],
            DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.Equal("unchanged", File.ReadAllText(unrelated));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void RecoveryRequiresContentOwnerApprovalForEveryVerifiedIdentity()
    {
        using var fixture = new Fixture();
        fixture.WriteRaw([1, 2, 3]);
        Assert.Equal(MemoryFailure.OwnershipViolation, fixture.Store.Recover(true, null).Failure);
        Assert.Single(fixture.Root.EnumerateNames(16));
        int calls = 0;
        var denied = fixture.Store.Recover(true, entry =>
        {
            calls++;
            Assert.Equal(3, entry.PayloadBytes);
            return false;
        });
        Assert.Equal(MemoryFailure.OwnershipViolation, denied.Failure);
        Assert.Equal(1, calls);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void ReentrantDisposeKeepsCopyOperationAliveUntilItsFinalHoldEnds()
    {
        using var fixture = new Fixture();
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication source = fixture.Publish(identity, new byte[256]);
        DiskSegmentLease reader = fixture.Store.Acquire(source.SegmentId, identity).Value!;
        using var target = new RetiringStream(() =>
        {
            reader.Dispose();
            fixture.Store.Retire(source.SegmentId);
            fixture.Store.Disable();
            Assert.False(fixture.Store.Drained.IsCompleted);
            Assert.Single(fixture.Root.EnumerateNames(16));
            Assert.True(fixture.DiskUsed > 0);
            Assert.Equal(MemoryFailure.StaleLocation, reader.CopyTo(new MemoryStream()).Failure);
        });
        Assert.True(reader.CopyTo(target).Succeeded);
        Assert.Equal(new byte[256], target.ToArray());
        Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
        fixture.Root.Validate();
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        reader.Dispose();
    }

    [Fact]
    public void CallerExceptionStillReleasesAReentrantlyDisposedFinalOperationHold()
    {
        using var fixture = new Fixture();
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication source = fixture.Publish(identity, [1, 2]);
        DiskSegmentLease reader = fixture.Store.Acquire(source.SegmentId, identity).Value!;
        using var target = new RetiringStream(() =>
        {
            reader.Dispose();
            fixture.Store.Retire(source.SegmentId);
            fixture.Store.Disable();
            Assert.False(fixture.Store.Drained.IsCompleted);
            throw new InvalidOperationException("Task-owned caller staging failure.");
        });
        Assert.Throws<InvalidOperationException>(() => reader.CopyTo(target));
        Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
        fixture.Root.Validate();
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    private sealed class RetiringStream(Action retire) : MemoryStream
    {
        private bool _retired;
        public override void Write(byte[] buffer, int offset, int count)
        {
            if (!_retired)
            {
                _retired = true;
                retire();
            }
            base.Write(buffer, offset, count);
        }
    }

    private sealed class FailingStream : MemoryStream
    {
        private bool _read;
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_read)
            {
                throw new IOException("Task-owned injected disk/payload I/O failure after progress.");
            }
            _read = true;
            buffer[offset] = 7;
            return 1;
        }
    }

    [Fact]
    public void CompactionReclaimsUnretainedRecordsWithoutBreakingAnOldReader()
    {
        using var fixture = new Fixture();
        MemoryContentIdentity live = Identity();
        MemoryContentIdentity removed = Identity();
        var original = fixture.Store.Publish(
            [new(live, new MemoryStream([1, 2]), 2), new(removed, new MemoryStream([3, 4, 5]), 3)],
            DiskSpillClassification.PublicImmutableReconstructible, true).Value!;
        DiskSegmentLease oldReader = fixture.Store.Acquire(original.SegmentId, removed).Value!;
        var compacted = fixture.Store.Compact(original.SegmentId, entry => entry.Identity == live, true);
        Assert.True(compacted.Succeeded);
        Assert.Single(compacted.Value!.Entries);
        Assert.Equal(MemoryFailure.StaleLocation,
            fixture.Store.Acquire(compacted.Value.SegmentId, removed).Failure);
        using var oldCopy = new MemoryStream();
        Assert.True(oldReader.CopyTo(oldCopy).Succeeded);
        Assert.Equal(new byte[] { 3, 4, 5 }, oldCopy.ToArray());
        oldReader.Dispose();
        Assert.Equal(32768, fixture.DiskUsed);
    }

    [Theory]
    [InlineData(28)]
    [InlineData(160)]
    public void ALeasedReadRevalidatesHeaderAndPayloadBeforeTouchingItsStagingTarget(int offset)
    {
        using var fixture = new Fixture();
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication publication = fixture.Publish(identity, [1, 2, 3]);
        using DiskSegmentLease lease = fixture.Store.Acquire(publication.SegmentId, identity).Value!;
        string name = Assert.Single(fixture.Root.EnumerateNames(16));
        using (var file = new FileStream(Path.Combine(fixture.Path, name), FileMode.Open, FileAccess.ReadWrite))
        {
            file.Position = offset;
            file.WriteByte(0);
        }
        using var privateStaging = new MemoryStream();
        Assert.Equal(MemoryFailure.Corruption, lease.CopyTo(privateStaging).Failure);
        Assert.Equal(0, privateStaging.Length);
        Assert.Equal(MemoryFailure.Corruption, fixture.Store.Acquire(publication.SegmentId, identity).Failure);
    }

    [Fact]
    public void CallerCannotExpandCandidateIndexAfterResourceAdmission()
    {
        var records = new List<DiskSegmentWriteRecord> { new(Identity(), new MemoryStream([1]), 1) };
        using var fixture = new Fixture(duringAdmission: () =>
        {
            for (int index = 0; index < 3; index++)
            {
                records.Add(new(Identity(), new MemoryStream([2]), 1));
            }
        });
        var result = fixture.Store.Publish(records, DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.Equal(MemoryFailure.Corruption, result.Failure);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void InventoryReportsActualRootAndOwnedFilesWithoutAdoptingUntrackedPayloads()
    {
        using var fixture = new Fixture();
        DiskSegmentPublication published = fixture.Publish(Identity(), [1, 2, 3]);
        string tracked = Assert.Single(fixture.Root.EnumerateNames(16));
        string untracked = fixture.WriteRaw([4, 5, 6, 7]);
        File.WriteAllText(Path.Combine(fixture.Path, "foreign-authority"), "unrelated");
        DiskFileFootprint trackedFootprint = fixture.Root.ObserveFileFootprint(tracked);
        DiskFileFootprint untrackedFootprint = fixture.Root.ObserveFileFootprint(untracked);
        var observed = fixture.Store.ObserveInventory();
        Assert.True(observed.Succeeded);
        Assert.Equal(2, observed.Value!.OwnedFiles);
        Assert.Equal(1, observed.Value.UntrackedFiles);
        Assert.Equal(trackedFootprint.LogicalBytes + untrackedFootprint.LogicalBytes, observed.Value.LogicalFileBytes);
        Assert.Equal(trackedFootprint.AllocatedFileBytes + untrackedFootprint.AllocatedFileBytes,
            observed.Value.AllocatedFileBytes);
        Assert.Equal(untrackedFootprint.AllocatedFileBytes, observed.Value.UntrackedAllocatedFileBytes);
        Assert.Equal(fixture.Root.ObserveRootFootprint().Inode, observed.Value.Root.Inode);
        Assert.Equal(trackedFootprint.CapacityIdentity, observed.Value.Root.CapacityIdentity);
        Assert.NotEqual(default, observed.Value.ObservedAt);
        Assert.Equal(1, fixture.Coordinator.Snapshot().Allocations);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.Equal(published.SegmentId, Guid.ParseExact(tracked.AsSpan(37, 32), "N"));
    }

    [Fact]
    public void StartupSegmentBlocksGrowthUntilVerifiedOwnerApprovedRecoveryAdoptsIt()
    {
        using var fixture = new Fixture();
        fixture.WriteRaw([1, 2, 3]);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Publish(
            [new(Identity(), new MemoryStream([4]), 1)], DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        Assert.Single(fixture.Root.EnumerateNames(16));
        Assert.Equal(0, fixture.Coordinator.Snapshot().Allocations);
        var recovered = fixture.Store.Recover(true, _ => true);
        Assert.True(recovered.Succeeded);
        Assert.Equal(1, recovered.Value!.Reused);
        Assert.Equal(0, fixture.Store.ObserveInventory().Value!.UntrackedFiles);
        fixture.Publish(Identity(), [4]);
        Assert.Equal(2, fixture.Root.EnumerateNames(16).Count());
    }

    [Fact]
    public void IncompleteStartupStageBlocksGrowthUntilRecoveryDiscardsOnlyThatOwnedCandidate()
    {
        using var fixture = new Fixture();
        string stage = fixture.Root.NewName("stage");
        using (FileStream file = fixture.Root.CreateFile(stage))
        {
            file.Write([1, 2, 3]);
        }
        string authority = Path.Combine(fixture.Path, "authority");
        File.WriteAllText(authority, "sentinel");
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Publish(
            [new(Identity(), new MemoryStream([4]), 1)], DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        var recovered = fixture.Store.Recover(true, _ => true);
        Assert.True(recovered.Succeeded);
        Assert.Equal(1, recovered.Value!.Discarded);
        Assert.Equal("sentinel", File.ReadAllText(authority));
        fixture.Publish(Identity(), [4]);
        Assert.Equal(0, fixture.Store.ObserveInventory().Value!.UntrackedFiles);
    }

    [Fact]
    public void UnsupportedVersionRemainsUntrackedAndBlocksGrowthAfterRecovery()
    {
        using var fixture = new Fixture();
        string name = fixture.WriteRaw([1]);
        using (var file = new FileStream(Path.Combine(fixture.Path, name), FileMode.Open, FileAccess.Write))
        {
            file.Position = 8;
            Span<byte> version = stackalloc byte[4];
            BinaryPrimitives.WriteUInt32LittleEndian(version, 2);
            file.Write(version);
        }
        Assert.True(fixture.Store.Recover(true, _ => true).Succeeded);
        Assert.Equal(1, fixture.Store.ObserveInventory().Value!.UntrackedFiles);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Publish(
            [new(Identity(), new MemoryStream([4]), 1)], DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        Assert.Equal(name, Assert.Single(fixture.Root.EnumerateNames(16)));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void ScanOverflowIncludesForeignObjectsAndRejectsInventoryRecoveryAndGrowth()
    {
        using var fixture = new Fixture();
        for (int index = 0; index < 17; index++)
        {
            Directory.CreateDirectory(Path.Combine(fixture.Path, $"foreign-{index}"),
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.ObserveInventory().Failure);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Recover(true, _ => true).Failure);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Publish(
            [new(Identity(), new MemoryStream([1]), 1)], DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        Assert.Equal(17, Directory.EnumerateFileSystemEntries(fixture.Path).Count());
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void ChangedTrackedInodeBlocksGrowthAndRetirementNeverDeletesItsReplacement()
    {
        using var fixture = new Fixture();
        DiskSegmentPublication original = fixture.Publish(Identity(), [1]);
        string name = Assert.Single(fixture.Root.EnumerateNames(16));
        string path = Path.Combine(fixture.Path, name);
        string moved = Path.Combine(fixture.Path, "held-original");
        File.Move(path, moved);
        using (FileStream file = fixture.Root.CreateFile(name))
        {
            file.Write([7, 8, 9]);
        }
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Publish(
            [new(Identity(), new MemoryStream([4]), 1)], DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        long originalCharge = fixture.DiskUsed;
        fixture.Store.Retire(original.SegmentId);
        fixture.Store.RetryCleanup();
        Assert.Equal(new byte[] { 7, 8, 9 }, File.ReadAllBytes(path));
        Assert.Equal(originalCharge, fixture.DiskUsed);
        File.Delete(path);
        File.Move(moved, path);
        fixture.Store.RetryCleanup();
        Assert.Equal(0, fixture.DiskUsed);
        Assert.Empty(fixture.Root.EnumerateNames(16));
    }

    [Theory]
    [InlineData("capacity", MemoryFailure.TierUnavailable)]
    [InlineData("root", MemoryFailure.TierUnavailable)]
    [InlineData("revision", MemoryFailure.TierUnavailable)]
    [InlineData("expired", MemoryFailure.TierUnavailable)]
    [InlineData("logical", MemoryFailure.BoundsViolation)]
    [InlineData("charge", MemoryFailure.BoundsViolation)]
    [InlineData("short-charge", MemoryFailure.BoundsViolation)]
    [InlineData("infinite-expiry", MemoryFailure.TierUnavailable)]
    public void PhysicalAllocationPolicyRejectsWrongScopeStaleRevisionAndInvalidBounds(string change, MemoryFailure failure)
    {
        var policy = new FixturePhysicalPolicy((root, logical) =>
        {
            DiskPhysicalAllocationBound bound = Bound(root, logical);
            bound = change switch
            {
                "capacity" => bound with { CapacityIdentity = "fixture:other-device" },
                "root" => bound with { RootInode = checked(root.Inode + 1) },
                "revision" => bound with { PolicyRevision = 2 },
                "expired" => bound with { ValidUntil = DateTimeOffset.MinValue },
                "logical" => bound with { MaximumLogicalBytes = logical - 1 },
                "charge" => bound with { MaximumChargeBytes = 0 },
                "short-charge" => bound with { MaximumChargeBytes = logical - 1 },
                "infinite-expiry" => bound with { ValidUntil = DateTimeOffset.MaxValue },
                _ => throw new ArgumentOutOfRangeException(nameof(change))
            };
            return MemoryOperationResult<DiskPhysicalAllocationBound>.Success(bound);
        });
        using var fixture = new Fixture(diskCap: 262144, physicalPolicy: policy);
        var result = fixture.Store.Publish([new(Identity(), new MemoryStream([1]), 1)],
            DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.Equal(failure, result.Failure);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void AdmittedPhysicalBoundRemainsChargedAcrossCompactionAndOldReaderDrain()
    {
        var policy = new FixturePhysicalPolicy((root, logical) =>
            MemoryOperationResult<DiskPhysicalAllocationBound>.Success(Bound(root, logical)));
        using var fixture = new Fixture(diskCap: 262144, physicalPolicy: policy);
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication source = fixture.Publish(identity, [1, 2, 3]);
        Assert.Equal(65536, fixture.DiskUsed);
        using DiskSegmentLease oldReader = fixture.Store.Acquire(source.SegmentId, identity).Value!;
        var compacted = fixture.Store.Compact(source.SegmentId, true);
        Assert.True(compacted.Succeeded);
        Assert.Equal(131072, fixture.DiskUsed);
        var inventory = fixture.Store.ObserveInventory();
        Assert.True(inventory.Succeeded);
        Assert.Equal(2, inventory.Value!.OwnedFiles);
        Assert.InRange(inventory.Value.AllocatedFileBytes, 1, fixture.DiskUsed);
        Assert.Equal(0, inventory.Value.UntrackedFiles);
        Assert.True(oldReader.CopyTo(new MemoryStream()).Succeeded);
        oldReader.Dispose();
        Assert.Equal(65536, fixture.DiskUsed);
        fixture.Store.Retire(compacted.Value!.SegmentId);
        Assert.Equal(0, fixture.DiskUsed);
        Assert.Empty(fixture.Root.EnumerateNames(16));
    }

    [Fact]
    public void CompactionMustAdmitSourceAndDestinationPhysicalBoundsTogether()
    {
        var policy = new FixturePhysicalPolicy((root, logical) =>
            MemoryOperationResult<DiskPhysicalAllocationBound>.Success(Bound(root, logical)));
        using var fixture = new Fixture(diskCap: 100000, physicalPolicy: policy);
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication source = fixture.Publish(identity, [1]);
        Assert.Equal(65536, fixture.DiskUsed);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Compact(source.SegmentId, true).Failure);
        Assert.Equal(65536, fixture.DiskUsed);
        Assert.Single(fixture.Root.EnumerateNames(16));
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        using DiskSegmentLease reader = fixture.Store.Acquire(source.SegmentId, identity).Value!;
        Assert.True(reader.CopyTo(new MemoryStream()).Succeeded);
    }

    [Fact]
    public void MeasuredAllocatedFileBytesAboveAdmittedPhysicalBoundRejectAndCleanCandidate()
    {
        long maximumCharge = 65536;
        var policy = new FixturePhysicalPolicy((root, logical) =>
            MemoryOperationResult<DiskPhysicalAllocationBound>.Success(Bound(root, logical) with
            {
                MaximumChargeBytes = maximumCharge
            }));
        using var fixture = new Fixture(diskCap: 262144, physicalPolicy: policy);
        string probe = fixture.WriteRaw([1]);
        DiskFileFootprint actual = fixture.Root.ObserveFileFootprint(probe);
        Assert.True(actual.AllocatedFileBytes > actual.LogicalBytes,
            "This fixture requires independently observed block allocation above logical record length.");
        maximumCharge = actual.AllocatedFileBytes - 1;
        fixture.Root.Delete(probe);
        var result = fixture.Store.Publish([new(Identity(), new MemoryStream([1]), 1)],
            DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.Equal(MemoryFailure.BudgetRejected, result.Failure);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void PhysicalPolicyFailureIsPreservedWithoutCreatingAFile()
    {
        var policy = new FixturePhysicalPolicy((root, logical) =>
            MemoryOperationResult<DiskPhysicalAllocationBound>.Reject(MemoryFailure.Corruption));
        using var fixture = new Fixture(diskCap: 262144, physicalPolicy: policy);
        var result = fixture.Store.Publish([new(Identity(), new MemoryStream([1]), 1)],
            DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.Equal(MemoryFailure.Corruption, result.Failure);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void ReentrantUntrackedFileCreationDuringPhysicalPolicyResolutionBlocksGrowth()
    {
        Fixture? fixture = null;
        string? untracked = null;
        var policy = new FixturePhysicalPolicy((root, logical) =>
        {
            Fixture active = fixture ?? throw new InvalidOperationException("Fixture must exist before policy execution.");
            untracked = active.Root.NewName("stage");
            using (FileStream file = active.Root.CreateFile(untracked))
            {
                file.WriteByte(7);
            }
            return MemoryOperationResult<DiskPhysicalAllocationBound>.Success(Bound(root, logical));
        });
        using (fixture = new Fixture(diskCap: 262144, physicalPolicy: policy))
        {
            var result = fixture.Store.Publish([new(Identity(), new MemoryStream([1]), 1)],
                DiskSpillClassification.PublicImmutableReconstructible, true);
            Assert.Equal(MemoryFailure.BudgetRejected, result.Failure);
            Assert.Equal(untracked, Assert.Single(fixture.Root.EnumerateNames(16)));
            Assert.Equal(1, fixture.Store.ObserveInventory().Value!.UntrackedFiles);
            Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        }
    }

    [Fact]
    public void PhysicalPolicyIoFailureReturnsControlledFailureWithoutCreatingAFile()
    {
        var policy = new FixturePhysicalPolicy((root, logical) => throw new IOException("Task-owned policy failure injection."));
        using var fixture = new Fixture(diskCap: 262144, physicalPolicy: policy);
        var result = fixture.Store.Publish([new(Identity(), new MemoryStream([1]), 1)],
            DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void DisableDuringPayloadReadRetainsWriterReservationUntilOperationExitThenDrains()
    {
        using var fixture = new Fixture();
        int callbacks = 0;
        using var payload = new CallbackReadStream(new byte[256], () =>
        {
            callbacks++;
            string stage = Assert.Single(fixture.Root.EnumerateNames(16));
            Assert.EndsWith(".stage", stage);
            MemoryAccountingSnapshot before = fixture.Coordinator.Snapshot();
            Assert.Equal(1, before.Reservations);
            Assert.True(fixture.DiskUsed > 0);
            fixture.Store.Disable();
            Assert.False(fixture.Store.Drained.IsCompleted);
            fixture.Store.RetryCleanup();
            Assert.False(fixture.Store.Drained.IsCompleted);
            Assert.Equal(stage, Assert.Single(fixture.Root.EnumerateNames(16)));
            MemoryAccountingSnapshot retained = fixture.Coordinator.Snapshot();
            Assert.Equal(before.Reservations, retained.Reservations);
            foreach (var charge in before.Used)
            {
                Assert.Equal(charge.Value, retained.Used[charge.Key]);
            }
            Assert.Equal(MemoryFailure.TierUnavailable, fixture.Store.Publish(
                [new(Identity(), new MemoryStream([9]), 1)],
                DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        });
        var result = fixture.Store.Publish([new(Identity(), payload, payload.Length)],
            DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.Equal(1, callbacks);
        Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
        Assert.Null(result.Value);
        Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
        fixture.Root.Validate();
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Allocations);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        Assert.False(fixture.Coordinator.Snapshot().Faulted);
    }

    [Fact]
    public void DisableDuringRecoveryApprovalDefersCandidateDeletionUntilOperationExit()
    {
        using var fixture = new Fixture();
        string name = fixture.WriteRaw([1, 2, 3]);
        int approvals = 0;
        var result = fixture.Store.Recover(true, entry =>
        {
            approvals++;
            Assert.Equal(3, entry.PayloadBytes);
            MemoryAccountingSnapshot before = fixture.Coordinator.Snapshot();
            Assert.True(before.Reservations > 0);
            Assert.True(fixture.DiskUsed > 0);
            fixture.Store.Disable();
            Assert.False(fixture.Store.Drained.IsCompleted);
            fixture.Store.RetryCleanup();
            Assert.False(fixture.Store.Drained.IsCompleted);
            Assert.Equal(name, Assert.Single(fixture.Root.EnumerateNames(16)));
            MemoryAccountingSnapshot retained = fixture.Coordinator.Snapshot();
            Assert.Equal(before.Reservations, retained.Reservations);
            foreach (var charge in before.Used)
            {
                Assert.Equal(charge.Value, retained.Used[charge.Key]);
            }
            return true;
        });
        Assert.Equal(1, approvals);
        Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
        Assert.Null(result.Value);
        Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
        fixture.Root.Validate();
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Allocations);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        Assert.False(fixture.Coordinator.Snapshot().Faulted);
    }

    [Fact]
    public void ReplacedStagingInodeIsNeitherPublishedNorDeletedAndOriginalChargeSurvivesUntilRestoredCleanup()
    {
        using var fixture = new Fixture();
        string? stage = null;
        string backup = Path.Combine(fixture.Path, "held-writer-inode");
        ulong originalInode = 0;
        using var payload = new CallbackReadStream([1, 2, 3, 4], () =>
        {
            stage = Assert.Single(fixture.Root.EnumerateNames(16));
            Assert.EndsWith(".stage", stage);
            DiskFileFootprint original = fixture.Root.ObserveFileFootprint(stage);
            originalInode = original.Inode;
            long admitted = fixture.DiskUsed;
            Assert.True(admitted > 0);
            File.Move(Path.Combine(fixture.Path, stage), backup);
            using (FileStream replacement = fixture.Root.CreateFile(stage))
            {
                replacement.Write([7, 8, 9]);
                replacement.Flush(flushToDisk: true);
            }
            Assert.NotEqual(originalInode, fixture.Root.ObserveFileFootprint(stage).Inode);
            Assert.Equal(admitted, fixture.DiskUsed);
            Assert.Equal(1, fixture.InodesUsed);
        });
        var result = fixture.Store.Publish([new(Identity(), payload, payload.Length)],
            DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.Equal(MemoryFailure.OwnershipViolation, result.Failure);
        Assert.Null(result.Value);
        string ownedStage = Assert.IsType<string>(stage);
        Assert.Equal(ownedStage, Assert.Single(fixture.Root.EnumerateNames(16)));
        string replacementPath = Path.Combine(fixture.Path, ownedStage);
        Assert.Equal(new byte[] { 7, 8, 9 }, File.ReadAllBytes(replacementPath));
        Assert.True(File.Exists(backup));
        MemoryAccountingSnapshot retained = fixture.Coordinator.Snapshot();
        Assert.Equal(1, retained.Reservations);
        Assert.Equal(0, retained.Allocations);
        Assert.Equal(1, fixture.InodesUsed);
        Assert.True(fixture.DiskUsed > 0);
        fixture.Store.RetryCleanup();
        Assert.Equal(new byte[] { 7, 8, 9 }, File.ReadAllBytes(replacementPath));
        Assert.Equal(retained.Reservations, fixture.Coordinator.Snapshot().Reservations);
        foreach (var charge in retained.Used)
        {
            Assert.Equal(charge.Value, fixture.Coordinator.Snapshot().Used[charge.Key]);
        }
        fixture.Store.Disable();
        Assert.False(fixture.Store.Drained.IsCompleted);
        fixture.Store.RetryCleanup();
        Assert.False(fixture.Store.Drained.IsCompleted);
        // The test owns both inodes. Restore only the original writer inode to exercise legal cleanup.
        File.Delete(replacementPath);
        File.Move(backup, replacementPath);
        Assert.Equal(originalInode, fixture.Root.ObserveFileFootprint(ownedStage).Inode);
        fixture.Store.RetryCleanup();
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.False(File.Exists(backup));
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Allocations);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
        fixture.Root.Validate();
        Assert.False(fixture.Coordinator.Snapshot().Faulted);
    }

    private sealed class CallbackReadStream(byte[] data, Action callback) : MemoryStream(data)
    {
        private bool _called;
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (!_called)
            {
                _called = true;
                callback();
            }
            return base.Read(buffer, offset, Math.Min(count, 1));
        }
    }

    [Fact]
    public async Task ContendedStoreOperationsRejectWithoutWaitingOrConsumingResources()
    {
        using var fixture = new Fixture();
        MemoryContentIdentity existingIdentity = Identity();
        DiskSegmentPublication existing = fixture.Publish(existingIdentity, [1, 2, 3]);
        using var entered = new ManualResetEventSlim();
        using var resume = new ManualResetEventSlim();
        using var payload = new CallbackReadStream(new byte[256], () =>
        {
            entered.Set();
            Assert.True(resume.Wait(TimeSpan.FromSeconds(5)), "Task-owned writer was not unblocked.");
        });
        using var competingPayload = new CountingReadStream([9, 8, 7]);
        Task<MemoryOperationResult<DiskSegmentPublication>> writer = Task.Factory.StartNew(
            () => fixture.Store.Publish([new(Identity(), payload, payload.Length)],
                DiskSpillClassification.PublicImmutableReconstructible, true),
            default, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        Task? competitor = null;
        MemoryOperationResult<DiskSegmentPublication>? writerResult = null;
        int approvals = 0;
        int retainedPredicates = 0;
        try
        {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(5)), "Task-owned writer did not enter its payload callback.");
            string[] names = fixture.Root.EnumerateNames(16).OrderBy(name => name, StringComparer.Ordinal).ToArray();
            Assert.Equal(2, names.Length);
            MemoryAccountingSnapshot before = fixture.Coordinator.Snapshot();
            Assert.True(before.Reservations > 0);
            competitor = Task.Factory.StartNew(() =>
            {
                DiskSegmentWriteRecord[] deniedRecords = [new(Identity(), competingPayload, competingPayload.Length)];
                Assert.Equal(MemoryFailure.OwnershipViolation, fixture.Store.Publish(deniedRecords,
                    DiskSpillClassification.Credentials, dataOwnerAllows: true).Failure);
                Assert.Equal(MemoryFailure.OwnershipViolation, fixture.Store.Publish(deniedRecords,
                    DiskSpillClassification.Credentials, dataOwnerAllows: false).Failure);
                Assert.Equal(MemoryFailure.OwnershipViolation, fixture.Store.Publish(deniedRecords,
                    DiskSpillClassification.PublicImmutableReconstructible, dataOwnerAllows: false).Failure);
                Assert.Equal(MemoryFailure.OwnershipViolation, fixture.Store.Recover(false, entry =>
                {
                    Interlocked.Increment(ref approvals);
                    return true;
                }).Failure);
                Assert.Equal(MemoryFailure.OwnershipViolation, fixture.Store.Recover(true, null).Failure);
                Assert.Equal(MemoryFailure.OwnershipViolation, fixture.Store.Compact(existing.SegmentId, entry =>
                {
                    Interlocked.Increment(ref retainedPredicates);
                    return true;
                }, dataOwnerAllows: false).Failure);
                Assert.Equal(MemoryFailure.OwnershipViolation, fixture.Store.Compact(existing.SegmentId, false).Failure);
                Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Publish(
                    [new(Identity(), competingPayload, competingPayload.Length)],
                    DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
                Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Recover(true, entry =>
                {
                    Interlocked.Increment(ref approvals);
                    return true;
                }).Failure);
                Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Acquire(existing.SegmentId, existingIdentity).Failure);
                Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.ObserveInventory().Failure);
                Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Compact(existing.SegmentId, entry =>
                {
                    Interlocked.Increment(ref retainedPredicates);
                    return true;
                }, true).Failure);
            }, default, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            await competitor.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(resume.IsSet);
            Assert.False(writer.IsCompleted);
            Assert.Equal(0, competingPayload.ReadCalls);
            Assert.Equal(0, approvals);
            Assert.Equal(0, retainedPredicates);
            Assert.Equal(names, fixture.Root.EnumerateNames(16).OrderBy(name => name, StringComparer.Ordinal).ToArray());
            MemoryAccountingSnapshot after = fixture.Coordinator.Snapshot();
            Assert.Equal(before.Reservations, after.Reservations);
            Assert.Equal(before.Allocations, after.Allocations);
            foreach (var charge in before.Used)
            {
                Assert.Equal(charge.Value, after.Used[charge.Key]);
            }
            Assert.False(after.Faulted);
        }
        finally
        {
            resume.Set();
            try
            {
                writerResult = await writer.WaitAsync(TimeSpan.FromSeconds(5));
            }
            finally
            {
                if (competitor is not null)
                {
                    await competitor.WaitAsync(TimeSpan.FromSeconds(5));
                }
            }
        }
        Assert.True(writerResult is { Succeeded: true });
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.Equal(2, fixture.Coordinator.Snapshot().Allocations);
        fixture.Store.Disable();
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public async Task ContendedLeaseCopyRejectsWithoutTouchingTargetAndFirstCopyKeepsRetiredSegmentAlive()
    {
        using var fixture = new Fixture();
        MemoryContentIdentity identity = Identity();
        byte[] data = Enumerable.Range(0, 256).Select(value => (byte)value).ToArray();
        DiskSegmentPublication publication = fixture.Publish(identity, data);
        using DiskSegmentLease lease = fixture.Store.Acquire(publication.SegmentId, identity).Value!;
        using var entered = new ManualResetEventSlim();
        using var resume = new ManualResetEventSlim();
        using var rejectedTarget = new MemoryStream();
        using var firstTarget = new RetiringStream(() =>
        {
            using var reentrantTarget = new MemoryStream();
            Assert.Equal(MemoryFailure.OwnershipViolation, lease.CopyTo(reentrantTarget).Failure);
            Assert.Equal(0, reentrantTarget.Length);
            entered.Set();
            Assert.True(resume.Wait(TimeSpan.FromSeconds(5)), "Task-owned copy was not unblocked.");
        });
        Task<MemoryOperationResult<DiskSegmentCopy>> first = Task.Factory.StartNew(
            () => lease.CopyTo(firstTarget), default, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        Task<MemoryOperationResult<DiskSegmentCopy>>? competing = null;
        MemoryOperationResult<DiskSegmentCopy>? firstResult = null;
        try
        {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(5)), "Task-owned copy did not enter its staging callback.");
            fixture.Store.Retire(publication.SegmentId);
            Assert.Single(fixture.Root.EnumerateNames(16));
            MemoryAccountingSnapshot before = fixture.Coordinator.Snapshot();
            Assert.True(fixture.DiskUsed > 0);
            Assert.True(before.Reservations > 0);
            competing = Task.Factory.StartNew(() => lease.CopyTo(rejectedTarget),
                default, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            MemoryOperationResult<DiskSegmentCopy> rejected = await competing.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(MemoryFailure.BudgetRejected, rejected.Failure);
            Assert.Equal(0, rejectedTarget.Length);
            Assert.False(resume.IsSet);
            Assert.False(first.IsCompleted);
            Assert.Single(fixture.Root.EnumerateNames(16));
            MemoryAccountingSnapshot after = fixture.Coordinator.Snapshot();
            Assert.Equal(before.Reservations, after.Reservations);
            Assert.Equal(before.Allocations, after.Allocations);
            foreach (var charge in before.Used)
            {
                Assert.Equal(charge.Value, after.Used[charge.Key]);
            }
            Assert.False(after.Faulted);
        }
        finally
        {
            resume.Set();
            try
            {
                firstResult = await first.WaitAsync(TimeSpan.FromSeconds(5));
            }
            finally
            {
                if (competing is not null)
                {
                    await competing.WaitAsync(TimeSpan.FromSeconds(5));
                }
            }
        }
        Assert.True(firstResult is { Succeeded: true });
        Assert.Equal(data, firstTarget.ToArray());
        Assert.Equal(0, rejectedTarget.Length);
        Assert.Single(fixture.Root.EnumerateNames(16));
        Assert.True(fixture.DiskUsed > 0);
        lease.Dispose();
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    private sealed class CountingReadStream(byte[] data) : MemoryStream(data)
    {
        private int _readCalls;
        internal int ReadCalls => Volatile.Read(ref _readCalls);
        public override int Read(byte[] buffer, int offset, int count)
        {
            Interlocked.Increment(ref _readCalls);
            return base.Read(buffer, offset, count);
        }
    }

    [Fact]
    public void DefaultStoreWithoutOwnerFrozenPhysicalBoundRejectsCreation()
    {
        using var fixture = new Fixture();
        using var unqualified = new DiskSegmentStore(fixture.Root, fixture.Budget, fixture.Limits);
        var result = unqualified.Publish([new(Identity(), new MemoryStream([1]), 1)],
            DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Theory]
    [InlineData("missing", MemoryFailure.TierUnavailable)]
    [InlineData("expired", MemoryFailure.TierUnavailable)]
    [InlineData("root", MemoryFailure.TierUnavailable)]
    [InlineData("capacity", MemoryFailure.TierUnavailable)]
    [InlineData("revision", MemoryFailure.TierUnavailable)]
    [InlineData("logical", MemoryFailure.BoundsViolation)]
    public void CanonicalFrozenPhysicalPolicyRejectsMissingExpiredWrongScopeAndInsufficientLogicalBound(
        string change, MemoryFailure failure)
    {
        using var fixture = new Fixture();
        DiskPhysicalAllocationBound? bound = change switch
        {
            "missing" => null,
            "expired" => fixture.PhysicalBound with { ValidUntil = DateTimeOffset.MinValue },
            "root" => fixture.PhysicalBound with { RootInode = checked(fixture.PhysicalBound.RootInode + 1) },
            "capacity" => fixture.PhysicalBound with { CapacityIdentity = "fixture:wrong-capacity" },
            "revision" => fixture.PhysicalBound with { PolicyRevision = 2 },
            "logical" => fixture.PhysicalBound with { MaximumLogicalBytes = 1 },
            _ => throw new ArgumentOutOfRangeException(nameof(change))
        };
        using var store = new DiskSegmentStore(fixture.Root, fixture.Budget, fixture.Limits,
            new FrozenDiskPhysicalAllocationPolicy(bound));
        var result = store.Publish([new(Identity(), new MemoryStream([1]), 1)],
            DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.Equal(failure, result.Failure);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void CanonicalFrozenPhysicalBoundRetainsSeparateInodesAcrossRecoveryCompactionAndReaderDrain()
    {
        using var fixture = new Fixture();
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication source = fixture.Publish(identity, [1, 2, 3]);
        Assert.Equal(32768, fixture.DiskUsed);
        Assert.Equal(1, fixture.InodesUsed);
        Assert.Equal(1, fixture.Coordinator.Snapshot().Used["application-inodes"]);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Used["slots"]);
        using DiskSegmentLease oldReader = fixture.Store.Acquire(source.SegmentId, identity).Value!;
        Assert.Equal(1, fixture.InodesUsed);
        Assert.Equal(1, fixture.Coordinator.Snapshot().Used["slots"]);
        var compacted = fixture.Store.Compact(source.SegmentId, true);
        Assert.True(compacted.Succeeded);
        Assert.Equal(65536, fixture.DiskUsed);
        Assert.Equal(2, fixture.InodesUsed);
        Assert.Equal(2, fixture.Coordinator.Snapshot().Used["application-inodes"]);
        Assert.Equal(1, fixture.Coordinator.Snapshot().Used["slots"]);
        using var copy = new MemoryStream();
        Assert.True(oldReader.CopyTo(copy).Succeeded);
        Assert.Equal(new byte[] { 1, 2, 3 }, copy.ToArray());
        oldReader.Dispose();
        Assert.Equal(32768, fixture.DiskUsed);
        Assert.Equal(1, fixture.InodesUsed);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Used["slots"]);
        fixture.WriteRaw([4, 5]);
        var recovered = fixture.Store.Recover(true, _ => true);
        Assert.True(recovered.Succeeded);
        Assert.Equal(1, recovered.Value!.Reused);
        Assert.Equal(65536, fixture.DiskUsed);
        Assert.Equal(2, fixture.InodesUsed);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Used["slots"]);
        Assert.Equal(0, fixture.Store.ObserveInventory().Value!.UntrackedFiles);
        fixture.Store.Disable();
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void OnePersistentInodeStopsNewSegmentsAndCompactionWhileReadSlotsRemainUsable()
    {
        using var fixture = new Fixture(inodeCap: 1);
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication source = fixture.Publish(identity, [1, 2, 3]);
        Assert.Equal(1, fixture.InodesUsed);
        using DiskSegmentLease reader = fixture.Store.Acquire(source.SegmentId, identity).Value!;
        Assert.Equal(1, fixture.Coordinator.Snapshot().Used["slots"]);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Publish(
            [new(Identity(), new MemoryStream([4]), 1)],
            DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Compact(source.SegmentId, true).Failure);
        Assert.Equal(1, fixture.InodesUsed);
        Assert.Equal(32768, fixture.DiskUsed);
        Assert.Equal(1, fixture.Coordinator.Snapshot().Used["slots"]);
        fixture.Store.Retire(source.SegmentId);
        Assert.Single(fixture.Root.EnumerateNames(16));
        Assert.Equal(1, fixture.InodesUsed);
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Store.Acquire(source.SegmentId, identity).Failure);
        using var copy = new MemoryStream();
        Assert.True(reader.CopyTo(copy).Succeeded);
        Assert.Equal(new byte[] { 1, 2, 3 }, copy.ToArray());
        reader.Dispose();
        Assert.Equal(0, fixture.InodesUsed);
        Assert.Equal(0, fixture.DiskUsed);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        fixture.Publish(Identity(), [5]);
        Assert.Equal(1, fixture.InodesUsed);
        Assert.Equal(32768, fixture.DiskUsed);
    }

    [Fact]
    public void CanonicalFrozenPolicyAdmitsAndDiscardsZeroByteStagingWithoutTouchingUnrelatedFiles()
    {
        using var fixture = new Fixture();
        string stage = fixture.Root.NewName("stage");
        using (FileStream file = fixture.Root.CreateFile(stage))
        {
            Assert.Equal(0, file.Length);
        }
        string unrelated = Path.Combine(fixture.Path, "authoritative-sentinel");
        File.WriteAllText(unrelated, "unchanged");
        Assert.Equal(0, fixture.Root.ObserveFileFootprint(stage).LogicalBytes);
        var result = fixture.Store.Recover(true, _ => true);
        Assert.True(result.Succeeded);
        Assert.Equal(0, result.Value!.Reused);
        Assert.Equal(1, result.Value.Discarded);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.Equal("unchanged", File.ReadAllText(unrelated));
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Allocations);
        Assert.Equal(0, fixture.InodesUsed);
        Assert.Equal(0, fixture.DiskUsed);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        Assert.False(fixture.Coordinator.Snapshot().Faulted);
    }

    [Fact]
    public void RecoveryRegistersExistingSegmentOverByteAndInodeCapsAndKeepsReadersAliveUntilLegalDeletion()
    {
        using var fixture = new Fixture(diskCap: 1, inodeCap: 0);
        string name = fixture.WriteRaw([1, 2, 3]);
        DiskFileFootprint footprint = fixture.Root.ObserveFileFootprint(name);
        Guid id = Guid.ParseExact(name.AsSpan(37, 32), "N");
        MemoryContentIdentity? identity = null;
        int approvals = 0;
        var recovered = fixture.Store.Recover(true, entry =>
        {
            approvals++;
            identity = entry.Identity;
            Assert.Equal(32768, fixture.DiskUsed);
            Assert.Equal(1, fixture.InodesUsed);
            Assert.True(fixture.Coordinator.Snapshot().OverTarget);
            AssertRecoveryOwner(fixture, id, footprint.LogicalBytes);
            return true;
        });
        Assert.True(recovered.Succeeded);
        Assert.Equal(1, recovered.Value!.Reused);
        Assert.Equal(1, approvals);
        MemoryContentIdentity recoveredIdentity = identity
            ?? throw new InvalidOperationException("Recovery approval did not capture content identity.");
        Assert.Equal(name, Assert.Single(fixture.Root.EnumerateNames(16)));
        AssertRecoveryOwner(fixture, id, footprint.LogicalBytes);
        MemoryAccountingSnapshot snapshot = fixture.Coordinator.Snapshot();
        Assert.True(snapshot.OverTarget);
        Assert.False(snapshot.Faulted);
        Assert.True(snapshot.Used["application"] > snapshot.HardCaps["application"]);
        Assert.True(snapshot.Used["application-inodes"] > snapshot.HardCaps["application-inodes"]);
        Assert.Equal(0, snapshot.Reservations);
        Assert.Equal(0, snapshot.Used["slots"]);
        MemoryAccountingEvent registered = Assert.Single(fixture.Coordinator.EventWindow().Events,
            entry => entry.Kind == "existing-registered");
        Assert.Equal(new AllocationId(id), registered.Allocation);
        using DiskSegmentLease reader = fixture.Store.Acquire(id, recoveredIdentity).Value!;
        using var payload = new CountingReadStream([4]);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Publish([new(Identity(), payload, payload.Length)],
            DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        Assert.Equal(0, payload.ReadCalls);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Compact(id, true).Failure);
        Assert.Equal(32768, fixture.DiskUsed);
        Assert.Equal(1, fixture.InodesUsed);
        fixture.Store.Retire(id);
        Assert.Equal(name, Assert.Single(fixture.Root.EnumerateNames(16)));
        Assert.Equal(32768, fixture.DiskUsed);
        Assert.Equal(1, fixture.InodesUsed);
        using var copied = new MemoryStream();
        Assert.True(reader.CopyTo(copied).Succeeded);
        Assert.Equal(new byte[] { 1, 2, 3 }, copied.ToArray());
        reader.Dispose();
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.Empty(fixture.Coordinator.Allocations());
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        Assert.False(fixture.Coordinator.Snapshot().OverTarget);
    }

    [Fact]
    public void RecoveryCannotAdoptExistingOwnerSegmentWithoutInodeAdmissionAndLeavesItBlockingGrowth()
    {
        using var fixture = new Fixture(inodeCap: 0, registerExistingPhysicalDomains: false);
        string name = fixture.WriteRaw([1, 2, 3]);
        DiskFileFootprint before = fixture.Root.ObserveFileFootprint(name);
        int approvals = 0;
        var recovered = fixture.Store.Recover(true, entry =>
        {
            approvals++;
            return true;
        });
        Assert.Equal(MemoryFailure.OwnershipViolation, recovered.Failure);
        Assert.Equal(0, approvals);
        Assert.Equal(name, Assert.Single(fixture.Root.EnumerateNames(16)));
        Assert.Equal(before.Inode, fixture.Root.ObserveFileFootprint(name).Inode);
        Assert.Empty(fixture.Coordinator.Allocations());
        Assert.DoesNotContain(fixture.Coordinator.EventWindow().Events, entry => entry.Kind == "existing-registered");
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        using var payload = new CountingReadStream([4]);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Publish([new(Identity(), payload, payload.Length)],
            DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        Assert.Equal(0, payload.ReadCalls);
        Assert.Equal(name, Assert.Single(fixture.Root.EnumerateNames(16)));
        Assert.Equal(1, fixture.Store.ObserveInventory().Value!.UntrackedFiles);
    }

    [Fact]
    public void InsufficientNewRecoveryIndexCapacityRejectsBeforeAdoptionAndOwnerApproval()
    {
        using var fixture = new Fixture(hostCap: 6000);
        string name = fixture.WriteRaw([1, 2, 3]);
        DiskFileFootprint original = fixture.Root.ObserveFileFootprint(name);
        int approvals = 0;
        var result = fixture.Store.Recover(true, entry =>
        {
            approvals++;
            return true;
        });
        Assert.Equal(MemoryFailure.BudgetRejected, result.Failure);
        Assert.Equal(0, approvals);
        Assert.Equal(name, Assert.Single(fixture.Root.EnumerateNames(16)));
        Assert.Equal(original.Inode, fixture.Root.ObserveFileFootprint(name).Inode);
        Assert.Empty(fixture.Coordinator.Allocations());
        Assert.DoesNotContain(fixture.Coordinator.EventWindow().Events, entry => entry.Kind == "existing-registered");
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void RecoveryOwnerApprovalReplacementPreservesReplacementAndRetainsOriginalRegisteredCharge()
    {
        using var fixture = new Fixture();
        string name = fixture.WriteRaw([1, 2, 3]);
        Guid id = Guid.ParseExact(name.AsSpan(37, 32), "N");
        string path = Path.Combine(fixture.Path, name);
        string backup = Path.Combine(fixture.Path, "held-recovery-original");
        DiskFileFootprint original = fixture.Root.ObserveFileFootprint(name);
        int approvals = 0;
        var result = fixture.Store.Recover(true, entry =>
        {
            approvals++;
            AssertRecoveryOwner(fixture, id, original.LogicalBytes);
            Assert.Equal(32768, fixture.DiskUsed);
            Assert.Equal(1, fixture.InodesUsed);
            File.Move(path, backup);
            using (FileStream replacement = fixture.Root.CreateFile(name))
            {
                replacement.Write([7, 8, 9]);
                replacement.Flush(flushToDisk: true);
            }
            Assert.NotEqual(original.Inode, fixture.Root.ObserveFileFootprint(name).Inode);
            return true;
        });
        Assert.Equal(1, approvals);
        Assert.Equal(MemoryFailure.OwnershipViolation, result.Failure);
        Assert.Equal(new byte[] { 7, 8, 9 }, File.ReadAllBytes(path));
        Assert.True(File.Exists(backup));
        AssertRecoveryOwner(fixture, id, original.LogicalBytes);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Used["slots"]);
        Assert.Equal(32768, fixture.DiskUsed);
        Assert.Equal(1, fixture.InodesUsed);
        fixture.Store.RetryCleanup();
        Assert.Equal(new byte[] { 7, 8, 9 }, File.ReadAllBytes(path));
        AssertRecoveryOwner(fixture, id, original.LogicalBytes);
        fixture.Store.Disable();
        Assert.False(fixture.Store.Drained.IsCompleted);
        fixture.Store.RetryCleanup();
        Assert.False(fixture.Store.Drained.IsCompleted);
        File.Delete(path);
        File.Move(backup, path);
        Assert.Equal(original.Inode, fixture.Root.ObserveFileFootprint(name).Inode);
        fixture.Store.RetryCleanup();
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.Empty(fixture.Coordinator.Allocations());
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
        fixture.Root.Validate();
    }

    [Fact]
    public void RecoveryPolicyRevisionChangeRejectsPublicationAfterHoldingExistingOwnershipUntilLegalCleanup()
    {
        using var fixture = new Fixture();
        string name = fixture.WriteRaw([1, 2, 3]);
        Guid id = Guid.ParseExact(name.AsSpan(37, 32), "N");
        long logical = fixture.Root.ObserveFileFootprint(name).LogicalBytes;
        int approvals = 0;
        var result = fixture.Store.Recover(true, entry =>
        {
            approvals++;
            AssertRecoveryOwner(fixture, id, logical);
            Assert.Equal(32768, fixture.DiskUsed);
            Assert.Equal(1, fixture.InodesUsed);
            Assert.True(fixture.Coordinator.Snapshot().Reservations > 0);
            fixture.Coordinator.ReviseLimits(2, fixture.ResourceLimits);
            AssertRecoveryOwner(fixture, id, logical);
            Assert.Equal(32768, fixture.DiskUsed);
            Assert.Equal(1, fixture.InodesUsed);
            Assert.Equal(name, Assert.Single(fixture.Root.EnumerateNames(16)));
            return true;
        });
        Assert.Equal(1, approvals);
        Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
        Assert.Null(result.Value);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        Assert.Empty(fixture.Coordinator.Allocations());
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        Assert.False(fixture.Coordinator.Snapshot().Faulted);
    }

    [Fact]
    public void DisableDuringIndexAdmissionStopsRecoveryBeforeExistingOwnershipRegistration()
    {
        Fixture? fixture = null;
        int observations = 0;
        using (fixture = new Fixture(duringAdmission: () =>
        {
            if (++observations == 3)
            {
                Fixture active = fixture ?? throw new InvalidOperationException("Fixture must exist before admission.");
                active.Store.Disable();
                Assert.False(active.Store.Drained.IsCompleted);
            }
        }))
        {
            string name = fixture.WriteRaw([1, 2, 3]);
            DiskFileFootprint original = fixture.Root.ObserveFileFootprint(name);
            int approvals = 0;
            var result = fixture.Store.Recover(true, entry =>
            {
                approvals++;
                return true;
            });
            Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
            fixture.Root.Validate();
            Assert.Equal(3, observations);
            Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
            Assert.Equal(0, approvals);
            Assert.Equal(name, Assert.Single(fixture.Root.EnumerateNames(16)));
            Assert.Equal(original.Inode, fixture.Root.ObserveFileFootprint(name).Inode);
            Assert.Empty(fixture.Coordinator.Allocations());
            Assert.DoesNotContain(fixture.Coordinator.EventWindow().Events, entry => entry.Kind == "existing-registered");
            Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
            Assert.False(fixture.Coordinator.Snapshot().Faulted);
        }
    }

    [Fact]
    public void ReentrantRecoveryDuringIndexAdmissionRegistersExistingOwnerOnceAndRejectsOuterReplay()
    {
        Fixture? fixture = null;
        MemoryOperationResult<DiskSegmentRecovery>? nested = null;
        MemoryContentIdentity? identity = null;
        int observations = 0;
        int nestedCalls = 0;
        using (fixture = new Fixture(duringAdmission: () =>
        {
            if (++observations == 3)
            {
                Fixture active = fixture ?? throw new InvalidOperationException("Fixture must exist before admission.");
                nestedCalls++;
                nested = active.Store.Recover(true, entry =>
                {
                    identity = entry.Identity;
                    return true;
                });
            }
        }))
        {
            string name = fixture.WriteRaw([1, 2, 3]);
            Guid id = Guid.ParseExact(name.AsSpan(37, 32), "N");
            long logical = fixture.Root.ObserveFileFootprint(name).LogicalBytes;
            int outerApprovals = 0;
            var outer = fixture.Store.Recover(true, entry =>
            {
                outerApprovals++;
                return true;
            });
            Assert.Equal(1, nestedCalls);
            Assert.True(nested is { Succeeded: true });
            Assert.Equal(1, nested!.Value!.Reused);
            Assert.Equal(MemoryFailure.OwnershipViolation, outer.Failure);
            Assert.Equal(0, outerApprovals);
            AssertRecoveryOwner(fixture, id, logical);
            Assert.Single(fixture.Coordinator.EventWindow().Events, entry => entry.Kind == "existing-registered");
            Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
            Assert.False(fixture.Coordinator.Snapshot().Faulted);
            Assert.Equal(name, Assert.Single(fixture.Root.EnumerateNames(16)));
            MemoryContentIdentity recoveredIdentity = identity
                ?? throw new InvalidOperationException("Nested approval did not capture content identity.");
            using DiskSegmentLease reader = fixture.Store.Acquire(id, recoveredIdentity).Value!;
            using var copy = new MemoryStream();
            Assert.True(reader.CopyTo(copy).Succeeded);
            Assert.Equal(new byte[] { 1, 2, 3 }, copy.ToArray());
            reader.Dispose();
            fixture.Store.Retire(id);
            Assert.Empty(fixture.Root.EnumerateNames(16));
            Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
            Assert.False(fixture.Coordinator.Snapshot().Faulted);
        }
    }

    [Fact]
    public void RecoveryApprovalMovingOriginalWithoutReplacementRetainsOwnershipUntilProvenUnlink()
    {
        using var fixture = new Fixture();
        string name = fixture.WriteRaw([1, 2, 3]);
        string path = Path.Combine(fixture.Path, name);
        string backup = Path.Combine(fixture.Path, "moved-recovery-original");
        byte[] originalBytes = File.ReadAllBytes(path);
        DiskFileFootprint original = fixture.Root.ObserveFileFootprint(name);
        Guid id = Guid.ParseExact(name.AsSpan(37, 32), "N");
        int approvals = 0;
        var result = fixture.Store.Recover(true, entry =>
        {
            approvals++;
            AssertRecoveryOwner(fixture, id, original.LogicalBytes);
            File.Move(path, backup);
            Assert.False(File.Exists(path));
            Assert.True(File.Exists(backup));
            return true;
        });
        Assert.Equal(1, approvals);
        Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
        Assert.Null(result.Value);
        Assert.False(File.Exists(path));
        Assert.Equal(originalBytes, File.ReadAllBytes(backup));
        AssertRecoveryOwner(fixture, id, original.LogicalBytes);
        Assert.Equal(32768, fixture.DiskUsed);
        Assert.Equal(1, fixture.InodesUsed);
        Assert.Equal(fixture.Limits.IndexBytes(fixture.Limits.MaxRecordsPerSegment),
            fixture.Coordinator.Snapshot().Used["host"]);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Used["slots"]);
        fixture.Store.RetryCleanup();
        AssertRecoveryOwner(fixture, id, original.LogicalBytes);
        Assert.Equal(32768, fixture.DiskUsed);
        Assert.Equal(1, fixture.InodesUsed);
        Assert.Equal(originalBytes, File.ReadAllBytes(backup));
        using var candidate = new CountingReadStream([4]);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Publish([new(Identity(), candidate, candidate.Length)],
            DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        Assert.Equal(0, candidate.ReadCalls);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        AssertRecoveryOwner(fixture, id, original.LogicalBytes);
        fixture.Store.Disable();
        Assert.False(fixture.Store.Drained.IsCompleted);
        fixture.Store.RetryCleanup();
        Assert.False(fixture.Store.Drained.IsCompleted);
        File.Move(backup, path);
        Assert.Equal(original.Inode, fixture.Root.ObserveFileFootprint(name).Inode);
        fixture.Store.RetryCleanup();
        Assert.False(File.Exists(path));
        Assert.False(File.Exists(backup));
        Assert.Empty(fixture.Coordinator.Allocations());
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
        fixture.Root.Validate();
        Assert.False(fixture.Coordinator.Snapshot().Faulted);
    }

    [Fact]
    public void MovedWriterStagingWithoutReplacementRetainsReservationUntilOriginalInodeIsUnlinked()
    {
        using var fixture = new Fixture();
        string? stage = null;
        string backup = Path.Combine(fixture.Path, "moved-writer-original");
        ulong originalInode = 0;
        byte[] data = [1, 2, 3, 4];
        using var payload = new CallbackReadStream(data, () =>
        {
            stage = Assert.Single(fixture.Root.EnumerateNames(16));
            originalInode = fixture.Root.ObserveFileFootprint(stage).Inode;
            File.Move(Path.Combine(fixture.Path, stage), backup);
            Assert.Empty(fixture.Root.EnumerateNames(16));
            Assert.Equal(32768, fixture.DiskUsed);
            Assert.Equal(1, fixture.InodesUsed);
        });
        var result = fixture.Store.Publish([new(Identity(), payload, payload.Length)],
            DiskSpillClassification.PublicImmutableReconstructible, true);
        Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
        Assert.Null(result.Value);
        string originalName = Assert.IsType<string>(stage);
        string path = Path.Combine(fixture.Path, originalName);
        Assert.False(File.Exists(path));
        byte[] backupBytes = File.ReadAllBytes(backup);
        Assert.Equal(data, backupBytes[^data.Length..]);
        Assert.Equal(32768, fixture.DiskUsed);
        Assert.Equal(1, fixture.InodesUsed);
        Assert.Empty(fixture.Coordinator.Allocations());
        MemoryAccountingSnapshot retained = fixture.Coordinator.Snapshot();
        Assert.Equal(1, retained.Reservations);
        fixture.Store.RetryCleanup();
        Assert.Equal(retained.Reservations, fixture.Coordinator.Snapshot().Reservations);
        foreach (var charge in retained.Used)
        {
            Assert.Equal(charge.Value, fixture.Coordinator.Snapshot().Used[charge.Key]);
        }
        Assert.Equal(backupBytes, File.ReadAllBytes(backup));
        using var candidate = new CountingReadStream([5]);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Publish([new(Identity(), candidate, candidate.Length)],
            DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        Assert.Equal(0, candidate.ReadCalls);
        Assert.Empty(fixture.Root.EnumerateNames(16));
        fixture.Store.Disable();
        Assert.False(fixture.Store.Drained.IsCompleted);
        fixture.Store.RetryCleanup();
        Assert.False(fixture.Store.Drained.IsCompleted);
        File.Move(backup, path);
        Assert.Equal(originalInode, fixture.Root.ObserveFileFootprint(originalName).Inode);
        fixture.Store.RetryCleanup();
        Assert.False(File.Exists(path));
        Assert.False(File.Exists(backup));
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
        Assert.True(fixture.Store.Drained.IsCompletedSuccessfully);
        fixture.Root.Validate();
        Assert.False(fixture.Coordinator.Snapshot().Faulted);
    }

    private static void AssertRecoveryOwner(Fixture fixture, Guid id, long logicalBytes)
    {
        MemoryAllocationObservation owner = Assert.Single(fixture.Coordinator.Allocations());
        MemoryAllocationDescriptor descriptor = Assert.IsType<MemoryAllocationDescriptor>(owner.Descriptor);
        Assert.Equal(new AllocationId(id), owner.Allocation);
        Assert.Equal(owner.Allocation, descriptor.Allocation);
        Assert.Equal(fixture.Budget.DiskDomain, descriptor.Domain);
        Assert.Equal(logicalBytes, descriptor.Layout.LogicalBytes);
        Assert.Equal(logicalBytes, descriptor.Layout.AlignedBytes);
        Assert.Equal(32768, descriptor.Layout.CapacityBytes);
        Assert.Equal(1, descriptor.Layout.AlignmentBytes);
        Assert.Equal(0, descriptor.Layout.AlignmentSlack);
        Assert.Equal(32768 - logicalBytes, descriptor.Layout.RetainedSlack);
        Assert.Equal(3, owner.ActualCharges.Count);
        MemoryResourceCharge disk = Assert.Single(owner.ActualCharges, charge => charge.Domain == fixture.Budget.DiskDomain);
        Assert.Equal(MemoryResourceUnit.Bytes, disk.Unit);
        Assert.Equal(32768, disk.Amount);
        MemoryResourceCharge inode = Assert.Single(owner.ActualCharges, charge => charge.Domain == fixture.Budget.InodeDomain);
        Assert.Equal(MemoryResourceUnit.Inodes, inode.Unit);
        Assert.Equal(1, inode.Amount);
        MemoryResourceCharge index = Assert.Single(owner.ActualCharges, charge => charge.Domain == fixture.Budget.HostDomain);
        Assert.Equal(MemoryResourceUnit.Bytes, index.Unit);
        Assert.Equal(fixture.Limits.IndexBytes(fixture.Limits.MaxRecordsPerSegment), index.Amount);
    }

    private static DiskPhysicalAllocationBound Bound(DiskFileFootprint root, long logical)
        => new(root.CapacityIdentity, root.Inode, logical, 65536, 1, DateTimeOffset.UtcNow.AddMinutes(10));

    private sealed class FixturePhysicalPolicy(
        Func<DiskFileFootprint, long, MemoryOperationResult<DiskPhysicalAllocationBound>> resolve) : IDiskPhysicalAllocationPolicy
    {
        public MemoryOperationResult<DiskPhysicalAllocationBound> TryGetBound(DiskFileFootprint root, long logicalBytes)
            => resolve(root, logicalBytes);
    }

    private static MemoryContentIdentity Identity()
        => new(new(Guid.NewGuid()), new(1), new(Guid.NewGuid()));

    private sealed class ShortReadStream(byte[] data) : MemoryStream(data)
    {
        public override int Read(byte[] buffer, int offset, int count)
            => base.Read(buffer, offset, Math.Min(count, 1));
    }

    private sealed class Fixture : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"mem-segment-test-{Guid.NewGuid():N}");
        internal OwnedSpillRoot Root
        {
            get;
        }
        internal DiskSegmentStore Store
        {
            get;
        }
        internal MemoryReservationCoordinator Coordinator
        {
            get;
        }
        private readonly DiskSegmentLimits _limits = new(8, 4, 4096, 32768, 128, 16);
        private readonly string _capacityIdentity;
        private readonly string _inodeCapacityIdentity;
        internal long DiskUsed => Coordinator.Snapshot().Used[_capacityIdentity];
        internal long InodesUsed => Coordinator.Snapshot().Used[_inodeCapacityIdentity];
        internal DiskBudgetAdmission Budget
        {
            get;
        }
        internal DiskPhysicalAllocationBound PhysicalBound
        {
            get;
        }
        internal DiskSegmentLimits Limits => _limits;
        internal IReadOnlyList<MemoryResourceLimit> ResourceLimits
        {
            get;
        }

        internal Fixture(long diskCap = 100000, long hostCap = 100000, Action? duringAdmission = null,
            IDiskPhysicalAllocationPolicy? physicalPolicy = null, long inodeCap = 16,
            bool registerExistingPhysicalDomains = true)
        {
            Directory.CreateDirectory(Path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            Root = new(Path, Guid.NewGuid());
            DiskFileFootprint rootFootprint = Root.ObserveRootFootprint();
            _capacityIdentity = rootFootprint.CapacityIdentity;
            _inodeCapacityIdentity = _capacityIdentity + ":inodes";
            var volume = new ResourceDomainId(Guid.NewGuid());
            var disk = new ResourceDomainId(Guid.NewGuid());
            var host = new ResourceDomainId(Guid.NewGuid());
            var slot = new ResourceDomainId(Guid.NewGuid());
            var inodeCapacity = new ResourceDomainId(Guid.NewGuid());
            var inode = new ResourceDomainId(Guid.NewGuid());
            var topology = new MemoryResourceTopology([
                new(volume, _capacityIdentity, MemoryResourceUnit.Bytes, null),
                new(disk, "application", MemoryResourceUnit.Bytes, volume),
                new(host, "host", MemoryResourceUnit.Bytes, null),
                new(slot, "slots", MemoryResourceUnit.OperationSlots, null),
                new(inodeCapacity, _inodeCapacityIdentity, MemoryResourceUnit.Inodes, null),
                new(inode, "application-inodes", MemoryResourceUnit.Inodes, inodeCapacity)
            ]);
            ResourceLimits = [new(volume, MemoryResourceUnit.Bytes, diskCap), new(disk, MemoryResourceUnit.Bytes, diskCap),
                new(host, MemoryResourceUnit.Bytes, hostCap), new(slot, MemoryResourceUnit.OperationSlots, 64),
                new(inodeCapacity, MemoryResourceUnit.Inodes, inodeCap), new(inode, MemoryResourceUnit.Inodes, inodeCap)];
            Coordinator = new(topology, ResourceLimits, 1, 128, 1024,
                existingPhysicalDomains: registerExistingPhysicalDomains ? [disk, inode] : null);
            DateTimeOffset now = DateTimeOffset.UtcNow;
            MemoryResourceObservation Observation(ResourceDomainId domain, MemoryResourceUnit unit, long amount)
                => new(domain, unit, MemoryObservationState.Available, amount, "fixture:finite-capacity", now);
            var sample = new DiskCapacityObservation(_capacityIdentity, Observation(volume, MemoryResourceUnit.Bytes, diskCap),
                Observation(volume, MemoryResourceUnit.Bytes, diskCap), Observation(inodeCapacity, MemoryResourceUnit.Inodes, inodeCap),
                DiskBackingKind.Independent, now.AddMinutes(10), 1);
            Budget = new DiskBudgetAdmission(Coordinator, disk, volume, host, slot, inode, inodeCapacity, diskCap, 0, () =>
            {
                duringAdmission?.Invoke();
                return sample;
            });
            PhysicalBound = new(rootFootprint.CapacityIdentity, rootFootprint.Inode, 32768, 32768,
                1, now.AddMinutes(10));
            Store = new(Root, Budget, _limits, physicalPolicy ?? new FrozenDiskPhysicalAllocationPolicy(PhysicalBound));
        }

        internal DiskSegmentPublication Publish(MemoryContentIdentity identity, byte[] data)
        {
            var result = Store.Publish([new(identity, new MemoryStream(data), data.Length)],
                DiskSpillClassification.PublicImmutableReconstructible, true);
            Assert.True(result.Succeeded);
            return result.Value!;
        }

        internal string WriteRaw(byte[] data)
        {
            string stage = Root.NewName("stage");
            Guid id = Guid.ParseExact(stage.AsSpan(37, 32), "N");
            DiskSegmentWriteRecord[] records = [new(Identity(), new ShortReadStream(data), data.Length)];
            using (FileStream file = Root.CreateFile(stage))
            {
                DiskSegmentFormat.Write(file, id, records, DiskSegmentFormat.Size(records, _limits), new byte[128], default);
            }
            string final = System.IO.Path.ChangeExtension(stage, "segment");
            Root.Rename(stage, final);
            return final;
        }

        public void Dispose()
        {
            Store.Dispose();
            Root.Dispose();
            Directory.Delete(Path, recursive: true);
        }
    }
}
