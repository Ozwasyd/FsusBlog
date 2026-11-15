using System.Buffers.Binary;
using System.Security.Cryptography;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.V2.Server.Administration;

internal readonly record struct AdminInboxActivityCursor(long Snapshot, DateTimeOffset At, long Conversation)
{
    internal const int EncodedLength = 75;
    private const int PayloadLength = 24;

    internal string Encode(byte[] session, byte scope)
    {
        var token = new byte[PayloadLength + SHA256.HashSizeInBytes];
        BinaryPrimitives.WriteInt64LittleEndian(token, Snapshot);
        BinaryPrimitives.WriteInt64LittleEndian(token.AsSpan(8), At.UtcTicks);
        BinaryPrimitives.WriteInt64LittleEndian(token.AsSpan(16), Conversation);
        AdminInboxCursorAuth.Sign(session, scope, token.AsSpan(0, PayloadLength), token.AsSpan(PayloadLength));
        return WebEncoders.Base64UrlEncode(token);
    }

    internal static bool TryDecode(string value, byte[] session, byte scope, out AdminInboxActivityCursor cursor)
    {
        cursor = default;
        if (value.Length != EncodedLength || value.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_'))
            return false;
        var token = WebEncoders.Base64UrlDecode(value);
        if (WebEncoders.Base64UrlEncode(token) != value) return false;
        Span<byte> digest = stackalloc byte[SHA256.HashSizeInBytes];
        AdminInboxCursorAuth.Sign(session, scope, token.AsSpan(0, PayloadLength), digest);
        if (!CryptographicOperations.FixedTimeEquals(token.AsSpan(PayloadLength), digest)) return false;
        long snapshot = BinaryPrimitives.ReadInt64LittleEndian(token);
        long ticks = BinaryPrimitives.ReadInt64LittleEndian(token.AsSpan(8));
        long conversation = BinaryPrimitives.ReadInt64LittleEndian(token.AsSpan(16));
        if (snapshot <= 0 || conversation <= 0 || ticks <= 0 || ticks > DateTimeOffset.MaxValue.Ticks)
            return false;
        cursor = new(snapshot, new DateTimeOffset(ticks, TimeSpan.Zero), conversation);
        return true;
    }
}
