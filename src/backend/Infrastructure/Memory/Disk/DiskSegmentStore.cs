using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Disk;

/// <summary>A complete verified private replica publication, with no PublicAOT authority.</summary>
public sealed record DiskSegmentPublication(Guid SegmentId, IReadOnlyList<DiskSegmentEntry> Entries);
/// <summary>Counts only the bounded recovery scan; it does not certify unsampled files.</summary>
public sealed record DiskSegmentRecovery(int Reused, int Discarded, int Examined);

/// <summary>
/// Bounded immutable replica segments. The caller owns the root and budget lifetime and supplies owner eligibility.
/// Disable prevents new operations; existing leases drain before physical deletion releases their charges.
/// Contended work returns BudgetRejected without entering an unbounded monitor wait queue.
/// </summary>
public sealed class DiskSegmentStore : IDisposable
{
    private readonly object _gate = new();
    private readonly OwnedSpillRoot _root;
    private readonly DiskBudgetAdmission _budget;
    private readonly DiskSegmentLimits _limits;
    private readonly IDiskPhysicalAllocationPolicy _physicalPolicy;
    private readonly List<Segment> _segments = [];
    private readonly TaskCompletionSource _drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _operations;
    private int _temporaryResources;
    private bool _releaseFailed;
    private bool _disabled;

