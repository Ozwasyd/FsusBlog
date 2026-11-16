using System.IO.Compression;

namespace FsusBlog.V2.Core.Extensions;

internal static class ExtensionArchive
{
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
