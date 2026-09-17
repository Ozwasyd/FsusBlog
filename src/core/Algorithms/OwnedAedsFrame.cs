using System.Buffers;
using System.Runtime.InteropServices;

namespace FsusBlog.Core.Algorithms;

/// <summary>
/// Owns an immutable AEDS frame until it is retired and all outstanding read leases finish.
/// </summary>
public sealed class OwnedAedsFrame : IDisposable
{
    private readonly object _gate = new();
    private readonly ArrayPool<byte>? _pool;
    private readonly bool _requiresClear;
    private byte[]? _buffer;
    private Action<int>? _backingReleased;
    private int _activeReadLeases;
    private bool _retired;

    private OwnedAedsFrame(
        byte[] buffer,
        int logicalLength,
        AedsFrameType frameType,
        ArrayPool<byte>? pool)
    {
        // MEASUREMENT: Pool-versus-exact selection remains governed by the cache-miss evidence;
        // this owner alone does not imply a cache-hit throughput result.
        ArgumentNullException.ThrowIfNull(buffer);
        if (logicalLength < AedsFrameHeader.Size || logicalLength > buffer.Length)
        {
            throw new ArgumentOutOfRangeException(
                nameof(logicalLength),
                "An owned AEDS frame must include its header and fit within the backing buffer.");
        }

        _buffer = buffer;
        _pool = pool;
        _requiresClear = AedsFrameSensitivity.RequiresClear(frameType);
        LogicalLength = logicalLength;
        Capacity = buffer.Length;
        FrameType = frameType;
    }

    /// <summary>Gets the protocol frame type associated with the owned bytes.</summary>
    public AedsFrameType FrameType
    {
        get;
    }

    /// <summary>The number of bytes that belong to the encoded frame.</summary>
    public int LogicalLength
    {
        get;
    }

    /// <summary>The full backing-buffer capacity that counts toward resident memory.</summary>
    public int Capacity
    {
        get;
    }

    /// <summary>Gets whether the backing array must be returned to an array pool.</summary>
    public bool IsPooled => _pool is not null;

    /// <summary>Gets whether the backing array contains data that must be cleared on release.</summary>
    public bool RequiresClear => _requiresClear;

    /// <summary>Gets whether this owner has stopped accepting new read leases.</summary>
    public bool IsRetired
    {
        get
        {
            lock (_gate)
            {
                return _retired;
            }
        }
    }

    /// <summary>Gets the number of readers currently retaining the backing array.</summary>
    public int ActiveReadLeaseCount
    {
        get
        {
            lock (_gate)
            {
                return _activeReadLeases;
            }
        }
    }

    /// <summary>
    /// Transfers ownership of an exact managed frame array to a lifecycle-tracked owner.
    /// The caller must not mutate or retain the array after this call.
    /// </summary>
    public static OwnedAedsFrame TakeOwnership(byte[] frame, AedsFrameType frameType)
    {
        ArgumentNullException.ThrowIfNull(frame);
        return new OwnedAedsFrame(frame, frame.Length, frameType, pool: null);
    }

    internal static OwnedAedsFrame TakePooledOwnership(
        byte[] buffer,
        int logicalLength,
        AedsFrameType frameType,
        ArrayPool<byte> pool)
        => new(buffer, logicalLength, frameType, pool);

    /// <summary>
    /// Acquires a read lease or throws when the frame has already been retired.
    /// </summary>
    public OwnedAedsFrameReadLease AcquireReadLease()
    {
        if (TryAcquireReadLease(out OwnedAedsFrameReadLease? lease))
        {
            return lease!;
        }

        throw new ObjectDisposedException(
            nameof(OwnedAedsFrame),
            "The owned AEDS frame has been retired and cannot issue another read lease.");
    }

    /// <summary>
    /// Attempts to acquire a read lease without reviving a retired frame.
    /// </summary>
    public bool TryAcquireReadLease(out OwnedAedsFrameReadLease? lease)
    {
        lock (_gate)
        {
            if (_retired || _buffer is null)
            {
                lease = null;
                return false;
            }

            lease = new OwnedAedsFrameReadLease(
                _buffer,
                LogicalLength,
                ReleaseReadLease);
            _activeReadLeases++;
            return true;
        }
    }

    /// <summary>
    /// Stops new readers. The backing buffer is released after the final current reader exits.
    /// </summary>
    /// <returns><see langword="true"/> only for the call that first retires this owner.</returns>
    public bool Retire()
        => RetireCore(backingReleased: null);

    /// <summary>
    /// Stops new readers and invokes <paramref name="backingReleased"/> exactly once, after the
    /// backing buffer has been returned to its pool or cleared for final release. The callback
    /// lets a cache keep physical residency charged while an already-retired frame still has
    /// in-flight readers.
    /// </summary>
    public bool Retire(Action<int> backingReleased)
    {
        ArgumentNullException.ThrowIfNull(backingReleased);
        return RetireCore(backingReleased);
    }

    private bool RetireCore(Action<int>? backingReleased)
    {
        // OWNERSHIP: Retirement closes admission, but the final active lease still owns release timing.
        BufferRelease? release = null;
        lock (_gate)
        {
            if (_retired)
            {
                return false;
            }

            _retired = true;
            _backingReleased = backingReleased;
            if (_activeReadLeases == 0)
            {
                release = DetachBufferForRelease();
            }
        }

        ReleaseBuffer(release);
        return true;
    }

