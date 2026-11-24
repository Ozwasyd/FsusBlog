namespace FsusBlog.V2.Server.Communication;

internal static class InboxReplayCursor
{
    internal static string Encode(string session, long position)
    {
        var bytes = new byte[sizeof(long) + SHA256.HashSizeInBytes];
        BinaryPrimitives.WriteInt64LittleEndian(bytes, position);
        Authenticate(session, bytes.AsSpan(0, sizeof(long)), bytes.AsSpan(sizeof(long)));
        return WebEncoders.Base64UrlEncode(bytes);
    }

    internal static bool TryDecode(string session, string encoded, out long position)
    {
        position = 0;
        if (encoded.Length != WireLimits.InboxReplayCursorChars ||
            encoded.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_'))
            return false;
        var bytes = WebEncoders.Base64UrlDecode(encoded);
        if (!string.Equals(WebEncoders.Base64UrlEncode(bytes), encoded, StringComparison.Ordinal)) return false;

        ReadOnlySpan<byte> offset = bytes.AsSpan(0, sizeof(long));
        Span<byte> expected = stackalloc byte[SHA256.HashSizeInBytes];
        Authenticate(session, offset, expected);
        if (!CryptographicOperations.FixedTimeEquals(bytes.AsSpan(sizeof(long)), expected)) return false;
        position = BinaryPrimitives.ReadInt64LittleEndian(offset);
        return position >= 0;
    }

    private static void Authenticate(string session, ReadOnlySpan<byte> position, Span<byte> signature)
    {
        ReadOnlySpan<byte> label = "FsusBlog.private-inbox-replay.v1"u8;
        Span<byte> message = stackalloc byte[label.Length + sizeof(long)];
        label.CopyTo(message);
        position.CopyTo(message[label.Length..]);
        HMACSHA256.HashData(Convert.FromHexString(session), message, signature);
    }
}
