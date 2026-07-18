namespace FsusBlog.Core.Algorithms;

/// <summary>
/// Computes the CRC-16 checksum stored in AEDS v2 frame headers.
/// </summary>
public static class AedsCrc16
{
    private const ushort Polynomial = 0xA001;
    private static readonly ushort[] s_table = CreateTable();

    /// <summary>
    /// Computes the AEDS CRC-16 value for the supplied payload bytes.
    /// </summary>
    public static ushort Compute(ReadOnlySpan<byte> data)
    {
        ushort crc = 0xFFFF;
        for (int i = 0; i < data.Length; i++)
        {
            crc = (ushort)((crc >> 8) ^ s_table[(crc ^ data[i]) & 0xFF]);
        }

        return crc;
    }

    private static ushort[] CreateTable()
    {
        var table = new ushort[256];
        for (int i = 0; i < table.Length; i++)
        {
            ushort value = (ushort)i;
            for (int bit = 0; bit < 8; bit++)
            {
                value = (ushort)(((value & 1) != 0) ? ((value >> 1) ^ Polynomial) : (value >> 1));
            }

            table[i] = value;
        }

        return table;
    }
}