    /// <inheritdoc />
    public void Dispose() => Retire();

    private void ReleaseReadLease()
    {
        BufferRelease? release = null;
        lock (_gate)
        {
            if (_activeReadLeases <= 0)
            {
                throw new InvalidOperationException("An AEDS frame read lease was released more than once.");
            }

            _activeReadLeases--;
            if (_retired && _activeReadLeases == 0)
            {
                release = DetachBufferForRelease();
            }
        }

        ReleaseBuffer(release);
    }

    private BufferRelease? DetachBufferForRelease()
    {
        byte[]? buffer = _buffer;
        _buffer = null;
        Action<int>? backingReleased = _backingReleased;
        _backingReleased = null;
        return buffer is null ? null : new BufferRelease(buffer, backingReleased);
    }

    private void ReleaseBuffer(BufferRelease? release)
    {
        if (release is null)
        {
            return;
        }

        // SECURITY-INVARIANT: Pooled sensitive frames clear on return; exact frames clear before final release.
        if (_pool is not null)
        {
            try
            {
                _pool.Return(release.Value.Buffer, clearArray: _requiresClear);
            }
            finally
            {
                release.Value.BackingReleased?.Invoke(Capacity);
            }

            return;
        }

        if (_requiresClear)
        {
            release.Value.Buffer.AsSpan().Clear();
        }

        release.Value.BackingReleased?.Invoke(Capacity);
    }

    private readonly record struct BufferRelease(byte[] Buffer, Action<int>? BackingReleased);
}

/// <summary>
/// Holds one read reference to an <see cref="OwnedAedsFrame"/>.
/// </summary>
public sealed class OwnedAedsFrameReadLease : IDisposable
{
    private LeaseMemoryManager? _memoryManager;

    internal OwnedAedsFrameReadLease(
        byte[] buffer,
        int length,
        Action releaseOwnerReference)
    {
        _memoryManager = new LeaseMemoryManager(buffer, length, releaseOwnerReference);
    }

    /// <summary>Gets the leased frame bytes while this lease remains active.</summary>
    public ReadOnlyMemory<byte> Memory
    {
        get
        {
            LeaseMemoryManager manager = Volatile.Read(ref _memoryManager)
                ?? throw new ObjectDisposedException(nameof(OwnedAedsFrameReadLease));
            return manager.ReadOnlyMemory;
        }
    }

    /// <summary>Gets the logical frame length exposed by this lease.</summary>
    public int Length => Memory.Length;

    /// <inheritdoc />
    public void Dispose()
    {
        LeaseMemoryManager? manager = Interlocked.Exchange(ref _memoryManager, null);
        if (manager is not null)
        {
            ((IDisposable)manager).Dispose();
        }
    }

    private sealed class LeaseMemoryManager : MemoryManager<byte>
    {
        private readonly object _gate = new();
        private readonly int _length;
        private byte[]? _buffer;
        private Action? _releaseOwnerReference;
        private int _pinCount;
        private bool _disposed;

        public LeaseMemoryManager(
            byte[] buffer,
            int length,
            Action releaseOwnerReference)
        {
            _buffer = buffer;
            _length = length;
            _releaseOwnerReference = releaseOwnerReference;
        }

        public ReadOnlyMemory<byte> ReadOnlyMemory => Memory;

        public override Span<byte> GetSpan()
        {
            lock (_gate)
            {
                ThrowIfDisposed();
                return _buffer!.AsSpan(0, _length);
            }
        }

        public override unsafe MemoryHandle Pin(int elementIndex = 0)
        {
            lock (_gate)
            {
                ThrowIfDisposed();
                if ((uint)elementIndex > (uint)_length)
                {
                    throw new ArgumentOutOfRangeException(nameof(elementIndex));
                }

                GCHandle handle = GCHandle.Alloc(_buffer!, GCHandleType.Pinned);
                try
                {
                    _pinCount++;
                    void* pointer = (byte*)handle.AddrOfPinnedObject().ToPointer() + elementIndex;
                    return new MemoryHandle(pointer, handle, this);
                }
                catch
                {
                    _pinCount--;
                    handle.Free();
                    throw;
                }
            }
        }

        public override void Unpin()
        {
            Action? releaseOwnerReference = null;
            lock (_gate)
            {
                if (_pinCount <= 0)
                {
                    throw new InvalidOperationException("An AEDS frame memory handle was unpinned more than once.");
                }

                _pinCount--;
                releaseOwnerReference = DetachAfterDisposeIfReady();
            }

            releaseOwnerReference?.Invoke();
        }

        protected override void Dispose(bool disposing)
        {
            Action? releaseOwnerReference = null;
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _disposed = true;
                releaseOwnerReference = DetachAfterDisposeIfReady();
            }

            releaseOwnerReference?.Invoke();
        }

        private Action? DetachAfterDisposeIfReady()
        {
            if (!_disposed || _pinCount != 0)
            {
                return null;
            }

            _buffer = null;
            Action? releaseOwnerReference = _releaseOwnerReference;
            _releaseOwnerReference = null;
            return releaseOwnerReference;
        }

        private void ThrowIfDisposed()
        {
            if (_disposed || _buffer is null)
            {
                throw new ObjectDisposedException(nameof(OwnedAedsFrameReadLease));
            }
        }
    }
}
