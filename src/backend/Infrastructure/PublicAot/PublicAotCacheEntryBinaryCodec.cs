using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotCacheEntryBinaryCodec
{
    private const uint Magic = 0x45434150; // PACE
    private const uint LegacyStringVersion = 1;
    private const uint ArtifactVersion = 2;
    private const uint Version = 3;
    private const int DecodedCacheCapacity = 256;
    private const int MaxStringBytes = 8 * 1024 * 1024;
    private const int MaxBlobBytes = 32 * 1024 * 1024;
    private static readonly ConcurrentDictionary<string, PublicAotCacheEntry> DecodedCache = new(StringComparer.Ordinal);
    private static readonly ConcurrentQueue<string> DecodedCacheKeys = new();

    internal static byte[] Encode(PublicAotCacheEntry entry)
    {
        PublicAotHtmlArtifact document = entry.GetDocument();
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
        WriteString(writer, document.ContentType);
        WriteString(writer, document.CacheControl);
        WriteString(writer, document.ETag);
        WriteString(writer, document.BrotliETag);
        WriteString(writer, document.GzipETag);
        WriteBool(writer, document.RequiresCspNonceMutation);
        WriteBytes(writer, document.Utf8Bytes.Span);
        WriteBytes(writer, document.BrotliBytes.Span);
        WriteBytes(writer, document.GzipBytes.Span);
        WriteString(writer, entry.HydrationSidecar.Url);
        WriteString(writer, entry.HydrationSidecar.Sha256Hex);
        WriteString(writer, entry.HydrationSidecar.RelativePath);
        return writer.ToArray();
    }

    internal static byte[] EncodeLegacyForTests(PublicAotCacheEntry entry)
    {
        using var writer = new PooledByteBufferWriter(4096);
        WriteUInt32(writer, Magic);
        WriteUInt32(writer, LegacyStringVersion);
        WriteInt32(writer, (int)entry.PageId);
        WriteInt32(writer, (int)entry.Source);
        WriteInt64(writer, entry.GeneratedAtUtc.UtcDateTime.Ticks);
        WriteInt64(writer, entry.ExpiresAtUtc.UtcDateTime.Ticks);
        WriteString(writer, entry.CacheKey);
        WriteString(writer, entry.RouteKey);
        WriteString(writer, entry.RendererVersion);
        WriteString(writer, entry.FrontendAssetVersion);
        WriteString(writer, entry.GetHtml());
        return writer.ToArray();
    }

    internal static PublicAotCacheEntry? Decode(ReadOnlySpan<byte> payload)
    {
        string cacheKey = BuildDecodedCacheKey(payload);
        if (TryGetDecodedCacheEntry(cacheKey, out PublicAotCacheEntry? cached))
        {
            FsusObservability.RecordPublicAotCacheCodecAccess(cacheHit: true);
            return cached;
        }

        bool success = TryDecode(payload, out PublicAotCacheEntry? entry);
        FsusObservability.RecordPublicAotCacheCodecAccess(cacheHit: false);
        if (success && entry is not null)
        {
            AddDecodedCacheEntry(cacheKey, entry);
            return entry;
        }

        return null;
    }

    internal static PublicAotCacheEntry? Decode(ReadOnlyMemory<byte> payload)
        => Decode(payload.Span);

    private static bool TryDecode(ReadOnlySpan<byte> payload, out PublicAotCacheEntry? entry)
    {
        entry = null;
        var reader = new SpanReader(payload);
        if (!reader.TryReadUInt32(out uint magic)
            || !reader.TryReadUInt32(out uint version)
            || magic != Magic
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

        if (version == LegacyStringVersion)
        {
            return TryDecodeLegacy(
                ref reader,
                pageId,
                source,
                generatedTicks,
                expiresTicks,
                out entry);
        }

        if (version != ArtifactVersion && version != Version)
        {
            return false;
        }

        return TryDecodeCurrent(
            ref reader,
            pageId,
            source,
            generatedTicks,
            expiresTicks,
            version >= Version,
            out entry);
    }

    private static bool TryGetDecodedCacheEntry(string cacheKey, out PublicAotCacheEntry? entry)
        => DecodedCache.TryGetValue(cacheKey, out entry);

    private static void AddDecodedCacheEntry(string cacheKey, PublicAotCacheEntry entry)
    {
        if (DecodedCache.TryAdd(cacheKey, entry))
        {
            DecodedCacheKeys.Enqueue(cacheKey);
            TrimDecodedCache();
        }
    }

    private static void TrimDecodedCache()
    {
        while (DecodedCache.Count > DecodedCacheCapacity && DecodedCacheKeys.TryDequeue(out string? oldestKey))
        {
            DecodedCache.TryRemove(oldestKey, out _);
        }
    }

    private static string BuildDecodedCacheKey(ReadOnlySpan<byte> payload)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(payload, hash);
        return Convert.ToHexStringLower(hash);
    }

    private static bool TryDecodeLegacy(
        ref SpanReader reader,
        PublicPageId pageId,
        PublicAotWriteSource source,
        long generatedTicks,
        long expiresTicks,
        out PublicAotCacheEntry? entry)
    {
        entry = null;
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
            PublicAotHtmlArtifact document = PublicAotHtmlArtifactFactory.FromHtml(
                value,
                rendererVersion,
                frontendAssetVersion,
                PublicAotHtmlArtifactOptions.DefaultCacheControl,
                PublicAotHtmlArtifactOptions.DefaultMinPrecompressedHtmlBytes);
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
                Value = value,
                Document = document
            };
            return true;
        }
        catch (ArgumentOutOfRangeException)
        {
            entry = null;
            return false;
        }
    }

    private static bool TryDecodeCurrent(
        ref SpanReader reader,
        PublicPageId pageId,
        PublicAotWriteSource source,
        long generatedTicks,
        long expiresTicks,
        bool includesHydrationSidecar,
        out PublicAotCacheEntry? entry)
    {
        entry = null;
        string sidecarUrl = string.Empty;
        string sidecarHash = string.Empty;
        string sidecarRelativePath = string.Empty;
        if (!reader.TryReadString(out string cacheKey)
            || !reader.TryReadString(out string routeKey)
            || !reader.TryReadString(out string rendererVersion)
            || !reader.TryReadString(out string frontendAssetVersion)
            || !reader.TryReadString(out string contentType)
            || !reader.TryReadString(out string cacheControl)
            || !reader.TryReadString(out string etag)
            || !reader.TryReadString(out string brotliEtag)
            || !reader.TryReadString(out string gzipEtag)
            || !reader.TryReadBool(out bool requiresCspNonceMutation)
            || !reader.TryReadBytes(out ReadOnlyMemory<byte> utf8Bytes)
            || !reader.TryReadBytes(out ReadOnlyMemory<byte> brotliBytes)
            || !reader.TryReadBytes(out ReadOnlyMemory<byte> gzipBytes))
        {
            return false;
        }

        if (includesHydrationSidecar &&
            (!reader.TryReadString(out sidecarUrl)
                || !reader.TryReadString(out sidecarHash)
                || !reader.TryReadString(out sidecarRelativePath)))
        {
            return false;
        }

        if (!reader.Consumed)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(cacheKey) || utf8Bytes.IsEmpty)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(etag))
        {
            etag = PublicAotHtmlArtifactFactory.CreateEtag(utf8Bytes.Span);
        }

        try
        {
            string html = Encoding.UTF8.GetString(utf8Bytes.Span);
            CspNonceUtf8Template? nonceTemplate = CspNonceUtf8Template.Compile(
                html,
                string.Concat(
                    rendererVersion,
                    ':',
                    frontendAssetVersion,
                    ":sha256:",
                    PublicAotHtmlArtifactFactory.CreateDigest(utf8Bytes.Span)));
            if ((nonceTemplate is not null) != requiresCspNonceMutation)
            {
                return false;
            }

            var document = new PublicAotHtmlArtifact(
                utf8Bytes,
                etag,
                nonceTemplate is null ? brotliBytes : ReadOnlyMemory<byte>.Empty,
                nonceTemplate is null ? brotliEtag : string.Empty,
                nonceTemplate is null ? gzipBytes : ReadOnlyMemory<byte>.Empty,
                nonceTemplate is null ? gzipEtag : string.Empty,
                string.IsNullOrWhiteSpace(contentType) ? "text/html; charset=utf-8" : contentType,
                string.IsNullOrWhiteSpace(cacheControl) ? PublicAotHtmlArtifactOptions.DefaultCacheControl : cacheControl,
                rendererVersion,
                frontendAssetVersion,
                nonceTemplate);
            PublicAotHydrationSidecarReference sidecar = default;
            if (!string.IsNullOrWhiteSpace(sidecarUrl))
            {
                if (!PublicAotHydrationSidecarReference.TryFromUrl(sidecarUrl, out sidecar) ||
                    (!string.IsNullOrWhiteSpace(sidecarHash) && !string.Equals(sidecar.Sha256Hex, sidecarHash, StringComparison.Ordinal)) ||
                    (!string.IsNullOrWhiteSpace(sidecarRelativePath) && !string.Equals(sidecar.RelativePath, sidecarRelativePath, StringComparison.Ordinal)))
                {
                    return false;
                }
            }

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
                Value = html,
                Document = document,
                HydrationSidecar = sidecar
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

    private static void WriteBool(PooledByteBufferWriter writer, bool value)
        => WriteInt32(writer, value ? 1 : 0);

    private static void WriteString(PooledByteBufferWriter writer, string value)
    {
        value ??= string.Empty;
        int byteCount = Encoding.UTF8.GetByteCount(value);
        if (byteCount > MaxStringBytes)
        {
            throw new ArgumentException("Public AOT cache entry string exceeds the maximum encoded byte length.", nameof(value));
        }

        WriteInt32(writer, byteCount);
        Span<byte> span = writer.GetSpan(byteCount);
        int written = Encoding.UTF8.GetBytes(value.AsSpan(), span);
        writer.Advance(written);
    }

    private static void WriteBytes(PooledByteBufferWriter writer, ReadOnlySpan<byte> value)
    {
        if (value.Length > MaxBlobBytes)
        {
            throw new ArgumentException("Public AOT cache entry byte artifact exceeds the maximum encoded byte length.", nameof(value));
        }

        WriteInt32(writer, value.Length);
        Span<byte> span = writer.GetSpan(value.Length);
        value.CopyTo(span);
        writer.Advance(value.Length);
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

        public bool TryReadBool(out bool value)
        {
            value = false;
            if (!TryReadInt32(out int raw) || raw is not 0 and not 1)
            {
                return false;
            }

            value = raw == 1;
            return true;
        }

        public bool TryReadString(out string value)
        {
            value = string.Empty;
            if (!TryReadInt32(out int length) || length < 0 || length > MaxStringBytes || _remaining.Length < length)
            {
                return false;
            }

            value = Encoding.UTF8.GetString(_remaining[..length]);
            _remaining = _remaining[length..];
            return true;
        }

        public bool TryReadBytes(out ReadOnlyMemory<byte> value)
        {
            value = ReadOnlyMemory<byte>.Empty;
            if (!TryReadInt32(out int length) || length < 0 || length > MaxBlobBytes || _remaining.Length < length)
            {
                return false;
            }

            if (length == 0)
            {
                return true;
            }

            value = _remaining[..length].ToArray();
            _remaining = _remaining[length..];
            return true;
        }
    }
}
