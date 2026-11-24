namespace FsusBlog.V2.Server.Authoring;

internal static class AuthorRecentOpenCursor
{
    private const int Coordinates = 2 * sizeof(long);
    private static readonly byte[] Key = RandomNumberGenerator.GetBytes(32);

    internal static string Encode(Guid site, Guid owner, byte[] session, long revision, long before)
    {
        Span<byte> token = stackalloc byte[Coordinates + SHA256.HashSizeInBytes];
        BinaryPrimitives.WriteInt64LittleEndian(token, revision);
        BinaryPrimitives.WriteInt64LittleEndian(token[sizeof(long)..], before);
        Sign(site, owner, session, token[..Coordinates], token[Coordinates..]);
        return WebEncoders.Base64UrlEncode(token);
    }

    internal static (long Revision, long Before)? Decode(Guid site, Guid owner, byte[] session, string cursor)
    {
        if (cursor.Length != WireLimits.AuthorRecentOpenCursorChars || cursor.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_'))
            return null;
        var bytes = WebEncoders.Base64UrlDecode(cursor);
        Span<byte> tag = stackalloc byte[SHA256.HashSizeInBytes];
        Sign(site, owner, session, bytes.AsSpan(0, Coordinates), tag);
        if (!CryptographicOperations.FixedTimeEquals(bytes.AsSpan(Coordinates), tag)) return null;
        var revision = BinaryPrimitives.ReadInt64LittleEndian(bytes);
        var before = BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(sizeof(long)));
        return before > 1 && before <= revision ? (revision, before) : null;
    }

    private static void Sign(Guid site, Guid owner, byte[] session, ReadOnlySpan<byte> coordinates, Span<byte> tag)
    {
        Span<byte> input = stackalloc byte[2 * 16 + SHA256.HashSizeInBytes + Coordinates];
        site.TryWriteBytes(input);
        owner.TryWriteBytes(input[16..]);
        session.CopyTo(input[32..]);
        coordinates.CopyTo(input[(32 + SHA256.HashSizeInBytes)..]);
        HMACSHA256.HashData(Key, input, tag);
    }
}
