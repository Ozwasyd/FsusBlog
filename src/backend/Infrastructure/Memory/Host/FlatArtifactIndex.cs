using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Host;

/// <summary>Process-local public immutable metadata. Payload handles remain owned by their backing.</summary>
internal readonly record struct FlatArtifactDescriptor(long Id, MemoryContentIdentity Content,
    MemoryLocationToken PayloadLocation, long PayloadLength)
{
    internal bool IsEligible => PayloadLength > 0;
    internal bool IsValid => Id > 0 && PayloadLength >= 0
        && Content.Blob.Value != Guid.Empty && Content.Generation.Value > 0
        && Content.Representation.Value != Guid.Empty && PayloadLocation.Allocation.Value != Guid.Empty
        && PayloadLocation.Block.Value != Guid.Empty && PayloadLocation.Revision.Value > 0
        && PayloadLocation.Epoch.Value > 0;
}

internal sealed record FlatArtifactIndexEntry(string RouteKey, FlatArtifactDescriptor Descriptor);
internal sealed record FlatArtifactIndexMutation(long Id, FlatArtifactIndexEntry? Replacement);

/// <summary>
/// Owns one charged, sealed native index and a simple counted-reader reclamation protocol.
/// No pointer or writable view escapes. Descriptors are metadata, not payload leases or serving authority.
/// </summary>
internal sealed unsafe class FlatArtifactIndex : IDisposable
{
    private readonly object _gate = new();
    private readonly FlatArtifactIndexLimits _limits;
    private readonly FlatArtifactIndexLayout _layout;
    private readonly IMemoryAllocationCharge _charge;
    private readonly TaskCompletionSource _drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private byte* _storage;
    private int _readers;
    private bool _closed;
    private bool _publicationClaimed;

    private FlatArtifactIndex(byte* storage, FlatArtifactIndexLayout layout,
        FlatArtifactIndexLimits limits, IMemoryAllocationCharge charge, MemoryContentIdentity content,
        MemoryLocationToken location)
    {
        _storage = storage;
        _layout = layout;
        _limits = limits;
        _charge = charge;
        Content = content;
        Location = location;
    }

    internal MemoryContentIdentity Content
    {
        get;
    }
    internal MemoryLocationToken Location
    {
        get;
    }
    internal MemoryAllocationDescriptor Descriptor => _charge.Descriptor!;
    internal Task Drained => _drained.Task;
    internal int Count => _layout.Count;
    internal int Readers
    {
        get
        {
            lock (_gate)
            {
                return _readers;
            }
        }
    }

