using System.Buffers;
using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Transient;

/// <summary>
/// Owns a logical buffer view. Captured Memory rejects access after disposal; pins and
/// asynchronous consumer holds keep the actual bucket charged until their terminal event.
/// </summary>
public sealed class TransientBufferLease : MemoryManager<byte>
{
    private readonly object _gate = new();
    private readonly TransientBufferPool _pool;
    private readonly int _length;
    private TransientBufferPool.Buffer? _buffer;

    internal TransientBufferLease(TransientBufferPool pool, TransientBufferPool.Buffer buffer, int length)
    {
        _pool = pool;
        _buffer = buffer;
        _length = length;
    }

    public int Capacity => RequireBuffer().Bytes.Length;
    public AllocationId Allocation => RequireBuffer().Charge.Allocation;

    public override Span<byte> GetSpan()
    {
        lock (_gate)
        {
            return RequireBuffer().Bytes.AsSpan(0, _length);
        }
    }

    /// <summary>The returned task owns a separate hold, including when an outer wait cancels.</summary>
    public async ValueTask ConsumeAsync(Func<Memory<byte>, CancellationToken, ValueTask> consumer,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(consumer);
        TransientBufferLease operation;
        lock (_gate)
        {
            TransientBufferPool.Buffer buffer = RequireBuffer();
            operation = new(_pool, buffer, _length);
            _pool.Retain(buffer);
        }
        using (operation)
        {
            await consumer(operation.Memory, cancellationToken).ConfigureAwait(false);
        }
    }

    public override unsafe MemoryHandle Pin(int elementIndex = 0)
    {
        lock (_gate)
        {
            if ((uint)elementIndex > (uint)_length)
            {
                throw new ArgumentOutOfRangeException(nameof(elementIndex));
            }
            TransientBufferPool.Buffer buffer = RequireBuffer();
            var pin = new PinHold(_pool, buffer);
            _pool.Retain(buffer);
            GCHandle handle = default;
            try
            {
                handle = GCHandle.Alloc(buffer.Bytes, GCHandleType.Pinned);
                pin.Handle = handle;
                return new MemoryHandle((byte*)handle.AddrOfPinnedObject() + elementIndex, default, pin);
            }
            catch
            {
                if (handle.IsAllocated)
                {
                    handle.Free();
                }
                _pool.Return(buffer);
                throw;
            }
        }
    }

    public override void Unpin() => throw new InvalidOperationException("Dispose the exact pin token.");

    protected override void Dispose(bool disposing)
    {
        TransientBufferPool.Buffer? buffer;
        lock (_gate)
        {
            buffer = _buffer;
            _buffer = null;
        }
        if (buffer is not null)
        {
            _pool.Return(buffer);
        }
    }

    private TransientBufferPool.Buffer RequireBuffer()
        => Volatile.Read(ref _buffer) ?? throw new ObjectDisposedException(nameof(TransientBufferLease));

    private sealed class PinHold : IPinnable
    {
        private int _disposed;
        private TransientBufferPool? _pool;
        private TransientBufferPool.Buffer? _buffer;
        public PinHold(TransientBufferPool pool, TransientBufferPool.Buffer buffer)
        {
            _pool = pool;
            _buffer = buffer;
        }
        public GCHandle Handle
        {
            get;
            set;
        }
        public MemoryHandle Pin(int elementIndex) => throw new NotSupportedException();
        public void Unpin()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                TransientBufferPool.Buffer buffer = Interlocked.Exchange(ref _buffer, null)!;
                TransientBufferPool pool = Interlocked.Exchange(ref _pool, null)!;
                Handle.Free();
                Handle = default;
                pool.Return(buffer);
            }
        }
    }
}
