using System.Text;

internal static partial class Cli
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    private static async Task<byte[]> ReadBoundedArtifactAsync(Stream input, int limit, CancellationToken ct,
        Func<Exception> invalidSize, Func<Exception> changed)
    {
        var length = input.Length;
        if (length < 1 || length > limit) throw invalidSize();
        var bytes = new byte[(int)length];
        await input.ReadExactlyAsync(bytes, ct);
        if (input.ReadByte() != -1)
            throw changed();
        return bytes;
    }
}
