using System.Buffers.Binary;
using System.Text;

namespace FsusBlog.V2.Contracts;

public sealed record PowChallenge(string Salt, int Difficulty, long Timestamp, string Signature);

public sealed record PowProof(string Salt, string Nonce, int Difficulty, long Timestamp, string Signature, string ClientNonce);

public static class PowWire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static byte[] EncodeChallenge(PowChallenge challenge)
    {
        Span<byte> body = stackalloc byte[WireLayouts.PowChallengeBytes];
        body.Clear();
        WriteText(challenge.Salt, body[..WireLayouts.PowChallengeSaltBytes]);
        BinaryPrimitives.WriteInt32LittleEndian(body[WireLayouts.PowChallengeSaltBytes..], challenge.Difficulty);
        BinaryPrimitives.WriteInt64LittleEndian(body[WireLayouts.PowChallengeTimestampOffset..], challenge.Timestamp);
        WriteText(challenge.Signature, body[WireLayouts.PowChallengeSignatureOffset..]);
        return Aeds.Encode(FrameType.PowChallenge, body);
    }

    public static PowProof ReadProof(string? raw)
    {
        Span<byte> bytes = stackalloc byte[WireLimits.PowProofHeaderChars * 3 / 4];
        if (raw is not { Length: > 0 and <= WireLimits.PowProofHeaderChars } ||
            !Convert.TryFromBase64String(raw, bytes, out var length) ||
            raw != Convert.ToBase64String(bytes[..length]) ||
            length < WireLayouts.PowProofHeaderBytes || !bytes[..5].SequenceEqual("FPOW\u0001"u8))
            throw Invalid();

        var offset = WireLayouts.PowProofHeaderBytes;
        var salt = ReadText(bytes[..length], ref offset, 128);
        var nonce = ReadText(bytes[..length], ref offset, 64);
        var signature = ReadText(bytes[..length], ref offset, 128);
        var clientNonce = ReadText(bytes[..length], ref offset, 256);
        if (offset != length) throw Invalid();
        return new(salt, nonce, BinaryPrimitives.ReadInt32LittleEndian(bytes[5..]),
            BinaryPrimitives.ReadInt64LittleEndian(bytes[9..]), signature, clientNonce);
    }

    private static string ReadText(ReadOnlySpan<byte> body, ref int offset, int limit)
    {
        if (body.Length - offset < 2) throw Invalid();
        var size = BinaryPrimitives.ReadUInt16LittleEndian(body[offset..]);
        offset += 2;
        if (size == 0 || size > limit || body.Length - offset < size) throw Invalid();
        var value = body.Slice(offset, size);
        offset += size;
        try { return Utf8.GetString(value); }
        catch (DecoderFallbackException) { throw Invalid(); }
    }

    private static void WriteText(string value, Span<byte> destination)
    {
        if (value.Contains('\0') || Utf8.GetByteCount(value) > destination.Length) throw Invalid();
        Utf8.GetBytes(value, destination);
    }

    private static ProtocolException Invalid() => new("Invalid FPOW proof encoding");
}
