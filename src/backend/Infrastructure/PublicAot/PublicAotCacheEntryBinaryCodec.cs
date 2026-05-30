using System.Text;
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
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
        writer.Write(Magic);
        writer.Write(Version);
        writer.Write((int)entry.PageId);
        writer.Write((int)entry.Source);
        writer.Write(entry.GeneratedAtUtc.UtcDateTime.Ticks);
        writer.Write(entry.ExpiresAtUtc.UtcDateTime.Ticks);
        WriteString(writer, entry.CacheKey);
        WriteString(writer, entry.RouteKey);
        WriteString(writer, entry.RendererVersion);
        WriteString(writer, entry.FrontendAssetVersion);
        WriteString(writer, entry.Value);
        writer.Flush();
        return stream.ToArray();
    }

    internal static PublicAotCacheEntry? Decode(ReadOnlySpan<byte> payload)
        => Decode(new ReadOnlyMemory<byte>(payload.ToArray()));

    internal static PublicAotCacheEntry? Decode(ReadOnlyMemory<byte> payload)
    {
        try
        {
            using var stream = new ReadOnlyMemoryStream(payload);
            using var reader = new BinaryReader(stream, Encoding.UTF8, leaveOpen: false);
            if (reader.ReadUInt32() != Magic || reader.ReadUInt32() != Version)
            {
                return null;
            }

            var pageId = (PublicPageId)reader.ReadInt32();
            var source = (PublicAotWriteSource)reader.ReadInt32();
            if (!Enum.IsDefined(pageId) || !Enum.IsDefined(source))
            {
                return null;
            }

            var entry = new PublicAotCacheEntry
            {
                PageId = pageId,
                Source = source,
                GeneratedAtUtc = new DateTimeOffset(new DateTime(reader.ReadInt64(), DateTimeKind.Utc)),
                ExpiresAtUtc = new DateTimeOffset(new DateTime(reader.ReadInt64(), DateTimeKind.Utc)),
                CacheKey = ReadString(reader),
                RouteKey = ReadString(reader),
                RendererVersion = ReadString(reader),
                FrontendAssetVersion = ReadString(reader),
                Value = ReadString(reader)
            };

            return stream.Position == stream.Length && !string.IsNullOrWhiteSpace(entry.CacheKey)
                ? entry
                : null;
        }
        catch (ArgumentException)
        {
            return null;
        }
        catch (EndOfStreamException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    private static void WriteString(BinaryWriter writer, string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        writer.Write(bytes.Length);
        writer.Write(bytes);
    }

    private static string ReadString(BinaryReader reader)
    {
        int length = reader.ReadInt32();
        if (length < 0 || length > MaxStringBytes)
        {
            throw new ArgumentException("Invalid public AOT cache entry string length.");
        }

        byte[] bytes = reader.ReadBytes(length);
        if (bytes.Length != length)
        {
            throw new EndOfStreamException();
        }

        return Encoding.UTF8.GetString(bytes);
    }
}
