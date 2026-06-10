using System.Buffers;

namespace FsusBlog.Core.Algorithms;

public sealed class AedsFrameBufferWriter : IBufferWriter<byte>, IDisposable
{
    private byte[] _buffer;
    private int _written;
    private bool _sealed;
    private bool _disposed;

    public AedsFrameBufferWriter(int initialCapacity = 1024)
    {
        _buffer = ArrayPool<byte>.Shared.Rent(Math.Max(AedsFrameHeader.Size + 1, initialCapacity));
        _written = AedsFrameHeader.Size;
    }

    public IBufferWriter<byte> PayloadWriter => this;
    public int PayloadLength => _written - AedsFrameHeader.Size;

    public ReadOnlySpan<byte> WrittenFrameSpan
    {
        get
        {
            ThrowIfDisposed();
            if (!_sealed)
            {
                throw new InvalidOperationException("AEDS frame must be sealed before reading.");
            }

            return _buffer.AsSpan(0, _written);
        }
    }

    public ReadOnlyMemory<byte> WrittenFrame
    {
        get
        {
            ThrowIfDisposed();
            if (!_sealed)
            {
                throw new InvalidOperationException("AEDS frame must be sealed before reading.");
            }

            return _buffer.AsMemory(0, _written);
        }
    }

    public void Seal(AedsFrameType frameType, uint flags = 0, ushort version = AedsFrameHeader.CurrentVersion)
    {
        ThrowIfDisposed();
        if (_sealed)
        {
            throw new InvalidOperationException("AEDS frame has already been sealed.");
        }

        ReadOnlySpan<byte> payload = _buffer.AsSpan(AedsFrameHeader.Size, PayloadLength);
        AedsEncoder.WriteHeaderInto(frameType, payload, version, flags, _buffer.AsSpan(0, AedsFrameHeader.Size));
        _sealed = true;
    }

    public void Advance(int count)
    {
        ThrowIfWritable();
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
        ThrowIfWritable();
        Ensure(sizeHint);
        return _buffer.AsMemory(_written);
    }

    public Span<byte> GetSpan(int sizeHint = 0)
    {
        ThrowIfWritable();
        Ensure(sizeHint);
        return _buffer.AsSpan(_written);
    }

    public void Write(ReadOnlySpan<byte> value)
    {
        Span<byte> target = GetSpan(value.Length);
        value.CopyTo(target);
        Advance(value.Length);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        ArrayPool<byte>.Shared.Return(_buffer, clearArray: true);
        _buffer = [];
        _written = 0;
        _disposed = true;
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

    private void ThrowIfWritable()
    {
        ThrowIfDisposed();
        if (_sealed)
        {
            throw new InvalidOperationException("Cannot write payload after sealing the AEDS frame.");
        }
    }

    private void ThrowIfDisposed()
    {
        if (_disposed)
        {
            throw new ObjectDisposedException(nameof(AedsFrameBufferWriter));
        }
    }
}
