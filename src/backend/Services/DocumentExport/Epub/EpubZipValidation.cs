using System.Buffers.Binary;
using System.Text;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>Reads actual stored ZIP headers and CRCs without trusting ZipArchive's index.</summary>
internal static class EpubZipValidation
{
    private static readonly uint[] s_crcTable = CreateCrcTable();

    internal static Dictionary<string, ReadOnlyMemory<byte>> Read(byte[] bytes, DocumentExportResourceBudgets budgets,
        CancellationToken cancellationToken)
    {
        if (bytes.Length > budgets.MaxOutputBytes || bytes.Length < 100)
        {
            throw new InvalidDataException("EPUB archive is empty or exceeds its output budget.");
        }
        var entries = new Dictionary<string, ReadOnlyMemory<byte>>(StringComparer.Ordinal);
        var headers = new List<(string Name, int Offset, ushort Flags, uint Crc, uint Length)>();
        int position = 0;
        long expandedBytes = 0;
        while (Read32(bytes, position) == 0x04034b50)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int offset = position;
            ushort flags = Read16(bytes, position + 6);
            uint crc = Read32(bytes, position + 14);
            uint length = Read32(bytes, position + 18);
            int nameLength = Read16(bytes, position + 26);
            int extraLength = Read16(bytes, position + 28);
            if (Read16(bytes, position + 4) != 20 || flags is not (0 or 0x0800)
                || Read16(bytes, position + 8) != 0 || Read16(bytes, position + 10) != 0
                || Read16(bytes, position + 12) != 33 || length != Read32(bytes, position + 22)
                || extraLength != 0 || length > budgets.MaxFileBytes || length > int.MaxValue)
            {
                throw new InvalidDataException("EPUB local ZIP normalization, compression or entry size is invalid.");
            }
            string name = ReadName(bytes, position + 30, nameLength);
            position = checked(position + 30 + nameLength);
            EnsureRange(bytes, position, (int)length);
            ReadOnlyMemory<byte> content = bytes.AsMemory(position, (int)length);
            if (!entries.TryAdd(name, content) || Crc32(content.Span) != crc)
            {
                throw new InvalidDataException("EPUB archive has duplicate entries or corrupt content CRCs.");
            }
            expandedBytes = checked(expandedBytes + length);
            if (entries.Count > budgets.MaxFileCount || expandedBytes > budgets.MaxFileBytes)
            {
                throw new DocumentExportBudgetExceededException("EPUB expanded entries exceed their budget.", "file-budget");
            }
            headers.Add((name, offset, flags, crc, length));
            position = checked(position + (int)length);
        }
        if (headers.Count == 0 || headers[0].Name != "mimetype"
            || !entries["mimetype"].Span.SequenceEqual("application/epub+zip"u8)
            || !headers.Skip(1).Select(header => header.Name).SequenceEqual(
                headers.Skip(1).Select(header => header.Name).OrderBy(name => name, StringComparer.Ordinal)))
        {
            throw new InvalidDataException("EPUB mimetype must be first and entry order must be normalized.");
        }
        int centralOffset = position;
        foreach (var header in headers)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int nameLength = Read16(bytes, position + 28);
            if (Read32(bytes, position) != 0x02014b50
                || Read16(bytes, position + 6) != 20
                || Read16(bytes, position + 8) != header.Flags
                || Read16(bytes, position + 10) != 0
                || Read16(bytes, position + 12) != 0 || Read16(bytes, position + 14) != 33
                || Read32(bytes, position + 16) != header.Crc
                || Read32(bytes, position + 20) != header.Length || Read32(bytes, position + 24) != header.Length
                || Read16(bytes, position + 30) != 0 || Read16(bytes, position + 32) != 0
                || Read16(bytes, position + 34) != 0 || Read16(bytes, position + 36) != 0
                || Read32(bytes, position + 38) != 0 || Read32(bytes, position + 42) != header.Offset
                || ReadName(bytes, position + 46, nameLength) != header.Name)
            {
                throw new InvalidDataException("EPUB central ZIP headers do not match actual local entries.");
            }
            position = checked(position + 46 + nameLength);
        }
        int centralLength = position - centralOffset;
        if (Read32(bytes, position) != 0x06054b50 || bytes.Length - position != 22
            || Read16(bytes, position + 4) != 0 || Read16(bytes, position + 6) != 0
            || Read16(bytes, position + 8) != headers.Count || Read16(bytes, position + 10) != headers.Count
            || Read32(bytes, position + 12) != centralLength || Read32(bytes, position + 16) != centralOffset
            || Read16(bytes, position + 20) != 0)
        {
            throw new InvalidDataException("EPUB ZIP end record, entry count or archive closure is invalid.");
        }
        return entries;
    }

    internal static uint Crc32(ReadOnlySpan<byte> bytes)
    {
        uint crc = uint.MaxValue;
        foreach (byte value in bytes)
        {
            crc = s_crcTable[(crc ^ value) & 255] ^ (crc >> 8);
        }
        return ~crc;
    }

    private static uint[] CreateCrcTable()
    {
        var table = new uint[256];
        for (uint index = 0; index < table.Length; index++)
        {
            uint value = index;
            for (int bit = 0; bit < 8; bit++)
            {
                value = (value & 1) != 0 ? 0xedb88320 ^ (value >> 1) : value >> 1;
            }
            table[index] = value;
        }
        return table;
    }

    private static ushort Read16(byte[] bytes, int position)
    {
        EnsureRange(bytes, position, 2);
        return BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(position, 2));
    }

    private static uint Read32(byte[] bytes, int position)
    {
        EnsureRange(bytes, position, 4);
        return BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(position, 4));
    }

    private static string ReadName(byte[] bytes, int position, int length)
    {
        EnsureRange(bytes, position, length);
        string name;
        try
        {
            name = new UTF8Encoding(false, true).GetString(bytes, position, length);
        }
        catch (DecoderFallbackException exception)
        {
            throw new InvalidDataException("EPUB ZIP path is not UTF-8.", exception);
        }
        if (name.Length == 0 || name.Length > 180
            || name.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not ('/' or '-' or '.' or '_'))
            || name.Split('/').Any(segment => segment.Length == 0 || segment is "." or ".."))
        {
            throw new InvalidDataException("EPUB ZIP path is not a closed portable relative file path.");
        }
        return name;
    }

    private static void EnsureRange(byte[] bytes, int position, int length)
    {
        if (position < 0 || length < 0 || position > bytes.Length - length)
        {
            throw new InvalidDataException("EPUB ZIP is truncated.");
        }
    }
}
