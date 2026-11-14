using System.Buffers.Binary;
using System.Text;

namespace FsusBlog.ArticleVault.Windows;

/// <summary>Decodes FILE_NOTIFY_INFORMATION without pairing, sorting or dropping native actions.</summary>
internal static class WindowsVaultNotifyDecoder
{
    private const int HeaderBytes = 12;
    private static readonly Encoding s_strictUnicode = new UnicodeEncoding(false, false, true);

    internal static void Decode(ReadOnlySpan<byte> bytes, Action<WindowsVaultNativeRecord> receive)
    {
        int offset = 0;
        while (offset < bytes.Length)
        {
            ReadOnlySpan<byte> remaining = bytes[offset..];
            if (remaining.Length < HeaderBytes)
            {
                throw new InvalidDataException("windows_vault_native_record_truncated");
            }

            uint nextOffset = BinaryPrimitives.ReadUInt32LittleEndian(remaining);
            uint action = BinaryPrimitives.ReadUInt32LittleEndian(remaining[4..]);
            uint nameBytes = BinaryPrimitives.ReadUInt32LittleEndian(remaining[8..]);
            if (nameBytes == 0 || nameBytes % 2 != 0 || nameBytes > 2048
                || nameBytes > remaining.Length - HeaderBytes)
            {
                throw new InvalidDataException("windows_vault_native_name_invalid");
            }

            int recordBytes = checked(HeaderBytes + (int)nameBytes);
            if (nextOffset != 0 && (nextOffset % 4 != 0 || nextOffset < recordBytes
                || nextOffset > remaining.Length - HeaderBytes))
            {
                throw new InvalidDataException("windows_vault_native_offset_invalid");
            }

            string name;
            try
            {
                name = s_strictUnicode.GetString(remaining.Slice(HeaderBytes, (int)nameBytes));
            }
            catch (DecoderFallbackException exception)
            {
                throw new InvalidDataException("windows_vault_native_name_invalid", exception);
            }

            // Preserve the native spelling and separators. Canonical #2109 validates it separately.
            receive(new WindowsVaultNativeRecord(action, name));
            if (nextOffset == 0)
            {
                return;
            }

            offset += checked((int)nextOffset);
        }
    }
}
