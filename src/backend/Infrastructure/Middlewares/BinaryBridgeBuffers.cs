using System.Buffers;

namespace FsusBlog.Server.Infrastructure.Middlewares;

internal sealed class BinaryBridgeRequestPayload(PooledBinaryBridgeBuffer owner, ReadOnlyMemory<byte> payload) : IDisposable
{
    private PooledBinaryBridgeBuffer? _owner = owner;

    public ReadOnlyMemory<byte> Payload => payload;

    public void Dispose()
    {
        _owner?.Dispose();
        _owner = null;
    }
}

internal sealed class PooledBinaryBridgeBuffer : IDisposable
{
    private byte[] _buffer;
    private readonly int _maxBytes;
    private readonly Stream _stream;
    private int _written;
    private bool _disposed;

    public PooledBinaryBridgeBuffer(int initialCapacity = 16 * 1024, int maxBytes = int.MaxValue)
    {
        if (maxBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxBytes));
        }

        _maxBytes = maxBytes;
        _buffer = ArrayPool<byte>.Shared.Rent(Math.Min(Math.Max(1, initialCapacity), maxBytes));
        _stream = new BufferWriteStream(this);
    }

    public int Length => _written;

    public ReadOnlyMemory<byte> WrittenMemory
    {
        get
        {
            ThrowIfDisposed();
            return _buffer.AsMemory(0, _written);
        }
    }

    public Stream Stream
    {
        get
        {
            ThrowIfDisposed();
            return _stream;
        }
    }

    public void Write(ReadOnlySpan<byte> source)
    {
        ThrowIfDisposed();
        Ensure(source.Length);
        source.CopyTo(_buffer.AsSpan(_written));
        _written += source.Length;
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

    private void Ensure(int appendLength)
    {
        if (appendLength < 0 || _written > _maxBytes - appendLength)
        {
            throw new InvalidOperationException("binary_bridge_frame_too_large");
        }

        int required = _written + appendLength;
        if (required <= _buffer.Length)
        {
            return;
        }

        int nextLength = _buffer.Length;
        do
        {
            nextLength = Math.Min(nextLength * 2, _maxBytes);
        }
        while (nextLength < required);

        byte[] next = ArrayPool<byte>.Shared.Rent(nextLength);
        _buffer.AsSpan(0, _written).CopyTo(next);
        ArrayPool<byte>.Shared.Return(_buffer, clearArray: true);
        _buffer = next;
    }

    private void ThrowIfDisposed()
    {
        if (_disposed)
        {
            throw new ObjectDisposedException(nameof(PooledBinaryBridgeBuffer));
        }
    }

    private sealed class BufferWriteStream(PooledBinaryBridgeBuffer owner) : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => owner.Length;

        public override long Position
        {
            get => owner.Length;
            set => throw new NotSupportedException();
        }

        public override void Flush()
        {
        }

        public override Task FlushAsync(CancellationToken cancellationToken)
            => Task.CompletedTask;

        public override int Read(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin)
            => throw new NotSupportedException();

        public override void SetLength(long value)
            => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count)
            => owner.Write(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> buffer)
            => owner.Write(buffer);

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            owner.Write(buffer.Span);
            return ValueTask.CompletedTask;
        }
    }
}

internal sealed class ReadOnlyMemoryStream(ReadOnlyMemory<byte> source) : Stream
{
    private int _position;

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => source.Length;

    public override long Position
    {
        get => _position;
        set
        {
            ArgumentOutOfRangeException.ThrowIfNegative(value);
            if (value > source.Length)
            {
                throw new ArgumentOutOfRangeException(nameof(value));
            }

            _position = (int)value;
        }
    }

    public override void Flush()
    {
    }

    public override int Read(byte[] buffer, int offset, int count)
        => Read(buffer.AsSpan(offset, count));

    public override int Read(Span<byte> buffer)
    {
        int read = Math.Min(buffer.Length, source.Length - _position);
        if (read <= 0)
        {
            return 0;
        }

        source.Span.Slice(_position, read).CopyTo(buffer);
        _position += read;
        return read;
    }

    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(Read(buffer.Span));
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        long next = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => _position + offset,
            SeekOrigin.End => source.Length + offset,
            _ => throw new ArgumentOutOfRangeException(nameof(origin))
        };

        Position = next;
        return _position;
    }

    public override void SetLength(long value)
        => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count)
        => throw new NotSupportedException();
}
