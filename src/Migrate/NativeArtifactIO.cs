using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

internal static partial class Migration
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    private static async Task<byte[]> ReadBoundedArtifactAsync(Stream input, int limit, CancellationToken ct,
        Func<Exception> invalidSize, Func<Exception> changed, string? expectedSha256 = null)
    {
        var length = input.Length;
        if (length < 1 || length > limit) throw invalidSize();
        var bytes = new byte[(int)length];
        await input.ReadExactlyAsync(bytes, ct);
        if (input.ReadByte() != -1 || expectedSha256 is not null &&
            Convert.ToHexStringLower(SHA256.HashData(bytes)) != expectedSha256)
            throw changed();
        return bytes;
    }

    private static void AppendBackupValue(IncrementalHash data, object? value)
    {
        var (kind, text) = value switch
        {
            null => ((byte)'n', ""),
            string s => ((byte)'s', s),
            bool b => ((byte)'b', b ? "1" : "0"),
            int or long or short or byte or sbyte or uint or ulong or ushort
                => ((byte)'i', Convert.ToString(value, CultureInfo.InvariantCulture)!),
            DateTime dt => ((byte)'t', dt.ToString("O", CultureInfo.InvariantCulture)),
            DateTimeOffset dt => ((byte)'t', dt.ToString("O", CultureInfo.InvariantCulture)),
            _ => throw new InvalidOperationException("Legacy column contains an unsupported runtime type.")
        };
        var bytes = StrictUtf8.GetBytes(text);
        Span<byte> prefix = stackalloc byte[5];
        prefix[0] = kind;
        BinaryPrimitives.WriteInt32BigEndian(prefix[1..], bytes.Length);
        data.AppendData(prefix);
        data.AppendData(bytes);
    }
}
