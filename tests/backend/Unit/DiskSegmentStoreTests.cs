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
        Assert.Single(fixture.Root.EnumerateNames(16));
        using DiskSegmentLease lease = fixture.Store.Acquire(published.Value.SegmentId, first).Value!;
        using var copy = new MemoryStream();
        Assert.True(lease.CopyTo(copy).Succeeded);
        Assert.Equal(new byte[] { 1, 2, 3 }, copy.ToArray());
        Assert.Equal(64 + 2 * 96 + 5, fixture.Coordinator.Snapshot().Used["volume"]);
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
        Assert.Equal(2, fixture.Coordinator.Snapshot().Allocations);
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
        long before = fixture.Coordinator.Snapshot().Used["volume"];
        var compacted = fixture.Store.Compact(old.SegmentId, true);
        Assert.True(compacted.Succeeded);
        Assert.Equal(before * 2, fixture.Coordinator.Snapshot().Used["volume"]);
        Assert.Equal(2, fixture.Root.EnumerateNames(16).Count());
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Store.Acquire(old.SegmentId, identity).Failure);
        using var target = new MemoryStream();
        Assert.True(reader.CopyTo(target).Succeeded);
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, target.ToArray());
        reader.Dispose();
        reader.Dispose();
        Assert.Single(fixture.Root.EnumerateNames(16));
        Assert.Equal(before, fixture.Coordinator.Snapshot().Used["volume"]);
        using DiskSegmentLease current = fixture.Store.Acquire(compacted.Value!.SegmentId, identity).Value!;
        Assert.True(current.CopyTo(new MemoryStream()).Succeeded);
    }

    [Fact]
    public void CompactionRequiresSimultaneousDestinationAdmissionAndPreservesSourceOnRejection()
    {
        using var fixture = new Fixture(diskCap: 300);
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication source = fixture.Publish(identity, [1, 2, 3, 4]);
        long before = fixture.Coordinator.Snapshot().Used["volume"];
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Store.Compact(source.SegmentId, true).Failure);
        Assert.Single(fixture.Root.EnumerateNames(16));
        Assert.Equal(before, fixture.Coordinator.Snapshot().Used["volume"]);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        using DiskSegmentLease reader = fixture.Store.Acquire(source.SegmentId, identity).Value!;
        Assert.True(reader.CopyTo(new MemoryStream()).Succeeded);
    }

    [Fact]
    public void DisableBlocksNewOperationsAndDrainsExistingReaderBeforeDeletion()
    {
        using var fixture = new Fixture();
        MemoryContentIdentity identity = Identity();
        DiskSegmentPublication published = fixture.Publish(identity, [7]);
        DiskSegmentLease reader = fixture.Store.Acquire(published.SegmentId, identity).Value!;
        fixture.Store.Disable();
        Assert.Single(fixture.Root.EnumerateNames(16));
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Store.Acquire(published.SegmentId, identity).Failure);
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Store.Recover(true, _ => true).Failure);
        Assert.True(reader.CopyTo(new MemoryStream()).Succeeded);
        reader.Dispose();
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
            Assert.Single(fixture.Root.EnumerateNames(16));
            Assert.True(fixture.Coordinator.Snapshot().Used["volume"] > 0);
            Assert.Equal(MemoryFailure.StaleLocation, reader.CopyTo(new MemoryStream()).Failure);
        });
        Assert.True(reader.CopyTo(target).Succeeded);
        Assert.Equal(new byte[256], target.ToArray());
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
            throw new InvalidOperationException("Task-owned caller staging failure.");
        });
        Assert.Throws<InvalidOperationException>(() => reader.CopyTo(target));
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
        Assert.Equal(64 + 96 + 2, fixture.Coordinator.Snapshot().Used["volume"]);
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
            fixture.Store.RetryCleanup();
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
            fixture.Store.RetryCleanup();
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
        Assert.True(fixture.DiskUsed > 0);
        fixture.Store.RetryCleanup();
        Assert.Equal(new byte[] { 7, 8, 9 }, File.ReadAllBytes(replacementPath));
        Assert.Equal(retained.Reservations, fixture.Coordinator.Snapshot().Reservations);
        foreach (var charge in retained.Used)
        {
            Assert.Equal(charge.Value, fixture.Coordinator.Snapshot().Used[charge.Key]);
        }
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
        internal long DiskUsed => Coordinator.Snapshot().Used[_capacityIdentity];

        internal Fixture(long diskCap = 100000, long hostCap = 100000, Action? duringAdmission = null,
            IDiskPhysicalAllocationPolicy? physicalPolicy = null)
        {
            Directory.CreateDirectory(Path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            Root = new(Path, Guid.NewGuid());
            _capacityIdentity = physicalPolicy is null ? "volume" : Root.ObserveRootFootprint().CapacityIdentity;
            var volume = new ResourceDomainId(Guid.NewGuid());
            var disk = new ResourceDomainId(Guid.NewGuid());
            var host = new ResourceDomainId(Guid.NewGuid());
            var slot = new ResourceDomainId(Guid.NewGuid());
            var topology = new MemoryResourceTopology([
                new(volume, _capacityIdentity, MemoryResourceUnit.Bytes, null),
                new(disk, "application", MemoryResourceUnit.Bytes, volume),
                new(host, "host", MemoryResourceUnit.Bytes, null),
                new(slot, "slots", MemoryResourceUnit.OperationSlots, null)
            ]);
            Coordinator = new(topology,
                [new(volume, MemoryResourceUnit.Bytes, diskCap), new(disk, MemoryResourceUnit.Bytes, diskCap),
                new(host, MemoryResourceUnit.Bytes, hostCap), new(slot, MemoryResourceUnit.OperationSlots, 64)],
                1, 128, 1024);
            DateTimeOffset now = DateTimeOffset.UtcNow;
            MemoryResourceObservation Observation(ResourceDomainId domain, MemoryResourceUnit unit, long amount)
                => new(domain, unit, MemoryObservationState.Available, amount, "fixture:finite-capacity", now);
            var sample = new DiskCapacityObservation(_capacityIdentity, Observation(volume, MemoryResourceUnit.Bytes, diskCap),
                Observation(volume, MemoryResourceUnit.Bytes, diskCap), Observation(slot, MemoryResourceUnit.OperationSlots, 64),
                DiskBackingKind.Independent, now.AddMinutes(10), 1);
            var budget = new DiskBudgetAdmission(Coordinator, disk, volume, host, slot, diskCap, 0, () =>
            {
                duringAdmission?.Invoke();
                return sample;
            });
            Store = new(Root, budget, _limits, physicalPolicy);
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
