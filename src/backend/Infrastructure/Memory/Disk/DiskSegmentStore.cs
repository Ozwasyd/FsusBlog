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
/// </summary>
public sealed class DiskSegmentStore : IDisposable
{
    private readonly object _gate = new();
    private readonly OwnedSpillRoot _root;
    private readonly DiskBudgetAdmission _budget;
    private readonly DiskSegmentLimits _limits;
    private readonly IDiskPhysicalAllocationPolicy? _physicalPolicy;
    private readonly List<Segment> _segments = [];
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
        _physicalPolicy = physicalPolicy;
    }

    /// <summary>False identifies the existing unqualified logical-byte source path.</summary>
    public bool UsesPhysicalAllocationPolicy => _physicalPolicy is not null;

    public MemoryOperationResult<DiskSpillInventoryObservation> ObserveInventory(CancellationToken cancellationToken = default)
    {
        lock (_gate)
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
            using MemoryReservation reservation = admission.Value!;
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
                foreach (string name in _root.EnumerateNames(_limits.MaxRecoveryFiles))
                {
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
    }

    public MemoryOperationResult<DiskSegmentPublication> Publish(IReadOnlyList<DiskSegmentWriteRecord> records,
        DiskSpillClassification classification, bool dataOwnerAllows, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(records);
        lock (_gate)
        {
            if (_disabled)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.TierUnavailable);
            }
            if (!dataOwnerAllows || !DiskSpillEligibility.IsEligible(classification))
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.OwnershipViolation);
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
            string stagingName = _root.NewName("stage");
            TryName(stagingName, out Guid id, out _);
            var segment = new Segment(id, stagingName, admission.Value!) { Bytes = size, Operations = 1 };
            _segments.Add(segment);
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
                using (FileStream file = _root.CreateFile(segment.Name, () => segment.FileExists = true))
                {
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
                    || (_physicalPolicy is not null && segment.Footprint.AllocatedFileBytes > bound.Value.MaximumChargeBytes))
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
                    || (_physicalPolicy is not null && publishedFootprint.AllocatedFileBytes > bound.Value.MaximumChargeBytes)
                    || !BoundStillValid(bound.Value, inventory.Value.Root, size))
                {
                    throw new DiskFileSystemException("publish changed spill file", 0, DiskFileSystemFailure.OwnershipChanged);
                }
                segment.Footprint = publishedFootprint;
                long diskCharge = _physicalPolicy is null ? size : bound.Value.MaximumChargeBytes;
                MemoryOperationResult<IMemoryAllocationCharge> committed = admission.Value!.Commit(
                    new AllocationId(id), Charges(diskCharge, _limits.IndexBytes(segment.Entries.Count)));
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
    }

    public MemoryOperationResult<DiskSegmentRecovery> Recover(bool dataOwnerAllows,
        Func<DiskSegmentEntry, bool>? approveRecoveredRecord, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (_disabled)
            {
                return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.TierUnavailable);
            }
            if (!dataOwnerAllows || approveRecoveredRecord is null)
            {
                return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.OwnershipViolation);
            }
            MemoryOperationResult<MemoryReservation> scanAdmission = _budget.TryReserve(
                new DiskBudgetRequest(0, _limits.RecoveryScanBytes, 1));
            if (!scanAdmission.Succeeded)
            {
                return MemoryOperationResult<DiskSegmentRecovery>.Reject(scanAdmission.Failure!.Value);
            }
            using MemoryReservation scanReservation = scanAdmission.Value!;
            if (_disabled)
            {
                return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.TierUnavailable);
            }
            int reused = 0;
            int discarded = 0;
            int examined = 0;
            try
            {
                foreach (string name in _root.EnumerateNames(_limits.MaxRecoveryFiles))
                {
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
                    if (_disabled)
                    {
                        probe.Value!.Dispose();
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.TierUnavailable);
                    }
                    long size;
                    DiskFileFootprint footprint;
                    using (probe.Value!)
                    using (FileStream file = _root.OpenRead(name))
                    {
                        size = file.Length;
                        if (!staging && !DiskSegmentFormat.Supported(file))
                        {
                            continue;
                        }
                    }
                    footprint = _root.ObserveFileFootprint(name);
                    if (footprint.LogicalBytes != size)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.BudgetRejected);
                    }
                    DiskFileFootprint rootFootprint = _root.ObserveRootFootprint();
                    MemoryOperationResult<DiskPhysicalAllocationBound> bound = GetBound(rootFootprint, size);
                    if (!bound.Succeeded)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(bound.Failure!.Value);
                    }
                    if (_disabled)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.TierUnavailable);
                    }
                    if (_physicalPolicy is not null && footprint.AllocatedFileBytes > bound.Value!.MaximumChargeBytes)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.BudgetRejected);
                    }
                    MemoryOperationResult<MemoryReservation> admission = Reserve(bound.Value!.MaximumChargeBytes,
                        _limits.IndexBytes(_limits.MaxRecordsPerSegment));
                    if (!admission.Succeeded)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(admission.Failure!.Value);
                    }
                    var segment = new Segment(id, name, admission.Value!)
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
                        using (FileStream file = _root.OpenRead(name))
                        {
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
                        if (_disabled || segment.Retired)
                        {
                            segment.Retired = true;
                            return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.TierUnavailable);
                        }
                        MemoryOperationResult<IMemoryAllocationCharge> committed = admission.Value!.Commit(
                            new AllocationId(id), Charges(_physicalPolicy is null ? size : bound.Value.MaximumChargeBytes,
                                _limits.IndexBytes(segment.Entries.Count)));
                        if (!committed.Succeeded)
                        {
                            segment.Retired = true;
                            Cleanup(segment);
                            return MemoryOperationResult<DiskSegmentRecovery>.Reject(committed.Failure!.Value);
                        }
                        segment.Owner = committed.Value!;
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
    }

    public MemoryOperationResult<DiskSegmentLease> Acquire(Guid segmentId, MemoryContentIdentity identity,
        CancellationToken cancellationToken = default)
    {
        lock (_gate)
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
            FileStream? file = null;
            try
            {
                if (_disabled || segment.Retired)
                {
                    admission.Value!.Dispose();
                    return MemoryOperationResult<DiskSegmentLease>.Reject(MemoryFailure.TierUnavailable);
                }
                _root.Validate();
                file = _root.OpenRead(segment.Name);
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
                segment.Leases++;
                return MemoryOperationResult<DiskSegmentLease>.Success(
                    new(file, segment.Id, segment.Entries.Count, segment.Bytes, entry, scratch, admission.Value!, () => Release(segment)));
            }
            catch (Exception exception) when (KnownFailure(exception))
            {
                file?.Dispose();
                admission.Value!.Dispose();
                if (exception is InvalidDataException or EndOfStreamException)
                {
                    segment.Retired = true;
                    Cleanup(segment);
                }
                return MemoryOperationResult<DiskSegmentLease>.Reject(Failure(exception));
            }
            catch
            {
                file?.Dispose();
                admission.Value!.Dispose();
                throw;
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
        lock (_gate)
        {
            Segment? source = _segments.Find(segment => segment.Id == segmentId && segment.Published && !segment.Retired);
            if (_disabled || source is null)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.TierUnavailable);
            }
            if (!dataOwnerAllows)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(MemoryFailure.OwnershipViolation);
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
        }
    }

    public void Dispose() => Disable();

    private MemoryOperationResult<DiskPhysicalAllocationBound> GetBound(DiskFileFootprint root, long logicalBytes)
    {
        if (_physicalPolicy is null)
        {
            // Kept for isolated source compatibility; Auto qualification must require the physical policy path.
            return MemoryOperationResult<DiskPhysicalAllocationBound>.Success(
                new(root.CapacityIdentity, root.Inode, logicalBytes, Math.Max(1, logicalBytes), _budget.PolicyRevision, DateTimeOffset.MaxValue));
        }
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
        if (result.Value!.MaximumLogicalBytes < logicalBytes || result.Value.MaximumChargeBytes <= 0)
        {
            return MemoryOperationResult<DiskPhysicalAllocationBound>.Reject(MemoryFailure.BoundsViolation);
        }
        return BoundStillValid(result.Value, root, logicalBytes) ? result
            : MemoryOperationResult<DiskPhysicalAllocationBound>.Reject(MemoryFailure.TierUnavailable);
    }

    private bool BoundStillValid(DiskPhysicalAllocationBound bound, DiskFileFootprint root, long logicalBytes)
        => bound.CapacityIdentity == root.CapacityIdentity && bound.RootInode == root.Inode && root.IsDirectory
            && bound.MaximumLogicalBytes >= logicalBytes && bound.MaximumChargeBytes > 0
            && bound.PolicyRevision != 0 && bound.PolicyRevision == _budget.PolicyRevision
            && bound.ValidUntil > DateTimeOffset.UtcNow;

    private static bool SameFile(DiskFileFootprint left, DiskFileFootprint right)
        => SameObject(left, right)
            && left.LogicalBytes == right.LogicalBytes && left.AllocatedFileBytes == right.AllocatedFileBytes
            && left.ChangeStamp == right.ChangeStamp && !left.IsDirectory && !right.IsDirectory;

    private static bool SameObject(DiskFileFootprint left, DiskFileFootprint right)
        => left.CapacityIdentity == right.CapacityIdentity && left.Inode == right.Inode
            && left.IsDirectory == right.IsDirectory;

    private MemoryOperationResult<MemoryReservation> Reserve(long diskBytes, long indexBytes)
        => _budget.TryReserve(new DiskBudgetRequest(diskBytes, checked(indexBytes + _limits.ChunkBytes + 512L), 1));

    private IReadOnlyList<MemoryResourceCharge> Charges(long diskBytes, long indexBytes)
        => new MemoryResourceCharge[]
        {
            new(_budget.DiskDomain, MemoryResourceUnit.Bytes, diskBytes),
            new(_budget.HostDomain, MemoryResourceUnit.Bytes, indexBytes)
        };

    private void Release(Segment segment)
    {
        lock (_gate)
        {
            segment.Leases--;
            Cleanup(segment);
        }
    }

    private void Cleanup(Segment segment)
    {
        if (!segment.Retired || segment.Leases != 0 || segment.Operations != 0)
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
                _root.Delete(segment.Name, segment.Footprint);
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
