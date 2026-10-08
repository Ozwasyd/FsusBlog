using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Host;

/// <summary>
/// Owns bounded candidate blocks until Seal transfers them to exactly one arena.
/// Append copies input; no writable pointer, Span or Memory escapes this builder.
/// </summary>
public sealed class NativeMemoryArenaBuilder : IDisposable
{
    private readonly object _gate = new();
    private readonly MemoryReservationCoordinator _ledger;
    private readonly ResourceDomainId _payloadDomain;
    private readonly ResourceDomainId _operationDomain;
    private readonly NativeMemoryArenaPolicy _policy;
    private readonly INativeMemoryAllocator _allocator;
    private readonly List<NativeMemoryBlock> _blocks = [];
    private readonly List<NativeMemorySlice> _slices = [];
    private NativeMemoryBlock? _currentNormal;
    private long _capacity;
    private BuilderState _state;

    public NativeMemoryArenaBuilder(MemoryReservationCoordinator ledger, ResourceDomainId payloadDomain,
        ResourceDomainId operationDomain, NativeMemoryArenaPolicy policy)
        : this(ledger, payloadDomain, operationDomain, policy, NativeMemoryAllocator.Instance)
    {
    }

    internal NativeMemoryArenaBuilder(MemoryReservationCoordinator ledger, ResourceDomainId payloadDomain,
        ResourceDomainId operationDomain, NativeMemoryArenaPolicy policy, INativeMemoryAllocator allocator)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(policy);
        ArgumentNullException.ThrowIfNull(allocator);
        if (payloadDomain.Value == Guid.Empty || operationDomain.Value == Guid.Empty)
        {
            throw new ArgumentException("Payload and operation resource domains are required.");
        }
        _ledger = ledger;
        _payloadDomain = payloadDomain;
        _operationDomain = operationDomain;
        _policy = policy;
        _allocator = allocator;
    }

    public MemoryOperationResult<NativeMemorySlice> TryAppend(MemoryContentIdentity content,
        ResidencyRevision revision, DeviceEpoch epoch, ReadOnlySpan<byte> payload)
    {
        content.Validate();
        lock (_gate)
        {
            if (_state != BuilderState.Building)
            {
                return MemoryOperationResult<NativeMemorySlice>.Reject(MemoryFailure.OwnershipViolation);
            }
            if (revision.Value == 0 || epoch.Value == 0 || payload.IsEmpty)
            {
                return MemoryOperationResult<NativeMemorySlice>.Reject(MemoryFailure.BoundsViolation);
            }
            if (_slices.Count >= _policy.MaximumSlices)
            {
                return MemoryOperationResult<NativeMemorySlice>.Reject(MemoryFailure.BudgetRejected);
            }
            MemoryOperationResult<MemoryAllocationLayout> plan = _policy.Plan(payload.Length);
            if (!plan.Succeeded)
            {
                return MemoryOperationResult<NativeMemorySlice>.Reject(plan.Failure!.Value);
            }
            try
            {
                NativeMemoryBlock? block = _currentNormal;
                if (block is null || payload.Length > block.Capacity - block.LogicalLength)
                {
                    MemoryOperationResult<NativeMemoryBlock> allocation = Allocate((int)plan.Value!.CapacityBytes);
                    if (!allocation.Succeeded)
                    {
                        FailAndClean();
                        return MemoryOperationResult<NativeMemorySlice>.Reject(allocation.Failure!.Value);
                    }
                    block = allocation.Value!;
                    // A separately bounded oversized blob gets a dedicated block.
                    if (block.Capacity == _policy.BlockCapacity)
                    {
                        _currentNormal = block;
                    }
                }
                var location = new MemoryLocationToken(block.Allocation, block.Block, revision, epoch);
                var slice = new NativeMemorySlice(block, content, location, block.LogicalLength, payload.Length);
                var result = MemoryOperationResult<NativeMemorySlice>.Success(slice);
                _slices.Add(slice);
                block.Append(payload);
                return result;
            }
            catch (OutOfMemoryException)
            {
                FailAndClean();
                // The common failure contract has no AllocationFailed value. This
                // is backend unavailability, never a fabricated budget rejection.
                return MemoryOperationResult<NativeMemorySlice>.Reject(MemoryFailure.TierUnavailable);
            }
            catch
            {
                FailAndClean();
                throw;
            }
        }
    }

    public MemoryOperationResult<NativeMemoryArena> Seal()
    {
        lock (_gate)
        {
            if (_state != BuilderState.Building)
            {
                return MemoryOperationResult<NativeMemoryArena>.Reject(MemoryFailure.OwnershipViolation);
            }
            try
            {
                var arena = new NativeMemoryArena(_blocks.ToArray(), _slices.ToArray());
                var result = MemoryOperationResult<NativeMemoryArena>.Success(arena);
                foreach (NativeMemoryBlock block in _blocks)
                {
                    MemoryFailure? failure = block.Commit();
                    if (failure is not null)
                    {
                        FailAndClean();
                        return MemoryOperationResult<NativeMemoryArena>.Reject(failure.Value);
                    }
                }
                foreach (NativeMemoryBlock block in _blocks)
                {
                    block.Publish();
                }
                _state = BuilderState.Sealed;
                _blocks.Clear();
                _slices.Clear();
                _currentNormal = null;
                return result;
            }
            catch (OutOfMemoryException)
            {
                FailAndClean();
                return MemoryOperationResult<NativeMemoryArena>.Reject(MemoryFailure.TierUnavailable);
            }
            catch
            {
                FailAndClean();
                throw;
            }
        }
    }

    private MemoryOperationResult<NativeMemoryBlock> Allocate(int capacity)
    {
        if (_blocks.Count >= _policy.MaximumBlocks || capacity > _policy.MaximumArenaCapacity - _capacity)
        {
            return MemoryOperationResult<NativeMemoryBlock>.Reject(MemoryFailure.BudgetRejected);
        }
        MemoryOperationResult<MemoryReservation> admission = _ledger.TryReserve(
            [new(_payloadDomain, MemoryResourceUnit.Bytes, capacity)]);
        if (!admission.Succeeded)
        {
            return MemoryOperationResult<NativeMemoryBlock>.Reject(admission.Failure!.Value);
        }
        MemoryReservation reservation = admission.Value!;
        nint address = 0;
        bool transferred = false;
        try
        {
            address = _allocator.Allocate(capacity, _policy.Alignment);
            if (address == 0)
            {
                return MemoryOperationResult<NativeMemoryBlock>.Reject(MemoryFailure.TierUnavailable);
            }
            var block = new NativeMemoryBlock(_allocator, _ledger, _payloadDomain, _operationDomain,
                reservation, address, capacity, _policy);
            var result = MemoryOperationResult<NativeMemoryBlock>.Success(block);
            _blocks.Add(block);
            _capacity = checked(_capacity + capacity);
            transferred = true;
            return result;
        }
        finally
        {
            if (!transferred)
            {
                if (address != 0)
                {
                    _allocator.ClearAndFree(address, capacity, _policy.Alignment);
                }
                reservation.Dispose();
            }
        }
    }

    private void FailAndClean()
    {
        _state = BuilderState.Failed;
        CloseBlocks();
    }

    private void CloseBlocks()
    {
        // CLEANUP: Attempt every task-owned block even if a ledger release faults.
        Exception? first = null;
        foreach (NativeMemoryBlock block in _blocks)
        {
            try
            {
                block.Close();
            }
            catch (Exception exception)
            {
                first ??= exception;
            }
        }
        _blocks.Clear();
        _slices.Clear();
        _currentNormal = null;
        if (first is not null)
        {
            throw new InvalidOperationException("Native builder cleanup faulted.", first);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_state == BuilderState.Building)
            {
                _state = BuilderState.Disposed;
                CloseBlocks();
            }
        }
    }

    private enum BuilderState
    {
        Building, Sealed, Disposed, Failed
    }
}
