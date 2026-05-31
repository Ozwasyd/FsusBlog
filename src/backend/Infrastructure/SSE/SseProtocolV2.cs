using System.Buffers;

namespace FsusBlog.Server.Infrastructure.Sse;

public sealed class SharedSseFrame
{
    private readonly byte[] _buffer;
    private readonly bool _pooled;
    // Ownership invariant: a frame starts with one owner, publishers call Retain before fan-out,
    // and every owner must call Release exactly once. The pooled buffer is returned only at zero.
    private int _refCount;

    private SharedSseFrame(byte[] buffer, int length, bool pooled)
    {
        _buffer = buffer;
        Length = length;
        _pooled = pooled;
        _refCount = 1;
    }

    public int Length { get; }

    public ReadOnlyMemory<byte> Memory => _buffer.AsMemory(0, Length);

    internal ReadOnlyMemory<byte> BufferMemory => _buffer.AsMemory(0, Length);

    public static SharedSseFrame FromOwnedBuffer(byte[] buffer, int length) => new(buffer, length, pooled: true);

    public static SharedSseFrame FromArray(byte[] buffer) => new(buffer, buffer.Length, pooled: false);

    public void Retain()
    {
        while (true)
        {
            int current = Volatile.Read(ref _refCount);
            if (current <= 0)
            {
                throw new ObjectDisposedException(nameof(SharedSseFrame), "Cannot retain a released SSE frame.");
            }

            if (Interlocked.CompareExchange(ref _refCount, current + 1, current) == current)
            {
                return;
            }
        }
    }

    public void Release()
    {
        int remaining = Interlocked.Decrement(ref _refCount);
        if (remaining < 0)
        {
            throw new InvalidOperationException("SharedSseFrame released more times than it was retained.");
        }

        if (remaining != 0)
        {
            return;
        }

        if (_pooled)
        {
            ArrayPool<byte>.Shared.Return(_buffer, clearArray: true);
        }
    }
}
