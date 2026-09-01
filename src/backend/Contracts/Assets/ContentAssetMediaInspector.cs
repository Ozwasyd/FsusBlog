using System.Buffers.Binary;
using System.Text;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Contracts.Assets;

internal readonly record struct ContentAssetMediaMetadata(
    string MediaType,
    int Width,
    int Height);

internal static partial class ContentAssetMediaInspector
{
    internal static bool TryInspect(
        string extension,
        ReadOnlySpan<byte> bytes,
        out ContentAssetMediaMetadata metadata)
    {
        extension = extension.StartsWith(".", StringComparison.Ordinal)
            ? extension.ToLowerInvariant()
            : "." + extension.ToLowerInvariant();
        string mediaType = extension switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".ico" => "image/x-icon",
            ".svg" => "image/svg+xml",
            _ => string.Empty
        };
        int width;
        int height;
        bool recognized = extension switch
        {
            ".png" => TryReadPng(bytes, out width, out height),
            ".gif" => TryReadGif(bytes, out width, out height),
            ".jpg" or ".jpeg" => TryReadJpeg(bytes, out width, out height),
            ".webp" => TryReadWebp(bytes, out width, out height),
            ".ico" => TryReadIco(bytes, out width, out height),
            ".svg" => TryReadSvg(bytes, out width, out height),
            _ => Fail(out width, out height)
        };
        metadata = recognized
            ? new ContentAssetMediaMetadata(mediaType, width, height)
            : default;
        return recognized;
    }

    private static bool TryReadPng(ReadOnlySpan<byte> bytes, out int width, out int height)
    {
        width = height = 0;
        if (bytes.Length < 24 || !bytes[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
            return false;
        width = BinaryPrimitives.ReadInt32BigEndian(bytes[16..20]);
        height = BinaryPrimitives.ReadInt32BigEndian(bytes[20..24]);
        return width > 0 && height > 0;
    }

    private static bool TryReadGif(ReadOnlySpan<byte> bytes, out int width, out int height)
    {
        width = height = 0;
        if (bytes.Length < 10 || (!bytes[..6].SequenceEqual("GIF87a"u8) && !bytes[..6].SequenceEqual("GIF89a"u8)))
            return false;
        width = BinaryPrimitives.ReadUInt16LittleEndian(bytes[6..8]);
        height = BinaryPrimitives.ReadUInt16LittleEndian(bytes[8..10]);
        return width > 0 && height > 0;
    }

    private static bool TryReadJpeg(ReadOnlySpan<byte> bytes, out int width, out int height)
    {
        width = height = 0;
        if (bytes.Length < 4 || bytes[0] != 0xff || bytes[1] != 0xd8)
            return false;
        int offset = 2;
        while (offset + 4 <= bytes.Length)
        {
            while (offset < bytes.Length && bytes[offset] != 0xff)
                offset++;
            while (offset < bytes.Length && bytes[offset] == 0xff)
                offset++;
            if (offset >= bytes.Length)
                return false;
            byte marker = bytes[offset++];
            if (marker is 0xd8 or 0xd9 || marker is >= 0xd0 and <= 0xd7)
                continue;
            if (offset + 2 > bytes.Length)
                return false;
            int length = BinaryPrimitives.ReadUInt16BigEndian(bytes[offset..(offset + 2)]);
            if (length < 2 || offset + length > bytes.Length)
                return false;
            if (IsStartOfFrame(marker) && length >= 7)
            {
                height = BinaryPrimitives.ReadUInt16BigEndian(bytes[(offset + 3)..(offset + 5)]);
                width = BinaryPrimitives.ReadUInt16BigEndian(bytes[(offset + 5)..(offset + 7)]);
                return width > 0 && height > 0;
            }
            offset += length;
        }
        return false;
    }

    private static bool IsStartOfFrame(byte marker)
        => marker is 0xc0 or 0xc1 or 0xc2 or 0xc3 or 0xc5 or 0xc6 or 0xc7
            or 0xc9 or 0xca or 0xcb or 0xcd or 0xce or 0xcf;

    private static bool TryReadWebp(ReadOnlySpan<byte> bytes, out int width, out int height)
    {
        width = height = 0;
        if (bytes.Length < 30 || !bytes[..4].SequenceEqual("RIFF"u8) || !bytes[8..12].SequenceEqual("WEBP"u8))
            return false;
        if (bytes[12..16].SequenceEqual("VP8X"u8))
        {
            width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
            height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
            return true;
        }
        if (bytes[12..16].SequenceEqual("VP8L"u8) && bytes.Length >= 25 && bytes[20] == 0x2f)
        {
            int bits = BinaryPrimitives.ReadInt32LittleEndian(bytes[21..25]);
            width = (bits & 0x3fff) + 1;
            height = ((bits >> 14) & 0x3fff) + 1;
            return true;
        }
        if (bytes[12..16].SequenceEqual("VP8 "u8))
        {
            width = BinaryPrimitives.ReadUInt16LittleEndian(bytes[26..28]) & 0x3fff;
            height = BinaryPrimitives.ReadUInt16LittleEndian(bytes[28..30]) & 0x3fff;
            return width > 0 && height > 0;
        }
        return false;
    }

    private static bool TryReadIco(ReadOnlySpan<byte> bytes, out int width, out int height)
    {
        width = height = 0;
        if (bytes.Length < 22
            || BinaryPrimitives.ReadUInt16LittleEndian(bytes[..2]) != 0
            || BinaryPrimitives.ReadUInt16LittleEndian(bytes[2..4]) != 1
            || BinaryPrimitives.ReadUInt16LittleEndian(bytes[4..6]) == 0)
            return false;
        width = bytes[6] == 0 ? 256 : bytes[6];
        height = bytes[7] == 0 ? 256 : bytes[7];
        uint payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(bytes[14..18]);
        uint payloadOffset = BinaryPrimitives.ReadUInt32LittleEndian(bytes[18..22]);
        return payloadLength > 0
            && payloadOffset >= 22
            && payloadOffset <= (uint)bytes.Length
            && payloadLength <= (uint)bytes.Length - payloadOffset;
    }

    private static bool TryReadSvg(ReadOnlySpan<byte> bytes, out int width, out int height)
    {
        width = height = 0;
        string text;
        try
        {
            text = Encoding.UTF8.GetString(bytes);
        }
        catch
        {
            return false;
        }
        Match match = SvgDimensionsRegex().Match(text);
        if (!match.Success)
            match = SvgViewBoxRegex().Match(text);
        if (!match.Success)
            return false;
        width = (int)Math.Ceiling(double.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture));
        height = (int)Math.Ceiling(double.Parse(match.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture));
        return width > 0 && height > 0;
    }

    private static bool Fail(out int width, out int height)
    {
        width = height = 0;
        return false;
    }

    [GeneratedRegex("""<svg[^>]*width=['"]([0-9]+(?:\.[0-9]+)?)[^'"]*['"][^>]*height=['"]([0-9]+(?:\.[0-9]+)?)[^'"]*['"]""", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SvgDimensionsRegex();

    [GeneratedRegex("""<svg[^>]*viewBox=['"][^'"]*\s([0-9]+(?:\.[0-9]+)?)\s([0-9]+(?:\.[0-9]+)?)[^'"]*['"]""", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SvgViewBoxRegex();
}
