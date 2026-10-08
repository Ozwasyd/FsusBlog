using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Text;

namespace FsusBlog.ArticleVault.Observations;

/// <summary>Retains Linux directory-entry type hints; a hint never admits a path or source identity.</summary>
public sealed record LinuxVaultDirectoryEntry(string Name, byte TypeHint);

/// <summary>Validates bounded Linux getdents64 records without opening or admitting a filesystem.</summary>
public static class LinuxVaultDirectoryRecordCodec
{
    public const int MaximumBufferBytes = 64 * 1024;
    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);

    /// <summary>Rejects truncated records, invalid UTF-8, embedded path separators and ambiguous names.</summary>
    public static ImmutableArray<LinuxVaultDirectoryEntry> Decode(ReadOnlySpan<byte> buffer)
    {
        if (buffer.Length > MaximumBufferBytes)
        {
            throw new InvalidDataException("vault_rescan_directory_buffer_bound_exceeded");
        }

        var entries = ImmutableArray.CreateBuilder<LinuxVaultDirectoryEntry>();
        int offset = 0;
        while (offset < buffer.Length)
        {
            if (buffer.Length - offset < 24)
            {
                throw new InvalidDataException("vault_rescan_directory_record_truncated");
            }

            int length = BinaryPrimitives.ReadUInt16LittleEndian(buffer[(offset + 16)..]);
            if (length < 24 || length % 8 != 0 || length > buffer.Length - offset)
            {
                throw new InvalidDataException("vault_rescan_directory_record_length_invalid");
            }

            ReadOnlySpan<byte> nameBytes = buffer.Slice(offset + 19, length - 19);
            int terminator = nameBytes.IndexOf((byte)0);
            if (terminator is <= 0 or > 255 || nameBytes[..terminator].Contains((byte)'/'))
            {
                throw new InvalidDataException("vault_rescan_directory_name_invalid");
            }

            string name;
            try
            {
                name = s_strictUtf8.GetString(nameBytes[..terminator]);
            }
            catch (DecoderFallbackException)
            {
                throw new InvalidDataException("vault_rescan_directory_name_utf8_invalid");
            }

            if (name is not "." and not "..")
            {
                entries.Add(new(name, buffer[offset + 18]));
            }

            offset += length;
        }

        return entries.ToImmutable();
    }
}
