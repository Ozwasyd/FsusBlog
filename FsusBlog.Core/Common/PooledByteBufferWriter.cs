using System.Buffers;

namespace FsusBlog.Core.Common;

public sealed class PooledByteBufferWriter : IBufferWriter<byte>, IDisposable
{
    private byte[] _buffer;
    private int _written;

    public PooledByteBufferWriter(int initialCapacity = 256)
    {
        _buffer = ArrayPool<byte>.Shared.Rent(Math.Max(256, initialCapacity));
    }

    public int WrittenCount => _written;

    public ReadOnlySpan<byte> WrittenSpan => _buffer.AsSpan(0, _written);

    public ReadOnlyMemory<byte> WrittenMemory => _buffer.AsMemory(0, _written);

    public void Advance(int count)
    {
        if (count < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(count));
        }

        if (_written + count > _buffer.Length)
        {
            throw new InvalidOperationException("Cannot advance past the current buffer capacity.");
        }

        _written += count;
    }

    public Memory<byte> GetMemory(int sizeHint = 0)
    {
        Ensure(sizeHint);
        return _buffer.AsMemory(_written);
    }

    public Span<byte> GetSpan(int sizeHint = 0)
    {
        Ensure(sizeHint);
        return _buffer.AsSpan(_written);
    }

    public void Write(ReadOnlySpan<byte> value)
    {
        Span<byte> target = GetSpan(value.Length);
        value.CopyTo(target);
        Advance(value.Length);
    }

    public byte[] ToArray()
    {
        byte[] result = new byte[_written];
        _buffer.AsSpan(0, _written).CopyTo(result);
        return result;
    }

    public byte[] DetachBuffer(out int length)
    {
        byte[] buffer = _buffer;
        length = _written;
        _buffer = Array.Empty<byte>();
        _written = 0;
        return buffer;
    }

    public void Dispose()
    {
        if (_buffer.Length == 0)
        {
            return;
        }

        ArrayPool<byte>.Shared.Return(_buffer, clearArray: true);
        _buffer = Array.Empty<byte>();
        _written = 0;
    }

    private void Ensure(int sizeHint)
    {
        if (sizeHint <= 0)
        {
            sizeHint = 1;
        }

        int remaining = _buffer.Length - _written;
        if (remaining >= sizeHint)
        {
            return;
        }

        int newSize = Math.Max(_buffer.Length * 2, _written + sizeHint);
        byte[] next = ArrayPool<byte>.Shared.Rent(newSize);
        _buffer.AsSpan(0, _written).CopyTo(next);
        ArrayPool<byte>.Shared.Return(_buffer, clearArray: true);
        _buffer = next;
    }
}
