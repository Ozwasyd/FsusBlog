using System.Buffers;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Lifetime;

namespace FsusBlog.Server.Infrastructure.Memory.Host;

// OWNERSHIP: One block holds exactly one reservation/charge. Slices and role,
// reader, operation and pin tokens never create another physical charge.
internal sealed class NativeMemoryBlock
{
    private readonly object _gate = new();
    private readonly INativeMemoryAllocator _allocator;
    private readonly MemoryReservationCoordinator _ledger;
    private readonly ResourceDomainId _payloadDomain;
    private readonly ResourceDomainId _operationDomain;
    private readonly int _alignment;
    private readonly int _holdLimit;
    private readonly TaskCompletionSource _drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly int[] _roleCounts = new int[4];
    private MemoryReservation? _reservation;
    private IMemoryAllocationCharge? _charge;
    private nint _address;
    private bool _allocatorRelinquished;
    private bool _published;
    private MemoryRetirementState _state;
    private int _roles = 1;
    private int _readers;
    private int _pins;
    private int _operations;

    internal NativeMemoryBlock(INativeMemoryAllocator allocator, MemoryReservationCoordinator ledger,
        ResourceDomainId payloadDomain, ResourceDomainId operationDomain, MemoryReservation reservation,
        nint address, int capacity, NativeMemoryArenaPolicy policy)
    {
        _allocator = allocator;
        _ledger = ledger;
        _payloadDomain = payloadDomain;
        _operationDomain = operationDomain;
        _reservation = reservation;
        _address = address;
        _alignment = policy.Alignment;
        _holdLimit = policy.HoldLimit;
        Capacity = capacity;
        Allocation = new(Guid.NewGuid());
        Block = new(Guid.NewGuid());
    }

    internal AllocationId Allocation
    {
        get;
    }
    internal BlockId Block
    {
        get;
    }
    internal int Capacity
    {
        get;
    }
    internal int LogicalLength
    {
        get; private set;
    }
    internal Task Drained => _drained.Task;

    internal bool AllocatorRelinquished
    {
        get
        {
            lock (_gate)
            {
                return _allocatorRelinquished;
            }
        }
    }

    internal unsafe int Append(ReadOnlySpan<byte> payload)
    {
        // Builder serializes writes and never hands out the raw destination span.
        if (_published || _state != MemoryRetirementState.Open || payload.Length > Capacity - LogicalLength)
        {
            throw new InvalidOperationException("Block is not writable or cannot contain the slice.");
        }
        int offset = LogicalLength;
        payload.CopyTo(new Span<byte>((void*)(_address + offset), payload.Length));
        LogicalLength = checked(LogicalLength + payload.Length);
        return offset;
    }

    internal MemoryFailure? Commit()
    {
        MemoryOperationResult<MemoryAllocationLayout> layout = MemoryAllocationLayout.TryCreate(LogicalLength, Capacity, _alignment);
        if (!layout.Succeeded)
        {
            return layout.Failure;
        }
        var descriptor = new MemoryAllocationDescriptor(Allocation, _payloadDomain, layout.Value!);
        MemoryOperationResult<IMemoryAllocationCharge> conversion = _reservation!.CommitPhysical(descriptor,
            [new(_payloadDomain, MemoryResourceUnit.Bytes, Capacity)]);
        if (!conversion.Succeeded)
        {
            return conversion.Failure;
        }
        _charge = conversion.Value!;
        _reservation.Dispose();
        _reservation = null;
        return null;
    }

    internal void Publish()
    {
        lock (_gate)
        {
            _published = true;
        }
    }

    internal MemoryLifetimeSnapshot Snapshot()
    {
        lock (_gate)
        {
            return new(_state, _roles, _readers, _pins, _operations, LogicalLength, Capacity,
                _roleCounts[0], _roleCounts[1], _roleCounts[2], _roleCounts[3]);
        }
    }

    internal MemoryOperationResult<IDisposable> Retain(MemoryLocationToken expected, MemoryLocationToken current,
        MemoryRoleKind role)
    {
        if (!Enum.IsDefined(role))
        {
            return MemoryOperationResult<IDisposable>.Reject(MemoryFailure.BoundsViolation);
        }
        lock (_gate)
        {
            MemoryFailure? failure = AcquisitionFailure(expected, current);
            if (failure is not null)
            {
                return MemoryOperationResult<IDisposable>.Reject(failure.Value);
            }
            var lease = new RoleLease(this, role);
            var result = MemoryOperationResult<IDisposable>.Success(lease);
            _roles++;
            _roleCounts[(int)role]++;
            return result;
        }
    }

