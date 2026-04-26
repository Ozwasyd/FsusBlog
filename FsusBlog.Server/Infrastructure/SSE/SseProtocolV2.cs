using System.Buffers;
using System.Buffers.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlog.Shared.Contracts.Sse;

namespace FsusBlog.Server.Infrastructure.Sse;

internal static class SseProtocolV2
{
    private static readonly ReadOnlyMemory<byte> HeartbeatBytes = ":hb\n\n"u8.ToArray();

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public const string Version = "2";

    public static ReadOnlyMemory<byte> HeartbeatFrame => HeartbeatBytes;

    public static SharedSseFrame CreateFrame<TPayload>(long eventId, SseEventType eventType, long timestampUnixMs, TPayload payload)
    {
        using var envelopeWriter = new PooledArrayBufferWriter(512);
        using (var jsonWriter = new Utf8JsonWriter(envelopeWriter))
        {
            jsonWriter.WriteStartObject();
            jsonWriter.WriteNumber("id", eventId);
            jsonWriter.WriteNumber("type", (short)eventType);
            jsonWriter.WriteNumber("ts", timestampUnixMs);
            jsonWriter.WritePropertyName("payload");
            JsonSerializer.Serialize(jsonWriter, payload, SerializerOptions);
            jsonWriter.WriteEndObject();
        }

        using var frameWriter = new PooledArrayBufferWriter(envelopeWriter.WrittenCount + 48);
        WriteAscii(frameWriter, "id:");
        WriteInt64(frameWriter, eventId);
        WriteAscii(frameWriter, "\ndata:");
        frameWriter.Write(envelopeWriter.WrittenSpan);
        WriteAscii(frameWriter, "\n\n");

        return SharedSseFrame.FromOwnedBuffer(frameWriter.DetachBuffer(out int length), length);
    }

    private static void WriteAscii(PooledArrayBufferWriter writer, string value)
    {
        int maxByteCount = value.Length;
        Span<byte> span = writer.GetSpan(maxByteCount);
        int written = 0;

        for (int i = 0; i < value.Length; i++)
        {
            span[written++] = (byte)value[i];
        }

        writer.Advance(written);
    }

    private static void WriteInt64(PooledArrayBufferWriter writer, long value)
    {
        Span<byte> span = writer.GetSpan(20);
        if (!Utf8Formatter.TryFormat(value, span, out int written))
        {
            throw new InvalidOperationException("Unable to encode SSE event id.");
        }

        writer.Advance(written);
    }
}

internal sealed class PooledArrayBufferWriter : IBufferWriter<byte>, IDisposable
{
    private byte[] _buffer;
    private int _written;

    public PooledArrayBufferWriter(int initialCapacity)
    {
        _buffer = ArrayPool<byte>.Shared.Rent(Math.Max(256, initialCapacity));
    }

    public int WrittenCount => _written;

    public ReadOnlySpan<byte> WrittenSpan => _buffer.AsSpan(0, _written);

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