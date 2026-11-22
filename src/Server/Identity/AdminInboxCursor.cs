using System.Buffers.Binary;
using System.Security.Cryptography;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.V2.Server.Administration;

internal readonly record struct AdminInboxCursor(long First, long Second)
{
    internal string Encode(byte[] session, byte scope) =>
        AdminInboxCursorAuth.Encode(session, scope, [First, Second]);

    internal static bool TryDecode(string value, byte[] session, byte scope, out AdminInboxCursor cursor)
    {
        cursor = default;
        Span<long> coordinates = stackalloc long[2];
        if (!AdminInboxCursorAuth.TryRead(value, 64, session, scope, coordinates)) return false;
        cursor = new(coordinates[0], coordinates[1]);
        return cursor.First > 0 && cursor.Second >= 0;
    }
}

internal static class AdminInboxCursorAuth
{
    private static readonly byte[] Key = RandomNumberGenerator.GetBytes(32);

    internal static string Encode(byte[] session, byte scope, ReadOnlySpan<long> coordinates)
    {
        var payloadLength = sizeof(long) * coordinates.Length;
        Span<byte> token = stackalloc byte[payloadLength + SHA256.HashSizeInBytes];
        for (var i = 0; i < coordinates.Length; i++)
            BinaryPrimitives.WriteInt64LittleEndian(token[(i * sizeof(long))..], coordinates[i]);
        Sign(session, scope, token[..payloadLength], token[payloadLength..]);
        return WebEncoders.Base64UrlEncode(token);
    }

    internal static bool TryRead(string value, int encodedLength, byte[] session, byte scope, Span<long> coordinates)
    {
        var payloadLength = sizeof(long) * coordinates.Length;
        if (value.Length != encodedLength ||
            value.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_')) return false;
        var token = WebEncoders.Base64UrlDecode(value);
        if (WebEncoders.Base64UrlEncode(token) != value) return false;
        Span<byte> digest = stackalloc byte[SHA256.HashSizeInBytes];
        Sign(session, scope, token.AsSpan(0, payloadLength), digest);
        if (!CryptographicOperations.FixedTimeEquals(token.AsSpan(payloadLength), digest)) return false;
        for (var i = 0; i < coordinates.Length; i++)
            coordinates[i] = BinaryPrimitives.ReadInt64LittleEndian(token.AsSpan(i * sizeof(long)));
        return true;
    }

    private static void Sign(byte[] session, byte scope, ReadOnlySpan<byte> payload, Span<byte> digest)
    {
        Span<byte> binding = stackalloc byte[SHA256.HashSizeInBytes + 1 + payload.Length];
        session.AsSpan().CopyTo(binding);
        binding[SHA256.HashSizeInBytes] = scope;
        payload.CopyTo(binding[(SHA256.HashSizeInBytes + 1)..]);
        HMACSHA256.HashData(Key, binding, digest);
    }
}
