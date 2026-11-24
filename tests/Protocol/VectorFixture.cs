internal static class VectorFixture
{
    internal static byte[] Hex(string directory, string file) =>
        Convert.FromHexString(File.ReadAllText(Path.Combine(directory, file)).Trim());

    internal static byte[] MultilineHex(string directory, string file) =>
        Convert.FromHexString(string.Concat(File.ReadAllLines(Path.Combine(directory, file))));

    internal static byte[] HexBytes(string hex) => Convert.FromHexString(hex);

    internal static string HexLower(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(bytes);

    internal static void Equal(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual, string message = "AEDS bytes differ from independent vector")
    {
        if (!expected.SequenceEqual(actual)) throw new InvalidOperationException(message);
    }

    internal static void CheckHex(string directory, string file, ReadOnlySpan<byte> actual, string message = "AEDS bytes differ from independent vector") =>
        Equal(Hex(directory, file), actual, message);

    internal static void CheckMultilineHex(string directory, string file, ReadOnlySpan<byte> actual, string message = "AEDS bytes differ from independent vector") =>
        Equal(MultilineHex(directory, file), actual, message);

    internal static void CheckRoundTrip<T>(byte[] expected, T value, Func<T, byte[]> encode, Func<byte[], T> decode, string message = "AEDS round-trip mismatch")
    {
        Equal(expected, encode(value), message);
        Require(EqualityComparer<T>.Default.Equals(decode(expected), value), message);
    }

    internal static byte[] WithByte(ReadOnlySpan<byte> bytes, int offset, byte value)
    {
        var copy = bytes.ToArray();
        copy[offset] = value;
        return copy;
    }

    internal static byte[] WithI32(ReadOnlySpan<byte> bytes, int offset, int value)
    {
        var copy = bytes.ToArray();
        BinaryPrimitives.WriteInt32LittleEndian(copy.AsSpan(offset), value);
        return copy;
    }

    internal static byte[] WithI64(ReadOnlySpan<byte> bytes, int offset, long value)
    {
        var copy = bytes.ToArray();
        BinaryPrimitives.WriteInt64LittleEndian(copy.AsSpan(offset), value);
        return copy;
    }

    internal static void Require(bool condition, string message = "Vector assertion failed")
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    internal static void Reject(Action action, string message = "Invalid protocol input accepted") => Reject<ProtocolException>(action, message);

    internal static void Reject<TException>(Action action, string message = "Invalid protocol input accepted") where TException : Exception
    {
        try { action(); }
        catch (TException) { return; }
        throw new InvalidOperationException(message);
    }

    internal static void RejectAll(params Action[] actions)
    {
        foreach (var action in actions) Reject(action);
    }

    internal static void RejectEach<T>(IEnumerable<T> cases, Action<T> action)
    {
        foreach (var item in cases) Reject(() => action(item));
    }

    internal static void RejectTruncations(byte[] frame, Action<ReadOnlySpan<byte>> decode)
    {
        for (int length = 0; length < frame.Length; length++) Reject(() => decode(frame.AsSpan(0, length)));
    }
}
