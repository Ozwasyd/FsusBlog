namespace FsusBlog.V2.Server.Authoring;

internal static class RevisionHistoryCursor
{
    private static readonly byte[] Key = RandomNumberGenerator.GetBytes(32);

    internal static string Encode(string session, int articleId, long revision, long before)
    {
        Span<byte> token = stackalloc byte[sizeof(long) + SHA256.HashSizeInBytes];
        BinaryPrimitives.WriteInt64LittleEndian(token, before);
        Authenticate(session, articleId, revision, before, token[sizeof(long)..]);
        return WebEncoders.Base64UrlEncode(token.ToArray());
    }

    internal static bool TryDecode(string session, int articleId, long revision, string token, out long before)
    {
        before = 0;
        if (token.Length != WireLimits.RevisionHistoryCursorChars ||
            token.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_'))
            return false;
        var bytes = WebEncoders.Base64UrlDecode(token);
        if (WebEncoders.Base64UrlEncode(bytes) != token) return false;
        before = BinaryPrimitives.ReadInt64LittleEndian(bytes);
        if (before <= 1 || before > revision) return false;
        Span<byte> tag = stackalloc byte[SHA256.HashSizeInBytes];
        Authenticate(session, articleId, revision, before, tag);
        return CryptographicOperations.FixedTimeEquals(bytes.AsSpan(sizeof(long)), tag);
    }

    private static void Authenticate(string session, int articleId, long revision, long before, Span<byte> tag)
    {
        var binding = new byte[SHA256.HashSizeInBytes + sizeof(int) + 2 * sizeof(long)];
        Store.TokenDigest(session)!.CopyTo(binding, 0);
        BinaryPrimitives.WriteInt32LittleEndian(binding.AsSpan(32), articleId);
        BinaryPrimitives.WriteInt64LittleEndian(binding.AsSpan(36), revision);
        BinaryPrimitives.WriteInt64LittleEndian(binding.AsSpan(44), before);
        HMACSHA256.HashData(Key, binding, tag);
    }
}
