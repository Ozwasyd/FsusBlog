using System.Buffers.Binary;
using System.Text;
using static FsusBlog.V2.Contracts.WireLayouts;

namespace FsusBlog.V2.Contracts;

public sealed record MfaAttempt(string Token, string Action, string Code, string Recovery);

public static class MfaWire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    public const string Setup = "mfa_setup";
    public const string Disable = "mfa_disable";
    public const string Regenerate = "mfa_recovery_regenerate";
    public const string Login = "login";

    public static byte[] EncodeSetup(string seed, string uri, string issuer, string account)
    {
        var payload = WriteFields(MfaSetupStartBytes, 4, [seed, uri, issuer, account]);
        return Aeds.Encode(FrameType.MfaSetupStart, payload);
    }

    public static byte[] EncodeSetupVerified(IReadOnlyList<string> codes)
    {
        var payload = new byte[MfaSetupVerifyBytes + codes.Count * MfaFixedCodeBytes];
        payload[0] = 1;
        I32(payload.AsSpan(4), codes.Count);
        for (var i = 0; i < codes.Count; i++) WriteFixed(payload.AsSpan(MfaSetupVerifyBytes + i * MfaFixedCodeBytes, MfaFixedCodeBytes), codes[i]);
        return Aeds.Encode(FrameType.MfaSetupVerify, payload);
    }

    public static byte[] EncodeProfile(DateTimeOffset? verifiedAt)
    {
        var payload = new byte[MfaProfileBytes];
        if (verifiedAt.HasValue)
        {
            BinaryPrimitives.WriteInt64LittleEndian(payload, verifiedAt.Value.ToUnixTimeMilliseconds());
            payload[8] = 1;
            payload[9] = 1;
        }
        return Aeds.Encode(FrameType.MfaProfile, payload);
    }

    public static byte[] EncodeChallenge(bool verified, string action, string? token = null, int? account = null)
    {
        var payload = new byte[MfaChallengeResultBytes];
        payload[4] = verified ? (byte)1 : (byte)0;
        if (token is not null)
        {
            payload[5] = 1;
            WriteFixed(payload.AsSpan(MfaChallengeProofOffset), token);
        }
        if (account is int id)
        {
            I32(payload, id);
            payload[6] = 1;
            payload[7] = 1;
            "anonymous_account"u8.CopyTo(payload.AsSpan(8));
        }
        WriteFixed(payload.AsSpan(MfaChallengeActionOffset, 64), action);
        return Aeds.Encode(FrameType.MfaChallengeResult, payload);
    }

    public static string ReadSingle(ReadOnlySpan<byte> frame, FrameType type, int maxLength) =>
        ReadFields(Aeds.Decode(frame, type), [maxLength])[0];

    public static MfaAttempt ReadAttempt(ReadOnlySpan<byte> frame)
    {
        var fields = ReadFields(Aeds.Decode(frame, FrameType.MfaChallengeVerifyRequest), [64, 64, 6, 40]);
        return new(fields[0], fields[1], fields[2], fields[3]);
    }

    private static byte[] WriteFields(int size, int referenceOffset, string[] fields)
    {
        var values = fields.Select(Utf8.GetBytes).ToArray();
        var length = values.Sum(value => value.Length);
        var payload = new byte[size + 4 + length];
        I32(payload.AsSpan(size), length);
        var offset = 0;
        for (var i = 0; i < values.Length; i++)
        {
            var point = referenceOffset + i * 8;
            I32(payload.AsSpan(point), offset);
            I32(payload.AsSpan(point + 4), values[i].Length);
            values[i].CopyTo(payload, size + 4 + offset);
            offset += values[i].Length;
        }
        return payload;
    }

    private static string[] ReadFields(ReadOnlySpan<byte> packet, int[] bounds)
    {
        var header = bounds.Length * 8;
        if (packet.Length < header + 4 || packet.Length + Aeds.HeaderSize > WireLimits.MaxMfaFrameBytes) throw Invalid();
        var blob = packet[(header + 4)..];
        if (ReadI32(packet[header..]) != blob.Length) throw Invalid();
        var fields = new string[bounds.Length];
        var position = 0;
        for (var i = 0; i < fields.Length; i++)
        {
            var field = packet[(i * 8)..];
            var offset = ReadI32(field);
            var length = ReadI32(field[4..]);
            if (offset != position || length < 0 || length > bounds[i] || length > blob.Length - position) throw Invalid();
            try { fields[i] = Utf8.GetString(blob.Slice(position, length)); }
            catch (DecoderFallbackException) { throw Invalid(); }
            position += length;
        }
        if (position != blob.Length) throw Invalid();
        return fields;
    }

    private static void WriteFixed(Span<byte> field, string value)
    {
        if (Utf8.GetByteCount(value) >= field.Length) throw new ArgumentOutOfRangeException(nameof(value));
        Utf8.GetBytes(value, field);
    }

    private static int ReadI32(ReadOnlySpan<byte> data) => BinaryPrimitives.ReadInt32LittleEndian(data);
    private static void I32(Span<byte> data, int value) => BinaryPrimitives.WriteInt32LittleEndian(data, value);
    private static ProtocolException Invalid() => new("Invalid MFA AEDS payload.");
}
