using System.Buffers.Text;
using System.Security.Cryptography;

namespace FsusBlog.V2.Server.Comments;

// Only the shared token encoding; each action retains its own scope, authorization and consumption.
internal static class CommentAuthorProof
{
    private const int SecretSize = 32;

    internal static (string Proof, byte[] Digest) Issue()
    {
        Span<byte> secret = stackalloc byte[SecretSize];
        RandomNumberGenerator.Fill(secret);
        try { return (Base64Url.EncodeToString(secret), SHA256.HashData(secret)); }
        finally { CryptographicOperations.ZeroMemory(secret); }
    }

    internal static byte[]? Digest(string proof)
    {
        Span<byte> secret = stackalloc byte[SecretSize];
        try
        {
            return Base64Url.TryDecodeFromChars(proof, secret, out var written) && written == secret.Length &&
                Base64Url.EncodeToString(secret) == proof ? SHA256.HashData(secret) : null;
        }
        finally { CryptographicOperations.ZeroMemory(secret); }
    }
}
