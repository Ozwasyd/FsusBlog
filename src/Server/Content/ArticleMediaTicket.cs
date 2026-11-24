namespace FsusBlog.V2.Server.Content;

internal readonly record struct ArticleMediaTicket(int Article, long Revision, Guid Asset)
{
    private const int PayloadLength = 36;
    internal const int EncodedLength = 91;
    private static readonly byte[] Key = RandomNumberGenerator.GetBytes(32);

    internal string Encode(byte[] session, long now)
    {
        var bytes = new byte[PayloadLength + SHA256.HashSizeInBytes];
        BinaryPrimitives.WriteInt32LittleEndian(bytes, Article);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(4), Revision);
        Asset.TryWriteBytes(bytes.AsSpan(12), bigEndian: true, out _);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(28), now + 90);
        Sign(session, bytes.AsSpan(0, PayloadLength), bytes.AsSpan(PayloadLength));
        return WebEncoders.Base64UrlEncode(bytes);
    }

    internal static bool TryDecode(string encoded, byte[] session, long now, out ArticleMediaTicket ticket)
    {
        ticket = default;
        if (encoded.Length != EncodedLength || encoded.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not '-' and not '_')) return false;
        var bytes = WebEncoders.Base64UrlDecode(encoded);
        if (WebEncoders.Base64UrlEncode(bytes) != encoded) return false;
        var expires = BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(28));
        if (expires <= now || expires - now > 90) return false;
        Span<byte> expected = stackalloc byte[SHA256.HashSizeInBytes];
        Sign(session, bytes.AsSpan(0, PayloadLength), expected);
        if (!CryptographicOperations.FixedTimeEquals(expected, bytes.AsSpan(PayloadLength))) return false;
        ticket = new(BinaryPrimitives.ReadInt32LittleEndian(bytes), BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(4)),
            new Guid(bytes.AsSpan(12, 16), bigEndian: true));
        return ticket.Article > 0 && ticket.Revision > 0 && ticket.Asset != Guid.Empty;
    }

    private static void Sign(byte[] session, ReadOnlySpan<byte> payload, Span<byte> output)
    {
        Span<byte> input = stackalloc byte[SHA256.HashSizeInBytes + PayloadLength];
        session.AsSpan().CopyTo(input);
        payload.CopyTo(input[SHA256.HashSizeInBytes..]);
        HMACSHA256.HashData(Key, input, output);
    }
}
