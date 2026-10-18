using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

internal enum OsPageRegionState
{
    Reserved,
    Building,
    Sealed,
    Decommitted,
    Faulted,
    Released
}

internal sealed class OsPageRegionCleanupException(OsPageRegion region, Exception innerException)
    : InvalidOperationException("OS region cleanup failed; the retained region must be retried.", innerException)
{
    public OsPageRegion Region { get; } = region;
}

internal sealed record OsPageRegionObservation(string Backend, OsPageRegionState State,
    long ReservedBytes, long? CommittedBytes, long ChargedBytes, long? LockedBytes,
    bool OsReadOnly, OsPageStrategy RequestedStrategy, bool LargePageHintAccepted,
    bool ExplicitLargeMappingAllocated, long? ObservedPhysicalPageBytes, int? RequestedNumaNode, bool NumaPolicyAccepted, int LastNativeError);

// OWNERSHIP: A dedicated region never exports a pointer or Memory to callers.
// Synchronous copies hold the owner gate through completion, so seal, decommit,
// unlock and release cannot race a view, pin or asynchronous continuation.
// This primitive does not publish content or select/qualify a capability.
internal sealed class OsPageRegion : IDisposable
{
    private readonly object _gate = new();
    private readonly IOsPageNativeApi _native;
    private readonly MemoryAllocationDescriptor _descriptor;
    private nint _address;
    private nint _payload;
    private readonly nuint _reservedBytes;
    private readonly nuint _payloadBytes;
    private IMemoryAllocationCharge? _charge;
    private IMemoryReservation? _pendingReservation;
    private OsPageRegionState _state;
    private long _committedBytes;
    private bool _hintAccepted;
    private OsPageStrategy _requestedStrategy;
    private bool _locked;
    private bool _lockObservationKnown = true;
    private int _lastNativeError;
    private int? _requestedNumaNode;
    private bool _numaPolicyAccepted;

    private OsPageRegion(IOsPageNativeApi native, MemoryAllocationDescriptor descriptor, nint address,
        nuint reservedBytes, int guardBytes)
    {
        _native = native;
        _descriptor = descriptor;
        _address = address;
        _payload = address + guardBytes;
        _reservedBytes = reservedBytes;
        _payloadBytes = reservedBytes - (nuint)(2L * guardBytes);
        _state = OsPageRegionState.Reserved;
        _requestedStrategy = native.UsesExplicitLargePages ? OsPageStrategy.ExplicitLarge : OsPageStrategy.Normal;
    }

    // ADMISSION: The caller's existing coordinator must reserve the complete
    // mapping before entry. CommitPhysical transfers that same charge; no local
    // byte ledger or capability policy is introduced.
    public static MemoryOperationResult<OsPageRegion> TryReserve(IOsPageNativeApi native,
        MemoryAllocationDescriptor descriptor, IMemoryReservation reservation, bool guardPages, ResourceDomainId? lockedSubset = null)
        => TryReserve(native, descriptor, reservation, guardPages, out _, lockedSubset);

