using System.Buffers.Binary;
using System.Security.Cryptography;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.V2.Server.Administration;

internal readonly record struct AdminInboxCursor(long First, long Second)
{
    private const int PayloadLength = 16;

    internal string Encode(byte[] session, byte scope)
    {
        var token = new byte[PayloadLength + SHA256.HashSizeInBytes];
        BinaryPrimitives.WriteInt64LittleEndian(token, First);
        BinaryPrimitives.WriteInt64LittleEndian(token.AsSpan(8), Second);
        AdminInboxCursorAuth.Sign(session, scope, token.AsSpan(0, PayloadLength), token.AsSpan(PayloadLength));
        return WebEncoders.Base64UrlEncode(token);
    }

    internal static bool TryDecode(string value, byte[] session, byte scope, out AdminInboxCursor cursor)
    {
        cursor = default;
        if (value.Length != 64 || value.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_')) return false;
        var token = WebEncoders.Base64UrlDecode(value);
        if (WebEncoders.Base64UrlEncode(token) != value) return false;
        Span<byte> digest = stackalloc byte[SHA256.HashSizeInBytes];
        AdminInboxCursorAuth.Sign(session, scope, token.AsSpan(0, PayloadLength), digest);
        if (!CryptographicOperations.FixedTimeEquals(token.AsSpan(PayloadLength), digest)) return false;
        cursor = new(BinaryPrimitives.ReadInt64LittleEndian(token), BinaryPrimitives.ReadInt64LittleEndian(token.AsSpan(8)));
        return cursor.First > 0 && cursor.Second >= 0;
    }
}

internal static class AdminInboxCursorAuth
{
    private static readonly byte[] Key = RandomNumberGenerator.GetBytes(32);

    internal static void Sign(byte[] session, byte scope, ReadOnlySpan<byte> payload, Span<byte> digest)
    {
        Span<byte> binding = stackalloc byte[SHA256.HashSizeInBytes + 1 + payload.Length];
        session.AsSpan().CopyTo(binding);
        binding[SHA256.HashSizeInBytes] = scope;
        payload.CopyTo(binding[(SHA256.HashSizeInBytes + 1)..]);
        HMACSHA256.HashData(Key, binding, digest);
    }
}
