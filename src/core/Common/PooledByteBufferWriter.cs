using System.Buffers;

namespace FsusBlog.Core.Common;

public sealed class PooledByteBufferWriter : IBufferWriter<byte>, IDisposable
{
    private byte[] _buffer;
    private int _written;
    private readonly bool _clearOnReturn;
    private bool _detached;
    private bool _disposed;

    public PooledByteBufferWriter(int initialCapacity = 256, bool clearOnReturn = false)
    {
        _clearOnReturn = clearOnReturn;
        _buffer = ArrayPool<byte>.Shared.Rent(Math.Max(256, initialCapacity));
    }

    public int WrittenCount
    {
        get
        {
            ThrowIfUnavailable();
            return _written;
        }
    }

    public ReadOnlySpan<byte> WrittenSpan
    {
        get
        {
            ThrowIfUnavailable();
            return _buffer.AsSpan(0, _written);
        }
    }

    public ReadOnlyMemory<byte> WrittenMemory
    {
        get
        {
            ThrowIfUnavailable();
            return _buffer.AsMemory(0, _written);
        }
    }

    public void Advance(int count)
    {
        ThrowIfUnavailable();
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
        ThrowIfUnavailable();
        Ensure(sizeHint);
        return _buffer.AsMemory(_written);
    }

    public Span<byte> GetSpan(int sizeHint = 0)
    {
        ThrowIfUnavailable();
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
        ThrowIfUnavailable();
        byte[] result = new byte[_written];
        _buffer.AsSpan(0, _written).CopyTo(result);
        return result;
    }

    public byte[] DetachBuffer(out int length)
    {
        ThrowIfUnavailable();
        byte[] buffer = _buffer;
        length = _written;
        _detached = true;
        _buffer = Array.Empty<byte>();
        _written = 0;
        return buffer;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        if (!_detached && _buffer.Length > 0)
        {
            ArrayPool<byte>.Shared.Return(_buffer, clearArray: _clearOnReturn);
        }

        _buffer = Array.Empty<byte>();
        _written = 0;
        _disposed = true;
    }

    private void ThrowIfUnavailable()
    {
        if (_disposed)
        {
            throw new ObjectDisposedException(nameof(PooledByteBufferWriter));
        }

        if (_detached)
        {
            throw new InvalidOperationException("The pooled buffer has been detached and is no longer owned by this writer.");
        }
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
        ArrayPool<byte>.Shared.Return(_buffer, clearArray: _clearOnReturn);
        _buffer = next;
    }
}
