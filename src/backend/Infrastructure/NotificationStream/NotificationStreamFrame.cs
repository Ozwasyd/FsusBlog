using System.Buffers;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

public sealed class SharedNotificationStreamFrame
{
    private readonly byte[]? _buffer;
    private readonly ArrayPool<byte>? _pool;
    private readonly IMemoryOwner<byte>? _memoryOwner;
    // Ownership invariant: a frame starts with one owner. Publishers Retain once per fan-out
    // target, and the target queue must either consume that retain on success or Release it
    // on reject. The pooled buffer is returned only at zero.
    private int _refCount;

    private SharedNotificationStreamFrame(byte[] buffer, int length, ArrayPool<byte>? pool)
    {
        _buffer = buffer;
        Length = length;
        _pool = pool;
        _refCount = 1;
    }

    private SharedNotificationStreamFrame(IMemoryOwner<byte> memoryOwner, int length)
    {
        _memoryOwner = memoryOwner;
        Length = length;
        _refCount = 1;
    }

    public int Length
    {
        get;
    }

    public ReadOnlyMemory<byte> Memory
    {
        get
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref _refCount) <= 0, this);
            return _memoryOwner is null ? _buffer.AsMemory(0, Length) : _memoryOwner.Memory[..Length];
        }
    }

    internal ReadOnlyMemory<byte> BufferMemory => Memory;

    // OWNERSHIP: Only the admitted adapter transfers this owner. No mutable view escapes
    // after transfer; existing per-recipient retains hold it through actual completion.
    internal static SharedNotificationStreamFrame FromOwnedMemory(IMemoryOwner<byte> owner, int length)
    {
        ArgumentNullException.ThrowIfNull(owner);
        if (length <= 0 || length > owner.Memory.Length)
        {
            throw new ArgumentOutOfRangeException(nameof(length));
        }
        return new SharedNotificationStreamFrame(owner, length);
    }

    public static SharedNotificationStreamFrame FromOwnedBuffer(byte[] buffer, int length)
        => FromOwnedBuffer(buffer, length, ArrayPool<byte>.Shared);

    internal static SharedNotificationStreamFrame FromOwnedBuffer(
        byte[] buffer,
        int length,
        ArrayPool<byte> pool)
    {
        ArgumentNullException.ThrowIfNull(pool);
        return new SharedNotificationStreamFrame(buffer, length, pool);
    }

    public static SharedNotificationStreamFrame FromArray(byte[] buffer)
        => new(buffer, buffer.Length, pool: null);

    public void Retain()
    {
        while (true)
        {
            int current = Volatile.Read(ref _refCount);
            if (current <= 0)
            {
                throw new ObjectDisposedException(nameof(SharedNotificationStreamFrame), "Cannot retain a released notification stream frame.");
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
            throw new InvalidOperationException("SharedNotificationStreamFrame released more times than it was retained.");
        }

        if (remaining != 0)
        {
            return;
        }

        if (_pool is not null)
        {
            _pool.Return(_buffer!, clearArray: true);
        }
        _memoryOwner?.Dispose();
    }
}
