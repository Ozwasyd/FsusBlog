using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.V2.Server.Administration;

// Stateless token helpers shared by the administrator identity, Step-Up, and domain stores.
internal static class AdminSql
{
    internal static string Token() => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    internal static bool TryChallengeDigest(string? text, [NotNullWhen(true)] out byte[]? digest, byte[]? ticket = null)
    {
        if (text is not { Length: 43 } || !text.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
        {
            digest = null;
            return false;
        }
        Span<byte> bytes = stackalloc byte[43 + (ticket?.Length ?? 0)];
        Encoding.ASCII.GetBytes(text, bytes);
        if (ticket is not null) ticket.AsSpan().CopyTo(bytes[43..]);
        digest = SHA256.HashData(bytes);
        return true;
    }

    internal static byte[] ChallengeDigest(string? text, byte[]? ticket) =>
        TryChallengeDigest(text, out var digest, ticket) ? digest : throw AdminSessionGate.Denied();

    internal static void RequireCredentialId(string text, byte[] raw)
    {
        if (WebEncoders.Base64UrlEncode(raw) != text) throw AdminSessionGate.Denied();
    }
}
