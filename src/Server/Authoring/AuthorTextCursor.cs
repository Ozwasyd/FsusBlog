using System.Buffers.Binary;
using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Authoring;

internal sealed class AuthorTextCursor(TimeProvider time)
{
    private const int GenerationBytes = 32;
    private const int PayloadBytes = 28 + GenerationBytes;
    private const int NonceBytes = 12;
    private const int TagBytes = 16;
    private const int EncodedChars = 118;
    private const long LifetimeSeconds = 15 * 60;
    private readonly byte[] key = RandomNumberGenerator.GetBytes(32);

    internal string Encode(AuthorTextRankKey position, byte[] generation, Identity actor, byte[] session, string query, FrameType mode)
    {
        Span<byte> payload = stackalloc byte[PayloadBytes];
        BinaryPrimitives.WriteInt64LittleEndian(payload, Now + LifetimeSeconds);
        BinaryPrimitives.WriteInt32LittleEndian(payload[8..], position.PhraseRank);
        BinaryPrimitives.WriteInt32LittleEndian(payload[12..], position.FieldRank);
        BinaryPrimitives.WriteInt64LittleEndian(payload[16..], position.UpdatedAtUnixMs);
        BinaryPrimitives.WriteInt32LittleEndian(payload[24..], position.Id);
        if (generation.Length != GenerationBytes) throw Invalid();
        generation.AsSpan().CopyTo(payload[28..]);

        Span<byte> encoded = stackalloc byte[NonceBytes + PayloadBytes + TagBytes];
        var nonce = encoded[..NonceBytes];
        RandomNumberGenerator.Fill(nonce);
        using var aes = new AesGcm(key, TagBytes);
        aes.Encrypt(nonce, payload, encoded.Slice(NonceBytes, PayloadBytes), encoded[^TagBytes..], Context(actor, session, query, mode));
        return Base64Url.EncodeToString(encoded);
    }

    internal (AuthorTextRankKey Position, byte[] Generation) Decode(string cursor, Identity actor, byte[] session, string query, FrameType mode)
    {
        Span<byte> encoded = stackalloc byte[NonceBytes + PayloadBytes + TagBytes];
        if (cursor.Length != EncodedChars || !Base64Url.TryDecodeFromChars(cursor, encoded, out var size) ||
            size != encoded.Length || !string.Equals(Base64Url.EncodeToString(encoded), cursor, StringComparison.Ordinal))
            throw Invalid();

        Span<byte> payload = stackalloc byte[PayloadBytes];
        using var aes = new AesGcm(key, TagBytes);
        try
        {
            aes.Decrypt(encoded[..NonceBytes], encoded.Slice(NonceBytes, PayloadBytes), encoded[^TagBytes..], payload,
                Context(actor, session, query, mode));
        }
        catch (AuthenticationTagMismatchException)
        {
            throw Invalid();
        }
        if (BinaryPrimitives.ReadInt64LittleEndian(payload) <= Now) throw Invalid();
        return (new(BinaryPrimitives.ReadInt32LittleEndian(payload[8..]), BinaryPrimitives.ReadInt32LittleEndian(payload[12..]),
            BinaryPrimitives.ReadInt64LittleEndian(payload[16..]), BinaryPrimitives.ReadInt32LittleEndian(payload[24..])),
            payload[28..].ToArray());
    }

    private long Now => time.GetUtcNow().ToUnixTimeSeconds();

    private static byte[] Context(Identity actor, byte[] session, string query, FrameType mode)
    {
        var context = new byte[94];
        BinaryPrimitives.WriteInt32LittleEndian(context, AuthorTextProfile.Version);
        actor.Id.TryWriteBytes(context.AsSpan(4, 16));
        BinaryPrimitives.WriteInt64LittleEndian(context.AsSpan(20), actor.Generation);
        session.CopyTo(context, 28);
        SHA256.HashData(Encoding.UTF8.GetBytes(query), context.AsSpan(60, 32));
        BinaryPrimitives.WriteUInt16LittleEndian(context.AsSpan(92), (ushort)mode);
        return context;
    }

    internal static BusinessException Invalid() => AuthorTextContinuation.Invalid();
}
