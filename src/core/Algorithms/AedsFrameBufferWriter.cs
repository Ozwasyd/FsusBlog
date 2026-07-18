using System.Buffers;

namespace FsusBlog.Core.Algorithms;

/// <summary>
/// Builds one pooled AEDS frame in place and transfers ownership after the header is sealed.
/// </summary>
public sealed class AedsFrameBufferWriter : IBufferWriter<byte>, IDisposable
{
    private readonly ArrayPool<byte> _pool;
    private byte[] _buffer;
    private int _written;
    private bool _sealed;
    private bool _disposed;
    private bool _clearOnReturn = true;
    private AedsFrameType _frameType;

    /// <summary>
    /// Creates a writer with capacity reserved for both the AEDS header and payload.
    /// </summary>
    public AedsFrameBufferWriter(int initialCapacity = 1024, ArrayPool<byte>? pool = null)
    {
        _pool = pool ?? ArrayPool<byte>.Shared;
        _buffer = _pool.Rent(Math.Max(AedsFrameHeader.Size + 1, initialCapacity));
        _written = AedsFrameHeader.Size;
    }

    /// <summary>Gets the buffer writer used to append payload bytes.</summary>
    public IBufferWriter<byte> PayloadWriter => this;

    /// <summary>Gets the number of payload bytes written after the reserved header.</summary>
    public int PayloadLength => _written - AedsFrameHeader.Size;

    /// <summary>Gets the sealed frame as a read-only span owned by this writer.</summary>
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

    /// <summary>Gets the sealed frame as read-only memory owned by this writer.</summary>
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

    /// <summary>
    /// Writes the AEDS header and prevents additional payload writes.
    /// </summary>
    public void Seal(AedsFrameType frameType, uint flags = 0, ushort version = AedsFrameHeader.CurrentVersion)
    {
        ThrowIfDisposed();
        if (_sealed)
        {
            throw new InvalidOperationException("AEDS frame has already been sealed.");
        }

        ReadOnlySpan<byte> payload = _buffer.AsSpan(AedsFrameHeader.Size, PayloadLength);
        AedsEncoder.WriteHeaderInto(frameType, payload, version, flags, _buffer.AsSpan(0, AedsFrameHeader.Size));
        _clearOnReturn = AedsFrameSensitivity.RequiresClear(frameType);
        _frameType = frameType;
        _sealed = true;
    }

    /// <summary>
    /// Transfers the sealed pooled frame to an independent lifecycle-tracked owner.
    /// </summary>
    public OwnedAedsFrame DetachOwnedFrame()
    {
        ThrowIfDisposed();
        if (!_sealed)
        {
            throw new InvalidOperationException("AEDS frame must be sealed before transferring ownership.");
        }

        OwnedAedsFrame ownedFrame = OwnedAedsFrame.TakePooledOwnership(
            _buffer,
            _written,
            _frameType,
            _pool);
        _buffer = [];
        _written = 0;
        _disposed = true;
        return ownedFrame;
    }

    /// <inheritdoc />
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

    /// <inheritdoc />
    public Memory<byte> GetMemory(int sizeHint = 0)
    {
        ThrowIfWritable();
        Ensure(sizeHint);
        return _buffer.AsMemory(_written);
    }

    /// <inheritdoc />
    public Span<byte> GetSpan(int sizeHint = 0)
    {
        ThrowIfWritable();
        Ensure(sizeHint);
        return _buffer.AsSpan(_written);
    }

    /// <summary>Appends the supplied bytes to the frame payload.</summary>
    public void Write(ReadOnlySpan<byte> value)
    {
        Span<byte> target = GetSpan(value.Length);
        value.CopyTo(target);
        Advance(value.Length);
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _pool.Return(_buffer, clearArray: _clearOnReturn);
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
        byte[] next = _pool.Rent(newSize);
        _buffer.AsSpan(0, _written).CopyTo(next);
        // The frame type is not known until Seal, so intermediate buffers are sensitive.
        _pool.Return(_buffer, clearArray: true);
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
