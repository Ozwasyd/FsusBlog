using System.Buffers.Binary;
using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotCacheEntryBinaryCodec
{
    private const uint Magic = 0x45434150; // PACE
    private const uint Version = 1;
    private const int MaxStringBytes = 8 * 1024 * 1024;

    internal static byte[] Encode(PublicAotCacheEntry entry)
    {
        using var writer = new PooledByteBufferWriter(4096);
        WriteUInt32(writer, Magic);
        WriteUInt32(writer, Version);
        WriteInt32(writer, (int)entry.PageId);
        WriteInt32(writer, (int)entry.Source);
        WriteInt64(writer, entry.GeneratedAtUtc.UtcDateTime.Ticks);
        WriteInt64(writer, entry.ExpiresAtUtc.UtcDateTime.Ticks);
        WriteString(writer, entry.CacheKey);
        WriteString(writer, entry.RouteKey);
        WriteString(writer, entry.RendererVersion);
        WriteString(writer, entry.FrontendAssetVersion);
        WriteString(writer, entry.Value);
        return writer.ToArray();
    }

    internal static PublicAotCacheEntry? Decode(ReadOnlySpan<byte> payload)
        => TryDecode(payload, out PublicAotCacheEntry? entry) ? entry : null;

    internal static PublicAotCacheEntry? Decode(ReadOnlyMemory<byte> payload)
        => Decode(payload.Span);

    private static bool TryDecode(ReadOnlySpan<byte> payload, out PublicAotCacheEntry? entry)
    {
        entry = null;
        var reader = new SpanReader(payload);
        if (!reader.TryReadUInt32(out uint magic)
            || !reader.TryReadUInt32(out uint version)
            || magic != Magic
            || version != Version
            || !reader.TryReadInt32(out int pageIdRaw)
            || !reader.TryReadInt32(out int sourceRaw)
            || !reader.TryReadInt64(out long generatedTicks)
            || !reader.TryReadInt64(out long expiresTicks))
        {
            return false;
        }

        var pageId = (PublicPageId)pageIdRaw;
        var source = (PublicAotWriteSource)sourceRaw;
        if (!Enum.IsDefined(pageId) || !Enum.IsDefined(source))
        {
            return false;
        }

        if (!reader.TryReadString(out string cacheKey)
            || !reader.TryReadString(out string routeKey)
            || !reader.TryReadString(out string rendererVersion)
            || !reader.TryReadString(out string frontendAssetVersion)
            || !reader.TryReadString(out string value)
            || !reader.Consumed)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(cacheKey))
        {
            return false;
        }

        try
        {
            entry = new PublicAotCacheEntry
            {
                PageId = pageId,
                Source = source,
                GeneratedAtUtc = new DateTimeOffset(new DateTime(generatedTicks, DateTimeKind.Utc)),
                ExpiresAtUtc = new DateTimeOffset(new DateTime(expiresTicks, DateTimeKind.Utc)),
                CacheKey = cacheKey,
                RouteKey = routeKey,
                RendererVersion = rendererVersion,
                FrontendAssetVersion = frontendAssetVersion,
                Value = value
            };
            return true;
        }
        catch (ArgumentOutOfRangeException)
        {
            entry = null;
            return false;
        }
    }

    private static void WriteUInt32(PooledByteBufferWriter writer, uint value)
    {
        Span<byte> span = writer.GetSpan(sizeof(uint));
        BinaryPrimitives.WriteUInt32LittleEndian(span, value);
        writer.Advance(sizeof(uint));
    }

    private static void WriteInt32(PooledByteBufferWriter writer, int value)
    {
        Span<byte> span = writer.GetSpan(sizeof(int));
        BinaryPrimitives.WriteInt32LittleEndian(span, value);
        writer.Advance(sizeof(int));
    }

    private static void WriteInt64(PooledByteBufferWriter writer, long value)
    {
        Span<byte> span = writer.GetSpan(sizeof(long));
        BinaryPrimitives.WriteInt64LittleEndian(span, value);
        writer.Advance(sizeof(long));
    }

    private static void WriteString(PooledByteBufferWriter writer, string value)
    {
        int byteCount = System.Text.Encoding.UTF8.GetByteCount(value);
        if (byteCount > MaxStringBytes)
        {
            throw new ArgumentException("Public AOT cache entry string exceeds the maximum encoded byte length.", nameof(value));
        }

        WriteInt32(writer, byteCount);
        Span<byte> span = writer.GetSpan(byteCount);
        int written = System.Text.Encoding.UTF8.GetBytes(value.AsSpan(), span);
        writer.Advance(written);
    }

    private ref struct SpanReader
    {
        private ReadOnlySpan<byte> _remaining;

        public SpanReader(ReadOnlySpan<byte> source)
        {
            _remaining = source;
        }

        public bool Consumed => _remaining.IsEmpty;

        public bool TryReadUInt32(out uint value)
        {
            value = 0;
            if (_remaining.Length < sizeof(uint))
            {
                return false;
            }

            value = BinaryPrimitives.ReadUInt32LittleEndian(_remaining);
            _remaining = _remaining[sizeof(uint)..];
            return true;
        }

        public bool TryReadInt32(out int value)
        {
            value = 0;
            if (_remaining.Length < sizeof(int))
            {
                return false;
            }

            value = BinaryPrimitives.ReadInt32LittleEndian(_remaining);
            _remaining = _remaining[sizeof(int)..];
            return true;
        }

        public bool TryReadInt64(out long value)
        {
            value = 0;
            if (_remaining.Length < sizeof(long))
            {
                return false;
            }

            value = BinaryPrimitives.ReadInt64LittleEndian(_remaining);
            _remaining = _remaining[sizeof(long)..];
            return true;
        }

        public bool TryReadString(out string value)
        {
            value = string.Empty;
            if (!TryReadInt32(out int length) || length < 0 || length > MaxStringBytes || _remaining.Length < length)
            {
                return false;
            }

            value = System.Text.Encoding.UTF8.GetString(_remaining[..length]);
            _remaining = _remaining[length..];
            return true;
        }
    }
}