    // A missing error means no native allocation was attempted; native errno or
    // Win32 error survives failed allocation/locking and subsequent cleanup.
    public static MemoryOperationResult<OsPageRegion> TryReserve(IOsPageNativeApi native,
        MemoryAllocationDescriptor descriptor, IMemoryReservation reservation, bool guardPages,
        out int? nativeError, ResourceDomainId? lockedSubset = null)
    {
        nativeError = null;
        ArgumentNullException.ThrowIfNull(native);
        ArgumentNullException.ThrowIfNull(descriptor);
        ArgumentNullException.ThrowIfNull(reservation);
        long capacity = descriptor.Layout.CapacityBytes;
        int guardBytes = guardPages ? native.PageBytes : 0;
        long payloadBytes = capacity - 2L * guardBytes;
        if (native.PageBytes <= 0 || (native.PageBytes & (native.PageBytes - 1)) != 0
            || descriptor.Layout.LogicalBytes <= 0 || capacity % native.PageBytes != 0
            || descriptor.Layout.AlignmentBytes != native.PageBytes
            || payloadBytes < descriptor.Layout.LogicalBytes
            || (ulong)capacity > (ulong)nint.MaxValue
            || !reservation.Reserved.Any(charge => charge.Domain == descriptor.Domain
                && charge.Unit == MemoryResourceUnit.Bytes && charge.Amount >= capacity))
        {
            return MemoryOperationResult<OsPageRegion>.Reject(MemoryFailure.BoundsViolation);
        }
        if (lockedSubset is ResourceDomainId lockedDomain && (lockedDomain == descriptor.Domain
            || !reservation.Reserved.Any(charge => charge.Domain == lockedDomain
                && charge.Unit == MemoryResourceUnit.Bytes && charge.Amount >= payloadBytes)))
        {
            return MemoryOperationResult<OsPageRegion>.Reject(MemoryFailure.BudgetRejected);
        }
        var charges = new List<MemoryResourceCharge>
        {
            new(descriptor.Domain, MemoryResourceUnit.Bytes, capacity)
        };
        if (lockedSubset is ResourceDomainId subset)
        {
            charges.Add(new(subset, MemoryResourceUnit.Bytes, payloadBytes));
        }
        var region = new OsPageRegion(native, descriptor, 0, (nuint)capacity, guardBytes);
        nint address = native.Reserve((nuint)capacity, out int reserveError);
        nativeError = reserveError;
        if (address == 0)
        {
            return MemoryOperationResult<OsPageRegion>.Reject(MemoryFailure.TierUnavailable);
        }
        region._address = address;
        region._payload = address + guardBytes;
        region._pendingReservation = reservation;
        if ((nuint)address % (nuint)native.PageBytes != 0)
        {
            region.Dispose();
            return MemoryOperationResult<OsPageRegion>.Reject(MemoryFailure.BoundsViolation);
        }
        MemoryOperationResult<IMemoryAllocationCharge> committed;
        try
        {
            committed = reservation.CommitPhysical(descriptor, charges);
        }
        catch
        {
            region.Dispose();
            throw;
        }
        if (!committed.Succeeded)
        {
            region.Dispose();
            return MemoryOperationResult<OsPageRegion>.Reject(committed.Failure!.Value);
        }
        region._charge = committed.Value;
        region._pendingReservation = null;
        if (lockedSubset is not null)
        {
            try
            {
                if (!region.Commit())
                {
                    nativeError = region._lastNativeError;
                    region.Dispose();
                    return MemoryOperationResult<OsPageRegion>.Reject(MemoryFailure.TierUnavailable);
                }
                region._lockObservationKnown = false;
                if (!region.Observe(native.Lock(region._payload, region._payloadBytes)))
                {
                    nativeError = region._lastNativeError;
                    region.Dispose();
                    return MemoryOperationResult<OsPageRegion>.Reject(MemoryFailure.TierUnavailable);
                }
                region._locked = true;
                region._lockObservationKnown = true;
            }
            catch (OsPageRegionCleanupException)
            {
                throw;
            }
            catch
            {
                region.Dispose();
                throw;
            }
        }
        return MemoryOperationResult<OsPageRegion>.Success(region);
    }

