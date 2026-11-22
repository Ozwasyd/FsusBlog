using System.IO.Compression;
using System.Text;

namespace FsusBlog.V2.Core.Extensions;

internal static class ExtensionArchive
{
    internal static T Read<T>(byte[] bytes, string invalidArchive, string? invalidEncoding, Func<ZipArchive, T> read)
    {
        try
        {
            using var stream = new MemoryStream(bytes, writable: false);
            using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
            return read(archive);
        }
        catch (DecoderFallbackException) when (invalidEncoding is not null)
        {
            throw new ExtensionRejectedException(invalidEncoding);
        }
        catch (Exception error) when (error is IOException or InvalidDataException or NotSupportedException)
        {
            throw new ExtensionRejectedException(invalidArchive);
        }
    }

    internal static bool IsRegularFile(ZipArchiveEntry entry)
    {
        var attributes = entry.ExternalAttributes;
        return ((attributes >> 16) & 0xf000) is 0 or 0x8000 &&
            (attributes & ((int)FileAttributes.ReparsePoint | (int)FileAttributes.Directory)) == 0;
    }

    // Callers bound the declared entry length and apply their own admission and integrity checks.
    internal static byte[] ReadExact(ZipArchiveEntry entry, string overflowCode)
    {
        var bytes = new byte[checked((int)entry.Length)];
        using var stream = entry.Open();
        stream.ReadExactly(bytes);
        if (stream.ReadByte() != -1) throw new ExtensionRejectedException(overflowCode);
        return bytes;
    }
}
