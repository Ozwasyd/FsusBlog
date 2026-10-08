using System.Buffers;
using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Lifetime;

public enum MemoryRoleKind
{
    Current, LastGood, Sticky, Overlay
}

public enum MemoryRetirementState
{
    Open, Closing, Releasing, Released
}

public sealed record MemoryLifetimeSnapshot(MemoryRetirementState State, int Roles, int Readers,
    int Pins, int Operations, int LogicalLength, int Capacity, int CurrentRoles, int LastGoodRoles,
    int StickyRoles, int OverlayRoles);

// OWNERSHIP: This owner controls one managed byte-array backing, never publication,
// qualification, visibility or revocation. The existing authority decides when to close.
// GC object/header and control-metadata overhead remain outside payload-byte accounting.
public sealed class ManagedMemoryBacking : IMemoryHostViewSource, IDisposable
{
    private readonly object _gate = new();
    private readonly MemoryReservationCoordinator _ledger;
    private readonly ResourceDomainId _operationDomain;
    private readonly IMemoryAllocationCharge _charge;
    private readonly int _holdLimit;
    private readonly Action<int>? _releaseRecorder;
    private readonly TaskCompletionSource _drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly int[] _roleCounts = new int[4];
    private byte[]? _buffer;
    private byte[]? _retiringBuffer;
    private MemoryRetirementState _state;
    private int _roles = 1;
    private int _readers;
    private int _pins;
    private int _operations;

    private ManagedMemoryBacking(MemoryReservationCoordinator ledger, ResourceDomainId operationDomain,
        IMemoryAllocationCharge charge, MemoryContentIdentity content, MemoryLocationToken location,
        byte[] buffer, int logicalLength, int holdLimit, Action<int>? releaseRecorder)
    {
        _ledger = ledger;
        _operationDomain = operationDomain;
        _charge = charge;
        _holdLimit = holdLimit;
        _releaseRecorder = releaseRecorder;
        _buffer = buffer;
        Content = content;
        Location = location;
        LogicalLength = logicalLength;
        Capacity = buffer.Length;
    }

    public MemoryContentIdentity Content
    {
        get;
    }
    public MemoryLocationToken Location
    {
        get;
    }
    public int LogicalLength
    {
        get;
    }
    public int Capacity
    {
        get;
    }
    public MemoryAllocationDescriptor Descriptor => _charge.Descriptor!;
    public Task Drained => _drained.Task;

