using System.Buffers;

namespace FsusBlog.V2.Server;

internal static class CursorEnvelope
{
    private const int NonceSize = 12;
    private const int TagSize = 16;
    internal const int Overhead = NonceSize + TagSize;

    internal static string Encode(ReadOnlySpan<byte> key, ReadOnlySpan<byte> payload, ReadOnlySpan<byte> associatedData = default)
    {
        Span<byte> protectedBytes = stackalloc byte[payload.Length + Overhead];
        var nonce = protectedBytes[..NonceSize];
        RandomNumberGenerator.Fill(nonce);
        using var aes = new AesGcm(key, TagSize);
        aes.Encrypt(nonce, payload, protectedBytes[NonceSize..^TagSize], protectedBytes[^TagSize..], associatedData);
        return Base64Url.EncodeToString(protectedBytes);
    }

    internal static bool TryRead(string cursor, int encodedSize, Span<byte> protectedBytes, bool throwOnMalformed = true)
    {
        if (cursor.Length != encodedSize)
            return false;

        // The status overload keeps malformed public-search tokens on the search failure path.
        int written;
        var decoded = throwOnMalformed
            ? Base64Url.TryDecodeFromChars(cursor, protectedBytes, out written)
            : Base64Url.DecodeFromChars(cursor, protectedBytes, out var consumed, out written) == OperationStatus.Done &&
                consumed == cursor.Length;
        return decoded && written == protectedBytes.Length &&
            string.Equals(Base64Url.EncodeToString(protectedBytes), cursor, StringComparison.Ordinal);
    }

    internal static bool TryDecrypt(
        ReadOnlySpan<byte> key, ReadOnlySpan<byte> protectedBytes, Span<byte> payload, ReadOnlySpan<byte> associatedData = default)
    {
        using var aes = new AesGcm(key, TagSize);
        try
        {
            aes.Decrypt(protectedBytes[..NonceSize], protectedBytes[NonceSize..^TagSize], protectedBytes[^TagSize..], payload, associatedData);
            return true;
        }
        catch (AuthenticationTagMismatchException)
        {
            return false;
        }
    }
}
