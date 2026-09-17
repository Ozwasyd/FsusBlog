namespace FsusBlog.Core.Common;

public sealed class ReadOnlyMemoryStream(ReadOnlyMemory<byte> memory) : Stream
{
    private int _position;

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => memory.Length;

    public override long Position
    {
        get => _position;
        set
        {
            if (value < 0 || value > memory.Length)
            {
                throw new ArgumentOutOfRangeException(nameof(value));
            }

            _position = (int)value;
        }
    }

    public override int Read(byte[] buffer, int offset, int count)
        => Read(buffer.AsSpan(offset, count));

    public override int Read(Span<byte> buffer)
    {
        int available = memory.Length - _position;
        if (available <= 0)
        {
            return 0;
        }

        int count = Math.Min(buffer.Length, available);
        memory.Span.Slice(_position, count).CopyTo(buffer);
        _position += count;
        return count;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        long next = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => _position + offset,
            SeekOrigin.End => memory.Length + offset,
            _ => throw new ArgumentOutOfRangeException(nameof(origin))
        };

        Position = next;
        return _position;
    }

    public override void Flush()
    {
    }

    public override void SetLength(long value)
        => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count)
        => throw new NotSupportedException();
}
