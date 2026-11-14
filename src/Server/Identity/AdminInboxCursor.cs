using System.Buffers.Binary;
using System.Security.Cryptography;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.V2.Server.Administration;

internal readonly record struct AdminInboxCursor(long First, long Second)
{
    private static readonly byte[] Key = RandomNumberGenerator.GetBytes(32);
    private const int PayloadLength = 16;

    internal string Encode(byte[] session, byte scope)
    {
        var token = new byte[PayloadLength + SHA256.HashSizeInBytes];
        BinaryPrimitives.WriteInt64LittleEndian(token, First);
        BinaryPrimitives.WriteInt64LittleEndian(token.AsSpan(8), Second);
        Authenticate(session, scope, token.AsSpan(0, PayloadLength), token.AsSpan(PayloadLength));
        return WebEncoders.Base64UrlEncode(token);
    }

    internal static bool TryDecode(string value, byte[] session, byte scope, out AdminInboxCursor cursor)
    {
        cursor = default;
        if (value.Length != 64 || value.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_')) return false;
        var token = WebEncoders.Base64UrlDecode(value);
        if (WebEncoders.Base64UrlEncode(token) != value) return false;
        Span<byte> digest = stackalloc byte[SHA256.HashSizeInBytes];
        Authenticate(session, scope, token.AsSpan(0, PayloadLength), digest);
        if (!CryptographicOperations.FixedTimeEquals(token.AsSpan(PayloadLength), digest)) return false;
        cursor = new(BinaryPrimitives.ReadInt64LittleEndian(token), BinaryPrimitives.ReadInt64LittleEndian(token.AsSpan(8)));
        return cursor.First > 0 && cursor.Second >= 0;
    }

    private static void Authenticate(byte[] session, byte scope, ReadOnlySpan<byte> payload, Span<byte> digest)
    {
        Span<byte> binding = stackalloc byte[SHA256.HashSizeInBytes + 1 + PayloadLength];
        session.AsSpan().CopyTo(binding);
        binding[SHA256.HashSizeInBytes] = scope;
        payload.CopyTo(binding[(SHA256.HashSizeInBytes + 1)..]);
        HMACSHA256.HashData(Key, binding, digest);
    }
}