    // Observation freshness is bounded by the owning policy. Policy acceptance is
    // not proof of physical placement; placement runtime qualification stays with
    // the common controller and its real-platform oracle.
    public bool BindToNode(IOsNumaRangeApi native, OsNumaTopologyObservation topology,
        int node, DateTimeOffset now, TimeSpan maximumAge)
    {
        ArgumentNullException.ThrowIfNull(native);
        ArgumentNullException.ThrowIfNull(topology);
        if (maximumAge <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumAge));
        }
        lock (_gate)
        {
            if (_state != OsPageRegionState.Reserved || !topology.CanTarget(node)
                || now < topology.SampledAt || now - topology.SampledAt > maximumAge)
            {
                return false;
            }
            _requestedNumaNode = node;
            _numaPolicyAccepted = Observe(native.Bind(_payload, _payloadBytes, node));
            return _numaPolicyAccepted;
        }
    }

    public unsafe bool Commit(bool firstTouch = false)
    {
        lock (_gate)
        {
            if (_state is not (OsPageRegionState.Reserved or OsPageRegionState.Decommitted))
            {
                return false;
            }
            if (!Observe(_native.Commit(_payload, _payloadBytes)))
            {
                _state = OsPageRegionState.Faulted;
                return false;
            }
            _committedBytes = (long)_payloadBytes;
            _state = OsPageRegionState.Building;
            if (firstTouch)
            {
                NativeMemory.Clear((void*)_payload, _payloadBytes);
            }
            return true;
        }
    }

    public bool Seal()
    {
        lock (_gate)
        {
            if (_state == OsPageRegionState.Sealed)
            {
                return true;
            }
            if (_state != OsPageRegionState.Building || !Observe(_native.Protect(_payload, _payloadBytes, false)))
            {
                return false;
            }
            _state = OsPageRegionState.Sealed;
            return true;
        }
    }

    public unsafe void Write(long offset, ReadOnlySpan<byte> source)
    {
        lock (_gate)
        {
            RequireAccessible(true, offset, source.Length);
            source.CopyTo(new Span<byte>((void*)checked(_payload + (nint)offset), source.Length));
        }
    }

    public unsafe void Read(long offset, Span<byte> destination)
    {
        lock (_gate)
        {
            RequireAccessible(false, offset, destination.Length);
            new ReadOnlySpan<byte>((void*)checked(_payload + (nint)offset), destination.Length).CopyTo(destination);
        }
    }

    // Locking is admitted in the original allocation vector, as a subset of the
    // same physical owner. The common topology validates containment. Unlock does
    // not manufacture a new owner or release the conservative subset reservation;
    // that bound remains held until the complete region is released.
    public bool Unlock()
    {
        lock (_gate)
        {
            if (!_locked)
            {
                return true;
            }
            _lockObservationKnown = false;
            if (!Observe(_native.Unlock(_payload, _payloadBytes)))
            {
                return false;
            }
            _locked = false;
            _lockObservationKnown = true;
            return true;
        }
    }

    public bool HintTransparentLargePages()
    {
        lock (_gate)
        {
            if (_state != OsPageRegionState.Building || _native.UsesExplicitLargePages)
            {
                return false;
            }
            _requestedStrategy = OsPageStrategy.TransparentHint;
            _hintAccepted = Observe(_native.HintTransparentLargePages(_payload, _payloadBytes));
            return _hintAccepted;
        }
    }

    // Destructive operation: this region primitive has no escaped holds. A future
    // host backing must invalidate its location and drain all leases before entry.
    public bool Decommit()
    {
        lock (_gate)
        {
            if (_locked || _state is not (OsPageRegionState.Building or OsPageRegionState.Sealed))
            {
                return false;
            }
            if (!Observe(_native.Decommit(_payload, _payloadBytes)))
            {
                _state = OsPageRegionState.Faulted;
                return false;
            }
            _committedBytes = 0;
            _hintAccepted = false;
            _state = OsPageRegionState.Decommitted;
            return true;
        }
    }

    public OsPageRegionObservation Observe()
    {
        lock (_gate)
        {
            bool released = _state == OsPageRegionState.Released;
            return new(_native.Backend, _state, released ? 0 : (long)_reservedBytes,
                _state == OsPageRegionState.Faulted ? null : _committedBytes,
                _charge is null ? 0 : _descriptor.Layout.CapacityBytes,
                _lockObservationKnown ? (_locked ? (long)_payloadBytes : 0) : null, _state == OsPageRegionState.Sealed,
                _requestedStrategy, _hintAccepted, _native.UsesExplicitLargePages && !released, null,
                _requestedNumaNode, _numaPolicyAccepted, _lastNativeError);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_state != OsPageRegionState.Released)
            {
                if (!Observe(_native.Release(_address, _reservedBytes)))
                {
                    _state = OsPageRegionState.Faulted;
                    throw new OsPageRegionCleanupException(this,
                        new InvalidOperationException($"Native release failed with error {_lastNativeError}."));
                }
                _state = OsPageRegionState.Released;
                _committedBytes = 0;
                _locked = false;
                _lockObservationKnown = true;
                _hintAccepted = false;
            }
            // A charge-release exception must leave its token retryable even when
            // the native range has already been released. Never free that range twice.
            try
            {
                _charge?.Dispose();
                _charge = null;
                _pendingReservation?.Dispose();
                _pendingReservation = null;
            }
            catch (Exception exception)
            {
                throw new OsPageRegionCleanupException(this, exception);
            }
        }
    }

    private bool Observe(OsPageCall result)
    {
        _lastNativeError = result.Error;
        return result.Succeeded;
    }

    private void RequireAccessible(bool writable, long offset, int length)
    {
        if (_state is not (OsPageRegionState.Building or OsPageRegionState.Sealed)
            || (writable && _state != OsPageRegionState.Building))
        {
            throw new InvalidOperationException("Region does not grant the requested access.");
        }
        if (offset < 0 || offset > _descriptor.Layout.LogicalBytes
            || length > _descriptor.Layout.LogicalBytes - offset)
        {
            throw new ArgumentOutOfRangeException(nameof(offset));
        }
    }
}
