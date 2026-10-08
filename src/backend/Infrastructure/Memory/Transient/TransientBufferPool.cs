using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Transient;

/// <summary>
/// Owns finite managed buckets charged to the shared coordinator before allocation.
/// Returning a lease clears its full capacity; retained buckets keep their original charge.
/// </summary>
public sealed class TransientBufferPool : IDisposable
{
    private readonly object _gate = new();
    private readonly MemoryReservationCoordinator _ledger;
    private readonly ResourceDomainId _domain;
    private readonly TransientBufferPoolLimits _limits;
    private readonly List<Buffer> _retained = [];
    private readonly TaskCompletionSource _drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _holds;
    private long _leasedBytes;
    private long _retainedBytes;
    private bool _closing;
    private MemoryCapabilityMode _mode;

    public TransientBufferPool(MemoryReservationCoordinator ledger, ResourceDomainId domain,
        TransientWorkload workload, TransientBufferPoolLimits limits,
        MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(limits);
        if (domain.Value == Guid.Empty || !Enum.IsDefined(workload)
            || limits.MaximumBufferBytes <= 0 || limits.MaximumBufferBytes > Array.MaxLength
            || limits.MaximumHolds <= 0 || limits.MaximumRetainedBuffers < 0 || limits.MaximumRetainedBytes < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(limits));
        }
        _ledger = ledger;
        _domain = domain;
        _limits = limits;
        _mode = MemoryCapabilityPolicy.Validate(mode);
        Workload = workload;
    }

    public TransientWorkload Workload
    {
        get;
    }
    public Task Drained => _drained.Task;

    public MemoryOperationResult<TransientBufferLease> TryRent(int length)
    {
        if (length <= 0 || length > _limits.MaximumBufferBytes)
        {
            return MemoryOperationResult<TransientBufferLease>.Reject(MemoryFailure.BoundsViolation);
        }
        // BUCKET: Unlike an uncontrolled third-party pool, capacity is known before rent.
        int capacity = 1;
        while (capacity < length && capacity <= _limits.MaximumBufferBytes / 2)
        {
            capacity *= 2;
        }
        capacity = capacity < length ? _limits.MaximumBufferBytes : capacity;
        lock (_gate)
        {
            if (_closing)
            {
                return MemoryOperationResult<TransientBufferLease>.Reject(MemoryFailure.OwnershipViolation);
            }
            if (_holds >= _limits.MaximumHolds)
            {
                return MemoryOperationResult<TransientBufferLease>.Reject(MemoryFailure.BudgetRejected);
            }
            capacity = _mode == MemoryCapabilityMode.Disabled ? length : capacity;
            int retainedIndex = _retained.FindIndex(buffer => buffer.Bytes.Length == capacity);
            Buffer buffer;
            if (retainedIndex >= 0)
            {
                buffer = _retained[retainedIndex];
                var lease = new TransientBufferLease(this, buffer, length);
                var result = MemoryOperationResult<TransientBufferLease>.Success(lease);
                _retained.RemoveAt(retainedIndex);
                _retainedBytes -= capacity;
                buffer.Holds = 1;
                _holds++;
                _leasedBytes += capacity;
                return result;
            }
            MemoryResourceCharge[] vector = [new(_domain, MemoryResourceUnit.Bytes, capacity)];
            MemoryOperationResult<MemoryReservation> admission = _ledger.TryReserve(vector);
            if (!admission.Succeeded)
            {
                return MemoryOperationResult<TransientBufferLease>.Reject(admission.Failure!.Value);
            }
            using MemoryReservation reservation = admission.Value!;
            byte[] bytes = new byte[capacity];
            IMemoryAllocationCharge? charge = null;
            bool transferred = false;
            try
            {
                var layout = MemoryAllocationLayout.TryCreate(length, capacity, 1).Value!;
                var descriptor = new MemoryAllocationDescriptor(new(Guid.NewGuid()), _domain, layout);
                MemoryOperationResult<IMemoryAllocationCharge> conversion = reservation.CommitPhysical(descriptor, vector);
                if (!conversion.Succeeded)
                {
                    return MemoryOperationResult<TransientBufferLease>.Reject(conversion.Failure!.Value);
                }
                charge = conversion.Value!;
                buffer = new Buffer(bytes, charge);
                var result = MemoryOperationResult<TransientBufferLease>.Success(new(this, buffer, length));
                _holds++;
                _leasedBytes += capacity;
                transferred = true;
                return result;
            }
            finally
            {
                if (!transferred)
                {
                    Array.Clear(bytes);
                    charge?.Dispose();
                }
            }
        }
    }

    public TransientBufferPoolSnapshot Snapshot()
    {
        lock (_gate)
        {
            return new(Workload, _holds, _leasedBytes, _retained.Count, _retainedBytes, _closing);
        }
    }

    /// <summary>Consumes the common policy decision; disable trims idle buckets and preserves live holds.</summary>
    public void ApplyMode(MemoryCapabilityMode mode)
    {
        MemoryCapabilityPolicy.Validate(mode);
        lock (_gate)
        {
            _mode = mode;
            if (mode == MemoryCapabilityMode.Disabled)
            {
                Trim(int.MaxValue);
            }
        }
    }

    /// <summary>Releases at most the caller's finite trim batch; outstanding leases are unaffected.</summary>
    public int Trim(int maximumBuffers)
    {
        if (maximumBuffers <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumBuffers));
        }
        lock (_gate)
        {
            int count = Math.Min(maximumBuffers, _retained.Count);
            for (int index = 0; index < count; index++)
            {
                Buffer buffer = _retained[^1];
                // RELEASE: Clear precedes refund; a managed refund is not proof of OS reclamation.
                Array.Clear(buffer.Bytes);
                buffer.Charge.Dispose();
                _retained.RemoveAt(_retained.Count - 1);
                _retainedBytes -= buffer.Bytes.Length;
            }
            return count;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _closing = true;
            Trim(int.MaxValue);
            CompleteDrain();
        }
    }

    internal void Retain(Buffer buffer)
    {
        lock (_gate)
        {
            if (buffer.Holds <= 0)
            {
                throw new ObjectDisposedException(nameof(TransientBufferLease));
            }
            // Existing consumers may finish while the pool closes; new rent stays disabled.
            if (_holds >= _limits.MaximumHolds)
            {
                throw new InsufficientMemoryException("The finite transient hold budget rejected retention.");
            }
            buffer.Holds++;
            _holds++;
        }
    }

    internal void Return(Buffer buffer)
    {
        lock (_gate)
        {
            if (buffer.Holds <= 0)
            {
                throw new InvalidOperationException("Transient buffer ownership underflow.");
            }
            if (buffer.Holds == 1)
            {
                Array.Clear(buffer.Bytes);
                bool retain = !_closing && _mode != MemoryCapabilityMode.Disabled
                    && _retained.Count < _limits.MaximumRetainedBuffers
                    && buffer.Bytes.Length <= _limits.MaximumRetainedBytes - _retainedBytes;
                if (retain)
                {
                    _retained.Add(buffer);
                    _retainedBytes += buffer.Bytes.Length;
                }
                else
                {
                    buffer.Charge.Dispose();
                }
                _leasedBytes -= buffer.Bytes.Length;
            }
            buffer.Holds--;
            _holds--;
            CompleteDrain();
        }
    }

    private void CompleteDrain()
    {
        if (_closing && _holds == 0 && _retained.Count == 0)
        {
            _drained.TrySetResult();
        }
    }

    internal sealed class Buffer(byte[] bytes, IMemoryAllocationCharge charge)
    {
        public byte[] Bytes { get; } = bytes;
        public IMemoryAllocationCharge Charge { get; } = charge;
        public int Holds { get; set; } = 1;
    }
}