    public DiskSegmentStore(OwnedSpillRoot root, DiskBudgetAdmission budget, DiskSegmentLimits limits,
        IDiskPhysicalAllocationPolicy? physicalPolicy = null)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(budget);
        ArgumentNullException.ThrowIfNull(limits);
        limits.Validate();
        _root = root;
        _budget = budget;
        _limits = limits;
        _physicalPolicy = physicalPolicy ?? new FrozenDiskPhysicalAllocationPolicy(null);
    }

    /// <summary>Every write requires an owner policy; an absent frozen bound rejects before creation.</summary>
    public bool UsesPhysicalAllocationPolicy => true;

    /// <summary>
    /// Completes after Disable and actual release of every store-owned operation, lease,
    /// handle and charge. Unresolved physical cleanup keeps it pending; temporary release
    /// failures fault it. The caller-owned root, budget and copy targets are excluded.
    /// Canceling a caller's wait never releases these resources.
    /// </summary>
    public Task Drained => _drained.Task;

    public MemoryOperationResult<DiskSpillInventoryObservation> ObserveInventory(CancellationToken cancellationToken = default)
    {
        if (!Monitor.TryEnter(_gate))
        {
            return MemoryOperationResult<DiskSpillInventoryObservation>.Reject(MemoryFailure.BudgetRejected);
        }
        _operations++;
        try
        {
            if (_disabled)
            {
                return MemoryOperationResult<DiskSpillInventoryObservation>.Reject(MemoryFailure.TierUnavailable);
            }
            MemoryOperationResult<MemoryReservation> admission = _budget.TryReserve(
                new DiskBudgetRequest(0, checked(_limits.RecoveryScanBytes + 512L), 1));
            if (!admission.Succeeded)
            {
                return MemoryOperationResult<DiskSpillInventoryObservation>.Reject(admission.Failure!.Value);
            }
            using OperationResource<MemoryReservation> reservation = Track(admission.Value!);
            if (_disabled)
            {
                return MemoryOperationResult<DiskSpillInventoryObservation>.Reject(MemoryFailure.TierUnavailable);
            }
            try
            {
                DiskFileFootprint root = _root.ObserveRootFootprint();
                long files = 0;
                long logicalBytes = 0;
                long allocatedBytes = 0;
                long untrackedFiles = 0;
                long untrackedAllocatedBytes = 0;
                int trackedFiles = 0;
                using OperationResource<IEnumerator<string>> scan = Track(_root.EnumerateNames(_limits.MaxRecoveryFiles).GetEnumerator());
                while (scan.Resource.MoveNext())
                {
                    string name = scan.Resource.Current;
                    cancellationToken.ThrowIfCancellationRequested();
                    DiskFileFootprint footprint = _root.ObserveFileFootprint(name);
                    files = checked(files + 1);
                    logicalBytes = checked(logicalBytes + footprint.LogicalBytes);
                    allocatedBytes = checked(allocatedBytes + footprint.AllocatedFileBytes);
                    Segment? tracked = _segments.Find(segment => segment.FileExists && segment.Name == name);
                    if (tracked?.Footprint is not null && SameFile(tracked.Footprint, footprint))
                    {
                        trackedFiles++;
                    }
                    else
                    {
                        untrackedFiles = checked(untrackedFiles + 1);
                        untrackedAllocatedBytes = checked(untrackedAllocatedBytes + footprint.AllocatedFileBytes);
                    }
                }
                DiskFileFootprint end = _root.ObserveRootFootprint();
                if (root.CapacityIdentity != end.CapacityIdentity || root.Inode != end.Inode
                    || root.ChangeStamp != end.ChangeStamp
                    || trackedFiles != _segments.Count(segment => segment.FileExists))
                {
                    return MemoryOperationResult<DiskSpillInventoryObservation>.Reject(MemoryFailure.BudgetRejected);
                }
                return MemoryOperationResult<DiskSpillInventoryObservation>.Success(
                    new(root, files, logicalBytes, allocatedBytes, untrackedFiles, untrackedAllocatedBytes, end.SampledAt));
            }
            catch (Exception exception) when (KnownFailure(exception))
            {
                return MemoryOperationResult<DiskSpillInventoryObservation>.Reject(Failure(exception));
            }
        }
        finally
        {
            try
            {
                EndOperation();
            }
            finally
            {
                Monitor.Exit(_gate);
            }
        }
    }

    public MemoryOperationResult<DiskSegmentPublication> Publish(IReadOnlyList<DiskSegmentWriteRecord> records,
        DiskSpillClassification classification, bool dataOwnerAllows, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(records);
        if (!dataOwnerAllows || !DiskSpillEligibility.IsEligible(classification))
        {
            return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.OwnershipViolation);
        }
        if (!Monitor.TryEnter(_gate))
        {
            return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.BudgetRejected);
        }
        _operations++;
        try
        {
            if (_disabled)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.TierUnavailable);
            }
            long size;
            try
            {
                size = DiskSegmentFormat.Size(records, _limits);
            }
            catch (Exception exception) when (exception is ArgumentException or OverflowException)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.BoundsViolation);
            }
            if (_segments.Count >= _limits.MaxSegments)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.BudgetRejected);
            }
            int admittedCount = records.Count;
            if (admittedCount <= 0 || admittedCount > _limits.MaxRecordsPerSegment)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.BoundsViolation);
            }
            MemoryOperationResult<DiskSpillInventoryObservation> inventory = ObserveInventory(cancellationToken);
            if (!inventory.Succeeded || inventory.Value!.UntrackedFiles != 0)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(inventory.Failure ?? MemoryFailure.BudgetRejected);
            }
            MemoryOperationResult<DiskPhysicalAllocationBound> bound = GetBound(inventory.Value.Root, size);
            if (!bound.Succeeded)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(bound.Failure!.Value);
            }
            if (_disabled)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.TierUnavailable);
            }
            MemoryOperationResult<MemoryReservation> admission = Reserve(bound.Value!.MaximumChargeBytes, _limits.IndexBytes(admittedCount));
            if (!admission.Succeeded)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(admission.Failure!.Value);
            }
            using OperationResource<MemoryReservation> reservation = Track(admission.Value!);
            string stagingName = _root.NewName("stage");
            TryName(stagingName, out Guid id, out _);
            var segment = new Segment(id, stagingName, admission.Value!) { Bytes = size, Operations = 1 };
            _segments.Add(segment);
            reservation.TransferOwnership();
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (_disabled || segment.Retired || !BoundStillValid(bound.Value, inventory.Value.Root, size))
                {
                    segment.Retired = true;
                    return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.TierUnavailable);
                }
                byte[] scratch = new byte[_limits.ChunkBytes];
                _root.Validate();
                DiskFileFootprint beforeCreate = _root.ObserveRootFootprint();
                if (beforeCreate.Inode != inventory.Value.Root.Inode
                    || beforeCreate.CapacityIdentity != inventory.Value.Root.CapacityIdentity
                    || beforeCreate.ChangeStamp != inventory.Value.Root.ChangeStamp)
                {
                    segment.Retired = true;
                    Cleanup(segment);
                    return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.BudgetRejected);
                }
                using (OperationResource<FileStream> handle = Track(_root.CreateFile(segment.Name, () => segment.FileExists = true)))
                {
                    FileStream file = handle.Resource;
                    segment.Footprint = _root.ObserveFileFootprint(file);
                    int count = records.Count;
                    if (count <= 0 || count > _limits.MaxRecordsPerSegment || count > admittedCount)
                    {
                        throw new InvalidDataException("Caller changed candidate record bounds.");
                    }
                    var frozen = new DiskSegmentWriteRecord[count];
                    for (int index = 0; index < count; index++)
                    {
                        frozen[index] = records[index];
                    }
                    long frozenSize = DiskSegmentFormat.Size(frozen, _limits);
                    if (frozenSize > size)
                    {
                        throw new InvalidDataException("Caller expanded candidate after admission.");
                    }
                    size = frozenSize;
                    segment.Bytes = size;
                    DiskSegmentFormat.Write(file, id, frozen, size, scratch, cancellationToken);
                    segment.Entries = DiskSegmentFormat.Verify(file, id, _limits, scratch, cancellationToken, frozen.Length);
                    DiskFileFootprint written = _root.ObserveFileFootprint(file);
                    if (!SameObject(segment.Footprint, written))
                    {
                        throw new DiskFileSystemException("write replaced spill file", 0, DiskFileSystemFailure.OwnershipChanged);
                    }
                    segment.Footprint = written;
                }
                if (!SameFile(segment.Footprint!, _root.ObserveFileFootprint(segment.Name)))
                {
                    throw new DiskFileSystemException("publish replaced spill file", 0, DiskFileSystemFailure.OwnershipChanged);
                }
                if (_disabled || segment.Retired)
                {
                    segment.Retired = true;
                    return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.TierUnavailable);
                }
                if (!BoundStillValid(bound.Value, inventory.Value.Root, size)
                    || segment.Footprint.AllocatedFileBytes > bound.Value.MaximumChargeBytes)
                {
                    segment.Retired = true;
                    Cleanup(segment);
                    return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.BudgetRejected);
                }
                cancellationToken.ThrowIfCancellationRequested();
                string finalName = Path.ChangeExtension(segment.Name, "segment");
                _root.Rename(segment.Name, finalName, segment.Footprint);
                segment.Name = finalName;
                // Rename changes ctime, so capture the final descriptor identity for inventory comparison.
                DiskFileFootprint publishedFootprint = _root.ObserveFileFootprint(finalName);
                if (!SameObject(segment.Footprint, publishedFootprint)
                    || publishedFootprint.LogicalBytes != size
                    || publishedFootprint.AllocatedFileBytes > bound.Value.MaximumChargeBytes
                    || !BoundStillValid(bound.Value, inventory.Value.Root, size))
                {
                    throw new DiskFileSystemException("publish changed spill file", 0, DiskFileSystemFailure.OwnershipChanged);
                }
                segment.Footprint = publishedFootprint;
                long diskCharge = bound.Value.MaximumChargeBytes;
                MemoryOperationResult<MemoryAllocationLayout> layout = MemoryAllocationLayout.TryCreate(size, diskCharge, 1);
                if (!layout.Succeeded)
                {
                    segment.Retired = true;
                    return MemoryOperationResult<DiskSegmentPublication>.Reject(layout.Failure!.Value);
                }
                var descriptor = new MemoryAllocationDescriptor(new AllocationId(id), _budget.DiskDomain, layout.Value!);
                MemoryOperationResult<IMemoryAllocationCharge> committed = admission.Value!.CommitPhysical(
                    descriptor, Charges(diskCharge, _limits.IndexBytes(segment.Entries.Count)));
                if (!committed.Succeeded)
                {
                    segment.Retired = true;
                    Cleanup(segment);
                    return MemoryOperationResult<DiskSegmentPublication>.Reject(committed.Failure!.Value);
                }
                segment.Owner = committed.Value!;
                segment.Published = true;
                return MemoryOperationResult<DiskSegmentPublication>.Success(
                    new(id, segment.Entries.AsReadOnly()));
            }
            catch (Exception exception) when (KnownFailure(exception))
            {
                segment.Retired = true;
                Cleanup(segment);
                return MemoryOperationResult<DiskSegmentPublication>.Reject(Failure(exception));
            }
            catch
            {
                segment.Retired = true;
                Cleanup(segment);
                throw;
            }
            finally
            {
                segment.Operations--;
                Cleanup(segment);
            }
        }
        finally
        {
            try
            {
                EndOperation();
            }
            finally
            {
                Monitor.Exit(_gate);
            }
        }
    }

    public MemoryOperationResult<DiskSegmentRecovery> Recover(bool dataOwnerAllows,
        Func<DiskSegmentEntry, bool>? approveRecoveredRecord, CancellationToken cancellationToken = default)
    {
        if (!dataOwnerAllows || approveRecoveredRecord is null)
        {
            return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.OwnershipViolation);
        }
        if (!Monitor.TryEnter(_gate))
        {
            return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.BudgetRejected);
        }
        _operations++;
        try
        {
            if (_disabled)
            {
                return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.TierUnavailable);
            }
            MemoryOperationResult<MemoryReservation> scanAdmission = _budget.TryReserve(
                new DiskBudgetRequest(0, _limits.RecoveryScanBytes, 1));
            if (!scanAdmission.Succeeded)
            {
                return MemoryOperationResult<DiskSegmentRecovery>.Reject(scanAdmission.Failure!.Value);
            }
            using OperationResource<MemoryReservation> scanReservation = Track(scanAdmission.Value!);
            if (_disabled)
            {
                return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.TierUnavailable);
            }
            int reused = 0;
            int discarded = 0;
            int examined = 0;
            try
            {
                using OperationResource<IEnumerator<string>> scan = Track(_root.EnumerateNames(_limits.MaxRecoveryFiles).GetEnumerator());
                while (scan.Resource.MoveNext())
                {
                    string name = scan.Resource.Current;
                    cancellationToken.ThrowIfCancellationRequested();
                    // Bounded scan includes unrelated names; unsupported version namespaces are never interpreted/deleted.
                    if (++examined > _limits.MaxRecoveryFiles)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.BudgetRejected);
                    }
                    if (!TryName(name, out Guid id, out bool staging)
                        || _segments.Any(segment => segment.Id == id))
                    {
                        continue;
                    }
                    if (_segments.Count >= _limits.MaxSegments)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.BudgetRejected);
                    }
                    // A bounded probe must itself be admitted before opening the file.
                    MemoryOperationResult<MemoryReservation> probe = _budget.TryReserve(
                        new DiskBudgetRequest(0, _limits.ChunkBytes + 512L, 1));
                    if (!probe.Succeeded)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(probe.Failure!.Value);
                    }
                    using OperationResource<MemoryReservation> probeReservation = Track(probe.Value!);
                    if (_disabled)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.TierUnavailable);
                    }
                    long size;
                    DiskFileFootprint footprint;
                    using (OperationResource<FileStream> handle = Track(_root.OpenRead(name)))
                    {
                        FileStream file = handle.Resource;
                        size = file.Length;
                        footprint = _root.ObserveFileFootprint(file);
                        if (!staging && !DiskSegmentFormat.Supported(file))
                        {
                            continue;
                        }
                    }
                    if (footprint.LogicalBytes != size || !SameFile(footprint, _root.ObserveFileFootprint(name)))
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.BudgetRejected);
                    }
                    DiskFileFootprint rootFootprint = _root.ObserveRootFootprint();
                    // Empty debris still owns filesystem metadata; request a positive frozen bound
                    // so its deletion can retain a conservative file and inode charge.
                    MemoryOperationResult<DiskPhysicalAllocationBound> bound = GetBound(rootFootprint, Math.Max(1, size));
                    if (!bound.Succeeded)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(bound.Failure!.Value);
                    }
                    if (_disabled)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.TierUnavailable);
                    }
                    if (footprint.AllocatedFileBytes > bound.Value!.MaximumChargeBytes)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.BudgetRejected);
                    }
                    // Registration precedes untrusted parsing. Retain the maximum index
                    // allowance for this owner; verification keeps its separate scratch/slot.
                    long indexBytes = _limits.IndexBytes(_limits.MaxRecordsPerSegment);
                    MemoryOperationResult<MemoryReservation> admission = _budget.TryReserveIndex(indexBytes);
                    if (!admission.Succeeded)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(admission.Failure!.Value);
                    }
                    using OperationResource<MemoryReservation> indexReservation = Track(admission.Value!);
                    if (_disabled)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.TierUnavailable);
                    }
                    if (_segments.Any(segment => segment.Id == id))
                    {
                        // Observation/policy callbacks can recover the same object reentrantly.
                        // Do not submit a duplicate allocation to the shared coordinator.
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.OwnershipViolation);
                    }
                    MemoryOperationResult<IMemoryAllocationCharge> adopted = AdoptExisting(id, name, footprint,
                        bound.Value!, indexReservation.Resource, indexBytes);
                    if (!adopted.Succeeded)
                    {
                        // No ownership was registered: preserve the existing file and its
                        // untracked inventory entry instead of treating rejection as deletion.
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(adopted.Failure!.Value);
                    }
                    var segment = new Segment(id, name, adopted.Value!)
                    {
                        FileExists = true,
                        Bytes = size,
                        Footprint = footprint,
                        Operations = 1
                    };
                    _segments.Add(segment);
                    try
                    {
                        if (staging || size > _limits.MaxSegmentBytes || size < DiskSegmentFormat.HeaderBytes)
                        {
                            segment.Retired = true;
                            Cleanup(segment);
                            discarded++;
                            continue;
                        }
                        using (OperationResource<FileStream> handle = Track(_root.OpenRead(name)))
                        {
                            FileStream file = handle.Resource;
                            if (!SameFile(footprint, _root.ObserveFileFootprint(file)))
                            {
                                throw new DiskFileSystemException("recover replaced spill file", 0, DiskFileSystemFailure.OwnershipChanged);
                            }
                            segment.Entries = DiskSegmentFormat.Verify(file, id, _limits,
                                new byte[_limits.ChunkBytes], cancellationToken, _limits.MaxRecordsPerSegment);
                        }
                        if (segment.Bytes != segment.Entries[^1].PayloadOffset + segment.Entries[^1].PayloadBytes)
                        {
                            throw new InvalidDataException("Recovered segment expanded after admission.");
                        }
                        DiskFileFootprint verifiedFootprint = _root.ObserveFileFootprint(name);
                        if (!SameFile(footprint, verifiedFootprint) || !BoundStillValid(bound.Value, rootFootprint, size))
                        {
                            throw new InvalidDataException("Recovered segment identity or allocation changed during verification.");
                        }
                        if (segment.Entries.Any(entry => !approveRecoveredRecord(entry)))
                        {
                            segment.Retired = true;
                            Cleanup(segment);
                            return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.OwnershipViolation);
                        }
                        // Content-owner callbacks may replace a file or revise the policy.
                        // The existing charge belongs to the adopted object, never its replacement.
                        if (!SameFile(footprint, _root.ObserveFileFootprint(name)))
                        {
                            throw new DiskFileSystemException("recover replaced spill file", 0, DiskFileSystemFailure.OwnershipChanged);
                        }
                        if (_disabled || segment.Retired || !BoundStillValid(bound.Value, _root.ObserveRootFootprint(), size))
                        {
                            segment.Retired = true;
                            return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.TierUnavailable);
                        }
                        segment.Published = true;
                        reused++;
                    }
                    catch (Exception exception) when (KnownFailure(exception))
                    {
                        segment.Retired = true;
                        Cleanup(segment);
                        if (exception is InvalidDataException or EndOfStreamException)
                        {
                            discarded++;
                            continue;
                        }
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(Failure(exception));
                    }
                    catch
                    {
                        segment.Retired = true;
                        Cleanup(segment);
                        throw;
                    }
                    finally
                    {
                        segment.Operations--;
                        Cleanup(segment);
                    }
                }
                return MemoryOperationResult<DiskSegmentRecovery>.Success(new(reused, discarded, examined));
            }
            catch (Exception exception) when (KnownFailure(exception))
            {
                return MemoryOperationResult<DiskSegmentRecovery>.Reject(Failure(exception));
            }
        }
        finally
        {
            try
            {
                EndOperation();
            }
            finally
            {
                Monitor.Exit(_gate);
            }
        }
    }

    public MemoryOperationResult<DiskSegmentLease> Acquire(Guid segmentId, MemoryContentIdentity identity,
        CancellationToken cancellationToken = default)
    {
        if (!Monitor.TryEnter(_gate))
        {
            return MemoryOperationResult<DiskSegmentLease>.Reject(MemoryFailure.BudgetRejected);
        }
        _operations++;
        try
        {
            Segment? segment = _segments.Find(candidate => candidate.Id == segmentId
                && candidate.Published && !candidate.Retired);
            if (_disabled || segment is null)
            {
                return MemoryOperationResult<DiskSegmentLease>.Reject(MemoryFailure.TierUnavailable);
            }
            DiskSegmentEntry? entry = segment.Entries.Find(candidate => candidate.Identity == identity);
            if (entry is null)
            {
                return MemoryOperationResult<DiskSegmentLease>.Reject(MemoryFailure.StaleLocation);
            }
            MemoryOperationResult<MemoryReservation> admission = _budget.TryReserve(
                new DiskBudgetRequest(0, _limits.ChunkBytes + 512L, 1));
            if (!admission.Succeeded)
            {
                return MemoryOperationResult<DiskSegmentLease>.Reject(admission.Failure!.Value);
            }
            OperationResource<MemoryReservation> reservation = Track(admission.Value!);
            OperationResource<FileStream>? handle = null;
            FileStream? file = null;
            try
            {
                if (_disabled || segment.Retired)
                {
                    reservation.Dispose();
                    return MemoryOperationResult<DiskSegmentLease>.Reject(MemoryFailure.TierUnavailable);
                }
                _root.Validate();
                handle = Track(_root.OpenRead(segment.Name));
                file = handle.Resource;
                if (segment.Footprint is null || !SameObject(segment.Footprint, _root.ObserveFileFootprint(file)))
                {
                    throw new DiskFileSystemException("read replaced spill file", 0, DiskFileSystemFailure.OwnershipChanged);
                }
                byte[] scratch = new byte[_limits.ChunkBytes];
                DiskSegmentLease.Verify(file, segment.Id, segment.Entries.Count, segment.Bytes, entry, scratch, cancellationToken);
                if (!SameFile(segment.Footprint, _root.ObserveFileFootprint(file)))
                {
                    throw new InvalidDataException("Segment data or allocation changed since publication.");
                }
                MemoryOperationResult<DiskSegmentLease> result = MemoryOperationResult<DiskSegmentLease>.Success(
                    new(file, segment.Id, segment.Entries.Count, segment.Bytes, entry, scratch, admission.Value!, () => Release(segment)));
                segment.Leases++;
                handle.TransferOwnership();
                reservation.TransferOwnership();
                return result;
            }
            catch (Exception exception) when (KnownFailure(exception))
            {
                try
                {
                    handle?.Dispose();
                }
                finally
                {
                    reservation.Dispose();
                }
                if (exception is InvalidDataException or EndOfStreamException)
                {
                    segment.Retired = true;
                    Cleanup(segment);
                }
                return MemoryOperationResult<DiskSegmentLease>.Reject(Failure(exception));
            }
            catch
            {
                try
                {
                    handle?.Dispose();
                }
                finally
                {
                    reservation.Dispose();
                }
                throw;
            }
        }
        finally
        {
            try
            {
                EndOperation();
            }
            finally
            {
                Monitor.Exit(_gate);
            }
        }
    }

    /// <summary>Copies a complete segment under simultaneous source, destination, scratch and index admission.</summary>
    public MemoryOperationResult<DiskSegmentPublication> Compact(Guid segmentId, bool dataOwnerAllows,
        CancellationToken cancellationToken = default)
        => Compact(segmentId, _ => true, dataOwnerAllows, cancellationToken);

    /// <summary>Rewrites only retained records; retired records remain available to existing source leases until drain.</summary>
    public MemoryOperationResult<DiskSegmentPublication> Compact(Guid segmentId,
        Func<DiskSegmentEntry, bool> retainRecord, bool dataOwnerAllows, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(retainRecord);
        if (!dataOwnerAllows)
        {
            return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.OwnershipViolation);
        }
        if (!Monitor.TryEnter(_gate))
        {
            return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.BudgetRejected);
        }
        _operations++;
        try
        {
            Segment? source = _segments.Find(segment => segment.Id == segmentId && segment.Published && !segment.Retired);
            if (_disabled || source is null)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.TierUnavailable);
            }
            // Each acquired source lease reserves its own bounded scratch and slot. No destination is made on rejection.
            var leases = new List<DiskSegmentLease>(source.Entries.Count);
            try
            {
                foreach (DiskSegmentEntry entry in source.Entries)
                {
                    if (!retainRecord(entry))
                    {
                        continue;
                    }
                    MemoryOperationResult<DiskSegmentLease> lease = Acquire(segmentId, entry.Identity, cancellationToken);
                    if (!lease.Succeeded)
                    {
                        return MemoryOperationResult<DiskSegmentPublication>.Reject(lease.Failure!.Value);
                    }
                    leases.Add(lease.Value!);
                }
                if (leases.Count == 0)
                {
                    return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.BoundsViolation);
                }
                DiskSegmentWriteRecord[] records = leases.Select(lease =>
                    new DiskSegmentWriteRecord(lease.Entry.Identity, lease.PayloadStream, lease.Entry.PayloadBytes, lease.Entry.Sha256)).ToArray();
                MemoryOperationResult<DiskSegmentPublication> result = Publish(records,
                    DiskSpillClassification.PublicImmutableReconstructible, dataOwnerAllows, cancellationToken);
                if (result.Succeeded)
                {
                    source.Retired = true;
                    Cleanup(source);
                }
                return result;
            }
            finally
            {
                foreach (DiskSegmentLease lease in leases)
                {
                    lease.Dispose();
                }
            }
        }
        finally
        {
            try
            {
                EndOperation();
            }
            finally
            {
                Monitor.Exit(_gate);
            }
        }
    }

    public void Retire(Guid segmentId)
    {
        lock (_gate)
        {
            Segment? segment = _segments.Find(candidate => candidate.Id == segmentId);
            if (segment is not null)
            {
                segment.Retired = true;
                Cleanup(segment);
            }
            CompleteIfDrained();
        }
    }

    public void RetryCleanup()
    {
        lock (_gate)
        {
            for (int index = _segments.Count - 1; index >= 0; index--)
            {
                Cleanup(_segments[index]);
            }
            CompleteIfDrained();
        }
    }

    public void Disable()
    {
        lock (_gate)
        {
            _disabled = true;
            for (int index = _segments.Count - 1; index >= 0; index--)
            {
                _segments[index].Retired = true;
                Cleanup(_segments[index]);
            }
            CompleteIfDrained();
        }
    }

    public void Dispose() => Disable();

    private MemoryOperationResult<DiskPhysicalAllocationBound> GetBound(DiskFileFootprint root, long logicalBytes)
    {
        MemoryOperationResult<DiskPhysicalAllocationBound> result;
        try
        {
            result = _physicalPolicy.TryGetBound(root, logicalBytes);
        }
        catch (Exception exception) when (KnownFailure(exception))
        {
            return MemoryOperationResult<DiskPhysicalAllocationBound>.Reject(Failure(exception));
        }
        if (!result.Succeeded)
        {
            return result;
        }
        if (result.Value!.MaximumLogicalBytes < logicalBytes
            || result.Value.MaximumChargeBytes < result.Value.MaximumLogicalBytes)
        {
            return MemoryOperationResult<DiskPhysicalAllocationBound>.Reject(MemoryFailure.BoundsViolation);
        }
        return BoundStillValid(result.Value, root, logicalBytes) ? result
            : MemoryOperationResult<DiskPhysicalAllocationBound>.Reject(MemoryFailure.TierUnavailable);
    }

    private bool BoundStillValid(DiskPhysicalAllocationBound bound, DiskFileFootprint root, long logicalBytes)
        => bound.CapacityIdentity == root.CapacityIdentity && bound.RootInode == root.Inode && root.IsDirectory
            && bound.MaximumLogicalBytes >= logicalBytes && bound.MaximumChargeBytes > 0
            && bound.MaximumChargeBytes >= bound.MaximumLogicalBytes
            && bound.PolicyRevision != 0 && bound.PolicyRevision == _budget.PolicyRevision
            && bound.ValidUntil != DateTimeOffset.MaxValue && bound.ValidUntil > DateTimeOffset.UtcNow;

    private static bool SameFile(DiskFileFootprint left, DiskFileFootprint right)
        => SameObject(left, right)
            && left.LogicalBytes == right.LogicalBytes && left.AllocatedFileBytes == right.AllocatedFileBytes
            && left.ChangeStamp == right.ChangeStamp && !left.IsDirectory && !right.IsDirectory;

    private static bool SameObject(DiskFileFootprint left, DiskFileFootprint right)
        => left.CapacityIdentity == right.CapacityIdentity && left.Inode == right.Inode
            && left.IsDirectory == right.IsDirectory;

    private MemoryOperationResult<MemoryReservation> Reserve(long diskBytes, long indexBytes)
        => _budget.TryReserve(new DiskBudgetRequest(diskBytes, checked(indexBytes + _limits.ChunkBytes + 512L), 1, 1));

    private MemoryOperationResult<IMemoryAllocationCharge> AdoptExisting(Guid id, string name,
        DiskFileFootprint footprint, DiskPhysicalAllocationBound bound, MemoryReservation indexReservation, long indexBytes)
    {
        MemoryOperationResult<MemoryAllocationLayout> layout = MemoryAllocationLayout.TryCreate(
            footprint.LogicalBytes, bound.MaximumChargeBytes, 1);
        if (!layout.Succeeded)
        {
            return MemoryOperationResult<IMemoryAllocationCharge>.Reject(layout.Failure!.Value);
        }
        // Keep an actual descriptor open through registration. Name, descriptor and
        // owner-frozen scope must agree before the common ledger observes ownership.
        using OperationResource<FileStream> handle = Track(_root.OpenRead(name));
        FileStream backing = handle.Resource;
        if (!SameFile(footprint, _root.ObserveFileFootprint(backing))
            || !SameFile(footprint, _root.ObserveFileFootprint(name)))
        {
            return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.OwnershipViolation);
        }
        if (!BoundStillValid(bound, _root.ObserveRootFootprint(), footprint.LogicalBytes))
        {
            return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.TierUnavailable);
        }
        var descriptor = new MemoryAllocationDescriptor(new AllocationId(id), _budget.DiskDomain, layout.Value!);
        return indexReservation.CommitObservedExisting(descriptor,
            [new(_budget.DiskDomain, MemoryResourceUnit.Bytes, bound.MaximumChargeBytes),
                new(_budget.InodeDomain, MemoryResourceUnit.Inodes, 1)],
            [new(_budget.HostDomain, MemoryResourceUnit.Bytes, indexBytes)], bound.PolicyRevision);
    }

    private IReadOnlyList<MemoryResourceCharge> Charges(long diskBytes, long indexBytes)
        => new MemoryResourceCharge[]
        {
            new(_budget.DiskDomain, MemoryResourceUnit.Bytes, diskBytes),
            new(_budget.HostDomain, MemoryResourceUnit.Bytes, indexBytes),
            new(_budget.InodeDomain, MemoryResourceUnit.Inodes, 1)
        };

    private void Release(Segment segment)
    {
        lock (_gate)
        {
            segment.Leases--;
            Cleanup(segment);
            CompleteIfDrained();
        }
    }

    private OperationResource<T> Track<T>(T resource) where T : IDisposable
    {
        var lifetime = new OperationResource<T>(this, resource);
        _temporaryResources++;
        return lifetime;
    }

    private void ReleaseTemporaryResource()
    {
        lock (_gate)
        {
            _temporaryResources--;
            CompleteIfDrained();
        }
    }

    private void EndOperation()
    {
        // This outer finally runs after all using scopes, including recovery's scan,
        // probe and index reservations. Reentrant Disable cannot finish them early.
        _operations--;
        CompleteIfDrained();
    }

    private void FailTemporaryRelease(Exception exception)
    {
        lock (_gate)
        {
            // An uncertain handle release may still keep unlinked backing alive.
            // Preserve its charges and stop growth rather than infer physical drain.
            _releaseFailed = true;
            _disabled = true;
            foreach (Segment segment in _segments)
            {
                segment.Retired = true;
            }
            _drained.TrySetException(exception);
        }
    }

    private void CompleteIfDrained()
    {
        if (_disabled && _operations == 0 && _temporaryResources == 0 && _segments.Count == 0)
        {
            _drained.TrySetResult();
        }
    }

    private sealed class OperationResource<T>(DiskSegmentStore owner, T resource) : IDisposable where T : IDisposable
    {
        private int _released;
        internal T Resource { get; } = resource;

        internal void TransferOwnership()
        {
            // The bounded segment/lease roster now owns the same real resource.
            // Transfer only changes lifetime tracking, never ledger accounting.
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                owner.ReleaseTemporaryResource();
            }
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) != 0)
            {
                return;
            }
            try
            {
                Resource.Dispose();
            }
            catch (Exception exception)
            {
                // A failed release is not a terminal success even if a surrounding
                // operation translates that exception to a typed failure result.
                owner.FailTemporaryRelease(exception);
                throw;
            }
            owner.ReleaseTemporaryResource();
        }
    }

    private void Cleanup(Segment segment)
    {
        if (_releaseFailed || !segment.Retired || segment.Leases != 0 || segment.Operations != 0)
        {
            return;
        }
        try
        {
            if (segment.FileExists)
            {
                if (segment.Footprint is null)
                {
                    // Creation succeeded but no leaf identity could be proven. Keep the charge;
                    // deleting a replacement by its opaque name alone is not a release proof.
                    return;
                }
                _root.Validate();
                if (!_root.Delete(segment.Name, segment.Footprint))
                {
                    // Missing namespace entries do not prove physical release.
                    // Retain this bounded owner until its original inode can be deleted.
                    return;
                }
                segment.FileExists = false;
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Keep the full owner charge and bounded roster entry; an explicit retry can reclaim it later.
            return;
        }
        segment.Owner.Dispose();
        _segments.Remove(segment);
    }

    private static bool TryName(string name, out Guid id, out bool staging)
    {
        id = Guid.Empty;
        staging = name.EndsWith(".stage", StringComparison.Ordinal);
        string suffix = staging ? ".stage" : ".segment";
        return name.StartsWith("mem-", StringComparison.Ordinal)
            && name.EndsWith(suffix, StringComparison.Ordinal)
            && name.Length == 37 + 32 + suffix.Length
            && Guid.TryParseExact(name.AsSpan(37, 32), "N", out id) && id != Guid.Empty;
    }

    internal static bool KnownFailure(Exception exception)
        => exception is IOException or InvalidDataException or UnauthorizedAccessException or OperationCanceledException
            or ArgumentException or OverflowException or IndexOutOfRangeException;

    internal static MemoryFailure Failure(Exception exception) => exception switch
    {
        OperationCanceledException => MemoryFailure.Cancelled,
        InvalidDataException or EndOfStreamException => MemoryFailure.Corruption,
        DiskFileSystemException diskFailure => diskFailure.OperationFailure,
        UnauthorizedAccessException => MemoryFailure.OwnershipViolation,
        ArgumentException or OverflowException or IndexOutOfRangeException => MemoryFailure.BoundsViolation,
        _ => MemoryFailure.TierUnavailable
    };

    private sealed class Segment(Guid id, string name, IDisposable owner)
    {
        internal Guid Id { get; } = id;
        internal string Name { get; set; } = name;
        internal IDisposable Owner { get; set; } = owner;
        internal List<DiskSegmentEntry> Entries { get; set; } = [];
        internal DiskFileFootprint? Footprint
        {
            get; set;
        }
        internal int Operations
        {
            get; set;
        }
        internal long Bytes
        {
            get; set;
        }
        internal bool Published
        {
            get; set;
        }
        internal bool Retired
        {
            get; set;
        }
        internal bool FileExists
        {
            get; set;
        }
        internal int Leases
        {
            get; set;
        }
    }
}
