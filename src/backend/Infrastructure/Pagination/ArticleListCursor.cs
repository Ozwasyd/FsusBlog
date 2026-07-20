using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Infrastructure.Pagination;

public static class ArticleListCursorCodec
{
    private const byte CurrentVersion = 1;
    private const int PayloadSize = 1 + sizeof(long) + sizeof(int) + sizeof(ulong) + sizeof(ulong);

    public static string Encode(
        ArticleListCursorPosition position,
        int? categoryId,
        int? tagId,
        string? normalizedKeyword)
    {
        Span<byte> payload = stackalloc byte[PayloadSize];
        payload[0] = CurrentVersion;
        BinaryPrimitives.WriteInt64LittleEndian(payload[1..], position.CreateTimeUtc.Ticks);
        BinaryPrimitives.WriteInt32LittleEndian(payload[(1 + sizeof(long))..], position.Id);
        BinaryPrimitives.WriteUInt64LittleEndian(
            payload[(1 + sizeof(long) + sizeof(int))..],
            ComputeFilterFingerprint(categoryId, tagId, normalizedKeyword));
        BinaryPrimitives.WriteUInt64LittleEndian(
            payload[(PayloadSize - sizeof(ulong))..],
            ComputeChecksum(payload[..(PayloadSize - sizeof(ulong))]));
        return Base64UrlEncode(payload);
    }

    public static bool TryDecode(
        string? encoded,
        int? categoryId,
        int? tagId,
        string? normalizedKeyword,
        out ArticleListCursorPosition position)
    {
        position = default;
        if (string.IsNullOrWhiteSpace(encoded) || encoded.Length > 64)
        {
            return false;
        }

        Span<byte> payload = stackalloc byte[PayloadSize];
        if (!TryBase64UrlDecode(encoded, payload, out int written)
            || written != PayloadSize
            || payload[0] != CurrentVersion)
        {
            return false;
        }

        ulong checksum = BinaryPrimitives.ReadUInt64LittleEndian(payload[(PayloadSize - sizeof(ulong))..]);
        ulong expectedChecksum = ComputeChecksum(payload[..(PayloadSize - sizeof(ulong))]);
        ulong filterFingerprint = BinaryPrimitives.ReadUInt64LittleEndian(
            payload[(1 + sizeof(long) + sizeof(int))..]);
        if (checksum != expectedChecksum
            || filterFingerprint != ComputeFilterFingerprint(categoryId, tagId, normalizedKeyword))
        {
            return false;
        }

        long ticks = BinaryPrimitives.ReadInt64LittleEndian(payload[1..]);
        int id = BinaryPrimitives.ReadInt32LittleEndian(payload[(1 + sizeof(long))..]);
        if (id <= 0 || ticks < DateTime.UnixEpoch.Ticks || ticks > DateTime.MaxValue.Ticks)
        {
            return false;
        }

        position = new ArticleListCursorPosition(new DateTime(ticks, DateTimeKind.Utc), id);
        return string.Equals(
            encoded,
            Encode(position, categoryId, tagId, normalizedKeyword),
            StringComparison.Ordinal);
    }

    private static ulong ComputeFilterFingerprint(int? categoryId, int? tagId, string? normalizedKeyword)
    {
        string identity = string.Concat(
            "category:", categoryId?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "0",
            "|tag:", tagId?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "0",
            "|keyword:", normalizedKeyword ?? string.Empty);
        Span<byte> digest = stackalloc byte[SHA256.HashSizeInBytes];
        SHA256.HashData(Encoding.UTF8.GetBytes(identity), digest);
        return BinaryPrimitives.ReadUInt64LittleEndian(digest);
    }

    private static ulong ComputeChecksum(ReadOnlySpan<byte> payload)
    {
        Span<byte> digest = stackalloc byte[SHA256.HashSizeInBytes];
        SHA256.HashData(payload, digest);
        return BinaryPrimitives.ReadUInt64LittleEndian(digest);
    }

    private static string Base64UrlEncode(ReadOnlySpan<byte> payload)
        => Convert.ToBase64String(payload).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static bool TryBase64UrlDecode(string encoded, Span<byte> destination, out int written)
    {
        written = 0;
        if (encoded.Any(static character => !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_')))
        {
            return false;
        }

        string normalized = encoded.Replace('-', '+').Replace('_', '/');
        normalized = normalized.PadRight((normalized.Length + 3) / 4 * 4, '=');
        return Convert.TryFromBase64String(normalized, destination, out written);
    }
}