    public static MemoryOperationResult<ManagedMemoryBacking> TryCreate(MemoryReservationCoordinator ledger,
        ResourceDomainId payloadDomain, ResourceDomainId operationDomain, MemoryContentIdentity content,
        ResidencyRevision revision, DeviceEpoch epoch, ReadOnlySpan<byte> payload, int capacity, int holdLimit,
        Action<int>? releaseRecorder = null)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        content.Validate();
        if (capacity <= 0 || capacity > Array.MaxLength || payload.Length > capacity || holdLimit <= 0 || revision.Value == 0
            || epoch.Value == 0 || operationDomain.Value == Guid.Empty)
        {
            return MemoryOperationResult<ManagedMemoryBacking>.Reject(MemoryFailure.BoundsViolation);
        }
        MemoryOperationResult<MemoryAllocationLayout> layout = MemoryAllocationLayout.TryCreate(payload.Length, capacity, 1);
        if (!layout.Succeeded)
        {
            return MemoryOperationResult<ManagedMemoryBacking>.Reject(layout.Failure!.Value);
        }
        MemoryResourceCharge[] vector = [new(payloadDomain, MemoryResourceUnit.Bytes, capacity)];
        MemoryOperationResult<MemoryReservation> admission = ledger.TryReserve(vector);
        if (!admission.Succeeded)
        {
            return MemoryOperationResult<ManagedMemoryBacking>.Reject(admission.Failure!.Value);
        }
        using MemoryReservation reservation = admission.Value!;
        // ADMISSION: Exact array capacity is reserved before allocation; padding starts
        // initialized and only the logical payload range is exposed by a host lease.
        var buffer = new byte[capacity];
        IMemoryAllocationCharge? charge = null;
        bool transferred = false;
        try
        {
            payload.CopyTo(buffer);
            var location = new MemoryLocationToken(new(Guid.NewGuid()), new(Guid.NewGuid()), revision, epoch);
            var descriptor = new MemoryAllocationDescriptor(location.Allocation, payloadDomain, layout.Value!);
            MemoryOperationResult<IMemoryAllocationCharge> conversion = reservation.CommitPhysical(descriptor, vector);
            if (!conversion.Succeeded)
            {
                return MemoryOperationResult<ManagedMemoryBacking>.Reject(conversion.Failure!.Value);
            }
            charge = conversion.Value!;
            var owner = new ManagedMemoryBacking(ledger, operationDomain, charge, content,
                location, buffer, payload.Length, holdLimit, releaseRecorder);
            MemoryOperationResult<ManagedMemoryBacking> result = MemoryOperationResult<ManagedMemoryBacking>.Success(owner);
            transferred = true;
            return result;
        }
        finally
        {
            if (!transferred)
            {
                Array.Clear(buffer);
                charge?.Dispose();
            }
        }
    }

    public MemoryLifetimeSnapshot Snapshot()
    {
        lock (_gate)
        {
            return new(_state, _roles, _readers, _pins, _operations, LogicalLength, Capacity,
                _roleCounts[0], _roleCounts[1], _roleCounts[2], _roleCounts[3]);
        }
    }

    public MemoryOperationResult<MemoryRoleLease> TryRetainRole(MemoryLocationToken expectedLocation, MemoryRoleKind kind)
    {
        if (!Enum.IsDefined(kind))
        {
            return MemoryOperationResult<MemoryRoleLease>.Reject(MemoryFailure.BoundsViolation);
        }
        expectedLocation.Validate();
        lock (_gate)
        {
            MemoryFailure? failure = AcquisitionFailure(expectedLocation);
            if (failure is not null)
            {
                return MemoryOperationResult<MemoryRoleLease>.Reject(failure.Value);
            }
            var lease = new MemoryRoleLease(this, kind);
            var result = MemoryOperationResult<MemoryRoleLease>.Success(lease);
            _roles++;
            _roleCounts[(int)kind]++;
            return result;
        }
    }

    public MemoryOperationResult<IMemoryHostReadLease> TryAcquireHostView(MemoryLocationToken expectedLocation)
        => TryAcquireHostView(expectedLocation, 0, LogicalLength);

    public MemoryOperationResult<IMemoryHostReadLease> TryAcquireHostView(MemoryLocationToken expectedLocation,
        int offset, int length)
        => Acquire(expectedLocation, offset, length, operation: false);

    // COMPLETION: Caller cancellation of a separate wait cannot dispose this operation's
    // source or slot. Only this one await's actual terminal event enters the finally.
    public async ValueTask<MemoryOperationResult<MemoryOperationCompletion>> ConsumeAsync(
        MemoryLocationToken expectedLocation, Func<ReadOnlyMemory<byte>, CancellationToken, ValueTask> consumer,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(consumer);
        MemoryOperationResult<MemoryReservation> admission = _ledger.TryReserve([
            new(_operationDomain, MemoryResourceUnit.OperationSlots, 1)
        ]);
        if (!admission.Succeeded)
        {
            return MemoryOperationResult<MemoryOperationCompletion>.Reject(admission.Failure!.Value);
        }
        using MemoryReservation reservation = admission.Value!;
        MemoryOperationResult<IMemoryHostReadLease> acquisition = Acquire(expectedLocation, 0, LogicalLength, operation: true);
        if (!acquisition.Succeeded)
        {
            return MemoryOperationResult<MemoryOperationCompletion>.Reject(acquisition.Failure!.Value);
        }
        using IMemoryHostReadLease lease = acquisition.Value!;
        try
        {
            await consumer(lease.Memory, cancellationToken).ConfigureAwait(false);
            return MemoryOperationResult<MemoryOperationCompletion>.Success(MemoryOperationCompletion.Completed);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return MemoryOperationResult<MemoryOperationCompletion>.Reject(MemoryFailure.Cancelled);
        }
        finally
        {
            reservation.Dispose();
        }
    }

    public bool Close()
    {
        bool release;
        lock (_gate)
        {
            if (_state != MemoryRetirementState.Open)
            {
                return false;
            }
            _state = MemoryRetirementState.Closing;
            _roles--;
            release = DetachIfDrained();
        }
        if (release)
        {
            CompleteRelease();
        }
        return true;
    }

    public void Dispose() => Close();

    private MemoryOperationResult<IMemoryHostReadLease> Acquire(MemoryLocationToken expectedLocation,
        int offset, int length, bool operation)
    {
        expectedLocation.Validate();
        if (offset < 0 || length < 0 || offset > LogicalLength || length > LogicalLength - offset)
        {
            return MemoryOperationResult<IMemoryHostReadLease>.Reject(MemoryFailure.BoundsViolation);
        }
        lock (_gate)
        {
            MemoryFailure? failure = AcquisitionFailure(expectedLocation);
            if (failure is not null)
            {
                return MemoryOperationResult<IMemoryHostReadLease>.Reject(failure.Value);
            }
            var lease = new HostReadLease(this, _buffer!, offset, length, operation);
            var result = MemoryOperationResult<IMemoryHostReadLease>.Success(lease);
            if (operation)
            {
                _operations++;
            }
            else
            {
                _readers++;
            }
            return result;
        }
    }

    private MemoryFailure? AcquisitionFailure(MemoryLocationToken expectedLocation)
    {
        if (expectedLocation != Location)
        {
            return MemoryFailure.StaleLocation;
        }
        if (_state != MemoryRetirementState.Open)
        {
            return MemoryFailure.OwnershipViolation;
        }
        return HoldCount >= _holdLimit ? MemoryFailure.BudgetRejected : null;
    }

    private long HoldCount => (long)_roles + _readers + _pins + _operations;

    private void RetainPin()
    {
        lock (_gate)
        {
            // A pre-close live reader may still pin its own backing. Closing only
            // prevents new independent acquisitions, not completion of existing work.
            if (_state is MemoryRetirementState.Releasing or MemoryRetirementState.Released)
            {
                throw new ObjectDisposedException(nameof(ManagedMemoryBacking));
            }
            if (HoldCount >= _holdLimit)
            {
                throw new InsufficientMemoryException("The finite managed ownership hold limit rejects this pin.");
            }
            _pins++;
        }
    }

    private void ReleaseHold(HoldKind kind, MemoryRoleKind? role = null)
    {
        bool release;
        lock (_gate)
        {
            ref int count = ref Count(kind);
            if (count <= 0)
            {
                throw new InvalidOperationException("Managed ownership count underflow.");
            }
            if (kind == HoldKind.Role)
            {
                if (role is null || _roleCounts[(int)role.Value] <= 0)
                {
                    throw new InvalidOperationException("Managed role count underflow.");
                }
                _roleCounts[(int)role.Value]--;
            }
            count--;
            release = DetachIfDrained();
        }
        if (release)
        {
            CompleteRelease();
        }
    }

    private ref int Count(HoldKind kind)
    {
        switch (kind)
        {
            case HoldKind.Role:
                return ref _roles;
            case HoldKind.Reader:
                return ref _readers;
            case HoldKind.Pin:
                return ref _pins;
            case HoldKind.Operation:
                return ref _operations;
            default:
                throw new ArgumentOutOfRangeException(nameof(kind));
        }
    }

    private bool DetachIfDrained()
    {
        if (_state != MemoryRetirementState.Closing || HoldCount != 0)
        {
            return false;
        }
        _state = MemoryRetirementState.Releasing;
        _retiringBuffer = _buffer;
        _buffer = null;
        return true;
    }

    private void CompleteRelease()
    {
        // CLEANUP: No external recorder or ledger callback runs under the lifetime gate.
        // No timer, GC callback or canceled waiter can force this release transition.
        try
        {
            // SECURITY: Generic content has no approved public-immutable clear exemption.
            // Clear the whole capacity only after every actual consumer/pin/role ends.
            Array.Clear(_retiringBuffer!);
            _retiringBuffer = null;
            _charge.Dispose();
            _releaseRecorder?.Invoke(Capacity);
            lock (_gate)
            {
                _state = MemoryRetirementState.Released;
            }
            _drained.TrySetResult();
        }
        catch (Exception exception)
        {
            _drained.TrySetException(exception);
            throw;
        }
    }

    private enum HoldKind
    {
        Role, Reader, Pin, Operation
    }

    public sealed class MemoryRoleLease : IDisposable
    {
        private ManagedMemoryBacking? _owner;
        internal MemoryRoleLease(ManagedMemoryBacking owner, MemoryRoleKind kind)
        {
            _owner = owner;
            Kind = kind;
        }
        public MemoryRoleKind Kind
        {
            get;
        }
        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.ReleaseHold(HoldKind.Role, Kind);
    }

    private sealed class HostReadLease : IMemoryHostReadLease
    {
        private LeaseMemoryManager? _manager;
        public HostReadLease(ManagedMemoryBacking owner, byte[] buffer, int offset, int length, bool operation)
        {
            Content = owner.Content;
            Location = owner.Location;
            _manager = new LeaseMemoryManager(owner, buffer, offset, length, operation);
        }
        public MemoryContentIdentity Content
        {
            get;
        }
        public MemoryLocationToken Location
        {
            get;
        }
        public ReadOnlyMemory<byte> Memory => (Volatile.Read(ref _manager)
            ?? throw new ObjectDisposedException(nameof(HostReadLease))).Memory;
        public void Dispose()
        {
            LeaseMemoryManager? manager = Interlocked.Exchange(ref _manager, null);
            ((IDisposable?)manager)?.Dispose();
        }
    }

    private sealed class LeaseMemoryManager : MemoryManager<byte>
    {
        private readonly object _gate = new();
        private readonly int _offset;
        private readonly int _length;
        private readonly bool _operation;
        private ManagedMemoryBacking? _owner;
        private byte[]? _buffer;

        public LeaseMemoryManager(ManagedMemoryBacking owner, byte[] buffer, int offset, int length, bool operation)
        {
            _owner = owner;
            _buffer = buffer;
            _offset = offset;
            _length = length;
            _operation = operation;
        }

        public override Span<byte> GetSpan()
        {
            lock (_gate)
            {
                ObjectDisposedException.ThrowIf(_buffer is null, this);
                return _buffer.AsSpan(_offset, _length);
            }
        }

        public override unsafe MemoryHandle Pin(int elementIndex = 0)
        {
            lock (_gate)
            {
                ObjectDisposedException.ThrowIf(_owner is null, this);
                if ((uint)elementIndex > (uint)_length)
                {
                    throw new ArgumentOutOfRangeException(nameof(elementIndex));
                }
                var pin = new PinOwner(_owner);
                _owner.RetainPin();
                GCHandle handle = default;
                try
                {
                    handle = GCHandle.Alloc(_buffer!, GCHandleType.Pinned);
                    pin.SetHandle(handle);
                    // IPinnable owns the GCHandle. Copies of the BCL MemoryHandle share
                    // one idempotent token and cannot free that handle twice.
                    return new MemoryHandle((byte*)handle.AddrOfPinnedObject() + _offset + elementIndex, default, pin);
                }
                catch
                {
                    if (handle.IsAllocated)
                    {
                        handle.Free();
                    }
                    _owner.ReleaseHold(HoldKind.Pin);
                    throw;
                }
            }
        }

        public override void Unpin() => throw new InvalidOperationException("Only the exact pin token can unpin this backing.");

        protected override void Dispose(bool disposing)
        {
            ManagedMemoryBacking? owner;
            lock (_gate)
            {
                owner = _owner;
                _owner = null;
                _buffer = null;
            }
            owner?.ReleaseHold(_operation ? HoldKind.Operation : HoldKind.Reader);
        }
    }

    private sealed class PinOwner(ManagedMemoryBacking owner) : IPinnable
    {
        private GCHandle _handle;
        private int _disposed;
        public void SetHandle(GCHandle handle) => _handle = handle;
        public MemoryHandle Pin(int elementIndex) => throw new NotSupportedException("A pin token cannot create another pin.");
        public void Unpin()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
            {
                return;
            }
            _handle.Free();
            owner.ReleaseHold(HoldKind.Pin);
        }
    }
}

public sealed class MemoryOperationCompletion
{
    private MemoryOperationCompletion()
    {
    }
    public static MemoryOperationCompletion Completed { get; } = new();
}