    internal static MemoryOperationResult<FlatArtifactIndex> TryBuild(MemoryReservationCoordinator ledger,
        ResourceDomainId domain, MemoryContentIdentity content, IReadOnlyList<FlatArtifactIndexEntry> entries,
        FlatArtifactIndexLimits limits)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(entries);
        ArgumentNullException.ThrowIfNull(limits);
        content.Validate();
        int count = entries.Count;
        if (!limits.IsValid || count < 0 || count > limits.MaximumEntries)
        {
            return MemoryOperationResult<FlatArtifactIndex>.Reject(MemoryFailure.BoundsViolation);
        }
        // ADMISSION: Reserve a bounded worst-case destination plus build workspace
        // before taking the immutable entry snapshot. Managed headers/normalization
        // temporaries are estimated overhead, not claims of exact GC control.
        long maximumKeyBytes = (long)count * limits.MaximumKeyBytes;
        if (maximumKeyBytes > int.MaxValue)
        {
            return MemoryOperationResult<FlatArtifactIndex>.Reject(MemoryFailure.BoundsViolation);
        }
        MemoryOperationResult<FlatArtifactIndexLayout> worst = FlatArtifactIndexLayout.TryPlan(
            count, (int)maximumKeyBytes, limits);
        if (!worst.Succeeded)
        {
            return MemoryOperationResult<FlatArtifactIndex>.Reject(worst.Failure!.Value);
        }
        long scratchEstimate = checked(64L + count * 16L + maximumKeyBytes * 8L);
        MemoryOperationResult<MemoryReservation> admission = ledger.TryReserve([
            new(domain, MemoryResourceUnit.Bytes, checked(worst.Value!.Allocation.CapacityBytes + scratchEstimate))
        ]);
        if (!admission.Succeeded)
        {
            return MemoryOperationResult<FlatArtifactIndex>.Reject(admission.Failure!.Value);
        }
        using MemoryReservation reservation = admission.Value!;
        var snapshot = new FlatArtifactIndexEntry[count];
        var canonical = new string[count];
        int keyBytes = 0;
        for (int index = 0; index < count; index++)
        {
            FlatArtifactIndexEntry? entry = entries[index];
            if (entry is null || !entry.Descriptor.IsValid
                || !FlatArtifactIndexLayout.TryCanonicalize(entry.RouteKey, limits.MaximumKeyBytes, out string route))
            {
                return MemoryOperationResult<FlatArtifactIndex>.Reject(MemoryFailure.BoundsViolation);
            }
            snapshot[index] = entry;
            canonical[index] = route;
            keyBytes = checked(keyBytes + Encoding.UTF8.GetByteCount(route));
        }
        FlatArtifactIndexLayout layout = FlatArtifactIndexLayout.TryPlan(count, keyBytes, limits).Value!;
        byte* storage = (byte*)NativeMemory.AlignedAlloc((nuint)layout.Allocation.CapacityBytes,
            FlatArtifactIndexLayout.Alignment);
        if (storage == null)
        {
            throw new OutOfMemoryException();
        }
        IMemoryAllocationCharge? charge = null;
        bool transferred = false;
        try
        {
            var bytes = new Span<byte>(storage, (int)layout.Allocation.CapacityBytes);
            bytes.Clear();
            int offset = 0;
            for (int index = 0; index < count; index++)
            {
                FlatArtifactDescriptor descriptor = snapshot[index].Descriptor;
                MemoryMarshal.Write(bytes.Slice(index * FlatArtifactIndexLayout.DescriptorBytes,
                    FlatArtifactIndexLayout.DescriptorBytes), in descriptor);
                int length = Encoding.UTF8.GetBytes(canonical[index], bytes.Slice(layout.KeyOffset + offset));
                uint hash = FlatArtifactIndexLayout.RouteHash(bytes.Slice(layout.KeyOffset + offset, length));
                if (!InsertId(bytes, layout, descriptor.Id, index + 1)
                    || !InsertRoute(bytes, layout, hash, index + 1, offset, length))
                {
                    return MemoryOperationResult<FlatArtifactIndex>.Reject(MemoryFailure.BoundsViolation);
                }
                offset += length;
            }
            var location = new MemoryLocationToken(new(Guid.NewGuid()), new(Guid.NewGuid()), new(1), new(1));
            var physical = new MemoryAllocationDescriptor(location.Allocation, domain, layout.Allocation);
            MemoryOperationResult<IMemoryAllocationCharge> conversion = reservation.CommitPhysical(physical, [
                new(domain, MemoryResourceUnit.Bytes, layout.Allocation.CapacityBytes)
            ]);
            if (!conversion.Succeeded)
            {
                return MemoryOperationResult<FlatArtifactIndex>.Reject(conversion.Failure!.Value);
            }
            charge = conversion.Value!;
            var owner = new FlatArtifactIndex(storage, layout, limits, charge, content, location);
            MemoryOperationResult<FlatArtifactIndex> result = MemoryOperationResult<FlatArtifactIndex>.Success(owner);
            // OWNERSHIP: Construction is complete before transfer/publication. No
            // write API exists after this point; this does not claim OS page protection.
            transferred = true;
            return result;
        }
        finally
        {
            if (!transferred)
            {
                NativeMemory.AlignedFree(storage);
                charge?.Dispose();
            }
        }
    }

    internal static MemoryOperationResult<FlatArtifactIndex> TryUpdate(MemoryReservationCoordinator ledger,
        ResourceDomainId domain, MemoryContentIdentity content, FlatArtifactIndexLease source,
        IReadOnlyList<FlatArtifactIndexMutation> mutations, FlatArtifactIndexLimits limits)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(mutations);
        ArgumentNullException.ThrowIfNull(limits);
        int mutationCount = mutations.Count;
        if (!limits.IsValid || source.Count > limits.MaximumEntries
            || mutationCount < 0 || mutationCount > limits.MaximumEntries)
        {
            return MemoryOperationResult<FlatArtifactIndex>.Reject(MemoryFailure.BoundsViolation);
        }
        // ACCOUNTING: The source lease retains its original physical charge while
        // the update workspace and complete new build are admitted simultaneously.
        // Copy-on-write avoids an overlay pinning a small slice of a large old block.
        long scratchEstimate = checked(64L + ((long)source.Count + mutationCount)
            * (256L + limits.MaximumKeyBytes * 8L));
        MemoryOperationResult<MemoryReservation> admission = ledger.TryReserve([
            new(domain, MemoryResourceUnit.Bytes, scratchEstimate)
        ]);
        if (!admission.Succeeded)
        {
            return MemoryOperationResult<FlatArtifactIndex>.Reject(admission.Failure!.Value);
        }
        using MemoryReservation scratch = admission.Value!;
        Dictionary<long, FlatArtifactIndexEntry> next = source.CopyEntries()
            .ToDictionary(entry => entry.Descriptor.Id);
        for (int index = 0; index < mutationCount; index++)
        {
            FlatArtifactIndexMutation? mutation = mutations[index];
            if (mutation is null || mutation.Id <= 0
                || (mutation.Replacement is not null && mutation.Replacement.Descriptor.Id != mutation.Id))
            {
                return MemoryOperationResult<FlatArtifactIndex>.Reject(MemoryFailure.BoundsViolation);
            }
            if (mutation.Replacement is null)
            {
                next.Remove(mutation.Id);
            }
            else
            {
                if (!next.ContainsKey(mutation.Id) && next.Count >= limits.MaximumEntries)
                {
                    return MemoryOperationResult<FlatArtifactIndex>.Reject(MemoryFailure.BoundsViolation);
                }
                next[mutation.Id] = mutation.Replacement;
            }
        }
        return TryBuild(ledger, domain, content, next.Values.ToArray(), limits);
    }

    internal MemoryOperationResult<FlatArtifactIndexLease> TryAcquire(MemoryLocationToken expected)
        => FlatArtifactIndexLease.TryAcquireOwned(this, expected);

    internal bool TryClaimPublication()
    {
        lock (_gate)
        {
            if (_closed || _publicationClaimed)
            {
                return false;
            }
            _publicationClaimed = true;
            return true;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _closed = true;
            ReleaseIfDrained();
        }
    }

    private void ReleaseReader()
    {
        lock (_gate)
        {
            if (_readers <= 0)
            {
                throw new InvalidOperationException("Index reader underflow.");
            }
            _readers--;
            ReleaseIfDrained();
        }
    }

    private void ReleaseIfDrained()
    {
        if (!_closed || _readers != 0 || _storage == null)
        {
            return;
        }
        NativeMemory.AlignedFree(_storage);
        _storage = null;
        _charge.Dispose();
        _drained.TrySetResult();
    }

    private bool ReadId(long id, out FlatArtifactDescriptor descriptor)
    {
        descriptor = default;
        if (id <= 0)
        {
            return false;
        }
        int slot = IdBucket(id, _layout.Slots);
        for (int probe = 0; probe < _layout.Slots; probe++, slot = (slot + 1) & (_layout.Slots - 1))
        {
            FlatArtifactIdSlot entry = Read<FlatArtifactIdSlot>(_layout.IdOffset + slot * FlatArtifactIndexLayout.IdSlotBytes);
            if (entry.Record == 0)
            {
                return false;
            }
            ValidateRecord(entry.Record);
            if (entry.Id == id)
            {
                descriptor = ReadDescriptor(entry.Record);
                if (descriptor.Id != id)
                {
                    throw new InvalidDataException("Index ID and descriptor disagree.");
                }
                return descriptor.IsEligible;
            }
        }
        throw new InvalidDataException("Index probing exhausted a half-full table.");
    }

    private bool ReadRoute(string route, out FlatArtifactDescriptor descriptor)
    {
        descriptor = default;
        if (!FlatArtifactIndexLayout.TryCanonicalize(route, _limits.MaximumKeyBytes, out string canonical))
        {
            return false;
        }
        Span<byte> key = stackalloc byte[_limits.MaximumKeyBytes];
        int length = Encoding.UTF8.GetBytes(canonical, key);
        key = key[..length];
        uint hash = FlatArtifactIndexLayout.RouteHash(key);
        int slot = (int)(hash & (uint)(_layout.Slots - 1));
        for (int probe = 0; probe < _layout.Slots; probe++, slot = (slot + 1) & (_layout.Slots - 1))
        {
            FlatArtifactRouteSlot entry = Read<FlatArtifactRouteSlot>(_layout.RouteOffset + slot * FlatArtifactIndexLayout.RouteSlotBytes);
            if (entry.Record == 0)
            {
                return false;
            }
            ValidateRecord(entry.Record);
            ReadOnlySpan<byte> stored = ReadKey(entry.Offset, entry.Length);
            // CORRECTNESS: Even equal full hashes never replace complete-key equality.
            if (entry.Hash == hash && stored.SequenceEqual(key))
            {
                descriptor = ReadDescriptor(entry.Record);
                return descriptor.IsEligible;
            }
        }
        throw new InvalidDataException("Index probing exhausted a half-full table.");
    }

    private T Read<T>(int offset) where T : unmanaged
    {
        int size = Unsafe.SizeOf<T>();
        if (!_layout.Contains(offset, 1, size, FlatArtifactIndexLayout.Alignment))
        {
            throw new InvalidDataException("Invalid native record range or alignment.");
        }
        return MemoryMarshal.Read<T>(new ReadOnlySpan<byte>(_storage + offset, size));
    }

    private FlatArtifactDescriptor ReadDescriptor(int record)
    {
        ValidateRecord(record);
        FlatArtifactDescriptor value = Read<FlatArtifactDescriptor>((record - 1) * FlatArtifactIndexLayout.DescriptorBytes);
        if (!value.IsValid)
        {
            throw new InvalidDataException("Invalid content identity or payload handle.");
        }
        return value;
    }

    private void ValidateRecord(int record)
    {
        if (record < 1 || record > _layout.Count)
        {
            throw new InvalidDataException("Invalid descriptor index.");
        }
    }

    private ReadOnlySpan<byte> ReadKey(int offset, int length)
    {
        if (!_layout.ContainsKey(offset, length, _limits.MaximumKeyBytes))
        {
            throw new InvalidDataException("Invalid UTF-8 pool range.");
        }
        return new ReadOnlySpan<byte>(_storage + _layout.KeyOffset + offset, length);
    }

    private FlatArtifactIndexEntry[] ExportEntries()
    {
        var entries = new FlatArtifactIndexEntry[_layout.Count];
        var encoding = new UTF8Encoding(false, true);
        int written = 0;
        for (int slot = 0; slot < _layout.Slots; slot++)
        {
            FlatArtifactRouteSlot entry = Read<FlatArtifactRouteSlot>(
                _layout.RouteOffset + slot * FlatArtifactIndexLayout.RouteSlotBytes);
            if (entry.Record == 0)
            {
                continue;
            }
            ValidateRecord(entry.Record);
            if (written >= entries.Length)
            {
                throw new InvalidDataException("Index key count exceeds the sealed record count.");
            }
            entries[written++] = new(encoding.GetString(ReadKey(entry.Offset, entry.Length)), ReadDescriptor(entry.Record));
        }
        if (written != entries.Length)
        {
            throw new InvalidDataException("Index key count disagrees with the sealed record count.");
        }
        return entries;
    }

    private static int IdBucket(long id, int slots)
        => (int)(unchecked((ulong)id * 11400714819323198485UL) & (uint)(slots - 1));

    private static bool InsertId(Span<byte> bytes, FlatArtifactIndexLayout layout, long id, int record)
    {
        int slot = IdBucket(id, layout.Slots);
        for (int probe = 0; probe < layout.Slots; probe++, slot = (slot + 1) & (layout.Slots - 1))
        {
            Span<byte> target = bytes.Slice(layout.IdOffset + slot * FlatArtifactIndexLayout.IdSlotBytes,
                FlatArtifactIndexLayout.IdSlotBytes);
            FlatArtifactIdSlot existing = MemoryMarshal.Read<FlatArtifactIdSlot>(target);
            if (existing.Record == 0)
            {
                var value = new FlatArtifactIdSlot(id, record, 0);
                MemoryMarshal.Write(target, in value);
                return true;
            }
            if (existing.Id == id)
            {
                return false;
            }
        }
        return false;
    }

    private static bool InsertRoute(Span<byte> bytes, FlatArtifactIndexLayout layout,
        uint hash, int record, int offset, int length)
    {
        int slot = (int)(hash & (uint)(layout.Slots - 1));
        for (int probe = 0; probe < layout.Slots; probe++, slot = (slot + 1) & (layout.Slots - 1))
        {
            Span<byte> target = bytes.Slice(layout.RouteOffset + slot * FlatArtifactIndexLayout.RouteSlotBytes,
                FlatArtifactIndexLayout.RouteSlotBytes);
            FlatArtifactRouteSlot existing = MemoryMarshal.Read<FlatArtifactRouteSlot>(target);
            if (existing.Record == 0)
            {
                var value = new FlatArtifactRouteSlot(hash, record, offset, length);
                MemoryMarshal.Write(target, in value);
                return true;
            }
            if (existing.Hash == hash && bytes.Slice(layout.KeyOffset + existing.Offset, existing.Length)
                .SequenceEqual(bytes.Slice(layout.KeyOffset + offset, length)))
            {
                return false;
            }
        }
        return false;
    }

    /// <summary>
    /// Owns one logical reader across awaits. Disposal waits for an in-progress lookup;
    /// cancellation of an outer wait never substitutes for this lease's actual disposal.
    /// </summary>
    internal sealed class FlatArtifactIndexLease : IDisposable
    {
        private readonly object _gate = new();
        private FlatArtifactIndex? _owner;

        private FlatArtifactIndexLease(FlatArtifactIndex owner)
        {
            _owner = owner;
            Content = owner.Content;
            Location = owner.Location;
            Count = owner.Count;
        }

        internal static MemoryOperationResult<FlatArtifactIndexLease> TryAcquireOwned(FlatArtifactIndex owner, MemoryLocationToken expected)
        {
            expected.Validate();
            lock (owner._gate)
            {
                if (expected != owner.Location)
                {
                    return MemoryOperationResult<FlatArtifactIndexLease>.Reject(MemoryFailure.StaleLocation);
                }
                if (owner._closed)
                {
                    return MemoryOperationResult<FlatArtifactIndexLease>.Reject(MemoryFailure.OwnershipViolation);
                }
                if (owner._readers >= owner._limits.MaximumReaders)
                {
                    return MemoryOperationResult<FlatArtifactIndexLease>.Reject(MemoryFailure.BudgetRejected);
                }
                var lease = new FlatArtifactIndexLease(owner);
                var result = MemoryOperationResult<FlatArtifactIndexLease>.Success(lease);
                owner._readers++;
                return result;
            }
        }

        internal MemoryContentIdentity Content
        {
            get;
        }
        internal MemoryLocationToken Location
        {
            get;
        }
        internal int Count
        {
            get;
        }

        internal FlatArtifactIndexEntry[] CopyEntries()
        {
            lock (_gate)
            {
                ObjectDisposedException.ThrowIf(_owner is null, this);
                return _owner.ExportEntries();
            }
        }

        internal bool TryGetId(long id, out FlatArtifactDescriptor descriptor)
        {
            lock (_gate)
            {
                ObjectDisposedException.ThrowIf(_owner is null, this);
                return _owner.ReadId(id, out descriptor);
            }
        }

        internal bool TryGetRoute(string route, out FlatArtifactDescriptor descriptor)
        {
            lock (_gate)
            {
                ObjectDisposedException.ThrowIf(_owner is null, this);
                return _owner.ReadRoute(route, out descriptor);
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                FlatArtifactIndex? owner = _owner;
                _owner = null;
                owner?.ReleaseReader();
            }
        }
    }
}
