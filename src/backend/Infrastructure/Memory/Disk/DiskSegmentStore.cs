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
    private readonly List<Segment> _segments = [];
    private bool _disabled;

    public DiskSegmentStore(OwnedSpillRoot root, DiskBudgetAdmission budget, DiskSegmentLimits limits)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(budget);
        ArgumentNullException.ThrowIfNull(limits);
        limits.Validate();
        _root = root;
        _budget = budget;
        _limits = limits;
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
            MemoryOperationResult<MemoryReservation> admission = Reserve(size, _limits.IndexBytes(admittedCount));
            if (!admission.Succeeded)
            {
                return MemoryOperationResult<DiskSegmentPublication>.Reject(admission.Failure!.Value);
            }
            string stagingName = _root.NewName("stage");
            TryName(stagingName, out Guid id, out _);
            var segment = new Segment(id, stagingName, admission.Value!) { Bytes = size };
            _segments.Add(segment);
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                byte[] scratch = new byte[_limits.ChunkBytes];
                _root.Validate();
                using (FileStream file = _root.CreateFile(segment.Name, () => segment.FileExists = true))
                {
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
                }
                cancellationToken.ThrowIfCancellationRequested();
                string finalName = Path.ChangeExtension(segment.Name, "segment");
                _root.Rename(segment.Name, finalName);
                segment.Name = finalName;
                MemoryOperationResult<IMemoryAllocationCharge> committed = admission.Value!.Commit(
                    new AllocationId(id), Charges(size, _limits.IndexBytes(segment.Entries.Count)));
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
                    long size;
                    using (probe.Value!)
                    using (FileStream file = _root.OpenRead(name))
                    {
                        size = file.Length;
                        if (!staging && !DiskSegmentFormat.Supported(file))
                        {
                            continue;
                        }
                    }
                    MemoryOperationResult<MemoryReservation> admission = Reserve(size,
                        _limits.IndexBytes(_limits.MaxRecordsPerSegment));
                    if (!admission.Succeeded)
                    {
                        return MemoryOperationResult<DiskSegmentRecovery>.Reject(admission.Failure!.Value);
                    }
                    var segment = new Segment(id, name, admission.Value!) { FileExists = true, Bytes = size };
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
                            segment.Entries = DiskSegmentFormat.Verify(file, id, _limits,
                                new byte[_limits.ChunkBytes], cancellationToken, _limits.MaxRecordsPerSegment);
                        }
                        if (segment.Bytes != segment.Entries[^1].PayloadOffset + segment.Entries[^1].PayloadBytes)
                        {
                            throw new InvalidDataException("Recovered segment expanded after admission.");
                        }
                        if (segment.Entries.Any(entry => !approveRecoveredRecord(entry)))
                        {
                            segment.Retired = true;
                            Cleanup(segment);
                            return MemoryOperationResult<DiskSegmentRecovery>.Reject(MemoryFailure.OwnershipViolation);
                        }
                        MemoryOperationResult<IMemoryAllocationCharge> committed = admission.Value!.Commit(
                            new AllocationId(id), Charges(size, _limits.IndexBytes(segment.Entries.Count)));
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
                _root.Validate();
                file = _root.OpenRead(segment.Name);
                byte[] scratch = new byte[_limits.ChunkBytes];
                DiskSegmentLease.Verify(file, segment.Id, segment.Entries.Count, segment.Bytes, entry, scratch, cancellationToken);
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
        if (!segment.Retired || segment.Leases != 0)
        {
            return;
        }
        try
        {
            if (segment.FileExists)
            {
                _root.Validate();
                _root.Delete(segment.Name);
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
