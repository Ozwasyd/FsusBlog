internal static class VectorFixture
{
    internal static byte[] Hex(string directory, string file) =>
        Convert.FromHexString(File.ReadAllText(Path.Combine(directory, file)).Trim());

    internal static byte[] MultilineHex(string directory, string file) =>
        Convert.FromHexString(string.Concat(File.ReadAllLines(Path.Combine(directory, file))));

    internal static void Equal(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual, string message)
    {
        if (!expected.SequenceEqual(actual))
            throw new InvalidOperationException(message);
    }
}
