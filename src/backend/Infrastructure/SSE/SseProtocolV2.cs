using System.Buffers;

namespace FsusBlog.Server.Infrastructure.Sse;

public sealed class SharedSseFrame
{
    private readonly byte[] _buffer;
    private readonly bool _pooled;
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

    public void Retain() => Interlocked.Increment(ref _refCount);

    public void Release()
    {
        if (Interlocked.Decrement(ref _refCount) != 0)
        {
            return;
        }

        if (_pooled)
        {
            ArrayPool<byte>.Shared.Return(_buffer, clearArray: true);
        }
    }
}