    internal MemoryOperationResult<IMemoryHostReadLease> Acquire(NativeMemorySlice slice,
        MemoryLocationToken expected, int offset, int length, bool operation = false)
    {
        if (offset < 0 || length < 0 || offset > slice.Length || length > slice.Length - offset)
        {
            return MemoryOperationResult<IMemoryHostReadLease>.Reject(MemoryFailure.BoundsViolation);
        }
        lock (_gate)
        {
            MemoryFailure? failure = AcquisitionFailure(expected, slice.Location);
            if (failure is not null)
            {
                return MemoryOperationResult<IMemoryHostReadLease>.Reject(failure.Value);
            }
            var manager = new LeaseMemoryManager(this, _address + checked(slice.Offset + offset), length, operation);
            var lease = new HostReadLease(slice.Content, slice.Location, manager);
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

    internal async ValueTask<MemoryOperationResult<MemoryOperationCompletion>> ConsumeAsync(NativeMemorySlice slice,
        MemoryLocationToken expected, Func<ReadOnlyMemory<byte>, CancellationToken, ValueTask> consumer,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(consumer);
        MemoryOperationResult<MemoryReservation> admission = _ledger.TryReserve(
            [new(_operationDomain, MemoryResourceUnit.OperationSlots, 1)]);
        if (!admission.Succeeded)
        {
            return MemoryOperationResult<MemoryOperationCompletion>.Reject(admission.Failure!.Value);
        }
        using MemoryReservation reservation = admission.Value!;
        MemoryOperationResult<IMemoryHostReadLease> acquisition = Acquire(slice, expected, 0, slice.Length, operation: true);
        if (!acquisition.Succeeded)
        {
            return MemoryOperationResult<MemoryOperationCompletion>.Reject(acquisition.Failure!.Value);
        }
        using IMemoryHostReadLease lease = acquisition.Value!;
        try
        {
            // COMPLETION: Cancellation of an outside waiter is not consumer completion.
            await consumer(lease.Memory, cancellationToken).ConfigureAwait(false);
            return MemoryOperationResult<MemoryOperationCompletion>.Success(MemoryOperationCompletion.Completed);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return MemoryOperationResult<MemoryOperationCompletion>.Reject(MemoryFailure.Cancelled);
        }
    }

    private MemoryFailure? AcquisitionFailure(MemoryLocationToken expected, MemoryLocationToken current)
    {
        if (expected != current)
        {
            return MemoryFailure.StaleLocation;
        }
        if (!_published || _state != MemoryRetirementState.Open)
        {
            return MemoryFailure.OwnershipViolation;
        }
        return HoldCount >= _holdLimit ? MemoryFailure.BudgetRejected : null;
    }

    private long HoldCount => (long)_roles + _readers + _pins + _operations;

    internal void Close()
    {
        bool release;
        lock (_gate)
        {
            if (_state != MemoryRetirementState.Open)
            {
                return;
            }
            _state = MemoryRetirementState.Closing;
            _roles--;
            release = DetachIfDrained();
        }
        if (release)
        {
            CompleteRelease();
        }
    }

    private void RetainPin()
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_state is MemoryRetirementState.Releasing or MemoryRetirementState.Released, this);
            if (HoldCount >= _holdLimit)
            {
                throw new InsufficientMemoryException("Finite native hold limit rejects this pin.");
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
                throw new InvalidOperationException("Native ownership count underflow.");
            }
            if (role is not null)
            {
                _roleCounts[(int)role]--;
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
        return true;
    }

    private void CompleteRelease()
    {
        // SECURITY: Clear unclassified data after all real holds end, before the
        // allocator relinquishes ownership. Neither event proves an RSS decrease.
        try
        {
            _allocator.ClearAndFree(_address, Capacity, _alignment);
            lock (_gate)
            {
                _address = 0;
                _allocatorRelinquished = true;
            }
            _charge?.Dispose();
            _reservation?.Dispose();
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

    private sealed class RoleLease(NativeMemoryBlock owner, MemoryRoleKind role) : IDisposable
    {
        private NativeMemoryBlock? _owner = owner;
        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.ReleaseHold(HoldKind.Role, role);
    }

    private sealed class HostReadLease(MemoryContentIdentity content, MemoryLocationToken location,
        LeaseMemoryManager manager) : IMemoryHostReadLease
    {
        private LeaseMemoryManager? _manager = manager;
        public MemoryContentIdentity Content { get; } = content;
        public MemoryLocationToken Location { get; } = location;
        public ReadOnlyMemory<byte> Memory => (Volatile.Read(ref _manager)
            ?? throw new ObjectDisposedException(nameof(HostReadLease))).Memory;
        public void Dispose() => ((IDisposable?)Interlocked.Exchange(ref _manager, null))?.Dispose();
    }

    private sealed class LeaseMemoryManager(NativeMemoryBlock owner, nint address, int length, bool operation) : MemoryManager<byte>
    {
        private readonly object _gate = new();
        private NativeMemoryBlock? _owner = owner;

        public override unsafe Span<byte> GetSpan()
        {
            lock (_gate)
            {
                ObjectDisposedException.ThrowIf(_owner is null, this);
                return new Span<byte>((void*)address, length);
            }
        }

        public override unsafe MemoryHandle Pin(int elementIndex = 0)
        {
            lock (_gate)
            {
                ObjectDisposedException.ThrowIf(_owner is null, this);
                if ((uint)elementIndex > (uint)length)
                {
                    throw new ArgumentOutOfRangeException(nameof(elementIndex));
                }
                var token = new PinOwner(_owner);
                _owner.RetainPin();
                return new MemoryHandle((void*)(address + elementIndex), default, token);
            }
        }

        public override void Unpin() => throw new InvalidOperationException("Only the exact pin token can release its hold.");

        protected override void Dispose(bool disposing)
        {
            NativeMemoryBlock? old;
            lock (_gate)
            {
                old = _owner;
                _owner = null;
            }
            old?.ReleaseHold(operation ? HoldKind.Operation : HoldKind.Reader);
        }
    }

    private sealed class PinOwner(NativeMemoryBlock owner) : IPinnable
    {
        private NativeMemoryBlock? _owner = owner;
        public MemoryHandle Pin(int elementIndex) => throw new NotSupportedException("A pin token cannot create another pin.");
        public void Unpin() => Interlocked.Exchange(ref _owner, null)?.ReleaseHold(HoldKind.Pin);
    }
}
